// T07 화면 검사 — 로컬 "Supabase 흉내"(PostgREST + 가입·로그인 흉내) 위에서 실제 화면을 눌러 봅니다.
// 브라우저 시간대는 일부러 서울이 아닌 America/Los_Angeles.
// 사용법: env/reset_db.sh && env/start_stack.sh && node checks/e2e.mjs
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || path.join(HERE, 'out');
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.BASE_URL || 'http://localhost:8080/';
const PSQL = process.env.PSQL || 'psql -h /tmp -p 54322 -U postgres -d pds';
const sql = (q) => execSync(`${PSQL} -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
const results = [];
const check = (id, desc, pass, detail = '') => {
  results.push({ id, desc, pass: !!pass, detail: String(detail).slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${desc}${pass ? '' : `  -- ${detail}`}`);
};
const run = Math.random().toString(16).slice(2, 8);
const EMAIL = `me-${run}@example.com`;
const PW = `Pw${run}12345`;
const PW2 = `Nw${run}67890`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles', locale: 'ko-KR' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/401|404|400|422/.test(m.text())) errors.push(m.text()); });
const urls = [];
page.on('request', (r) => urls.push(r.url()));
const text = async (sel) => ((await page.textContent(sel)) ?? '').trim();
const waitStatus = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#status').textContent), re.source, { timeout: 10000 });

// ---- 로그인 없이 자료 화면 주소 → 로그인 화면 (C97, C03)
await page.goto(`${BASE}#plan=1`);
await page.waitForSelector('#login-form');
check('C97', '로그인 없이 #plan=1 → 자료 대신 로그인 화면', (await page.$('#sec-plan')) === null && (await page.isVisible('#login-form')));
check('C03', '첫 화면은 로그인 화면(계정 없이 열림)', (await page.isVisible('#tab-signup')) && !(await page.isVisible('.steps')));
await page.screenshot({ path: path.join(SHOTS, '01-login.png') });

// ---- 가입 (C94)
await page.click('#tab-signup');
await page.fill('#auth-email', EMAIL);
await page.fill('#auth-password', PW);
await page.fill('#auth-password2', PW);
await page.click('#auth-submit');
await page.waitForSelector('#new-plan');
check('C94', '가입 화면에서 새 계정을 만들고 바로 들어감', (await text('#account-email')) === EMAIL);
const stored = await page.evaluate(() => Object.keys(sessionStorage));
check('C112', '토큰은 sessionStorage에만, 주소에는 없음', stored.includes('pds.auth.v1') && !/access_token|eyJ/.test(page.url()) && !urls.some((u) => /eyJ|access_token/.test(u)), page.url());

// ---- T06 자료를 이 계정으로 옮기기 (C100)
const claim = JSON.parse(sql(`select pds_private.claim_t06_rows('${EMAIL}')`));
await page.reload();
await page.waitForSelector('#sec-plan');
const opts = await page.$$eval('#plan-select option', (o) => o.map((x) => x.textContent));
check('C100', 'T06 계획 2개가 내 계정에 보임', claim.plans === 2 && opts.length === 2 && opts.some((t) => t.includes('ALEPH T06')), opts);
await page.selectOption('#plan-select', '1');
await page.waitForSelector('#plan-1');
check('C100b', 'T06 계획 #1의 할 일 6건이 그대로', (await page.$$('#task-list > li.task')).length === 6);
check('XSS', '스크립트 모양 메모가 글자 그대로', (await text('#task-5 .note')).includes('<script>alert(1)</script>'));

// ---- 할 일에 할 날·시간대 (T07)
await page.selectOption('#plan-select', '2');
await page.waitForSelector('#plan-2');
await page.fill('#task-form input[type=text]', '로그인 붙이기');
await page.fill('#task-planned-on', '2026-09-23');
await page.selectOption('#task-planned-slot', '오후');
await page.fill('#task-form input[type=number]', '60');
await page.click('#task-form button[type=submit]');
await waitStatus(/만들었습니다/);
const tid = Number(sql("select max(id) from public.tasks where title = '로그인 붙이기'"));
check('SLOT', '할 일에 할 날·시간대 저장·표시', (await text(`#task-${tid}`)).includes('할 날 2026-09-23 (수) 오후'), await text(`#task-${tid}`));

// ---- 5일 관찰 시작 + 1일차 (C04~C06)
await page.click('#obs-start');
await waitStatus(/관찰을 시작/);
check('C04', '관찰 설정(질문·지표·단위·규칙) 화면에 표시', (await text('#obs-setup')).includes('그날 끝낸 할 일 수') && (await text('#obs-setup')).includes('월요일'));
check('HINT', '할 일 추가 칸 위에 지금 계획 규칙', (await text('#rule-hint')).includes('마감일만 적는다'));
await page.click(`#task-${tid} .btn.complete`);
await waitStatus(/완료로 바꿨습니다/);
check('TODAY', '오늘 기록 미리보기 = 관찰 시작 뒤 완료 1개', (await text('#obs-today h3')).includes('지금 기록하면 1개'), await text('#obs-today h3'));
await page.fill('#obs-note', '1일차 시험');
await page.click('#obs-record');
await waitStatus(/1일차/);
check('C07', '1일차 기록이 표에 들어감', (await text('#obs-day-1')).includes('1개'));
check('C132', '합계·평균 계산식 표시와 브라우저 대조', (await text('#obs-sum')) === '1개' && (await text('#obs-check')).includes('= 서버가 계산한 합계 1'));
check('FIX', '1일차 뒤에는 설정 고치기 버튼 없음(고정)', (await text('#obs-setup')).includes('에 고정') && !(await text('#obs-setup')).includes('고치기'));
await page.screenshot({ path: path.join(SHOTS, '02-observation.png'), fullPage: true });

// ---- 모바일 폭
await page.setViewportSize({ width: 390, height: 800 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('MOBILE', '폭 390px에서 가로 스크롤 없음', overflow <= 0, overflow);
await page.setViewportSize({ width: 1280, height: 900 });

// ---- 로그아웃 (C96) → 같은 탭 새로고침은 로그인 화면
await page.click('#btn-logout');
await page.waitForSelector('#login-form');
check('C96', '로그아웃하면 로그인 화면', (await text('#auth-notice')).includes('로그아웃했습니다'));
await page.goto(`${BASE}#plan=2`);
await page.waitForSelector('#login-form');
check('C97b', '로그아웃 뒤 자료 주소 → 로그인 화면', (await page.$('#sec-plan')) === null);

// ---- 틀린 비밀번호 / 없는 계정 문구가 같음 (C99)
await page.fill('#auth-email', EMAIL);
await page.fill('#auth-password', PW + 'x');
await page.click('#auth-submit');
await page.waitForFunction(() => document.querySelector('#auth-error').textContent.length > 0);
const m1 = await text('#auth-error');
await page.fill('#auth-email', `nobody-${run}@example.com`);
await page.fill('#auth-password', PW);
await page.click('#auth-submit');
await page.waitForFunction((prev) => document.querySelector('#auth-error').textContent.length > 0, m1);
await page.waitForTimeout(300);
const m2 = await text('#auth-error');
check('C99', '비밀번호만 틀림 / 없는 아이디 — 같은 안내 문구', m1 === m2 && m1 === '이메일 또는 비밀번호가 맞지 않습니다.', `${m1} | ${m2}`);

// ---- 중복 가입 (C98)
await page.click('#tab-signup');
await page.fill('#auth-email', EMAIL);
await page.fill('#auth-password', PW);
await page.fill('#auth-password2', PW);
await page.click('#auth-submit');
await page.waitForFunction(() => document.querySelector('#auth-error').textContent.length > 0);
check('C98', '같은 이메일 두 번 가입 안 됨', (await text('#auth-error')).includes('이미 가입된'));

// ---- 로그인 (C95) → 다른 탭에서 로그아웃하면 이 탭도 끊김
await page.click('#tab-login');
await page.fill('#auth-email', EMAIL);
await page.fill('#auth-password', PW);
await page.click('#auth-submit');
await page.waitForSelector('#sec-account');
check('C95', '만든 계정으로 로그인', (await text('#me-email')) === EMAIL);
const page2 = await (await browser.newContext({ timezoneId: 'America/Los_Angeles' })).newPage();
await page2.goto(BASE);
await page2.fill('#auth-email', EMAIL);
await page2.fill('#auth-password', PW);
await page2.click('#auth-submit');
await page2.waitForSelector('#sec-account');
await page2.click('#logout-all');
await page2.waitForSelector('#login-form');
await page.reload();   // 이 탭은 예전 토큰을 그대로 들고 있음 → 서버가 거절
await page.waitForSelector('#login-form', { timeout: 10000 });
check('C114', '다른 곳에서 모든 기기 로그아웃 → 이 탭의 예전 토큰도 거절되어 로그인 화면', (await text('#auth-notice')).includes('로그인이 끝났습니다'), await text('#auth-notice'));

// ---- 비밀번호 바꾸기 (C114)
await page.fill('#auth-email', EMAIL);
await page.fill('#auth-password', PW);
await page.click('#auth-submit');
await page.waitForSelector('#pw-form');
await page.fill('#pw-current', PW);
await page.fill('#pw-new', PW2);
await page.fill('#pw-new2', PW2);
await page.click('#pw-submit');
await page.waitForSelector('#login-form');
check('PWCHG', '비밀번호를 바꾸면 전체 로그아웃 후 다시 로그인', (await text('#auth-notice')).includes('비밀번호를 바꿨습니다'));
const hash = sql(`select encrypted_password from auth.users where email = '${EMAIL}'`);
check('C103', '저장된 비밀번호에 글자가 그대로 없음', hash.startsWith('$2') && !hash.includes(PW2));
await page.fill('#auth-email', EMAIL);
await page.fill('#auth-password', PW2);
await page.click('#auth-submit');
await page.waitForSelector('#delete-zone');

// ---- 내보내기 + 계정 삭제 안내 (C133, C134)
check('C134a', '계정 삭제 안내 문구가 화면에', (await text('#delete-warning')).includes('모두 함께 지워지고'));
check('DEL-LOCK', '확인 문구 전에는 삭제 버튼 잠김', await page.isDisabled('#delete-account'));
await page.fill('#delete-confirm', '계정 삭제');
await page.click('#delete-account');
await page.waitForSelector('#login-form');
const left = sql(`select count(*) from auth.users where email = '${EMAIL}'`);
check('C134', '계정 삭제 → 계정·자료가 지워지고 로그인 화면', left === '0' && (await text('#auth-notice')).includes('모두 지웠습니다'), await text('#auth-notice'));

check('ERR', '콘솔 오류 없음', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
fs.writeFileSync(path.join(OUT, 'e2e_result.json'), JSON.stringify(results, null, 1));
process.exit(passed === results.length ? 0 : 1);
