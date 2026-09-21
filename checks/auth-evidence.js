/* T07 확인 기록 만들기 — 실제 Supabase에 시험 계정 3개(A·B·C)를 만들어
 * "성공한 요청"과 "거절된 요청"을 나란히 적습니다. 비밀번호·토큰은 이 페이지 안에서만 만들고 쓰며,
 * 기록에는 모두 가려서 남깁니다(비밀번호는 화면에도 보이지 않음).
 *   ① 로그인 없이 요청  ② 비밀번호(맞음/틀림/없는 계정·중복 가입·저장 방식)
 *   ③ 로그아웃·비밀번호 변경 뒤 같은 토큰  ④ 남의 자료 읽기·수정·삭제(양방향)  ⑤ 주인 바꿔치기·목록 섞임
 *   + 계정 삭제
 */
'use strict';
(function () {
  const CFG = window.PDS_CONFIG || {};
  const URL0 = String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');
  const KEY = String(CFG.SUPABASE_PUBLISHABLE_KEY || '');
  const $ = (s) => document.querySelector(s);
  const log = [];          // 모든 요청·응답(가린 것)
  const checks = [];       // {id, title, ok, success:[entry], rejected:[entry], note}
  const secrets = new Set();

  const maskTok = (t) => (t ? `${String(t).slice(0, 10)}…(가림)` : t);
  function scrub(text) {
    let s = String(text);
    for (const x of secrets) if (x && x.length >= 6) s = s.split(x).join('********(가림)');
    return s.replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, (m) => maskTok(m));
  }
  function maskBody(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(maskBody);
    if (typeof obj !== 'object') return obj;
    const o = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/password/i.test(k)) o[k] = '********(가림)';
      else if (/^(access_token|refresh_token|provider_token|provider_refresh_token|token)$/i.test(k) && typeof v === 'string') o[k] = maskTok(v);
      else o[k] = maskBody(v);
    }
    return o;
  }
  const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  const newPw = () => { const p = `${rand(6)}A${rand(6)}7${rand(4)}`; secrets.add(p); return p; };

  async function call(method, path, { body, token, headers } = {}) {
    const h = { apikey: KEY, 'Content-Type': 'application/json', ...(headers || {}) };
    if (token) h.Authorization = `Bearer ${token}`;
    const t0 = new Date();
    const res = await fetch(URL0 + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit' });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    const shownHeaders = { apikey: `${KEY.slice(0, 16)}…(공개 키)` };
    if (token) shownHeaders.Authorization = `Bearer ${maskTok(token)}`;
    for (const [k, v] of Object.entries(headers || {})) shownHeaders[k] = v;
    const entry = {
      n: log.length + 1, at: t0.toISOString(), method, path, headers: shownHeaders,
      body: body === undefined ? null : maskBody(body), status: res.status, response: maskBody(data),
    };
    log.push(entry);
    return { status: res.status, data, entry };
  }
  const rpc = (fn, args, token, opts = {}) => call(opts.get ? 'GET' : 'POST', `/rest/v1/rpc/${fn}${opts.query || ''}`,
    { body: opts.get ? undefined : (args || {}), token, headers: opts.headers });
  const signup = (email, password) => call('POST', '/auth/v1/signup', { body: { email, password } });
  const login = (email, password) => call('POST', '/auth/v1/token?grant_type=password', { body: { email, password } });
  const jwtPart = (t, i) => JSON.parse(atob(t.split('.')[i].replace(/-/g, '+').replace(/_/g, '/')));

  function add(id, title, ok, success, rejected, note) {
    checks.push({ id, title, ok: !!ok, success: success.filter(Boolean), rejected: rejected.filter(Boolean), note: note || '' });
    status(`${ok ? '✓' : '✗'} ${id} ${title}`);
  }
  function status(line) { const li = document.createElement('li'); li.textContent = line; $('#progress').append(li); }
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

  async function runAll() {
    const domain = ($('#domain').value || 'example.com').trim().replace(/^@/, '');
    const tag = `${today().replace(/-/g, '')}-${rand(4)}`;
    const EA = `t07-a-${tag}@${domain}`; const EB = `t07-b-${tag}@${domain}`; const EC = `t07-c-${tag}@${domain}`;
    const PW = newPw(); const PWC = newPw(); const PWC2 = newPw();
    const meta = { run: tag, started_at: new Date().toISOString(), supabase_url: URL0, page: location.href, accounts: { A: EA, B: EB, C: EC } };

    // 인증 서버 정보(이름·버전, 서명 방식)
    const health = await call('GET', '/auth/v1/health');
    const jwks = await call('GET', '/auth/v1/.well-known/jwks.json');
    meta.auth_server = health.data;

    // ---- ② 가입·로그인·비밀번호
    const sa = await signup(EA, PW);
    if (sa.status !== 200 || !sa.data.access_token) {
      add('SETUP', '시험 계정 A 가입', false, [], [sa.entry], '가입이 되지 않아 멈춥니다. Supabase에서 Confirm email이 꺼져 있는지, 이메일 도메인이 허용되는지 확인하세요.');
      return finish(meta);
    }
    secrets.add(sa.data.access_token); secrets.add(sa.data.refresh_token);
    const sb = await signup(EB, PW); secrets.add(sb.data.access_token); secrets.add(sb.data.refresh_token);
    const UA = sa.data.user.id; const UB = sb.data.user.id;
    add('C94', '가입 화면(가입 요청)으로 새 계정 만들기 — A·B를 같은 비밀번호로', sa.status === 200 && sb.status === 200, [sa.entry, sb.entry], []);
    const dup = await signup(EA.toUpperCase(), PW);
    add('C98', '같은 이메일(대문자로 바꿔도)로 두 번 가입되지 않음', dup.status >= 400, [sa.entry], [dup.entry]);
    const weak = await signup(`t07-w-${tag}@${domain}`, 'abc12');
    add('PW-RULE', '약한 비밀번호(5자)로는 가입되지 않음', weak.status >= 400, [], [weak.entry]);
    const la = await login(EA, PW); secrets.add(la.data.access_token); secrets.add(la.data.refresh_token);
    const bad1 = await login(EA, PW + 'x');
    const bad2 = await login(`nobody-${tag}@${domain}`, PW);
    add('C95/C99', '맞는 비밀번호는 로그인 200 / 비밀번호만 틀림·없는 아이디는 같은 상태·같은 문구',
      la.status === 200 && bad1.status === bad2.status && JSON.stringify(bad1.data) === JSON.stringify(bad2.data) && bad1.status === 400,
      [la.entry], [bad1.entry, bad2.entry], `틀린 비밀번호 응답 = 없는 아이디 응답: ${JSON.stringify(bad1.data) === JSON.stringify(bad2.data)}`);
    let TA = la.data.access_token; const TB = sb.data.access_token;
    const head = jwtPart(TA, 0); const pay = jwtPart(TA, 1);
    meta.token = { header: head, claims_shown: { sub: pay.sub, role: pay.role, session_id: pay.session_id, iat: pay.iat, exp: pay.exp, lifetime_seconds: pay.exp - pay.iat },
      jwks_kids: (jwks.data && jwks.data.keys || []).map((k) => `${k.kid} (${k.alg}, 공개키)`) };
    add('C108/C111', `토큰(JWT, ${head.alg}) — 사용자 ID·세션 ID·만료(발급 뒤 ${pay.exp - pay.iat}초)`, !!pay.session_id && pay.exp > pay.iat, [la.entry], [],
      `헤더 alg=${head.alg}, kid=${head.kid || '없음'} / 서명 공개키는 ${meta.token.jwks_kids.join(', ') || '(없음)'}`);

    // ---- ① 로그인 없이 요청
    const okList = await rpc('list_plans', {}, TA);
    const anon1 = await rpc('list_plans', {});
    const anon2 = await rpc('get_plan_bundle', { p_plan_id: 1 });
    const anon3 = await rpc('export_all', {});
    const ping = await rpc('ping', {});
    add('C124', '로그인 없이 자료를 직접 요청하면 거절(목록·계획·내보내기). ping만 열림', okList.status === 200 && [anon1, anon2, anon3].every((r) => r.status === 401) && ping.status === 200,
      [okList.entry, ping.entry], [anon1.entry, anon2.entry, anon3.entry]);

    // ---- ③ 로그아웃 뒤 같은 토큰
    const w1 = await rpc('whoami', {}, TA);
    const lo = await call('POST', '/auth/v1/logout?scope=local', { token: TA });
    const w2 = await rpc('whoami', {}, TA);
    add('C109/C110', '같은 주소·같은 방식·같은 토큰: 로그아웃 전 200 → 로그아웃 뒤 401', w1.status === 200 && lo.status === 204 && w2.status === 401,
      [w1.entry, lo.entry], [w2.entry], '두 요청은 POST /rest/v1/rpc/whoami, 헤더·본문 같음 — 달라진 것은 가운데 로그아웃뿐');
    const la2 = await login(EA, PW); TA = la2.data.access_token; secrets.add(TA); secrets.add(la2.data.refresh_token);

    // 비밀번호 변경 → 예전 토큰 (계정 C)
    const sc = await signup(EC, PWC); secrets.add(sc.data.access_token); secrets.add(sc.data.refresh_token);
    const c1 = await login(EC, PWC); const c2 = await login(EC, PWC);
    [c1, c2].forEach((c) => { secrets.add(c.data.access_token); secrets.add(c.data.refresh_token); });
    const cw1 = await rpc('whoami', {}, c1.data.access_token);
    const chg = await call('PUT', '/auth/v1/user', { body: { password: PWC2 }, token: c2.data.access_token });
    const cw2 = await rpc('whoami', {}, c1.data.access_token);
    const glo = await call('POST', '/auth/v1/logout?scope=global', { token: c2.data.access_token });
    const cw3 = await rpc('whoami', {}, c2.data.access_token);
    const oldpw = await login(EC, PWC);
    const newpw = await login(EC, PWC2); const TC = newpw.data && newpw.data.access_token; secrets.add(TC); if (newpw.data) secrets.add(newpw.data.refresh_token);
    add('C114', '비밀번호를 바꾸면 이전에 받은 토큰 거절(다른 세션 401) · 전체 로그아웃 뒤 남은 토큰도 401 · 예전 비밀번호 400',
      cw1.status === 200 && chg.status === 200 && cw2.status === 401 && cw3.status === 401 && oldpw.status === 400 && newpw.status === 200,
      [cw1.entry, chg.entry, newpw.entry], [cw2.entry, cw3.entry, oldpw.entry]);
    const forged = (() => { const p = jwtPart(TA, 1); p.sub = UB; const b = btoa(JSON.stringify(p)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); const s = TA.split('.'); return `${s[0]}.${b}.${s[2]}`; })();
    secrets.add(forged);

    // ---- ④ 남의 자료 (계정 두 개에 자료 넣기)
    const d0 = today();
    const mkPlan = (tok, title) => rpc('create_plan', { p_title: title, p_success_criteria: '확인 기록용 시험 자료', p_start_date: d0, p_end_date: d0, p_priority: 3, p_estimated_minutes: 10, p_request_key: crypto.randomUUID() }, tok);
    const mkTask = (tok, pid, title) => rpc('create_task', { p_plan_id: pid, p_title: title, p_note: null, p_due_date: d0, p_priority: 3, p_tags: ['시험'], p_estimated_minutes: 5, p_request_key: crypto.randomUUID() }, tok);
    const pa = await mkPlan(TA, `[시험] A의 계획 ${tag}`); const ta = await mkTask(TA, pa.data.id, 'A의 할 일');
    const ra = await rpc('add_run_log', { p_task_id: ta.data.id, p_started_at: `${d0}T09:00:00+09:00`, p_ended_at: `${d0}T09:05:00+09:00`, p_actual_minutes: 5, p_blocked_reason: null, p_note: null, p_request_key: crypto.randomUUID() }, TA);
    const pb = await mkPlan(TB, `[시험] B의 계획 ${tag}`); const tb = await mkTask(TB, pb.data.id, 'B의 할 일');
    const rb = await rpc('add_run_log', { p_task_id: tb.data.id, p_started_at: `${d0}T09:00:00+09:00`, p_ended_at: `${d0}T09:05:00+09:00`, p_actual_minutes: 5, p_blocked_reason: null, p_note: null, p_request_key: crypto.randomUUID() }, TB);
    add('C116', '계정 두 개(A·B)에 각각 계획·할 일·실행 기록을 넣음(비밀번호는 적지 않음)', [pa, ta, ra, pb, tb, rb].every((r) => r.status === 200), [pa.entry, ta.entry, ra.entry, pb.entry, tb.entry, rb.entry], []);

    const snap = async (tok) => { const r = await rpc('export_all', {}, tok); const d = r.data; return { entry: r.entry, counts: { plans: d.plans.length, tasks: d.tasks.length, run_logs: d.run_logs.length, task_completions: d.task_completions.length }, json: JSON.stringify([d.plans, d.tasks, d.run_logs, d.task_completions]) }; };
    const beforeA = await snap(TA); const beforeB = await snap(TB);

    async function attack(label, tok, own, victim) {
      const ok = [];
      const rej = [];
      ok.push((await rpc('get_plan_bundle', { p_plan_id: own.plan }, tok)).entry);
      const r1 = await rpc('get_plan_bundle', { p_plan_id: victim.plan }, tok);
      ok.push((await rpc('update_task', { p_id: own.task, p_title: `${label} 내 할 일 고침`, p_note: null, p_due_date: d0, p_priority: 3, p_tags: ['시험'], p_estimated_minutes: 5 }, tok)).entry);
      const r2 = await rpc('update_task', { p_id: victim.task, p_title: '남이 고침', p_note: null, p_due_date: d0, p_priority: 1, p_tags: [], p_estimated_minutes: 1 }, tok);
      const r3 = await rpc('delete_task', { p_id: victim.task }, tok);
      const r4 = await rpc('delete_run_log', { p_id: victim.log }, tok);
      const r5 = await rpc('create_task', { p_plan_id: victim.plan, p_title: '끼워넣기', p_note: null, p_due_date: null, p_priority: 2, p_tags: [], p_estimated_minutes: 0 }, tok);
      rej.push(r1.entry, r2.entry, r3.entry, r4.entry, r5.entry);
      return { ok, rej, all404: [r1, r2, r3, r4, r5].every((r) => r.status === 404) };
    }
    const A = { plan: pa.data.id, task: ta.data.id, log: ra.data.id };
    const B = { plan: pb.data.id, task: tb.data.id, log: rb.data.id };
    const atkAB = await attack('A', TA, A, B);
    const atkBA = await attack('B', TB, B, A);
    add('C117~C119/C121', 'A가 B의 자료를 읽기·수정·삭제(+B 계획에 할 일 끼워넣기) → 모두 404(없는 자료와 같은 답)', atkAB.all404, atkAB.ok, atkAB.rej);
    add('C120/C121', '반대 방향: B가 A의 자료를 읽기·수정·삭제 → 모두 404', atkBA.all404, atkBA.ok, atkBA.rej);
    const none = await rpc('get_plan_bundle', { p_plan_id: 999999999 }, TA);
    add('C121b', '없는 계획 번호와 남의 계획 번호의 응답이 같은 모양(존재를 감춤)', none.status === 404, [], [none.entry, atkAB.rej[0]]);
    const afterA = await snap(TA); const afterB = await snap(TB);
    // 수정 시도 뒤 "내 할 일 고침"만 바뀐 게 맞는지: 남의 쪽 자료(B는 A 공격 전후, A는 B 공격 전후) 비교
    const bSame = beforeB.counts.tasks === afterB.counts.tasks && beforeB.counts.plans === afterB.counts.plans && beforeB.counts.run_logs === afterB.counts.run_logs;
    const aSame = beforeA.counts.tasks === afterA.counts.tasks && beforeA.counts.plans === afterA.counts.plans && beforeA.counts.run_logs === afterA.counts.run_logs;
    const bTask = JSON.parse(afterB.json)[1].find((t) => t.id === B.task);
    const aTask = JSON.parse(afterA.json)[1].find((t) => t.id === A.task);
    add('C122', '거절 앞뒤로 반대편 자료 건수가 같고, 남이 고치거나 지운 흔적·새로 생긴 자료가 없음',
      aSame && bSame && bTask && !bTask.deleted_at && bTask.title !== '남이 고침' && aTask && !aTask.deleted_at && aTask.title !== '남이 고침',
      [beforeA.entry, beforeB.entry], [afterA.entry, afterB.entry],
      `A 건수 전 ${JSON.stringify(beforeA.counts)} → 후 ${JSON.stringify(afterA.counts)} / B 건수 전 ${JSON.stringify(beforeB.counts)} → 후 ${JSON.stringify(afterB.counts)} · B 할 일 #${B.task} 제목 "${bTask && bTask.title}", 지움 ${bTask && bTask.deleted_at} · A 할 일 #${A.task} 제목 "${aTask && aTask.title}"(A 자신이 고친 것), 지움 ${aTask && aTask.deleted_at}`);

    // ---- ⑤ 주인 바꿔치기 + 목록
    const myIds = (await rpc('list_plans', {}, TA)).data.map((p) => p.id).sort((x, y) => x - y);
    const q1 = await rpc('list_plans', null, TA, { get: true, query: `?p_owner_id=${UB}` });
    const q2 = await rpc('list_plans', {}, TA, { headers: { 'X-Owner-Id': UB, 'X-User-Id': UB } });
    const q3 = await rpc('list_plans', { p_owner_id: UB }, TA);
    const q4 = await rpc('list_plans', {}, forged);
    const ids = (r) => (Array.isArray(r.data) ? r.data.map((p) => p.id).sort((x, y) => x - y) : null);
    const only = (r) => r.status === 200 && JSON.stringify(ids(r)) === JSON.stringify(myIds) && !ids(r).includes(B.plan);
    add('C123', '주소·요청 헤더·요청 본문에 B 계정을 적어 보내도 A 자료만 돌아옴 / 토큰 안의 사용자를 B로 바꾸면(서명 불일치) 401',
      only(q1) && only(q2) && only(q3) && q4.status === 401, [q1.entry, q2.entry, q3.entry], [q4.entry], `A의 계획 ID 목록 ${JSON.stringify(myIds)}, B의 계획 #${B.plan}은 어느 응답에도 없음`);
    const lb = await rpc('list_plans', {}, TB);
    const ea = await rpc('export_all', {}, TA);
    const foreign = ea.data.plans.concat(ea.data.tasks, ea.data.run_logs).filter((r) => r.owner_id !== UA).length;
    add('C125', '목록 응답에 다른 계정의 자료가 하나도 없음(B 목록에 A 계획 0건, A 내보내기에 남의 행 0건)',
      lb.status === 200 && lb.data.every((p) => p.id !== A.plan) && foreign === 0, [lb.entry, ea.entry], [], `A 내보내기의 남의 행 ${foreign}건`);

    // ---- 계정 삭제 (C)
    const pc = await mkPlan(TC, `[시험] C의 계획 ${tag}`);
    const del0 = await rpc('delete_my_account', { p_confirm: '삭제' }, TC);
    const del1 = await rpc('delete_my_account', { p_confirm: '계정 삭제' }, TC);
    const del2 = await rpc('whoami', {}, TC);
    const del3 = await login(EC, PWC2);
    add('C134', '계정 삭제: 확인 문구가 맞을 때만 지워지고, 지운 뒤 그 토큰 401·로그인 400',
      pc.status === 200 && del0.status === 400 && del1.status === 200 && del2.status === 401 && del3.status === 400,
      [pc.entry, del1.entry], [del0.entry, del2.entry, del3.entry]);

    meta.hash_sql = `select email, left(encrypted_password, 7) as 방식_비용, substr(encrypted_password, 8, 22) as 소금값, left(substr(encrypted_password, 30), 6) || '…(가림)' as 해시_앞부분, length(encrypted_password) as 길이\nfrom auth.users where email in ('${EA}', '${EB}') order by email;`;
    meta.ids = { A_user: UA, B_user: UB, A: A, B: B };
    return finish(meta);
  }

  function finish(meta) {
    meta.finished_at = new Date().toISOString();
    const passed = checks.filter((c) => c.ok).length;
    window.__evidence = { meta, checks, log };
    const md = toMarkdown(meta, passed);
    window.__evidenceMd = md;
    $('#summary').textContent = `${passed}/${checks.length} 통과 · 요청 ${log.length}건`;
    $('#report').textContent = md;
    $('#download').disabled = false;
    return window.__evidence;
  }

  const fence = (x) => `\`\`\`\n${scrub(typeof x === 'string' ? x : JSON.stringify(x, null, 2))}\n\`\`\``;
  function entryMd(e) {
    return [`**#${e.n}** \`${e.method} ${e.path}\` → **${e.status}**  (${e.at})`,
      `요청 헤더: \`${scrub(JSON.stringify(e.headers))}\``,
      e.body !== null ? `요청 본문:\n${fence(e.body)}` : '요청 본문: 없음',
      `응답:\n${fence(e.response)}`].join('\n\n');
  }
  function toMarkdown(meta, passed) {
    const out = [`# T07 확인 기록 (${meta.run})`, '',
      `- 실행: ${meta.started_at} ~ ${meta.finished_at} (UTC) · 페이지 ${meta.page}`,
      `- 대상: ${meta.supabase_url} · 인증 서버 ${JSON.stringify(meta.auth_server)}`,
      `- 시험 계정: A ${meta.accounts.A} · B ${meta.accounts.B} (A·B는 같은 비밀번호) · C ${meta.accounts.C} (비밀번호 변경·계정 삭제용)`,
      '- 비밀번호는 이 페이지가 무작위로 만들어 쓰고 버렸으며, 기록의 비밀번호·토큰은 모두 가렸습니다.',
      meta.token ? `- 토큰: ${scrub(JSON.stringify(meta.token))}` : '',
      `- 결과: **${passed}/${checks.length} 통과**`, ''];
    for (const c of checks) {
      out.push(`## ${c.ok ? '✅' : '❌'} ${c.id} — ${c.title}`, '');
      if (c.note) out.push(`> ${scrub(c.note)}`, '');
      if (c.success.length) { out.push('### 성공한 요청', ''); c.success.forEach((e) => out.push(entryMd(e), '')); }
      if (c.rejected.length) { out.push('### 거절된 요청', ''); c.rejected.forEach((e) => out.push(entryMd(e), '')); }
    }
    if (meta.hash_sql) out.push('## 비밀번호가 저장된 모습 (SQL Editor에서 실행)', '', fence(meta.hash_sql), '');
    return out.join('\n');
  }

  $('#run').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    $('#progress').replaceChildren();
    try { await runAll(); } catch (err) { status(`중단: ${err.message}`); finish({ error: String(err), run: 'error', started_at: '', finished_at: '', page: location.href, supabase_url: URL0, accounts: {} }); }
  });
  $('#download').addEventListener('click', () => {
    const blob = new Blob([window.__evidenceMd || ''], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `T07_확인기록_${(window.__evidence && window.__evidence.meta.run) || 'run'}.md`;
    document.body.append(a); a.click(); a.remove();
  });
  if (!URL0 || !KEY) $('#summary').textContent = 'config.js 설정이 없습니다.';
}());
