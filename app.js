/* 플랜두씨 다이어리 1 (ALEPH T06)
 * - 모든 자료는 서버 DB(Supabase)의 함수(RPC)를 통해서만 읽고 씁니다.
 * - 사용자가 넣은 글자는 전부 textContent로만 화면에 넣습니다(innerHTML 사용 안 함).
 * - 날짜·시각은 브라우저 시간대와 상관없이 서울 시간(Asia/Seoul)으로 보여 주고 받습니다.
 */
'use strict';

(function () {
  // ------------------------------------------------------------------ 설정
  const CFG = window.PDS_CONFIG || {};
  const API_URL = String(CFG.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const API_KEY = String(CFG.SUPABASE_PUBLISHABLE_KEY || '').trim();
  const TZ = 'Asia/Seoul';
  const PRIORITY = { 1: '높음', 2: '보통', 3: '낮음' };

  // ------------------------------------------------------------------ 상태
  const state = {
    plans: [],
    planId: null,
    bundle: null,
    filters: { q: '', status: 'active', priority: 'all', tag: 'all', sort: 'due' },
    drill: null,
    editingPlan: false,
    editingTaskId: null,
    newPlan: null,          // null | { carriedReview: {...} | null, first: boolean }
    keys: {},               // 같은 요청을 알아보는 키 (완료·저장 버튼마다)
    open: new Set(['history', 'insight']),
    logProof: null,
    logTaskId: null,
    loadError: null,
  };

  // ------------------------------------------------------------------ DOM 도우미
  const $ = (sel) => document.querySelector(sel);

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    let value;
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        else if (k === 'value') value = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on')) {
          if (typeof v === 'function') node.addEventListener(k.slice(2), v);
        } else if (typeof v === 'boolean') node[k] = v;
        else node.setAttribute(k, String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    if (value !== undefined) node.value = String(value);
    return node;
  }

  function options(list, selected) {
    return list.map(([v, label]) => h('option', { value: v, selected: String(v) === String(selected) }, label));
  }

  function field(label, control, hint) {
    const hintNode = hint instanceof Node ? hint : (hint ? h('span', { class: 'field-hint' }, hint) : null);
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hintNode);
  }

  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }
  const keyFor = (scope) => (state.keys[scope] ||= newKey());
  const dropKey = (scope) => { delete state.keys[scope]; };

  // ------------------------------------------------------------------ 시간·숫자 표시
  const DTF = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

  function kstParts(date) {
    const p = {};
    for (const part of DTF.formatToParts(date)) p[part.type] = part.value;
    return p;
  }
  function fmtTs(iso) {
    if (!iso) return '—';
    const p = kstParts(new Date(iso));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }
  function weekday(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }
  function fmtDate(ymd) { return ymd ? `${ymd} (${weekday(ymd)})` : '없음'; }
  function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function dayCount(a, b) {
    const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((t(b) - t(a)) / 86400000) + 1;
  }
  function kstToday() { const p = kstParts(new Date()); return `${p.year}-${p.month}-${p.day}`; }
  function kstInputFromDate(date) {
    const p = kstParts(date);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  // datetime-local 값("YYYY-MM-DDTHH:mm")은 브라우저 시간대가 아니라 서울 시간으로 해석합니다.
  function inputToIso(v) {
    if (!v) return null;
    return v.length === 16 ? `${v}:00+09:00` : `${v}+09:00`;
  }
  function inputSpanMinutes(a, b) {
    if (!a || !b) return null;
    const ms = Date.parse(inputToIso(b)) - Date.parse(inputToIso(a));
    return Number.isFinite(ms) ? Math.round(ms / 60000) : null;
  }
  function fmtMin(n) {
    n = Number(n) || 0;
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a < 60) return `${sign}${a}분`;
    const hr = Math.floor(a / 60), mi = a % 60;
    return `${sign}${a}분 (${hr}시간${mi ? ` ${mi}분` : ''})`;
  }
  function fmtDiff(n) { n = Number(n) || 0; return n > 0 ? `+${fmtMin(n)}` : fmtMin(n); }
  function hm(n) {
    const a = Math.abs(Number(n) || 0);
    if (a < 60) return '';
    const hr = Math.floor(a / 60), mi = a % 60;
    return `${hr}시간${mi ? ` ${mi}분` : ''}`;
  }

  // ------------------------------------------------------------------ 서버 호출
  class ApiError extends Error {
    constructor(message, info) { super(message); this.name = 'ApiError'; Object.assign(this, info || {}); }
  }

  const FRIENDLY = [
    [/plans_carried_from_review_id_key|carried_from_review/, '이 고칠 점은 이미 다른 계획으로 넘어갔습니다.'],
    [/Could not find the function|PGRST202/, 'DB 함수를 찾지 못했습니다. supabase/schema.sql을 SQL Editor에서 실행했는지 확인하세요.'],
    [/permission denied/, '권한이 없습니다. supabase/schema.sql을 다시 실행해 권한을 확인하세요.'],
    [/Invalid API key|No API key|apikey/i, 'API 키가 맞지 않습니다. config.js의 Publishable key를 확인하세요.'],
    [/run_logs_actual/, '실제로 걸린 시간이 시작~끝 사이보다 길 수 없습니다.'],
    [/tasks_tags/, '태그는 10개까지, 하나에 20자까지 넣을 수 있습니다.'],
  ];
  function friendly(message) {
    for (const [re, text] of FRIENDLY) if (re.test(message)) return text;
    return message;
  }

  function keyProblem() {
    if (!API_URL || !API_KEY || /YOUR[-_]/.test(API_URL + API_KEY)) return 'missing';
    if (/^sb_secret_/.test(API_KEY)) return 'secret';
    if (API_KEY.startsWith('eyJ')) {
      try {
        const payload = JSON.parse(atob(API_KEY.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.role && payload.role !== 'anon') return 'secret';
      } catch (e) { return 'missing'; }
    }
    return null;
  }

  async function rpc(fn, args) {
    const headers = { 'Content-Type': 'application/json', apikey: API_KEY };
    // 예전 방식 anon 키(JWT)일 때만 Authorization에도 넣습니다. 새 publishable 키는 apikey 헤더에만 넣습니다.
    if (API_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${API_KEY}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(`${API_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers, body: JSON.stringify(args || {}), signal: ctrl.signal, cache: 'no-store',
      });
    } catch (e) {
      throw new ApiError(e.name === 'AbortError'
        ? '서버가 15초 넘게 답하지 않습니다.'
        : '서버에 연결하지 못했습니다. 인터넷 연결을 확인하거나, 무료 프로젝트가 일시정지되지 않았는지 확인하세요.', { network: true });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok) {
      const raw = (data && (data.message || data.msg || data.error)) || `서버 오류 (HTTP ${res.status})`;
      const extra = res.status >= 500 ? ' (무료 프로젝트가 일시정지되었을 수 있습니다.)' : '';
      throw new ApiError(friendly(String(raw)) + extra, { status: res.status, code: data && data.code });
    }
    return data;
  }

  // ------------------------------------------------------------------ 상태 표시줄
  let statusTimer = null;
  function say(message, kind = 'ok', action = null) {
    const box = $('#status');
    clearTimeout(statusTimer);
    box.className = `status show ${kind}`;
    box.replaceChildren(...[h('span', null, message), action].filter(Boolean));
    if (kind === 'ok') statusTimer = setTimeout(() => { box.className = 'status'; box.replaceChildren(); }, 9000);
  }
  function sayError(err) { say(err && err.message ? err.message : String(err), 'error'); }

  async function guarded(button, work) {
    if (button) button.disabled = true;
    try { return await work(); } catch (err) { sayError(err); return null; } finally { if (button && button.isConnected) button.disabled = false; }
  }

  // ------------------------------------------------------------------ 주소(#) 다루기
  function parseHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { plan: Number(p.get('plan')) || null, drill: p.get('drill'), focus: p.get('focus') };
  }
  function writeHash(obj, push) {
    const p = new URLSearchParams();
    if (obj.plan) p.set('plan', obj.plan);
    if (obj.drill) p.set('drill', obj.drill);
    if (obj.focus) p.set('focus', obj.focus);
    const next = `#${p.toString()}`;
    if (location.hash === next) return;
    if (push) history.pushState(null, '', next); else history.replaceState(null, '', next);
  }

  // ------------------------------------------------------------------ 불러오기
  async function loadPlans() {
    state.plans = await rpc('list_plans');
    renderPlanSelect();
  }
  async function loadBundle(planId) {
    state.bundle = await rpc('get_plan_bundle', { p_plan_id: planId });
    state.planId = planId;
  }
  // 저장 뒤 다시 읽기. 여러 번 겹쳐 불려도 가장 나중에 시작한 읽기 결과만 화면에 씁니다.
  let refreshSeq = 0;
  async function refresh() {
    const mine = ++refreshSeq;
    const plans = await rpc('list_plans');
    const bundle = state.planId ? await rpc('get_plan_bundle', { p_plan_id: state.planId }) : null;
    if (mine !== refreshSeq) return;
    state.plans = plans;
    state.bundle = bundle;
    render();
  }

  async function applyHash({ initial = false } = {}) {
    const want = parseHash();
    try {
      if (initial || !state.plans.length) await loadPlans();
      if (!state.plans.length) {
        state.bundle = null; state.planId = null;
        state.newPlan = { carriedReview: null, first: true };
        render();
        return;
      }
      const exists = state.plans.some((p) => p.id === want.plan);
      const target = exists ? want.plan : state.plans[0].id;
      if (target !== state.planId || !state.bundle || initial) {
        await loadBundle(target);
        state.editingPlan = false; state.editingTaskId = null; state.logTaskId = null; state.logProof = null;
      }
      state.drill = DRILL[want.drill] ? want.drill : null;
      if (!exists) writeHash({ plan: target, drill: state.drill }, false);
      render();
      if (want.focus) focusRecord(want.focus);
      else if (want.drill && !initial) scrollToId('drill');
    } catch (err) {
      state.loadError = err;
      renderLoadError(err);
    }
  }

  function scrollToId(id) {
    const node = document.getElementById(id);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function focusRecord(ref) {
    const b = state.bundle;
    if (!b) return;
    const [kind, idStr] = String(ref).split('-');
    const id = Number(idStr);
    if (kind === 'task') {
      const t = b.tasks.find((x) => x.id === id);
      if (!t) return;
      state.filters = { q: '', status: t.deleted_at ? 'deleted' : 'active', priority: 'all', tag: 'all', sort: state.filters.sort };
      render();
    } else if (kind === 'log') {
      const lg = b.run_logs.find((x) => x.id === id);
      if (lg && lg.deleted_at) { state.open.add('cancelled-logs'); render(); }
    } else if (kind === 'review') {
      render();
    }
    const node = document.getElementById(`${kind}-${id}`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  // ------------------------------------------------------------------ 그리기: 전체
  function render() {
    const app = $('#app');
    const b = state.bundle;
    app.replaceChildren(...[
      state.newPlan ? renderNewPlanForm() : null,
      b ? renderPlanSection(b) : null,
      b ? renderTaskSection(b) : null,
      b ? renderLogSection(b) : null,
      b ? renderReviewSection(b) : null,
    ].filter(Boolean));
    renderTaskList();
    renderPlanSelect();
    $('#btn-export').disabled = !state.plans.length;
  }

  function renderPlanSelect() {
    const sel = $('#plan-select');
    if (!state.plans.length) {
      sel.replaceChildren(h('option', null, '아직 계획이 없습니다'));
      sel.disabled = true;
      return;
    }
    sel.replaceChildren(...state.plans.map((p) => h('option', { value: p.id, selected: p.id === state.planId },
      `#${p.id} ${p.title} (${p.start_date.slice(5)}~${p.end_date.slice(5)})`)));
    sel.disabled = false;
  }

  function renderLoadError(err) {
    $('#app').replaceChildren(h('div', { class: 'error-box' },
      h('h2', null, '자료를 불러오지 못했습니다'),
      h('p', null, err.message || String(err)),
      h('p', { class: 'muted' }, '잠시 뒤 새로고침해 보세요. 계속 안 되면 Supabase 프로젝트가 일시정지되지 않았는지(대시보드 → Resume) 확인하세요.'),
      h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, '새로고침')));
    renderPlanSelect();
  }

  function renderSetupNeeded(kind) {
    const secret = kind === 'secret';
    $('#app').replaceChildren(h('div', { class: 'error-box' },
      h('h2', null, secret ? '비밀키가 들어 있어 멈췄습니다' : 'Supabase 연결 설정이 필요합니다'),
      secret
        ? h('p', null, 'config.js에 비밀키(secret / service_role)가 들어 있습니다. 곧바로 Supabase에서 그 키를 새로 발급(교체)하고, config.js에는 Publishable key만 넣으세요.')
        : h('p', null, 'config.js에 Supabase의 Project URL과 Publishable key(sb_publishable_…)를 넣어 주세요.'),
      h('p', { class: 'muted' }, '자세한 순서는 저장소의 README.md에 있습니다.')));
    $('#plan-select').replaceChildren(h('option', null, '연결 안 됨'));
    $('#btn-export').disabled = true;
    $('#btn-new-plan').disabled = true;
  }

  // ------------------------------------------------------------------ 1. 계획
  const PLAN_FIELDS = [
    ['title', '계획 이름', (v) => v],
    ['start_date', '시작일', fmtDate],
    ['end_date', '끝일', fmtDate],
    ['priority', '우선순위', (v) => PRIORITY[v]],
    ['success_criteria', '성공 기준', (v) => v],
    ['estimated_minutes', '예상 시간', fmtMin],
  ];

  function renderPlanSection(b) {
    const p = b.plan;
    return h('section', { id: 'sec-plan', class: 'sec' },
      h('h2', { class: 'sec-title' }, h('span', { class: 'step-no' }, '1'), '계획', h('small', null, 'Plan')),
      b.carried_review ? renderCarriedBox(b.carried_review) : null,
      state.editingPlan ? renderPlanEditForm(p) : renderPlanCard(p),
      renderPlanHistory(b));
  }

  function renderCarriedBox(cr) {
    return h('div', { class: 'carried', id: 'carried-fix' },
      h('div', { class: 'carried-label' }, '지난 돌아보기에서 넘어온 고칠 점'),
      h('p', { class: 'carried-text' }, cr.next_fix),
      h('p', { class: 'small muted' },
        `계획 #${cr.plan_id} 「${cr.plan_title}」의 돌아보기 #${cr.id} · ${fmtTs(cr.created_at)} · `,
        h('a', { href: `#plan=${cr.plan_id}&focus=review-${cr.id}` }, '원래 돌아보기로 가기')));
  }

  function renderPlanCard(p) {
    return h('article', { class: 'card plan-card', id: `plan-${p.id}` },
      h('div', { class: 'card-head' },
        h('span', { class: 'rid' }, `계획 #${p.id}`),
        h('h3', { class: 'plan-title' }, p.title),
        h('span', { class: 'badge' }, `${p.revision}판`)),
      h('dl', { class: 'kv' },
        h('dt', null, '기간'), h('dd', null, `${fmtDate(p.start_date)} ~ ${fmtDate(p.end_date)} · ${dayCount(p.start_date, p.end_date)}일`),
        h('dt', null, '우선순위'), h('dd', null, PRIORITY[p.priority]),
        h('dt', null, '성공 기준'), h('dd', { class: 'pre' }, p.success_criteria),
        h('dt', null, '예상 시간'), h('dd', null, fmtMin(p.estimated_minutes)),
        h('dt', null, '저장 기록'), h('dd', { class: 'small muted' },
          `처음 만든 때 ${fmtTs(p.created_at)} · 마지막으로 고친 때 ${fmtTs(p.updated_at)}`)),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => { state.editingPlan = true; render(); scrollToId('plan-edit'); } }, '계획 고치기')));
  }

  function renderPlanEditForm(p) {
    const f = {
      title: h('input', { type: 'text', required: true, maxlength: 120, value: p.title }),
      start: h('input', { type: 'date', required: true, value: p.start_date }),
      end: h('input', { type: 'date', required: true, value: p.end_date }),
      priority: h('select', null, options([[1, '높음'], [2, '보통'], [3, '낮음']], p.priority)),
      criteria: h('textarea', { required: true, maxlength: 500, rows: 3, value: p.success_criteria }),
      est: h('input', { type: 'number', required: true, min: 1, max: 100000, step: 1, value: p.estimated_minutes }),
      reason: h('input', { type: 'text', maxlength: 300, placeholder: '예: 카드 5가 생각보다 커서 하루 늘림' }),
    };
    const submit = h('button', { type: 'submit', class: 'btn primary' }, `저장 (${p.revision}판 → ${p.revision + 1}판)`);
    return h('form', {
      class: 'card form', id: 'plan-edit',
      onsubmit: (e) => {
        e.preventDefault();
        guarded(submit, async () => {
          const res = await rpc('update_plan', {
            p_id: p.id, p_expected_revision: p.revision,
            p_title: f.title.value, p_success_criteria: f.criteria.value,
            p_start_date: f.start.value || null, p_end_date: f.end.value || null,
            p_priority: Number(f.priority.value), p_estimated_minutes: toInt(f.est.value),
            p_change_reason: f.reason.value || null,
          });
          state.editingPlan = false;
          state.open.add('history');
          await refresh();
          say(res.revision > p.revision
            ? `계획 #${p.id}을(를) 고쳤습니다: ${p.revision}판 → ${res.revision}판. 고치기 전 내용은 아래 수정 이력에 그대로 남았습니다.`
            : '바뀐 내용이 없어 판 번호는 그대로입니다.');
        });
      },
    },
    h('h3', null, `계획 #${p.id} 고치기`),
    h('p', { class: 'small muted' }, '계획 ID는 그대로 두고 내용만 바뀝니다. 고치기 전 내용은 수정 이력에 남습니다.'),
    h('div', { class: 'grid' },
      field('계획 이름', f.title),
      field('시작일', f.start), field('끝일', f.end),
      field('우선순위', f.priority), field('예상 시간 (분)', f.est),
      h('div', { class: 'span-all' }, field('성공 기준', f.criteria)),
      h('div', { class: 'span-all' }, field('고친 이유 (선택)', f.reason))),
    h('div', { class: 'actions' }, submit,
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { state.editingPlan = false; render(); } }, '취소')));
  }

  function renderPlanHistory(b) {
    const versions = [
      ...b.revisions.map((r) => ({ ...r, current: false })),
      { ...b.plan, current: true, valid_from: b.plan.updated_at, replaced_at: null, change_reason: null },
    ];
    const items = versions.map((v, i) => {
      const prev = i > 0 ? versions[i - 1] : null;
      const reason = prev ? prev.change_reason : null;
      return h('li', { class: `version${v.current ? ' current' : ''}`, id: `rev-${v.revision}` },
        h('div', { class: 'version-head' },
          h('b', null, `${v.revision}판`),
          i === 0 ? h('span', { class: 'badge' }, '처음 계획') : null,
          v.current ? h('span', { class: 'badge solid' }, '지금') : null,
          h('span', { class: 'small muted' },
            v.current ? `${fmtTs(v.valid_from)}부터` : `${fmtTs(v.valid_from)} ~ ${fmtTs(v.replaced_at)}`)),
        reason ? h('p', { class: 'small' }, `고친 이유: ${reason}`) : null,
        h('dl', { class: 'kv compact' }, PLAN_FIELDS.map(([key, label, fmt]) => {
          const changed = prev && String(prev[key]) !== String(v[key]);
          return [
            h('dt', null, label),
            h('dd', { class: changed ? 'changed' : null },
              fmt(v[key]),
              changed ? h('span', { class: 'was' }, ` (이전: ${fmt(prev[key])})`) : null),
          ];
        })));
    });
    return detailsBlock('history', `수정 이력 — ${versions.length}판 (고친 횟수 ${b.revisions.length}번)`,
      h('ol', { class: 'versions' }, items),
      b.revisions.length ? null : h('p', { class: 'small muted' }, '아직 고친 적이 없습니다. 계획을 고치면 고치기 전 판이 여기에 쌓입니다.'));
  }

  function detailsBlock(key, summary, ...body) {
    const d = h('details', { class: 'block', open: state.open.has(key), dataset: { key } },
      h('summary', null, summary), ...body);
    d.addEventListener('toggle', () => { if (d.open) state.open.add(key); else state.open.delete(key); });
    return d;
  }

  function renderNewPlanForm() {
    const np = state.newPlan;
    const today = kstToday();
    const f = {
      title: h('input', { type: 'text', required: true, maxlength: 120, placeholder: '예: ALEPH T06 완주' }),
      start: h('input', { type: 'date', required: true, value: today }),
      end: h('input', { type: 'date', required: true, value: addDays(today, 6) }),
      priority: h('select', null, options([[1, '높음'], [2, '보통'], [3, '낮음']], 2)),
      criteria: h('textarea', { required: true, maxlength: 500, rows: 3, placeholder: '무엇이 되면 성공인지 (예: 카드 1~5 통과 기준을 모두 확인하고 제출)' }),
      est: h('input', { type: 'number', required: true, min: 1, max: 100000, step: 1, placeholder: '예: 600' }),
    };
    const cr = np.carriedReview;
    const submit = h('button', { type: 'submit', class: 'btn primary' }, cr ? '고칠 점을 넘겨받아 계획 만들기' : '계획 만들기');
    return h('form', {
      class: 'card form new-plan', id: 'new-plan',
      onsubmit: (e) => {
        e.preventDefault();
        guarded(submit, async () => {
          const res = await rpc('create_plan', {
            p_title: f.title.value, p_success_criteria: f.criteria.value,
            p_start_date: f.start.value || null, p_end_date: f.end.value || null,
            p_priority: Number(f.priority.value), p_estimated_minutes: toInt(f.est.value),
            p_carried_from_review_id: cr ? cr.id : null, p_request_key: keyFor('new-plan'),
          });
          dropKey('new-plan');
          state.newPlan = null;
          writeHash({ plan: res.id }, true);
          await loadPlans();
          await loadBundle(res.id);
          render();
          scrollToId('sec-plan');
          say(cr ? `새 계획 #${res.id}을(를) 만들고, 돌아보기 #${cr.id}의 고칠 점을 넘겨받았습니다.` : `계획 #${res.id}을(를) 만들었습니다.`);
        });
      },
    },
    h('h2', { class: 'sec-title' }, np.first ? '첫 계획 만들기' : '새 계획 만들기'),
    np.first ? h('p', { class: 'muted' }, '지금 실제로 하고 있는 일 하나를 골라 계획으로 옮깁니다. 남의 예시가 아니라 내 계획을 넣습니다.') : null,
    cr ? h('div', { class: 'carried' },
      h('div', { class: 'carried-label' }, '넘겨받는 고칠 점'),
      h('p', { class: 'carried-text' }, cr.next_fix),
      h('p', { class: 'small muted' }, `계획 #${cr.plan_id}의 돌아보기 #${cr.id}`)) : null,
    h('div', { class: 'grid' },
      h('div', { class: 'span-all' }, field('계획 이름', f.title)),
      field('시작일', f.start), field('끝일', f.end),
      field('우선순위', f.priority), field('예상 시간 (분)', f.est, '계획 전체에 들 것으로 보는 시간'),
      h('div', { class: 'span-all' }, field('성공 기준', f.criteria))),
    h('div', { class: 'actions' }, submit,
      np.first ? null : h('button', { type: 'button', class: 'btn ghost', onclick: () => { state.newPlan = null; render(); } }, '취소')));
  }

  function toInt(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  // ------------------------------------------------------------------ 2. 할 일
  const STATUS_FILTERS = [
    ['active', '전체 (지운 할 일 제외)'],
    ['open', '진행 중'],
    ['done', '완료'],
    ['overdue', '지연'],
    ['blocked', '막힘'],
    ['deleted', '지운 할 일'],
  ];
  const cmpDue = (a, b) => {
    if (a.due_date === b.due_date) return 0;
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  };
  const SORTS = {
    due: {
      label: '마감일 빠른 순',
      rule: '마감일 빠른 순 → 마감일이 같으면 우선순위 높은 순 → 그것도 같으면 할 일 ID 작은 순. 마감일 없는 할 일은 맨 뒤.',
      cmp: (a, b) => cmpDue(a, b) || a.priority - b.priority || a.id - b.id,
    },
    priority: {
      label: '우선순위 높은 순',
      rule: '우선순위 높은 순 → 같으면 마감일 빠른 순(마감일 없으면 뒤) → 그것도 같으면 할 일 ID 작은 순.',
      cmp: (a, b) => a.priority - b.priority || cmpDue(a, b) || a.id - b.id,
    },
    estimate: {
      label: '예상 시간 긴 순',
      rule: '예상 시간 긴 순 → 같으면 마감일 빠른 순(마감일 없으면 뒤) → 그것도 같으면 할 일 ID 작은 순.',
      cmp: (a, b) => b.estimated_minutes - a.estimated_minutes || cmpDue(a, b) || a.id - b.id,
    },
    created: {
      label: '최근 만든 순',
      rule: '할 일 ID 큰 순(ID는 만든 순서대로 붙으므로 최근에 만든 것이 위).',
      cmp: (a, b) => b.id - a.id,
    },
  };

  function matchesFilters(t, f) {
    if (f.status === 'deleted') { if (!t.deleted_at) return false; }
    else {
      if (t.deleted_at) return false;
      if (f.status === 'open' && t.status !== 'open') return false;
      if (f.status === 'done' && t.status !== 'done') return false;
      if (f.status === 'overdue' && !t.is_overdue) return false;
      if (f.status === 'blocked' && !t.is_blocked) return false;
    }
    if (f.priority !== 'all' && String(t.priority) !== String(f.priority)) return false;
    if (f.tag !== 'all' && !(t.tags || []).includes(f.tag)) return false;
    const q = f.q.trim().toLowerCase();
    if (q) {
      const hay = [t.title, t.note || '', ...(t.tags || []), `#${t.id}`].join('\n').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderTaskSection(b) {
    const plan = b.plan;
    const f = {
      title: h('input', { type: 'text', required: true, maxlength: 200, placeholder: '할 일 내용' }),
      due: h('input', { type: 'date', value: plan.end_date }),
      priority: h('select', null, options([[1, '높음'], [2, '보통'], [3, '낮음']], 2)),
      tags: h('input', { type: 'text', maxlength: 230, placeholder: '쉼표로 구분 (예: 카드3, DB)' }),
      est: h('input', { type: 'number', required: true, min: 0, max: 100000, step: 1, placeholder: '예: 90' }),
      note: h('input', { type: 'text', maxlength: 2000, placeholder: '메모 (선택)' }),
    };
    const submit = h('button', { type: 'submit', class: 'btn primary' }, '할 일 추가');
    const form = h('form', {
      class: 'card form', id: 'task-form',
      onsubmit: (e) => {
        e.preventDefault();
        guarded(submit, async () => {
          const res = await rpc('create_task', {
            p_plan_id: plan.id, p_title: f.title.value, p_note: f.note.value || null,
            p_due_date: f.due.value || null, p_priority: Number(f.priority.value),
            p_tags: splitTags(f.tags.value), p_estimated_minutes: toInt(f.est.value),
            p_request_key: keyFor('task-form'),
          });
          dropKey('task-form');
          await refresh();
          say(`할 일 #${res.id}을(를) 만들었습니다.`);
          const again = $('#task-form input');
          if (again) again.focus();
        });
      },
    },
    h('h3', null, '할 일 추가'),
    h('div', { class: 'grid grid-task' },
      h('div', { class: 'span-2' }, field('내용', f.title)),
      field('마감일', f.due), field('우선순위', f.priority),
      field('태그', f.tags), field('예상 시간 (분)', f.est),
      h('div', { class: 'span-2' }, field('메모', f.note))),
    h('div', { class: 'actions' }, submit));

    const allTags = [...new Set(b.tasks.filter((t) => !t.deleted_at).flatMap((t) => t.tags || []))].sort((x, y) => x.localeCompare(y, 'ko'));
    if (state.filters.tag !== 'all' && !allTags.includes(state.filters.tag)) state.filters.tag = 'all';
    const fs = state.filters;
    const search = h('input', { type: 'search', value: fs.q, placeholder: '내용·메모·태그에서 찾기', 'aria-label': '할 일 검색' });
    search.addEventListener('input', () => { fs.q = search.value; renderTaskList(); });
    const mk = (key, list, label) => {
      const s = h('select', { 'aria-label': label }, options(list, fs[key]));
      s.addEventListener('change', () => { fs[key] = s.value; renderTaskList(); });
      return field(label, s);
    };
    const toolbar = h('div', { class: 'toolbar', id: 'task-toolbar' },
      field('검색', search),
      mk('status', STATUS_FILTERS, '상태'),
      mk('priority', [['all', '전체'], [1, '높음'], [2, '보통'], [3, '낮음']], '우선순위'),
      mk('tag', [['all', '전체'], ...allTags.map((t) => [t, t])], '태그'),
      mk('sort', Object.entries(SORTS).map(([k, v]) => [k, v.label]), '정렬'),
      h('button', {
        type: 'button', class: 'btn ghost small-btn',
        onclick: () => { state.filters = { q: '', status: 'active', priority: 'all', tag: 'all', sort: fs.sort }; render(); },
      }, '조건 지우기'));

    return h('section', { id: 'sec-tasks', class: 'sec' },
      h('h2', { class: 'sec-title' }, h('span', { class: 'step-no' }, '2'), '할 일', h('small', null, 'Do — 계획에 딸린 할 일')),
      form, toolbar,
      h('p', { class: 'sort-rule', id: 'sort-rule' }),
      h('p', { class: 'small muted' }, '검색·거르기·정렬은 서버에서 받아 온 이 계획의 할 일 전체를 두고 화면(브라우저)에서 합니다. 지연·막힘 여부는 서버가 계산한 값을 씁니다.'),
      h('p', { class: 'count', id: 'task-count' }),
      h('ol', { class: 'tasks', id: 'task-list' }));
  }

  function splitTags(v) {
    return String(v || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }

  function renderTaskList() {
    const b = state.bundle;
    const list = $('#task-list');
    if (!b || !list) return;
    const fs = state.filters;
    const sort = SORTS[fs.sort] || SORTS.due;
    const shown = b.tasks.filter((t) => matchesFilters(t, fs)).sort(sort.cmp);
    const alive = b.tasks.filter((t) => !t.deleted_at).length;
    const deleted = b.tasks.length - alive;
    $('#sort-rule').replaceChildren(h('b', null, '정렬 기준: '), sort.rule);
    $('#task-count').textContent = fs.status === 'deleted'
      ? `지운 할 일 ${deleted}건 중 ${shown.length}건 표시`
      : `지우지 않은 할 일 ${alive}건 중 ${shown.length}건 표시${deleted ? ` · 지운 할 일 ${deleted}건은 '지운 할 일'에서 볼 수 있습니다` : ''}`;
    list.replaceChildren(...(shown.length
      ? shown.map((t) => renderTaskItem(t, b))
      : [h('li', { class: 'empty' }, b.tasks.length ? '조건에 맞는 할 일이 없습니다.' : '아직 할 일이 없습니다. 위에서 할 일을 추가하세요.')]));
  }

  function renderTaskItem(t, b) {
    const logs = b.run_logs.filter((r) => r.task_id === t.id && !r.deleted_at);
    const comps = b.completions.filter((c) => c.task_id === t.id);
    const activeComp = comps.find((c) => !c.reverted_at);
    const done = t.status === 'done';
    const cls = ['task', done ? 'done' : '', t.is_overdue ? 'overdue' : '', t.is_blocked ? 'blocked' : '', t.deleted_at ? 'deleted' : ''].filter(Boolean).join(' ');

    let lead;
    if (t.deleted_at) lead = h('span', { class: 'lead-mark' }, '지움');
    else if (done) lead = h('button', { type: 'button', class: 'btn complete is-done', disabled: true, 'aria-label': `할 일 #${t.id} 완료됨` }, '완료됨');
    else {
      lead = h('button', { type: 'button', class: 'btn complete', 'aria-label': `할 일 #${t.id} 완료로 바꾸기` }, '완료');
      lead.addEventListener('click', () => completeTask(t, lead));
    }

    const actions = t.deleted_at
      ? [h('button', { type: 'button', class: 'btn small-btn', onclick: (e) => restoreTask(t, e.currentTarget) }, '되살리기')]
      : [
        h('button', { type: 'button', class: 'btn small-btn', onclick: () => { state.editingTaskId = t.id; renderTaskList(); } }, '고치기'),
        h('button', { type: 'button', class: 'btn small-btn', onclick: () => pickLogTask(t.id) }, '실행 기록 추가'),
        done ? h('button', { type: 'button', class: 'btn small-btn', onclick: (e) => reopenTask(t, e.currentTarget) }, '진행 중으로 되돌리기') : null,
        h('button', { type: 'button', class: 'btn small-btn danger', onclick: (e) => deleteTask(t, e.currentTarget) }, '지우기'),
      ];

    const badges = [
      h('span', { class: `badge ${done ? 'solid' : ''}` }, done ? '완료' : '진행 중'),
      t.is_overdue ? h('span', { class: 'badge warn' }, '지연') : null,
      t.is_blocked ? h('span', { class: 'badge warn-soft' }, '막힘') : null,
      t.deleted_at ? h('span', { class: 'badge' }, `지움 ${fmtTs(t.deleted_at)}`) : null,
    ];

    const body = state.editingTaskId === t.id && !t.deleted_at
      ? renderTaskEditForm(t)
      : h('div', { class: 'task-body' },
        h('div', { class: 'task-title' }, h('span', { class: 'rid' }, `#${t.id}`), h('span', { class: 't' }, t.title)),
        h('div', { class: 'meta' },
          badges,
          h('span', null, `마감 ${fmtDate(t.due_date)}`),
          h('span', null, `우선순위 ${PRIORITY[t.priority]}`),
          h('span', null, `예상 ${fmtMin(t.estimated_minutes)}`),
          h('span', null, `실제 ${fmtMin(t.actual_minutes)} (기록 ${t.run_log_count}건)`)),
        (t.tags || []).length ? h('div', { class: 'tags' }, t.tags.map((tag) => h('span', { class: 'tag' }, tag))) : null,
        t.note ? h('p', { class: 'note' }, t.note) : null);

    const detail = detailsBlock(`task-${t.id}`, `실행 기록 ${logs.length}건 · 완료 기록 ${comps.length}건${activeComp ? ' (살아 있는 완료 1건)' : ''}`,
      logs.length
        ? h('ul', { class: 'mini' }, logs.map((r) => h('li', null,
          h('a', { href: `#plan=${b.plan.id}&focus=log-${r.id}` }, `기록 #${r.id}`),
          ` · ${fmtTs(r.started_at)} ~ ${fmtTs(r.ended_at)} · 실제 ${fmtMin(r.actual_minutes)}`,
          r.blocked_reason ? ` · 막힌 이유: ${r.blocked_reason}` : '')))
        : h('p', { class: 'small muted' }, '실행 기록이 없습니다.'),
      comps.length
        ? h('ul', { class: 'mini' }, comps.map((c) => h('li', null,
          `완료 기록 #${c.id} · ${fmtTs(c.completed_at)}`,
          c.reverted_at ? ` · ${fmtTs(c.reverted_at)}에 되돌림` : ' · 살아 있음',
          h('span', { class: 'muted' }, ` · 요청 키 ${c.request_key.slice(0, 8)}…`))))
        : h('p', { class: 'small muted' }, '완료 기록이 없습니다.'));

    return h('li', { class: cls, id: `task-${t.id}` },
      h('div', { class: 'task-main' }, h('div', { class: 'task-lead' }, lead), body, h('div', { class: 'task-actions' }, actions)),
      detail);
  }

  function renderTaskEditForm(t) {
    const f = {
      title: h('input', { type: 'text', required: true, maxlength: 200, value: t.title }),
      due: h('input', { type: 'date', value: t.due_date || '' }),
      priority: h('select', null, options([[1, '높음'], [2, '보통'], [3, '낮음']], t.priority)),
      tags: h('input', { type: 'text', maxlength: 230, value: (t.tags || []).join(', ') }),
      est: h('input', { type: 'number', required: true, min: 0, max: 100000, step: 1, value: t.estimated_minutes }),
      note: h('input', { type: 'text', maxlength: 2000, value: t.note || '' }),
    };
    const submit = h('button', { type: 'submit', class: 'btn primary' }, '저장');
    return h('form', {
      class: 'task-body form inline', id: `task-edit-${t.id}`,
      onsubmit: (e) => {
        e.preventDefault();
        guarded(submit, async () => {
          await rpc('update_task', {
            p_id: t.id, p_title: f.title.value, p_note: f.note.value || null, p_due_date: f.due.value || null,
            p_priority: Number(f.priority.value), p_tags: splitTags(f.tags.value), p_estimated_minutes: toInt(f.est.value),
          });
          state.editingTaskId = null;
          await refresh();
          say(`할 일 #${t.id}을(를) 고쳤습니다.`);
        });
      },
    },
    h('div', { class: 'grid grid-task' },
      h('div', { class: 'span-2' }, field(`할 일 #${t.id} 내용`, f.title)),
      field('마감일', f.due), field('우선순위', f.priority),
      field('태그', f.tags), field('예상 시간 (분)', f.est),
      h('div', { class: 'span-2' }, field('메모', f.note))),
    h('div', { class: 'actions' }, submit,
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { state.editingTaskId = null; renderTaskList(); } }, '취소')));
  }

  // 완료 버튼은 일부러 잠그지 않습니다. 같은 할 일의 완료 요청은 같은 키로 보내고,
  // 여러 번 눌러도 서버(DB)가 한 건만 기록합니다.
  const completeTally = {};
  async function completeTask(t, btn) {
    const key = keyFor(`complete:${t.id}`);
    const tally = (completeTally[key] ||= { sent: 0, answered: 0, createdId: null });
    tally.sent += 1;
    try {
      const res = await rpc('complete_task', { p_id: t.id, p_request_key: key });
      tally.answered += 1;
      if (res.created) tally.createdId = res.completion.id;
      await refresh();
      const id = tally.createdId || res.completion.id;
      say(tally.answered > 1
        ? `완료 요청을 ${tally.answered}번 받았지만 완료 기록은 1건만 남겼습니다 (할 일 #${t.id}, 완료 기록 #${id}).`
        : res.created
          ? `할 일 #${t.id}을(를) 완료로 바꿨습니다 (완료 기록 #${id}).`
          : `이미 완료된 할 일입니다. 완료 기록은 그대로 1건입니다 (#${id}).`);
    } catch (err) { sayError(err); if (btn.isConnected) btn.disabled = false; }
  }

  async function reopenTask(t, btn) {
    await guarded(btn, async () => {
      await rpc('reopen_task', { p_id: t.id });
      dropKey(`complete:${t.id}`);
      await refresh();
      say(`할 일 #${t.id}을(를) 다시 진행 중으로 되돌렸습니다. 이전 완료 기록은 '되돌림'으로 남겼습니다.`);
    });
  }

  async function deleteTask(t, btn) {
    await guarded(btn, async () => {
      await rpc('delete_task', { p_id: t.id });
      if (state.editingTaskId === t.id) state.editingTaskId = null;
      await refresh();
      say(`할 일 #${t.id}을(를) 지웠습니다. 돌아보기 집계에서 빠집니다.`, 'ok',
        h('button', { type: 'button', class: 'btn small-btn', onclick: (e) => restoreTask(t, e.currentTarget) }, '되살리기'));
    });
  }

  async function restoreTask(t, btn) {
    await guarded(btn, async () => {
      await rpc('restore_task', { p_id: t.id });
      await refresh();
      say(`할 일 #${t.id}을(를) 되살렸습니다.`);
    });
  }

  // ------------------------------------------------------------------ 3. 실행 기록
  function pickLogTask(taskId) {
    state.logTaskId = taskId;
    render();
    scrollToId('sec-logs');
    const start = $('#log-start');
    if (start) start.focus({ preventScroll: true });
  }

  function renderLogSection(b) {
    const alive = b.tasks.filter((t) => !t.deleted_at);
    const now = new Date();
    const f = {
      task: h('select', { required: true, id: 'log-task' },
        h('option', { value: '' }, alive.length ? '할 일을 고르세요' : '먼저 할 일을 만드세요'),
        alive.map((t) => h('option', { value: t.id, selected: t.id === state.logTaskId }, `#${t.id} ${t.title}`))),
      start: h('input', { type: 'datetime-local', required: true, id: 'log-start', value: kstInputFromDate(new Date(now.getTime() - 60 * 60000)) }),
      end: h('input', { type: 'datetime-local', required: true, id: 'log-end', value: kstInputFromDate(now) }),
      actual: h('input', { type: 'number', required: true, min: 0, max: 1440, step: 1, id: 'log-actual', value: 60 }),
      blocked: h('input', { type: 'text', maxlength: 500, id: 'log-blocked', placeholder: '막힌 곳이 있었다면 (예: 정렬 순서가 볼 때마다 달라짐)' }),
      note: h('input', { type: 'text', maxlength: 1000, id: 'log-note', placeholder: '메모 (선택)' }),
    };
    let actualTouched = false;
    const spanHint = h('span', { class: 'field-hint', id: 'log-span' });
    const syncActual = () => {
      const span = inputSpanMinutes(f.start.value, f.end.value);
      spanHint.textContent = span === null ? '' : span < 0 ? '끝난 시각이 시작 시각보다 앞입니다.' : `시작~끝 사이 ${fmtMin(span)} (쉰 시간을 빼고 적어도 됩니다)`;
      if (!actualTouched && span !== null && span >= 0) f.actual.value = String(span);
    };
    f.start.addEventListener('input', syncActual);
    f.end.addEventListener('input', syncActual);
    f.actual.addEventListener('input', () => { actualTouched = true; });
    f.task.addEventListener('change', () => { state.logTaskId = Number(f.task.value) || null; });
    syncActual();

    const submit = h('button', { type: 'submit', class: 'btn primary' }, '기록 저장');
    const form = h('form', {
      class: 'card form', id: 'log-form',
      onsubmit: (e) => {
        e.preventDefault();
        guarded(submit, async () => {
          const taskId = Number(f.task.value);
          if (!taskId) throw new Error('기록을 붙일 할 일을 고르세요.');
          const before = state.bundle;
          const beforeTask = before.tasks.find((t) => t.id === taskId);
          const res = await rpc('add_run_log', {
            p_task_id: taskId, p_started_at: inputToIso(f.start.value), p_ended_at: inputToIso(f.end.value),
            p_actual_minutes: toInt(f.actual.value), p_blocked_reason: f.blocked.value || null,
            p_note: f.note.value || null, p_request_key: keyFor('log-form'),
          });
          dropKey('log-form');
          await refresh();
          const after = state.bundle;
          const afterTask = after.tasks.find((t) => t.id === taskId);
          state.logProof = {
            logId: res.id, taskId,
            planBefore: before.plan.estimated_minutes, planAfter: after.plan.estimated_minutes,
            planRevBefore: before.plan.revision, planRevAfter: after.plan.revision,
            taskBefore: beforeTask ? beforeTask.estimated_minutes : null, taskAfter: afterTask ? afterTask.estimated_minutes : null,
          };
          state.logTaskId = taskId;
          render();
          scrollToId('log-proof');
          say(`실행 기록 #${res.id}을(를) 할 일 #${taskId}에 붙여 저장했습니다.`);
        });
      },
    },
    h('h3', null, '실행 기록 남기기'),
    h('p', { class: 'small muted' }, '계획과 따로 저장합니다. 기록을 저장해도 계획·할 일에 적어 둔 예상 값은 바뀌지 않습니다. 시각은 서울 시간으로 적습니다.'),
    h('div', { class: 'grid' },
      h('div', { class: 'span-all' }, field('할 일', f.task)),
      field('시작 시각 (서울)', f.start), field('끝난 시각 (서울)', f.end),
      field('실제로 걸린 시간 (분)', f.actual, spanHint),
      field('막혔던 이유', f.blocked),
      h('div', { class: 'span-all' }, field('메모', f.note))),
    h('div', { class: 'actions' }, submit));

    const proof = state.logProof ? renderLogProof(state.logProof) : null;
    const logs = b.run_logs.filter((r) => !r.deleted_at);
    const cancelled = b.run_logs.filter((r) => r.deleted_at);
    const taskTitle = (id) => { const t = b.tasks.find((x) => x.id === id); return t ? t.title : '(알 수 없음)'; };

    const row = (r) => h('li', { class: `log${r.deleted_at ? ' cancelled' : ''}`, id: `log-${r.id}` },
      h('div', { class: 'log-head' },
        h('span', { class: 'rid' }, `기록 #${r.id}`),
        h('a', { href: `#plan=${b.plan.id}&focus=task-${r.task_id}` }, `할 일 #${r.task_id} ${taskTitle(r.task_id)}`)),
      h('div', { class: 'meta' },
        h('span', null, `시작 ${fmtTs(r.started_at)}`),
        h('span', null, `끝 ${fmtTs(r.ended_at)}`),
        h('span', null, h('b', null, `실제 ${fmtMin(r.actual_minutes)}`))),
      r.blocked_reason ? h('p', { class: 'blocked-reason' }, `막힌 이유: ${r.blocked_reason}`) : null,
      r.note ? h('p', { class: 'note' }, r.note) : null,
      r.deleted_at
        ? h('p', { class: 'small muted' }, `${fmtTs(r.deleted_at)}에 취소 · 집계에서 빠짐`)
        : h('div', { class: 'actions' }, h('button', {
          type: 'button', class: 'btn small-btn danger',
          onclick: (e) => guarded(e.currentTarget, async () => {
            await rpc('delete_run_log', { p_id: r.id });
            await refresh();
            say(`실행 기록 #${r.id}을(를) 취소했습니다. 실제 시간 합계에서 빠집니다.`);
          }),
        }, '이 기록 취소')));

    return h('section', { id: 'sec-logs', class: 'sec' },
      h('h2', { class: 'sec-title' }, h('span', { class: 'step-no' }, '3'), '실행 기록', h('small', null, 'Do — 실제로 한 일')),
      form, proof,
      h('h3', { class: 'list-title' }, `이 계획의 실행 기록 ${logs.length}건 (시작 시각 최근 순)`),
      logs.length ? h('ol', { class: 'logs' }, logs.map(row)) : h('p', { class: 'muted' }, '아직 실행 기록이 없습니다.'),
      cancelled.length ? detailsBlock('cancelled-logs', `취소한 기록 ${cancelled.length}건`, h('ol', { class: 'logs' }, cancelled.map(row))) : null);
  }

  function renderLogProof(p) {
    const same = (a, b) => (a === b ? '그대로' : '바뀜!');
    return h('div', { class: 'proof', id: 'log-proof' },
      h('b', null, `방금 저장한 기록 #${p.logId} → 할 일 #${p.taskId}`),
      h('ul', { class: 'mini' },
        h('li', null, `계획 예상 시간: 저장 전 ${fmtMin(p.planBefore)} → 저장 후 ${fmtMin(p.planAfter)} (${same(p.planBefore, p.planAfter)})`),
        h('li', null, `계획 판 번호: 저장 전 ${p.planRevBefore}판 → 저장 후 ${p.planRevAfter}판 (${same(p.planRevBefore, p.planRevAfter)})`),
        h('li', null, `할 일 #${p.taskId} 예상 시간: 저장 전 ${fmtMin(p.taskBefore)} → 저장 후 ${fmtMin(p.taskAfter)} (${same(p.taskBefore, p.taskAfter)})`)));
  }

  // ------------------------------------------------------------------ 4. 돌아보기
  const DRILL = {
    planned: {
      label: '계획 수', rule: '이 계획에 딸린, 지우지 않은 할 일', kind: 'tasks',
      value: (s) => s.planned.count, display: (s) => String(s.planned.count), ids: (s) => s.planned.task_ids,
    },
    done: {
      label: '완료 수', rule: '그중 지금 완료 상태인 할 일', kind: 'tasks',
      value: (s) => s.done.count, display: (s) => String(s.done.count), ids: (s) => s.done.task_ids,
    },
    overdue: {
      label: '지연 수', rule: '완료되지 않았고 마감일이 오늘(서울)보다 앞선 할 일. 완료한 할 일은 세지 않음', kind: 'tasks',
      value: (s) => s.overdue.count, display: (s) => String(s.overdue.count), ids: (s) => s.overdue.task_ids,
    },
    blocked: {
      label: '막힘 수', rule: '막힌 이유가 하나라도 적힌 실행 기록이 있는 할 일', kind: 'tasks',
      value: (s) => s.blocked.count, display: (s) => String(s.blocked.count), ids: (s) => s.blocked.task_ids,
    },
    estimated: {
      label: '예상 시간', rule: '대상 할 일의 예상 시간 합계', kind: 'tasks',
      value: (s) => s.estimated_minutes.sum, display: (s) => `${s.estimated_minutes.sum}분`,
      sub: (s) => hm(s.estimated_minutes.sum), ids: (s) => s.estimated_minutes.task_ids,
    },
    actual: {
      label: '실제 시간', rule: '대상 할 일의 실행 기록(취소한 기록 제외) 실제 시간 합계', kind: 'logs',
      value: (s) => s.actual_minutes.sum, display: (s) => `${s.actual_minutes.sum}분`,
      sub: (s) => hm(s.actual_minutes.sum), ids: (s) => s.actual_minutes.run_log_ids,
    },
    diff: {
      label: '차이', rule: '실제 시간 − 예상 시간 (+면 예상보다 오래 걸림)', kind: 'diff',
      value: (s) => s.diff_minutes, display: (s) => `${s.diff_minutes > 0 ? '+' : ''}${s.diff_minutes}분`,
      sub: (s) => (s.diff_minutes === 0 ? '예상과 같음'
        : `예상보다 ${hm(s.diff_minutes) || `${Math.abs(s.diff_minutes)}분`} ${s.diff_minutes > 0 ? '더' : '덜'} 걸림`), ids: () => [],
    },
  };

  function renderReviewSection(b) {
    const s = b.summary;
    const stats = h('div', { class: 'stats', id: 'stats' }, Object.entries(DRILL).map(([key, d]) => h('button', {
      type: 'button', class: `stat${state.drill === key ? ' on' : ''}`, id: `stat-${key}`,
      'aria-pressed': state.drill === key ? 'true' : 'false',
      dataset: { drill: key },
      onclick: () => {
        state.drill = state.drill === key ? null : key;
        writeHash({ plan: b.plan.id, drill: state.drill }, true);
        render();
        if (state.drill) scrollToId('drill');
      },
    },
    h('span', { class: 'stat-label' }, d.label),
    h('span', { class: 'stat-num', id: `num-${key}` }, d.display(s)),
    d.sub && d.sub(s) ? h('span', { class: 'stat-sub' }, d.sub(s)) : null,
    h('span', { class: 'stat-rule' }, d.rule))));

    return h('section', { id: 'sec-review', class: 'sec' },
      h('h2', { class: 'sec-title' }, h('span', { class: 'step-no' }, '4'), '돌아보기', h('small', null, 'See')),
      h('p', { class: 'basis' },
        `기준: 계획 #${b.plan.id}에 딸린, 지우지 않은 할 일 ${s.planned.count}건 · 오늘(서울) ${fmtDate(s.today_kst)} · 시간 단위: 분 · 계산 시각 ${fmtTs(s.computed_at)}`),
      h('p', { class: 'small muted' }, '숫자를 누르면 그 숫자가 나온 기록을 보여 줍니다. 숫자와 근거 목록은 모두 서버가 같은 규칙으로 한 번에 계산합니다.'),
      stats,
      state.drill ? renderDrill(b, state.drill) : null,
      renderEstimateInsight(b),
      renderReviewForm(b),
      renderReviewList(b));
  }

  function renderDrill(b, key) {
    const d = DRILL[key];
    const s = b.summary;
    const byId = new Map(b.tasks.map((t) => [t.id, t]));
    const logById = new Map(b.run_logs.map((r) => [r.id, r]));
    let body;
    if (d.kind === 'tasks') {
      const ids = d.ids(s);
      const rows = ids.map((id) => byId.get(id)).filter(Boolean);
      const sum = rows.reduce((a, t) => a + t.estimated_minutes, 0);
      body = [
        rows.length
          ? h('ol', { class: 'drill-list' }, rows.map((t) => h('li', null,
            h('a', { href: `#plan=${b.plan.id}&focus=task-${t.id}` }, `할 일 #${t.id} ${t.title}`),
            h('span', { class: 'small muted' }, ` · ${t.status === 'done' ? '완료' : '진행 중'} · 마감 ${fmtDate(t.due_date)} · 예상 ${fmtMin(t.estimated_minutes)}`),
            key === 'overdue' ? h('span', { class: 'small' }, ` · 마감 ${t.due_date} < 오늘 ${s.today_kst}`) : null,
            key === 'blocked' ? h('div', { class: 'small' }, b.run_logs
              .filter((r) => r.task_id === t.id && !r.deleted_at && r.blocked_reason)
              .map((r) => h('div', null, h('a', { href: `#plan=${b.plan.id}&focus=log-${r.id}` }, `기록 #${r.id}`), ` 막힌 이유: ${r.blocked_reason}`))) : null)))
          : h('p', { class: 'muted' }, '해당하는 기록이 없습니다 (0건).'),
        h('p', { class: 'check' }, key === 'estimated'
          ? `목록의 예상 시간을 더하면 ${sum}분 = 위 숫자 ${d.display(s)}`
          : `목록 ${rows.length}건 = 위 숫자 ${d.display(s)}`),
      ];
    } else if (d.kind === 'logs') {
      const rows = d.ids(s).map((id) => logById.get(id)).filter(Boolean);
      const sum = rows.reduce((a, r) => a + r.actual_minutes, 0);
      body = [
        rows.length
          ? h('ol', { class: 'drill-list' }, rows.map((r) => h('li', null,
            h('a', { href: `#plan=${b.plan.id}&focus=log-${r.id}` }, `기록 #${r.id}`),
            ` · 할 일 #${r.task_id} ${(byId.get(r.task_id) || {}).title || ''}`,
            h('span', { class: 'small muted' }, ` · ${fmtTs(r.started_at)} ~ ${fmtTs(r.ended_at)} · 실제 ${fmtMin(r.actual_minutes)}`))))
          : h('p', { class: 'muted' }, '해당하는 실행 기록이 없습니다 (0분).'),
        h('p', { class: 'check' }, `목록의 실제 시간을 더하면 ${sum}분 = 위 숫자 ${d.display(s)}`),
      ];
    } else {
      body = [
        h('p', null, `실제 ${fmtMin(s.actual_minutes.sum)} − 예상 ${fmtMin(s.estimated_minutes.sum)} = ${fmtDiff(s.diff_minutes)}`),
        h('div', { class: 'actions' },
          h('a', { class: 'btn small-btn', href: `#plan=${b.plan.id}&drill=estimated` }, '예상 시간 근거 보기'),
          h('a', { class: 'btn small-btn', href: `#plan=${b.plan.id}&drill=actual` }, '실제 시간 근거 보기')),
      ];
    }
    return h('div', { class: 'card drill', id: 'drill' },
      h('div', { class: 'drill-head' },
        h('h3', null, `${d.label} ${d.display(s)} — 근거 기록`),
        h('button', {
          type: 'button', class: 'btn ghost small-btn',
          onclick: () => { state.drill = null; writeHash({ plan: b.plan.id }, true); render(); },
        }, '닫기')),
      h('p', { class: 'small muted' }, `규칙: ${d.rule}`),
      body);
  }

  function renderEstimateInsight(b) {
    const alive = b.tasks.filter((t) => !t.deleted_at);
    const withLogs = alive.filter((t) => t.run_log_count > 0);
    const over = withLogs.filter((t) => t.actual_minutes > t.estimated_minutes);
    const under = withLogs.filter((t) => t.actual_minutes < t.estimated_minutes);
    const exact = withLogs.filter((t) => t.actual_minutes === t.estimated_minutes);
    const s = b.summary;
    const logEst = withLogs.reduce((a, t) => a + t.estimated_minutes, 0);
    const logAct = withLogs.reduce((a, t) => a + t.actual_minutes, 0);
    let line;
    if (!withLogs.length) line = '실행 기록이 쌓이면 예상과 실제가 어느 쪽으로 빗나가는지 보여 줍니다.';
    else if (logEst === 0) line = `기록이 있는 할 일 ${withLogs.length}건의 예상 시간이 모두 0분이라 비율은 계산하지 않았습니다.`;
    else {
      const ratio = logAct / logEst;
      line = `기록이 있는 할 일 ${withLogs.length}건만 보면 예상 ${fmtMin(logEst)}, 실제 ${fmtMin(logAct)} → 실제가 예상의 ${ratio.toFixed(2)}배입니다. `
        + (over.length > under.length ? '주로 시간을 짧게 잡는 쪽으로 틀립니다.'
          : under.length > over.length ? '주로 시간을 넉넉하게 잡는 쪽으로 틀립니다.' : '길게·짧게 틀린 경우가 비슷합니다.');
    }
    const rows = alive.slice().sort((x, y) => (y.actual_minutes - y.estimated_minutes) - (x.actual_minutes - x.estimated_minutes) || x.id - y.id);
    return detailsBlock('insight', `예상과 실제, 어느 쪽으로 틀렸나 — 더 걸림 ${over.length} · 덜 걸림 ${under.length} · 같음 ${exact.length} · 기록 없음 ${alive.length - withLogs.length}`,
      h('p', { class: 'insight' }, line),
      rows.length ? h('table', { class: 'cmp' },
        h('thead', null, h('tr', null, h('th', null, '할 일'), h('th', null, '예상'), h('th', null, '실제'), h('th', null, '차이'))),
        h('tbody', null, rows.map((t) => h('tr', null,
          h('td', null, h('a', { href: `#plan=${b.plan.id}&focus=task-${t.id}` }, `#${t.id} ${t.title}`)),
          h('td', { class: 'num' }, `${t.estimated_minutes}분`),
          h('td', { class: 'num' }, t.run_log_count ? `${t.actual_minutes}분` : '기록 없음'),
          h('td', { class: 'num' }, t.run_log_count ? `${t.actual_minutes - t.estimated_minutes > 0 ? '+' : ''}${t.actual_minutes - t.estimated_minutes}분` : '—')))),
        h('tfoot', null, h('tr', null, h('td', null, '합계 (돌아보기 숫자)'),
          h('td', { class: 'num' }, `${s.estimated_minutes.sum}분`), h('td', { class: 'num' }, `${s.actual_minutes.sum}분`),
          h('td', { class: 'num' }, `${s.diff_minutes > 0 ? '+' : ''}${s.diff_minutes}분`)))) : null);
  }

  function renderReviewForm(b) {
    const f = {
      reflection: h('textarea', { rows: 3, maxlength: 2000, placeholder: '잘된 것, 빗나간 것, 그 이유 (선택)' }),
      fix: h('input', { type: 'text', required: true, maxlength: 200, placeholder: '예: DB 작업은 예상 시간을 1.5배로 잡는다' }),
    };
    const submit = h('button', { type: 'submit', class: 'btn primary' }, '돌아보기 저장');
    return h('form', {
      class: 'card form', id: 'review-form',
      onsubmit: (e) => {
        e.preventDefault();
        guarded(submit, async () => {
          const res = await rpc('add_review', {
            p_plan_id: b.plan.id, p_reflection: f.reflection.value || null, p_next_fix: f.fix.value,
            p_request_key: keyFor('review-form'),
          });
          dropKey('review-form');
          await refresh();
          focusRecord(`review-${res.id}`);
          say(`돌아보기 #${res.id}을(를) 저장했습니다. 이제 고칠 점을 다음 계획으로 넘길 수 있습니다.`);
        });
      },
    },
    h('h3', null, '돌아보기 남기기'),
    h('p', { class: 'small muted' }, '저장하는 순간의 숫자(계획·완료·지연·막힘·예상·실제·차이)가 함께 저장됩니다.'),
    field('돌아본 내용', f.reflection),
    field('다음 계획으로 넘길 고칠 점 (한 줄)', f.fix),
    h('div', { class: 'actions' }, submit));
  }

  function renderReviewList(b) {
    if (!b.reviews.length) return h('p', { class: 'muted' }, '아직 저장한 돌아보기가 없습니다.');
    return h('ol', { class: 'reviews' }, b.reviews.map((rv) => {
      const st = rv.stats || {};
      let carry;
      if (rv.carried_to_plan) {
        carry = h('p', { class: 'carried-note' }, '→ ',
          h('a', { href: `#plan=${rv.carried_to_plan.id}&focus=plan-${rv.carried_to_plan.id}` },
            `계획 #${rv.carried_to_plan.id} 「${rv.carried_to_plan.title}」`), '(으)로 넘어갔습니다.');
      } else {
        const candidates = state.plans.filter((p) => p.id !== b.plan.id && !p.carried_from_review_id);
        const sel = h('select', { 'aria-label': '고칠 점을 넘길 계획' },
          h('option', { value: 'new' }, '새 계획을 만들어 넘기기'),
          candidates.map((p) => h('option', { value: p.id }, `이미 있는 계획 #${p.id} ${p.title}`)));
        const go = h('button', {
          type: 'button', class: 'btn primary small-btn',
          onclick: () => {
            if (sel.value === 'new') {
              state.newPlan = { carriedReview: { id: rv.id, plan_id: b.plan.id, next_fix: rv.next_fix }, first: false };
              render();
              scrollToId('new-plan');
              return;
            }
            guarded(go, async () => {
              const target = Number(sel.value);
              await rpc('carry_review', { p_review_id: rv.id, p_plan_id: target });
              await refresh();
              say(`돌아보기 #${rv.id}의 고칠 점을 계획 #${target}(으)로 넘겼습니다.`, 'ok',
                h('a', { class: 'btn small-btn', href: `#plan=${target}&focus=plan-${target}` }, '그 계획 보기'));
            });
          },
        }, '다음 계획으로 넘기기');
        carry = h('div', { class: 'carry-row' }, sel, go);
      }
      return h('li', { class: 'card review', id: `review-${rv.id}` },
        h('div', { class: 'card-head' }, h('span', { class: 'rid' }, `돌아보기 #${rv.id}`), h('span', { class: 'small muted' }, fmtTs(rv.created_at))),
        h('p', { class: 'small muted' },
          `저장 시점 숫자 — 계획 ${st.planned} · 완료 ${st.done} · 지연 ${st.overdue} · 막힘 ${st.blocked} · 예상 ${st.estimated_minutes}분 · 실제 ${st.actual_minutes}분 · 차이 ${st.diff_minutes > 0 ? '+' : ''}${st.diff_minutes}분`),
        rv.reflection ? h('p', { class: 'pre' }, rv.reflection) : null,
        h('p', { class: 'fix' }, h('b', null, '고칠 점: '), rv.next_fix),
        carry);
    }));
  }

  // ------------------------------------------------------------------ 내보내기
  async function exportAll(btn) {
    await guarded(btn, async () => {
      const data = await rpc('export_all');
      const p = kstParts(new Date());
      const name = `pds-diary-export-${p.year}${p.month}${p.day}-${p.hour}${p.minute}KST.json`;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      say(`내보냈습니다: ${name} — 계획 ${data.plans.length} · 수정 이력 ${data.plan_revisions.length} · 할 일 ${data.tasks.length} · 완료 기록 ${data.task_completions.length} · 실행 기록 ${data.run_logs.length} · 돌아보기 ${data.reviews.length}`);
    });
  }

  // ------------------------------------------------------------------ 시작
  function start() {
    if (CFG.SOURCE_URL && /^https:\/\//.test(CFG.SOURCE_URL)) $('#source-link').href = CFG.SOURCE_URL;
    const problem = keyProblem();
    if (problem) { renderSetupNeeded(problem); return; }

    $('#plan-select').addEventListener('change', (e) => {
      const id = Number(e.target.value);
      state.drill = null;
      state.filters = { q: '', status: 'active', priority: 'all', tag: 'all', sort: state.filters.sort };
      writeHash({ plan: id }, true);
      applyHash();
    });
    $('#btn-new-plan').addEventListener('click', () => {
      state.newPlan = { carriedReview: null, first: !state.plans.length };
      render();
      scrollToId('new-plan');
    });
    $('#btn-export').addEventListener('click', (e) => exportAll(e.currentTarget));
    document.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      scrollToId(a.dataset.jump);
    }));
    window.addEventListener('hashchange', () => applyHash());
    window.addEventListener('popstate', () => applyHash());

    applyHash({ initial: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}());
