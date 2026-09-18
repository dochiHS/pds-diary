// Local stand-in for "GitHub Pages + Supabase": serves the app and proxies /rest/v1/* to PostgREST.
// Mimics Supabase's gateway: requires the publishable key on the `apikey` header and
// rejects a non-JWT value on Authorization: Bearer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const TEST_KEY = 'sb_publishable_localtest_0123456789';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const log = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/__log') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(log)); return; }
  if (url.pathname === '/config.js' && !process.env.REAL_CONFIG) {
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    res.end(`window.PDS_CONFIG = { SUPABASE_URL: 'http://localhost:${PORT}', SUPABASE_PUBLISHABLE_KEY: '${TEST_KEY}', SOURCE_URL: 'https://github.com/dochiHS/pds-diary' };`);
    return;
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    const apikey = req.headers['apikey'];
    const auth = req.headers['authorization'];
    log.push({ path: url.pathname, apikey: apikey ? apikey.slice(0, 16) : null, auth: auth || null });
    if (apikey !== TEST_KEY) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Invalid API key' })); return; }
    if (auth && !/^Bearer eyJ/.test(auth)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Invalid JWT' })); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const delay = Number(process.env.API_DELAY_MS || 0);
      setTimeout(() => {
        const up = http.request({
          host: '127.0.0.1', port: 3000, method: req.method,
          path: url.pathname.replace('/rest/v1', '') + url.search,
          headers: { 'content-type': req.headers['content-type'] || 'application/json', 'content-length': body.length, accept: 'application/json' },
        }, (ur) => {
          res.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] || 'application/json' });
          ur.pipe(res);
        });
        up.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ message: String(e) })); });
        up.end(body);
      }, delay);
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
