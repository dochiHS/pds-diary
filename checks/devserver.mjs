// 로컬 검사용 "GitHub Pages + Supabase" 흉내:
//   · 화면 파일을 내주고
//   · /rest/v1/* 는 PostgREST(:3000)로 넘기고
//   · /auth/v1/* 는 Supabase Auth(GoTrue)의 가입·로그인·로그아웃·토큰 갱신·비밀번호 변경을 흉내 냅니다.
// Supabase 게이트웨이처럼 publishable 키를 apikey 헤더로 요구하고, Authorization에는 JWT만 받습니다.
// 운영에서는 이 파일을 쓰지 않습니다(운영의 인증은 Supabase Auth가 합니다).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(process.env.NODE_DEPS ? path.join(process.env.NODE_DEPS, 'x.js') : import.meta.url);
const pg = require('pg');
const bcrypt = require('bcryptjs');

const ROOT = process.env.APP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const PGRST_PORT = Number(process.env.PGRST_PORT || 3000);
const TEST_KEY = 'sb_publishable_localtest_0123456789';
const JWT_SECRET = process.env.JWT_SECRET || 'local-only-jwt-secret-for-tests-0123456789abcdef';
const ACCESS_TTL = Number(process.env.ACCESS_TTL || 3600);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const pool = new pg.Pool({ host: process.env.PGHOST || '/tmp', port: Number(process.env.PGPORT || 54322), user: 'postgres', database: process.env.PGDATABASE || 'postgres' });
const log = [];

const b64u = (x) => Buffer.from(x).toString('base64url');
function signJwt(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const sig = Buffer.from(crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url'));
  const got = Buffer.from(parts[2]);
  if (sig.length !== got.length || !crypto.timingSafeEqual(sig, got)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch (e) { return null; }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

const send = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(obj === null ? '' : JSON.stringify(obj));
};
const authErr = (res, status, code, msg) => send(res, status, { code: status, error_code: code, msg });
const userJson = (u) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.email_confirmed_at,
  phone: '', confirmed_at: u.email_confirmed_at, last_sign_in_at: u.last_sign_in_at,
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [],
  created_at: u.created_at, updated_at: u.updated_at, is_anonymous: false,
});
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
function weak(pw) {
  const reasons = [];
  if (String(pw || '').length < 8) reasons.push('length');
  if (!/[A-Za-z]/.test(pw || '') || !/[0-9]/.test(pw || '')) reasons.push('characters');
  return reasons;
}

async function issueSession(user, existingSid) {
  const now = Math.floor(Date.now() / 1000);
  const sid = existingSid || crypto.randomUUID();
  if (!existingSid) {
    await pool.query('insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), $3)', [sid, user.id, 'aal1']);
  }
  const refresh = crypto.randomBytes(12).toString('base64url');
  await pool.query('insert into auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id) values ($1, $2, false, now(), now(), $3)',
    [refresh, user.id, sid]);
  const payload = {
    aud: 'authenticated', exp: now + ACCESS_TTL, iat: now, iss: `http://localhost:${PORT}/auth/v1`, sub: user.id,
    email: user.email, phone: '', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {},
    role: 'authenticated', aal: 'aal1', amr: [{ method: 'password', timestamp: now }], session_id: sid, is_anonymous: false,
  };
  return { access_token: signJwt(payload), token_type: 'bearer', expires_in: ACCESS_TTL, expires_at: now + ACCESS_TTL, refresh_token: refresh, user: userJson(user) };
}

async function authed(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const claims = m && verifyJwt(m[1]);
  if (!claims) return { error: [401, 'bad_jwt', 'invalid JWT: unable to parse or verify signature'] };
  const s = await pool.query('select id from auth.sessions where id = $1', [claims.session_id]);
  if (!s.rowCount) return { error: [403, 'session_not_found', 'Session from session_id claim in JWT does not exist'] };
  const u = await pool.query('select * from auth.users where id = $1', [claims.sub]);
  if (!u.rowCount) return { error: [403, 'user_not_found', 'User from sub claim in JWT does not exist'] };
  return { claims, user: u.rows[0] };
}

async function handleAuth(req, res, url, body) {
  const route = url.pathname.replace('/auth/v1', '');
  let data = {};
  try { data = body.length ? JSON.parse(body) : {}; } catch (e) { return authErr(res, 400, 'bad_json', 'Could not parse request body as JSON'); }
  if (route === '/health') return send(res, 200, { version: 'local-mock', name: 'GoTrue', description: 'local stand-in for tests' });
  if (route === '/settings') return send(res, 200, { external: { email: true }, disable_signup: false, mailer_autoconfirm: true });
  if (route === '/signup' && req.method === 'POST') {
    const email = String(data.email || '').trim().toLowerCase();
    if (!emailOk(email)) return authErr(res, 400, 'validation_failed', 'Unable to validate email address: invalid format');
    const reasons = weak(data.password);
    if (reasons.length) return send(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters. Password should contain letters and digits.', weak_password: { reasons } });
    const exists = await pool.query('select 1 from auth.users where email = $1', [email]);
    if (exists.rowCount) return authErr(res, 422, 'user_already_exists', 'User already registered');
    const hash = await bcrypt.hash(String(data.password), 10);
    const u = await pool.query(`insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at)
      values ($1, 'authenticated', 'authenticated', $2, $3, now(), '{"provider":"email"}', '{}', now(), now(), now()) returning *`, [crypto.randomUUID(), email, hash]);
    return send(res, 200, await issueSession(u.rows[0]));
  }
  if (route === '/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const email = String(data.email || '').trim().toLowerCase();
      const u = await pool.query('select * from auth.users where email = $1', [email]);
      const ok = u.rowCount && await bcrypt.compare(String(data.password || ''), u.rows[0].encrypted_password);
      if (!ok) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials');
      await pool.query('update auth.users set last_sign_in_at = now() where id = $1', [u.rows[0].id]);
      return send(res, 200, await issueSession(u.rows[0]));
    }
    if (grant === 'refresh_token') {
      const t = await pool.query(`select r.*, s.id as sid from auth.refresh_tokens r join auth.sessions s on s.id = r.session_id
                                  where r.token = $1 and not r.revoked`, [String(data.refresh_token || '')]);
      if (!t.rowCount) return authErr(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      await pool.query('update auth.refresh_tokens set revoked = true, updated_at = now() where id = $1', [t.rows[0].id]);
      const u = await pool.query('select * from auth.users where id = $1', [t.rows[0].user_id]);
      return send(res, 200, await issueSession(u.rows[0], t.rows[0].sid));
    }
    return authErr(res, 400, 'unsupported_grant_type', 'unsupported_grant_type');
  }
  if (route === '/logout' && req.method === 'POST') {
    const a = await authed(req);
    if (a.error) return authErr(res, ...a.error);
    const scope = url.searchParams.get('scope') || 'global';
    if (scope === 'local') await pool.query('delete from auth.sessions where id = $1', [a.claims.session_id]);
    else if (scope === 'others') await pool.query('delete from auth.sessions where user_id = $1 and id <> $2', [a.user.id, a.claims.session_id]);
    else await pool.query('delete from auth.sessions where user_id = $1', [a.user.id]);
    return send(res, 204, null);
  }
  if (route === '/user') {
    const a = await authed(req);
    if (a.error) return authErr(res, ...a.error);
    if (req.method === 'GET') return send(res, 200, userJson(a.user));
    if (req.method === 'PUT') {
      if (data.password !== undefined) {
        const reasons = weak(data.password);
        if (reasons.length) return send(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters. Password should contain letters and digits.', weak_password: { reasons } });
        if (await bcrypt.compare(String(data.password), a.user.encrypted_password)) return authErr(res, 422, 'same_password', 'New password should be different from the old password.');
        const hash = await bcrypt.hash(String(data.password), 10);
        await pool.query('update auth.users set encrypted_password = $2, updated_at = now() where id = $1', [a.user.id, hash]);
        // Supabase Auth와 같이: 비밀번호를 바꾸면 지금 세션을 뺀 나머지 세션을 모두 끝냅니다.
        await pool.query('delete from auth.sessions where user_id = $1 and id <> $2', [a.user.id, a.claims.session_id]);
      }
      const u = await pool.query('select * from auth.users where id = $1', [a.user.id]);
      return send(res, 200, userJson(u.rows[0]));
    }
  }
  return authErr(res, 404, 'not_found', 'Not Found');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/__log') { send(res, 200, log); return; }
  if (url.pathname === '/config.js' && !process.env.REAL_CONFIG) {
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    res.end(`window.PDS_CONFIG = { SUPABASE_URL: 'http://localhost:${PORT}', SUPABASE_PUBLISHABLE_KEY: '${TEST_KEY}', SOURCE_URL: 'https://github.com/dochiHS/pds-diary' };`);
    return;
  }
  if (url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/auth/v1/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const apikey = req.headers.apikey;
      const auth = req.headers.authorization;
      log.push({ method: req.method, path: url.pathname + url.search, apikey: apikey ? `${apikey.slice(0, 16)}…` : null, auth: auth ? `${auth.slice(0, 12)}…` : null, body: body.toString().slice(0, 300) });
      if (apikey !== TEST_KEY) { send(res, 401, { message: 'Invalid API key' }); return; }
      if (auth && !/^Bearer eyJ/.test(auth)) { send(res, 401, { message: 'Invalid JWT' }); return; }
      if (url.pathname.startsWith('/auth/v1/')) {
        try { await handleAuth(req, res, url, body); } catch (e) { send(res, 500, { code: 500, msg: String(e) }); }
        return;
      }
      const headers = { 'content-type': req.headers['content-type'] || 'application/json', 'content-length': body.length, accept: 'application/json' };
      if (auth) headers.authorization = auth;
      if (req.headers.prefer) headers.prefer = req.headers.prefer;
      for (const h of Object.keys(req.headers)) if (h.startsWith('x-')) headers[h] = req.headers[h];
      const up = http.request({ host: '127.0.0.1', port: PGRST_PORT, method: req.method, path: url.pathname.replace('/rest/v1', '') + url.search, headers }, (ur) => {
        res.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] || 'application/json' });
        ur.pipe(res);
      });
      up.on('error', (e) => send(res, 502, { message: String(e) }));
      up.end(body);
    });
    return;
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
server.listen(PORT, '127.0.0.1', () => console.log(`dev server on http://localhost:${PORT}`));
