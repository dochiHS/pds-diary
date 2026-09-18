// End-to-end check of T06 criteria against the local Supabase stand-in.
// Browser timezone is deliberately NOT Seoul (America/Los_Angeles) to prove KST handling.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 사용법: 로컬 PostgreSQL + PostgREST(:3000)에 supabase/schema.sql을 올리고 devserver.mjs(:8080)를 켠 뒤
//   RESET_CMD="psql ... -c 'truncate ...'" node checks/e2e.mjs
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCR = process.env.OUT_DIR || path.join(HERE, 'out');
const SHOTS = path.join(SCR, 'shots');
const BASE = process.env.BASE_URL || 'http://localhost:8080/';
const PSQL = process.env.PSQL || 'psql -h /tmp -p 54322 -U postgres';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(id, desc, pass, detail = '') {
  results.push({ id, desc, pass: !!pass, detail: String(detail).slice(0, 400) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${desc}${pass ? '' : `  -- ${detail}`}`);
}
const sql = (q) => execSync(`${PSQL} -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
const kstToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const D = (n) => addDays(kstToday, n);

execSync(process.env.RESET_CMD || `${PSQL} -q -c "truncate public.plans, public.plan_revisions, public.tasks, public.task_completions, public.run_logs, public.reviews restart identity cascade"`);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles', locale: 'ko-KR', acceptDownloads: true });
const page = await ctx.newPage();
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`pageerror: ${e.message}`));
const rpcCalls = [];
page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/')) rpcCalls.push({ fn: r.url().split('/rpc/')[1], headers: r.headers() }); });

const text = async (sel) => (await page.textContent(sel)) ?? '';
const ids = async () => page.$$eval('#task-list > li.task', (els) => els.map((e) => Number(e.id.split('-')[1])));
const stat = async (k) => (await text(`#num-${k}`)).trim();
const waitStatus = async (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#status').textContent), re.source, { timeout: 10000 });

// ---------------------------------------------------------------- 첫 화면 공개 안내
await page.goto(BASE);
await page.waitForSelector('#new-plan');
const notice = (await text('#public-notice-text')).trim();
const nbox = await page.locator('#public-notice').boundingBox();
check('C82', '첫 화면 공개 안내 문구(그대로)', notice.includes('지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요') && nbox.y < 60, `${notice} y=${nbox.y}`);

// ---------------------------------------------------------------- 카드 1 계획
await page.fill('#new-plan input[type=text]', 'ALEPH T06 완주');
await page.fill('#new-plan input[type=date] >> nth=0', D(0));
await page.fill('#new-plan input[type=date] >> nth=1', D(6));
await page.selectOption('#new-plan select', '1');
await page.fill('#new-plan textarea', '카드 1~5 통과 기준을 모두 확인하고 제출한다');
await page.fill('#new-plan input[type=number]', '600');
await page.click('#new-plan button[type=submit]');
await page.waitForSelector('#plan-1');
const card = await text('#plan-1');
const dbPlan = JSON.parse(sql('select to_json(p) from public.plans p where id=1'));
check('C04', '계획에 기간 저장', card.includes(`${D(0)}`) && card.includes(`${D(6)}`) && dbPlan.start_date === D(0) && dbPlan.end_date === D(6), card);
check('C05', '계획에 우선순위 저장', card.includes('높음') && dbPlan.priority === 1);
check('C06', '계획에 성공 기준 저장', card.includes('카드 1~5 통과 기준') && dbPlan.success_criteria.startsWith('카드 1~5'));
check('C07', '계획에 예상 시간 저장', card.includes('600분') && dbPlan.estimated_minutes === 600);

await page.click('#plan-1 button:has-text("계획 고치기")');
await page.fill('#plan-edit input[type=date] >> nth=1', D(7));
await page.fill('#plan-edit input[type=number]', '720');
await page.fill('#plan-edit input[placeholder^="예: 카드 5"]', '카드 5가 생각보다 커서 하루 늘림');
await page.click('#plan-edit button[type=submit]');
await waitStatus(/1판 → 2판/);
const hist = await text('details[data-key=history]');
const rev1 = JSON.parse(sql('select to_json(r) from public.plan_revisions r where plan_id=1 and revision=1'));
check('C08', '계획을 고쳐도 고치기 전 계획이 남음(같은 ID, 이력 표)',
  (await text('#plan-1')).includes('2판') && hist.includes('처음 계획') && hist.includes('600분') && hist.includes('이전:')
  && rev1.estimated_minutes === 600 && rev1.end_date === D(6) && sql('select count(*) from public.plans') === '1', hist.slice(0, 200));
await page.locator('#sec-plan').screenshot({ path: `${SHOTS}/10-plan-history.png` });

// ---------------------------------------------------------------- 카드 2 할 일
async function addTask(title, due, pr, tags, est, note = '') {
  const n = await page.locator('#task-list > li.task').count();
  await page.fill('#task-form input[placeholder="할 일 내용"]', title);
  await page.fill('#task-form input[type=date]', due);
  await page.selectOption('#task-form select', String(pr));
  await page.fill('#task-form input[placeholder^="쉼표"]', tags);
  await page.fill('#task-form input[type=number]', String(est));
  await page.fill('#task-form input[placeholder="메모 (선택)"]', note);
  await page.click('#task-form button[type=submit]');
  await page.waitForFunction((k) => document.querySelectorAll('#task-list > li.task').length === k, n + 1);
}
const XSS_TITLE = '<img src=x onerror="window.__xss=1">스크립트 시험';
const XSS_NOTE = '<script>window.__xss=2</script>';
await addTask('카드 1 계획 세우기', D(-2), 1, '카드1, DB', 60);
await addTask('카드 2 할 일 다루기', D(-1), 1, '카드2', 120);
await addTask('카드 3 실행 기록', D(0), 2, '카드3, DB', 90);
await addTask('카드 4 돌아보기', D(1), 1, '카드4', 90);
await addTask('카드 5 내 것으로 채우기', '', 3, '카드5, 제출', 60);
await addTask(XSS_TITLE, D(2), 2, '<b>태그</b>', 30, XSS_NOTE);
const t1 = JSON.parse(sql('select to_json(t) from public.tasks t where id=1'));
check('C09', '할 일 만들기', (await ids()).length === 6 && sql('select count(*) from public.tasks') === '6');
check('C14', '할 일 마감일 저장', t1.due_date === D(-2) && (await text('#task-1')).includes(D(-2)));
check('C15', '할 일 우선순위 저장', t1.priority === 1 && (await text('#task-1')).includes('우선순위 높음'));
check('C16', '할 일 태그 저장', JSON.stringify(t1.tags) === JSON.stringify(['카드1', 'DB']) && (await text('#task-1 .tags')).includes('DB'));
check('C17', '할 일 예상 시간 저장', t1.estimated_minutes === 60 && (await text('#task-1')).includes('예상 60분'));
const xss = await page.evaluate(() => ({ flag: window.__xss, imgs: document.querySelectorAll('#app img').length, scripts: document.querySelectorAll('#app script').length }));
const t6title = await text('#task-6 .task-title .t');
const t6note = await text('#task-6 .note');
check('C57', '스크립트 모양 글자가 실행되지 않고 글자 그대로 보임', xss.flag === undefined && xss.imgs === 0 && xss.scripts === 0 && t6title === XSS_TITLE && t6note === XSS_NOTE, JSON.stringify({ xss, t6title, t6note }));

await page.click('#task-2 button:has-text("고치기")');
await page.fill('#task-edit-2 input[type=text] >> nth=0', '카드 2 할 일 다루기 (검색·정렬)');
await page.fill('#task-edit-2 input[type=number]', '150');
await page.click('#task-edit-2 button[type=submit]');
await waitStatus(/할 일 #2을\(를\) 고쳤습니다/);
const t2 = JSON.parse(sql('select to_json(t) from public.tasks t where id=2'));
check('C10', '할 일 내용 고치기', t2.title === '카드 2 할 일 다루기 (검색·정렬)' && t2.estimated_minutes === 150 && (await text('#task-2')).includes('(검색·정렬)'));

// 정렬 (C20)
const expectSort = {
  due: [1, 2, 3, 4, 6, 5],
  priority: [1, 2, 4, 3, 6, 5],
  estimate: [2, 3, 4, 1, 5, 6],
  created: [6, 5, 4, 3, 2, 1],
};
let sortOk = true; const sortDetail = [];
for (const [k, exp] of Object.entries(expectSort)) {
  await page.selectOption('#task-toolbar select[aria-label="정렬"]', k);
  const got = await ids();
  const rule = await text('#sort-rule');
  sortDetail.push(`${k}:${got.join(',')} rule=${rule.slice(0, 20)}`);
  if (JSON.stringify(got) !== JSON.stringify(exp) || !rule.includes('정렬 기준')) sortOk = false;
}
await page.selectOption('#task-toolbar select[aria-label="정렬"]', 'due');
await page.reload(); await page.waitForSelector('#task-list > li.task');
const afterReload = await ids();
check('C20', '밝혀 둔 기준대로 정렬(값이 같을 때 ID 순, 새로고침해도 같은 순서)', sortOk && JSON.stringify(afterReload) === JSON.stringify(expectSort.due), sortDetail.join(' | ') + ` reload=${afterReload}`);
await page.locator('#sec-tasks').screenshot({ path: `${SHOTS}/11-tasks.png` });

// 검색·거르기 (C18, C19)
await page.fill('#task-toolbar input[type=search]', '카드 3');
const s1 = await ids();
await page.fill('#task-toolbar input[type=search]', 'DB');
const s2 = await ids();
await page.fill('#task-toolbar input[type=search]', '스크립트');
const s3 = await ids();
await page.fill('#task-toolbar input[type=search]', '');
check('C18', '할 일 검색(내용·태그)', JSON.stringify(s1) === '[3]' && JSON.stringify(s2) === '[1,3]' && JSON.stringify(s3) === '[6]', `${s1} ${s2} ${s3}`);
await page.selectOption('#task-toolbar select[aria-label="우선순위"]', '1');
const f1 = await ids();
await page.selectOption('#task-toolbar select[aria-label="우선순위"]', 'all');
await page.selectOption('#task-toolbar select[aria-label="태그"]', '카드5');
const f2 = await ids();
await page.selectOption('#task-toolbar select[aria-label="태그"]', 'all');
await page.selectOption('#task-toolbar select[aria-label="상태"]', 'overdue');
const f3 = await ids();
await page.selectOption('#task-toolbar select[aria-label="상태"]', 'active');
check('C19', '조건으로 걸러 보기(우선순위·태그·지연)', JSON.stringify(f1) === '[1,2,4]' && JSON.stringify(f2) === '[5]' && JSON.stringify(f3) === '[1,2]', `${f1} ${f2} ${f3}`);

// ---------------------------------------------------------------- 카드 3 완료 연타
const doneBefore = Number(await stat('done'));
await page.route('**/rest/v1/rpc/complete_task', async (route) => { await new Promise((r) => setTimeout(r, 700)); await route.continue(); });
const callsBefore = rpcCalls.filter((c) => c.fn === 'complete_task').length;
await page.dblclick('#task-1 .btn.complete');
await waitStatus(/완료/);
await page.waitForFunction(() => document.querySelector('#task-1 .btn.complete.is-done'));
await page.waitForTimeout(1600);
await page.unroute('**/rest/v1/rpc/complete_task');
const sentTwice = rpcCalls.filter((c) => c.fn === 'complete_task').length - callsBefore;
const comp1 = sql('select count(*) from public.task_completions where task_id=1');
const doneAfter = Number(await stat('done'));
const statusMsg = await text('#status');
await page.click('#task-1 details summary');
check('C11', '할 일을 완료로 바꾸기', JSON.parse(sql('select to_json(t) from public.tasks t where id=1')).status === 'done' && (await text('#task-1')).includes('완료됨'));
check('C21', '완료 버튼 연타(요청 2번 전송)해도 완료 기록 1건', sentTwice === 2 && comp1 === '1' && (await text('#task-1 details summary')).includes('완료 기록 1건'), `sent=${sentTwice} rows=${comp1} msg=${statusMsg}`);
check('C22', '돌아보기 완료 수가 정확히 1 늘어남', doneAfter - doneBefore === 1, `${doneBefore} -> ${doneAfter}`);
await page.locator('#task-1').screenshot({ path: `${SHOTS}/12-double-click-task.png` });
fs.writeFileSync(`${SHOTS}/12-double-click-status.txt`, statusMsg);

// 빠른 연타(지연 없음)도 확인
await page.dblclick('#task-3 .btn.complete');
await page.waitForFunction(() => document.querySelector('#task-3 .btn.complete.is-done'));
await page.waitForTimeout(800);
const comp3 = sql('select count(*) from public.task_completions where task_id=3');
// 되돌리기 (C12)
const doneMid = Number(await stat('done'));
await page.click('#task-3 button:has-text("진행 중으로 되돌리기")');
await waitStatus(/되돌렸습니다/);
const t3 = JSON.parse(sql('select to_json(t) from public.tasks t where id=3'));
check('C12', '완료한 할 일을 진행 중으로 되돌리기', comp3 === '1' && t3.status === 'open' && Number(await stat('done')) === doneMid - 1
  && sql('select count(*) from public.task_completions where task_id=3 and reverted_at is null') === '0', `comp3=${comp3} status=${t3.status}`);

// 지우기 (C13)
await addTask('지워 볼 할 일', D(3), 3, '', 10);
const plannedBeforeDel = Number(await stat('planned'));
await page.click('#task-7 button:has-text("지우기")');
await waitStatus(/지웠습니다/);
const alive = await ids();
await page.selectOption('#task-toolbar select[aria-label="상태"]', 'deleted');
const deletedView = await ids();
await page.selectOption('#task-toolbar select[aria-label="상태"]', 'active');
check('C13', '할 일 지우기(목록·집계에서 빠지고 지운 할 일에서 보임)', !alive.includes(7) && JSON.stringify(deletedView) === '[7]'
  && Number(await stat('planned')) === plannedBeforeDel - 1 && sql('select deleted_at is not null from public.tasks where id=7') === 't', `alive=${alive} deleted=${deletedView}`);

// ---------------------------------------------------------------- 실행 기록
async function addLog(taskId, start, end, actual, blocked) {
  const n = await page.locator('#sec-logs ol.logs > li.log').count();
  await page.selectOption('#log-task', String(taskId));
  await page.fill('#log-start', start);
  await page.fill('#log-end', end);
  if (actual !== null) await page.fill('#log-actual', String(actual));
  await page.fill('#log-blocked', blocked);
  await page.click('#log-form button[type=submit]');
  await page.waitForFunction((k) => document.querySelectorAll('#sec-logs > ol.logs > li.log').length === k, n + 1);
  return text('#log-proof');
}
const planBeforeLogs = sql('select to_json(p) from public.plans p where id=1');
const tasksBeforeLogs = sql('select json_agg(json_build_object(\'id\',id,\'est\',estimated_minutes,\'due\',due_date,\'title\',title) order by id) from public.tasks');
const proof1 = await addLog(1, `${D(0)}T09:00`, `${D(0)}T10:30`, 80, '');
const proof2 = await addLog(2, `${D(0)}T11:00`, `${D(0)}T13:30`, null, '정렬 순서가 볼 때마다 달라짐');
const proof3 = await addLog(3, `${D(0)}T14:00`, `${D(0)}T14:45`, null, '');
const logsText = await text('#sec-logs');
const lg1 = JSON.parse(sql('select to_json(r) from public.run_logs r where id=1'));
const lg2 = JSON.parse(sql('select to_json(r) from public.run_logs r where id=2'));
const lg3 = JSON.parse(sql('select to_json(r) from public.run_logs r where id=3'));
check('C23', '실행 기록에 시작 시각 저장(서울 09:00 = UTC 00:00, 화면도 09:00)', lg1.started_at.startsWith(`${D(0)}T00:00:00`) && logsText.includes(`시작 ${D(0)} 09:00`), lg1.started_at);
check('C24', '실행 기록에 끝난 시각 저장', lg1.ended_at.startsWith(`${D(0)}T01:30:00`) && logsText.includes(`끝 ${D(0)} 10:30`), lg1.ended_at);
check('C25', '실행 기록에 실제로 걸린 시간 저장(직접 적은 80분, 자동 150·45분)', lg1.actual_minutes === 80 && lg2.actual_minutes === 150 && lg3.actual_minutes === 45 && logsText.includes('실제 80분'));
check('C26', '실행 기록에 막혔던 이유 저장', lg2.blocked_reason === '정렬 순서가 볼 때마다 달라짐' && logsText.includes('막힌 이유: 정렬 순서가 볼 때마다 달라짐') && lg1.blocked_reason === null);
check('C27', '실행 기록을 저장해도 원래 계획 값은 그대로', planBeforeLogs === sql('select to_json(p) from public.plans p where id=1')
  && tasksBeforeLogs === sql('select json_agg(json_build_object(\'id\',id,\'est\',estimated_minutes,\'due\',due_date,\'title\',title) order by id) from public.tasks')
  && [proof1, proof2, proof3].every((p) => (p.match(/그대로/g) || []).length === 3), proof3);
await page.locator('#sec-logs').screenshot({ path: `${SHOTS}/13-logs.png` });

// ---------------------------------------------------------------- 카드 4 돌아보기
await page.reload(); await page.waitForSelector('#stats');
const ind = JSON.parse(sql(`with base as (select * from public.tasks where plan_id=1 and deleted_at is null),
 lg as (select r.* from public.run_logs r join base b on b.id=r.task_id where r.deleted_at is null)
 select json_build_object('planned',(select count(*) from base),'done',(select count(*) from base where status='done'),
 'overdue',(select count(*) from base where status<>'done' and due_date < (now() at time zone 'Asia/Seoul')::date),
 'blocked',(select count(distinct b.id) from base b join lg on lg.task_id=b.id where coalesce(btrim(lg.blocked_reason),'')<>''),
 'est',(select coalesce(sum(estimated_minutes),0) from base),'act',(select coalesce(sum(actual_minutes),0) from lg))`));
const ui = { planned: await stat('planned'), done: await stat('done'), overdue: await stat('overdue'), blocked: await stat('blocked'), est: await stat('estimated'), act: await stat('actual'), diff: await stat('diff') };
check('C28', '계획 수 = 지우지 않은 할 일 수', ui.planned === String(ind.planned) && ind.planned === 6, JSON.stringify({ ui, ind }));
check('C29', '완료 수 = 지금 완료 상태 할 일 수', ui.done === String(ind.done) && ind.done === 1, JSON.stringify({ ui, ind }));
check('C30', '지연 수 = 미완료 & 마감<오늘(서울), 완료한 할 일은 안 셈', ui.overdue === String(ind.overdue) && ind.overdue === 1, JSON.stringify({ ui, ind }));
check('C31', '막힘 수 = 막힌 이유가 적힌 할 일 수', ui.blocked === String(ind.blocked) && ind.blocked === 1, JSON.stringify({ ui, ind }));
check('C32', '예상=예상 합계, 실제=기록 합계, 차이=실제-예상', ui.est === `${ind.est}분` && ui.act === `${ind.act}분` && ui.diff === `${ind.act - ind.est > 0 ? '+' : ''}${ind.act - ind.est}분` && ind.est === 480 && ind.act === 275, JSON.stringify({ ui, ind }));
check('C81', '돌아보기가 자료로 채워지고 숫자가 모두 0은 아님', Object.values(ui).some((v) => !/^[+]?0분?$/.test(v)), JSON.stringify(ui));

// 드릴다운 (C83)
await page.click('#stat-overdue');
await page.waitForSelector('#drill');
const drillOverdue = await text('#drill');
await page.click('#drill a[href*="focus=task-2"]');
await page.waitForFunction(() => document.querySelector('#task-2')?.classList.contains('flash'));
await page.waitForTimeout(900);
const inView = await page.evaluate(() => { const r = document.querySelector('#task-2').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
await page.click('#stat-actual');
await page.waitForSelector('#drill');
const drillActual = await text('#drill');
const logLinks = await page.$$eval('#drill .drill-list a', (as) => as.map((a) => a.textContent));
await page.locator('#sec-review').screenshot({ path: `${SHOTS}/14-review-drill.png` });
await page.click('#stat-planned');
const plannedItems = await page.$$eval('#drill .drill-list > li', (els) => els.length);
await page.click('#stat-blocked');
const drillBlocked = await text('#drill');
check('C83', '집계 숫자를 눌러 근거 기록으로 이동', drillOverdue.includes('할 일 #2') && drillOverdue.includes('목록 1건 = 위 숫자 1') && inView
  && logLinks.length === 3 && drillActual.includes('275분 = 위 숫자 275분') && plannedItems === 6 && drillBlocked.includes('정렬 순서가 볼 때마다 달라짐'),
  JSON.stringify({ inView, logLinks, plannedItems }));

// 돌아보기 저장 → 다음 계획으로 (C33)
await page.fill('#review-form textarea', '정렬과 중복 방지에서 예상보다 오래 걸렸다.');
await page.fill('#review-form input[type=text]', 'DB 작업은 예상 시간을 1.5배로 잡는다');
await page.click('#review-form button[type=submit]');
await page.waitForSelector('#review-1');
const reviewText = await text('#review-1');
await page.click('#review-1 button:has-text("다음 계획으로 넘기기")');
await page.waitForSelector('#new-plan .carried');
await page.fill('#new-plan input[type=text]', 'T07 다이어리2 — 로그인 붙이기');
await page.fill('#new-plan textarea', '로그인한 사람만 자기 자료를 보고 고칠 수 있다');
await page.fill('#new-plan input[type=number]', '900');
await page.click('#new-plan button[type=submit]');
await page.waitForSelector('#carried-fix');
const carried = await text('#carried-fix');
await page.locator('#sec-plan').screenshot({ path: `${SHOTS}/15-carried.png` });
await page.goto(`${BASE}#plan=1&focus=review-1`);
await page.waitForSelector('#review-1');
const reviewAfter = await text('#review-1');
check('C33', '돌아보기의 고칠 점 한 건이 다음 계획으로 넘어감', reviewText.includes('저장 시점 숫자 — 계획 6') && carried.includes('DB 작업은 예상 시간을 1.5배로 잡는다')
  && reviewAfter.includes('계획 #2') && sql('select carried_from_review_id from public.plans where id=2') === '1', carried);

// ---------------------------------------------------------------- 카드 5
// 내보내기 (C36)
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
const dlPath = `${SCR}/export-test.json`;
await dl.saveAs(dlPath);
const ex = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
check('C36', '내 자료 전체를 파일 하나로 내보내기', dl.suggestedFilename().endsWith('KST.json') && ex.schema === 'pds-schema-v2' && ex.plans.length === 2 && ex.tasks.length === 7
  && ex.run_logs.length === 3 && ex.reviews.length === 1 && ex.plan_revisions.length === 1 && ex.task_completions.length >= 2,
  `${dl.suggestedFilename()} plans=${ex.plans.length} tasks=${ex.tasks.length}`);

// 새로고침 복원 (C35)
await page.goto(`${BASE}#plan=1`);
await page.waitForSelector('#stats');
const snap = async () => ({
  plan: await text('#plan-1'), tasks: await text('#task-list'), logs: await text('#sec-logs > ol.logs'),
  stats: await text('#stats'), history: await text('details[data-key=history] ol'),
});
const s1snap = await snap();
await page.reload(); await page.waitForSelector('#stats');
const s2snap = await snap();
check('C35', '새로고침 뒤 ID·날짜·값·단위가 같은 값으로 복원', JSON.stringify(s1snap) === JSON.stringify(s2snap) && s1snap.tasks.includes('#1') && s1snap.logs.includes(`${D(0)} 09:00`) && s1snap.stats.includes('분'));
check('C34', '계획·할 일·실행 기록·돌아보기가 서버 DB에 저장', ['plans', 'tasks', 'run_logs', 'reviews', 'plan_revisions', 'task_completions'].every((t) => Number(sql(`select count(*) from public.${t}`)) > 0)
  && rpcCalls.every((c) => c.fn) && rpcCalls.length > 20);
check('C78', '실제 계획 1개 이상(시험 자료 기준)', Number(sql('select count(*) from public.plans')) >= 1);
check('C79', '계획에 딸린 할 일 5개 이상(시험 자료 기준)', Number(sql('select count(*) from public.tasks where plan_id=1 and deleted_at is null')) >= 5);
check('C80', '실행 기록 3개 이상(시험 자료 기준)', Number(sql('select count(*) from public.run_logs where deleted_at is null')) >= 3);

// 비밀값 (C58)
const files = execSync(`cd ${REPO} && find . -type f -not -path './.git/*' -not -path './checks/out/*' -not -path '*/node_modules/*'`).toString().split('\n').filter(Boolean);
const leaks = [];
for (const f of files) {
  const c = fs.readFileSync(`${REPO}/${f}`, 'utf8');
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(c)) leaks.push(`${f}: sb_secret_`);
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(c)) leaks.push(`${f}: JWT`);
}
const authHeaders = rpcCalls.filter((c) => c.headers.authorization);
const keyInConsole = consoleMsgs.filter((m) => /sb_publishable|sb_secret|eyJ/.test(m));
check('C58', '코드·배포 파일·요청·콘솔 어디에도 비밀키 원문 없음', leaks.length === 0 && authHeaders.length === 0 && keyInConsole.length === 0
  && rpcCalls.every((c) => c.headers.apikey && c.headers.apikey.startsWith('sb_publishable_')), JSON.stringify({ leaks, auth: authHeaders.length, keyInConsole }));

// 오류 없음
const errs = consoleMsgs.filter((m) => /^(error|pageerror)/.test(m));
check('ERR', '콘솔 오류 없음', errs.length === 0, errs.join(' | '));
await page.screenshot({ path: `${SHOTS}/17-desktop-full.png`, fullPage: true });

// 좁은 화면
const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'ko-KR', deviceScaleFactor: 1 });
const mp = await mob.newPage();
await mp.goto(`${BASE}#plan=1`);
await mp.waitForSelector('#stats');
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth);
await mp.screenshot({ path: `${SHOTS}/16-mobile.png`, fullPage: true });
check('MOBILE', '폭 390px에서 가로 스크롤 없음', overflow <= 0, `overflow=${overflow}`);

await browser.close();
const passed = results.filter((r) => r.pass).length;
fs.writeFileSync(`${SCR}/e2e-results.json`, JSON.stringify({ at: new Date().toISOString(), kstToday, passed, total: results.length, results }, null, 2));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
