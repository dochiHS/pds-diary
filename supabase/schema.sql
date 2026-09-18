-- =============================================================================
-- 플랜두씨 다이어리 1 (ALEPH T06) · Supabase 스키마 pds-schema-v2
--
-- 실행 방법
--   Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣기 → Run
--   다시 실행해도 됩니다. 표는 이미 있으면 건너뛰고, 함수와 권한은 새로 덮어씁니다.
--
-- 설계 요약
--   · 브라우저(anon 역할)는 표를 직접 읽거나 쓰지 않습니다.
--     아래 public 스키마의 함수(RPC)만 실행할 수 있습니다.
--   · 모든 표에 RLS를 켜고, anon·authenticated에는 표 권한을 주지 않습니다.
--   · 계획을 고치면 고치기 전 내용이 plan_revisions에 자동으로 쌓입니다(트리거).
--   · 완료는 요청 키(request_key) + "할 일 하나에 살아 있는 완료 기록 1건" 제약으로
--     두 번 눌러도 한 건만 남습니다.
--   · 날짜(date)는 서울 달력 날짜, 시각(timestamptz)은 UTC로 저장하고
--     화면에서는 서울 시간(KST, UTC+9)으로 보여 줍니다.
--   · 시간 값(*_minutes)은 모두 '분' 단위 정수입니다.
-- =============================================================================


-- 0) 내부 전용 스키마 ----------------------------------------------------------
--    Data API에 노출하지 않는 도우미 함수는 pds_private에 둡니다.
create schema if not exists pds_private;
revoke all on schema pds_private from public;
revoke all on schema pds_private from anon, authenticated;


-- 1) 도우미 함수 --------------------------------------------------------------
create or replace function pds_private.today_kst()
returns date
language sql stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Seoul')::date
$$;

create or replace function pds_private.clean_text(p_value text)
returns text
language sql immutable
set search_path = ''
as $$
  select nullif(btrim(p_value), '')
$$;

-- 태그: 앞뒤 공백 제거, 빈 값 제거, 중복 제거(처음 나온 순서 유지)
create or replace function pds_private.clean_tags(p_tags text[])
returns text[]
language sql immutable
set search_path = ''
as $$
  select coalesce(array_agg(s.t order by s.first_pos), '{}'::text[])
  from (
    select btrim(u.x) as t, min(u.ord) as first_pos
    from unnest(coalesce(p_tags, '{}'::text[])) with ordinality as u(x, ord)
    where btrim(u.x) <> ''
    group by btrim(u.x)
  ) s
$$;

create or replace function pds_private.tags_ok(p_tags text[])
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_tags is not null
     and cardinality(p_tags) <= 10
     and not exists (
       select 1 from unnest(p_tags) as t(x)
       where x is null or char_length(x) not between 1 and 20 or x <> btrim(x)
     )
$$;

-- 조건이 거짓이면 사용자에게 보여 줄 한국어 메시지로 오류를 냅니다(HTTP 400).
create or replace function pds_private.check_arg(p_ok boolean, p_message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_ok is not true then
    raise exception using errcode = '22023', message = p_message;
  end if;
end
$$;


-- 2) 표 ----------------------------------------------------------------------

-- 계획(Plan): 지금 값. 고치기 전 값은 plan_revisions에 남습니다.
create table if not exists public.plans (
  id                     bigint generated always as identity primary key,
  title                  text        not null,
  success_criteria       text        not null,
  start_date             date        not null,
  end_date               date        not null,
  priority               smallint    not null default 2,
  estimated_minutes      integer     not null,
  revision               integer     not null default 1,
  carried_from_review_id bigint      unique,
  request_key            uuid        unique,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint plans_title_len   check (char_length(title) between 1 and 120),
  constraint plans_success_len check (char_length(success_criteria) between 1 and 500),
  constraint plans_period      check (end_date >= start_date and end_date - start_date <= 366),
  constraint plans_priority    check (priority between 1 and 3),
  constraint plans_estimate    check (estimated_minutes between 1 and 100000),
  constraint plans_revision    check (revision >= 1)
);

-- 계획 수정 이력: 계획을 고칠 때마다 "고치기 전" 판이 한 줄씩 쌓입니다(지우거나 고칠 수 없음).
create table if not exists public.plan_revisions (
  id                bigint generated always as identity primary key,
  plan_id           bigint      not null references public.plans(id) on delete restrict,
  revision          integer     not null,
  title             text        not null,
  success_criteria  text        not null,
  start_date        date        not null,
  end_date          date        not null,
  priority          smallint    not null,
  estimated_minutes integer     not null,
  valid_from        timestamptz not null,
  replaced_at       timestamptz not null default now(),
  change_reason     text,
  constraint plan_revisions_unique unique (plan_id, revision),
  constraint plan_revisions_reason_len check (change_reason is null or char_length(change_reason) <= 300)
);
create index if not exists plan_revisions_plan_idx on public.plan_revisions(plan_id);

-- 할 일(Do): 계획에 딸린 할 일. 지우면 deleted_at만 채우고 행은 남깁니다.
create table if not exists public.tasks (
  id                bigint generated always as identity primary key,
  plan_id           bigint      not null references public.plans(id) on delete restrict,
  title             text        not null,
  note              text,
  due_date          date,
  priority          smallint    not null default 2,
  tags              text[]      not null default '{}'::text[],
  estimated_minutes integer     not null default 0,
  status            text        not null default 'open',
  completed_at      timestamptz,
  deleted_at        timestamptz,
  request_key       uuid        unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint tasks_title_len  check (char_length(title) between 1 and 200),
  constraint tasks_note_len   check (note is null or char_length(note) <= 2000),
  constraint tasks_priority   check (priority between 1 and 3),
  constraint tasks_tags       check (pds_private.tags_ok(tags)),
  constraint tasks_estimate   check (estimated_minutes between 0 and 100000),
  constraint tasks_status     check (status in ('open', 'done')),
  constraint tasks_done_time  check ((status = 'done') = (completed_at is not null))
);
create index if not exists tasks_plan_idx on public.tasks(plan_id);

-- 완료 기록: 완료 버튼 한 번(같은 요청 키)은 한 건. 되돌리면 reverted_at이 채워집니다.
create table if not exists public.task_completions (
  id           bigint generated always as identity primary key,
  task_id      bigint      not null references public.tasks(id) on delete restrict,
  request_key  uuid        not null unique,
  completed_at timestamptz not null default now(),
  reverted_at  timestamptz,
  constraint task_completions_revert_order check (reverted_at is null or reverted_at >= completed_at)
);
-- 할 일 하나에 "되돌리지 않은 완료 기록"은 최대 1건 (중복 완료를 DB가 막음)
create unique index if not exists task_completions_one_active
  on public.task_completions(task_id) where reverted_at is null;

-- 실행 기록: 실제로 언제 시작해 얼마나 걸렸고 어디서 막혔는지. 계획·할 일 값은 건드리지 않습니다.
create table if not exists public.run_logs (
  id             bigint generated always as identity primary key,
  task_id        bigint      not null references public.tasks(id) on delete restrict,
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  actual_minutes integer     not null,
  blocked_reason text,
  note           text,
  request_key    uuid        unique,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  constraint run_logs_time_order  check (ended_at >= started_at),
  constraint run_logs_span        check (ended_at - started_at <= interval '24 hours'),
  constraint run_logs_actual      check (actual_minutes >= 0
                                         and actual_minutes <= ceil(extract(epoch from (ended_at - started_at)) / 60.0)),
  constraint run_logs_blocked_len check (blocked_reason is null or char_length(blocked_reason) between 1 and 500),
  constraint run_logs_note_len    check (note is null or char_length(note) <= 1000)
);
create index if not exists run_logs_task_idx on public.run_logs(task_id);

-- 돌아보기(See): 돌아본 내용 + 다음 계획으로 넘길 고칠 점 한 줄 + 저장 시점 집계 스냅샷
create table if not exists public.reviews (
  id          bigint generated always as identity primary key,
  plan_id     bigint      not null references public.plans(id) on delete restrict,
  reflection  text,
  next_fix    text        not null,
  stats       jsonb       not null,
  request_key uuid        unique,
  created_at  timestamptz not null default now(),
  constraint reviews_reflection_len check (reflection is null or char_length(reflection) <= 2000),
  constraint reviews_next_fix_len   check (char_length(next_fix) between 1 and 200)
);
create index if not exists reviews_plan_idx on public.reviews(plan_id);

-- 계획 ← 돌아보기(고칠 점을 넘겨받은 계획). 돌아보기 하나는 계획 하나로만 넘어갑니다(unique).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plans_carried_from_review_fk') then
    alter table public.plans
      add constraint plans_carried_from_review_fk
      foreign key (carried_from_review_id) references public.reviews(id) on delete restrict;
  end if;
end
$$;


-- 3) 트리거 -------------------------------------------------------------------

-- 계획을 고치면: 고치기 전 판을 plan_revisions에 저장하고, 판 번호를 1 올립니다. ID는 그대로입니다.
create or replace function pds_private.plans_keep_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.title, new.success_criteria, new.start_date, new.end_date, new.priority, new.estimated_minutes)
     is not distinct from
     (old.title, old.success_criteria, old.start_date, old.end_date, old.priority, old.estimated_minutes) then
    new.revision   := old.revision;
    new.updated_at := old.updated_at;
    return new;
  end if;

  insert into public.plan_revisions
    (plan_id, revision, title, success_criteria, start_date, end_date, priority,
     estimated_minutes, valid_from, replaced_at, change_reason)
  values
    (old.id, old.revision, old.title, old.success_criteria, old.start_date, old.end_date, old.priority,
     old.estimated_minutes, old.updated_at, now(),
     nullif(current_setting('pds.change_reason', true), ''));

  new.revision   := old.revision + 1;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists plans_keep_revision on public.plans;
create trigger plans_keep_revision
  before update on public.plans
  for each row execute function pds_private.plans_keep_revision();

-- 수정 이력은 한 번 쌓이면 고치거나 지울 수 없습니다.
create or replace function pds_private.block_history_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '42501', message = '계획 수정 이력은 고치거나 지울 수 없습니다.';
end
$$;

drop trigger if exists plan_revisions_append_only on public.plan_revisions;
create trigger plan_revisions_append_only
  before update or delete on public.plan_revisions
  for each row execute function pds_private.block_history_change();

-- 할 일을 고치면 updated_at을 갱신합니다.
create or replace function pds_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function pds_private.touch_updated_at();


-- 4) 집계(돌아보기) ------------------------------------------------------------
--   대상 할 일   = 이 계획에 딸린, 지우지 않은 할 일
--   계획 수      = 대상 할 일 수
--   완료 수      = 대상 할 일 중 지금 완료 상태인 수
--   지연 수      = 대상 할 일 중 완료되지 않았고 마감일 < 오늘(서울) 인 수 (완료한 할 일은 세지 않음)
--   막힘 수      = 대상 할 일 중 막힌 이유가 하나라도 적힌 실행 기록(취소 안 한 것)이 있는 수
--   예상 시간    = 대상 할 일의 예상 시간 합계 (분)
--   실제 시간    = 대상 할 일의 실행 기록(취소 안 한 것) 실제 시간 합계 (분)
--   차이         = 실제 시간 - 예상 시간 (분). 아무것도 없으면 0
--   각 숫자와 함께 그 숫자가 나온 기록의 ID 목록을 돌려줍니다(숫자를 눌러 근거 기록으로 이동).
create or replace function pds_private.plan_summary(p_plan_id bigint)
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  with today as (
    select pds_private.today_kst() as d
  ),
  base as (
    select t.id, t.status, t.due_date, t.estimated_minutes,
           exists (
             select 1 from public.run_logs r
             where r.task_id = t.id
               and r.deleted_at is null
               and r.blocked_reason is not null
               and btrim(r.blocked_reason) <> ''
           ) as is_blocked
    from public.tasks t
    where t.plan_id = p_plan_id
      and t.deleted_at is null
  ),
  logs as (
    select r.id, r.actual_minutes
    from public.run_logs r
    join base b on b.id = r.task_id
    where r.deleted_at is null
  ),
  sums as (
    select coalesce((select sum(estimated_minutes) from base), 0)::bigint as est,
           coalesce((select sum(actual_minutes) from logs), 0)::bigint    as act
  )
  select jsonb_build_object(
    'plan_id',     p_plan_id,
    'today_kst',   (select d from today),
    'computed_at', now(),
    'unit',        'minutes',
    'planned', jsonb_build_object(
        'count',    (select count(*) from base),
        'task_ids', coalesce((select jsonb_agg(id order by id) from base), '[]'::jsonb)),
    'done', jsonb_build_object(
        'count',    (select count(*) from base where status = 'done'),
        'task_ids', coalesce((select jsonb_agg(id order by id) from base where status = 'done'), '[]'::jsonb)),
    'overdue', jsonb_build_object(
        'count',    (select count(*) from base
                      where status <> 'done' and due_date is not null and due_date < (select d from today)),
        'task_ids', coalesce((select jsonb_agg(id order by id) from base
                      where status <> 'done' and due_date is not null and due_date < (select d from today)), '[]'::jsonb)),
    'blocked', jsonb_build_object(
        'count',    (select count(*) from base where is_blocked),
        'task_ids', coalesce((select jsonb_agg(id order by id) from base where is_blocked), '[]'::jsonb)),
    'estimated_minutes', jsonb_build_object(
        'sum',      (select est from sums),
        'task_ids', coalesce((select jsonb_agg(id order by id) from base), '[]'::jsonb)),
    'actual_minutes', jsonb_build_object(
        'sum',         (select act from sums),
        'run_log_ids', coalesce((select jsonb_agg(id order by id) from logs), '[]'::jsonb)),
    'diff_minutes', (select act - est from sums)
  )
$$;


-- 5) 읽기 함수 (RPC) ----------------------------------------------------------

create or replace function public.ping()
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'plans', (select count(*) from public.plans), 'at', now())
$$;

create or replace function public.list_plans()
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',                     p.id,
           'title',                  p.title,
           'start_date',             p.start_date,
           'end_date',               p.end_date,
           'priority',               p.priority,
           'revision',               p.revision,
           'carried_from_review_id', p.carried_from_review_id,
           'task_count', (select count(*) from public.tasks t
                          where t.plan_id = p.id and t.deleted_at is null)
         ) order by p.id desc), '[]'::jsonb)
  from public.plans p
$$;

-- 계획 하나에 딸린 모든 자료(계획·수정 이력·할 일·실행 기록·완료 기록·돌아보기·집계)를 한 번에
create or replace function public.get_plan_bundle(p_plan_id bigint)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_plan  public.plans;
  v_today date := pds_private.today_kst();
begin
  select * into v_plan from public.plans where id = p_plan_id;
  if not found then
    raise exception using errcode = 'P0002', message = format('계획 #%s을(를) 찾을 수 없습니다.', p_plan_id);
  end if;

  return jsonb_build_object(
    'today_kst',   v_today,
    'server_time', now(),
    'plan',        to_jsonb(v_plan),
    'revisions',   coalesce((
        select jsonb_agg(to_jsonb(r) order by r.revision)
        from public.plan_revisions r where r.plan_id = p_plan_id), '[]'::jsonb),
    'carried_review', (
        select jsonb_build_object('id', rv.id, 'plan_id', rv.plan_id, 'plan_title', p.title,
                                  'next_fix', rv.next_fix, 'created_at', rv.created_at)
        from public.reviews rv join public.plans p on p.id = rv.plan_id
        where rv.id = v_plan.carried_from_review_id),
    'tasks', coalesce((
        select jsonb_agg(to_jsonb(t) || jsonb_build_object(
                 'is_overdue', t.deleted_at is null and t.status <> 'done'
                               and t.due_date is not null and t.due_date < v_today,
                 'is_blocked', exists (select 1 from public.run_logs r
                                       where r.task_id = t.id and r.deleted_at is null
                                         and r.blocked_reason is not null and btrim(r.blocked_reason) <> ''),
                 'actual_minutes', coalesce((select sum(r.actual_minutes) from public.run_logs r
                                             where r.task_id = t.id and r.deleted_at is null), 0),
                 'run_log_count', (select count(*) from public.run_logs r
                                   where r.task_id = t.id and r.deleted_at is null)
               ) order by t.id)
        from public.tasks t where t.plan_id = p_plan_id), '[]'::jsonb),
    'run_logs', coalesce((
        select jsonb_agg(to_jsonb(r) order by r.started_at desc, r.id desc)
        from public.run_logs r join public.tasks t on t.id = r.task_id
        where t.plan_id = p_plan_id), '[]'::jsonb),
    'completions', coalesce((
        select jsonb_agg(to_jsonb(c) order by c.id)
        from public.task_completions c join public.tasks t on t.id = c.task_id
        where t.plan_id = p_plan_id), '[]'::jsonb),
    'reviews', coalesce((
        select jsonb_agg(to_jsonb(rv) || jsonb_build_object(
                 'carried_to_plan', (select jsonb_build_object('id', p2.id, 'title', p2.title)
                                     from public.plans p2 where p2.carried_from_review_id = rv.id)
               ) order by rv.id desc)
        from public.reviews rv where rv.plan_id = p_plan_id), '[]'::jsonb),
    'summary', pds_private.plan_summary(p_plan_id)
  );
end
$$;

create or replace function public.review_summary(p_plan_id bigint)
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select pds_private.plan_summary(p_plan_id)
$$;

-- 내 자료 전체를 파일 하나(JSON)로
create or replace function public.export_all()
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schema',       'pds-schema-v2',
    'exported_at',  now(),
    'rules', jsonb_build_object(
        'date',        'date 칸은 서울(Asia/Seoul) 달력 날짜 YYYY-MM-DD',
        'timestamptz', 'timestamptz 칸은 ISO 8601(UTC 오프셋 포함). 화면은 서울 시간(KST, UTC+9)으로 표시',
        'minutes',     '*_minutes 칸은 모두 분 단위 정수'),
    'plans',            coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.plans x), '[]'::jsonb),
    'plan_revisions',   coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.plan_revisions x), '[]'::jsonb),
    'tasks',            coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.tasks x), '[]'::jsonb),
    'task_completions', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.task_completions x), '[]'::jsonb),
    'run_logs',         coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.run_logs x), '[]'::jsonb),
    'reviews',          coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.reviews x), '[]'::jsonb)
  )
$$;


-- 6) 쓰기 함수 (RPC) ----------------------------------------------------------

-- 계획 만들기 (같은 요청 키로 두 번 오면 처음 만든 계획을 돌려줌)
create or replace function public.create_plan(
  p_title                  text,
  p_success_criteria       text,
  p_start_date             date,
  p_end_date               date,
  p_priority               smallint,
  p_estimated_minutes      integer,
  p_carried_from_review_id bigint default null,
  p_request_key            uuid   default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.plans;
begin
  if p_request_key is not null then
    select * into v from public.plans where request_key = p_request_key;
    if found then
      return to_jsonb(v) || jsonb_build_object('created', false);
    end if;
  end if;

  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_title), '')) between 1 and 120,
                                '계획 이름은 1~120자로 적어 주세요.');
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_success_criteria), '')) between 1 and 500,
                                '성공 기준은 1~500자로 적어 주세요.');
  perform pds_private.check_arg(p_start_date is not null and p_end_date is not null,
                                '기간(시작일·끝일)을 모두 넣어 주세요.');
  perform pds_private.check_arg(p_end_date >= p_start_date, '끝일은 시작일과 같거나 뒤여야 합니다.');
  perform pds_private.check_arg(p_end_date - p_start_date <= 366, '기간은 1년을 넘길 수 없습니다.');
  perform pds_private.check_arg(p_priority between 1 and 3, '우선순위는 1(높음)~3(낮음) 가운데 하나입니다.');
  perform pds_private.check_arg(p_estimated_minutes between 1 and 100000, '예상 시간은 1분 이상으로 적어 주세요.');

  if p_carried_from_review_id is not null then
    perform pds_private.check_arg(exists (select 1 from public.reviews where id = p_carried_from_review_id),
                                  '넘겨받을 돌아보기를 찾을 수 없습니다.');
    perform pds_private.check_arg(not exists (select 1 from public.plans where carried_from_review_id = p_carried_from_review_id),
                                  '이 고칠 점은 이미 다른 계획으로 넘어갔습니다.');
  end if;

  insert into public.plans
    (title, success_criteria, start_date, end_date, priority, estimated_minutes, carried_from_review_id, request_key)
  values
    (pds_private.clean_text(p_title), pds_private.clean_text(p_success_criteria), p_start_date, p_end_date,
     p_priority, p_estimated_minutes, p_carried_from_review_id, p_request_key)
  returning * into v;

  return to_jsonb(v) || jsonb_build_object('created', true);
end
$$;

-- 계획 고치기: 고치기 전 판은 트리거가 plan_revisions에 남깁니다.
create or replace function public.update_plan(
  p_id                bigint,
  p_expected_revision integer,
  p_title             text,
  p_success_criteria  text,
  p_start_date        date,
  p_end_date          date,
  p_priority          smallint,
  p_estimated_minutes integer,
  p_change_reason     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.plans;
begin
  select * into v from public.plans where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = format('계획 #%s을(를) 찾을 수 없습니다.', p_id);
  end if;
  if p_expected_revision is not null and v.revision <> p_expected_revision then
    raise exception using errcode = 'P0001',
      message = format('다른 곳에서 먼저 고쳤습니다(지금 %s판). 새로고침한 뒤 다시 고쳐 주세요.', v.revision);
  end if;

  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_title), '')) between 1 and 120,
                                '계획 이름은 1~120자로 적어 주세요.');
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_success_criteria), '')) between 1 and 500,
                                '성공 기준은 1~500자로 적어 주세요.');
  perform pds_private.check_arg(p_start_date is not null and p_end_date is not null,
                                '기간(시작일·끝일)을 모두 넣어 주세요.');
  perform pds_private.check_arg(p_end_date >= p_start_date, '끝일은 시작일과 같거나 뒤여야 합니다.');
  perform pds_private.check_arg(p_end_date - p_start_date <= 366, '기간은 1년을 넘길 수 없습니다.');
  perform pds_private.check_arg(p_priority between 1 and 3, '우선순위는 1(높음)~3(낮음) 가운데 하나입니다.');
  perform pds_private.check_arg(p_estimated_minutes between 1 and 100000, '예상 시간은 1분 이상으로 적어 주세요.');
  perform pds_private.check_arg(p_change_reason is null or char_length(p_change_reason) <= 300,
                                '고친 이유는 300자 이내로 적어 주세요.');

  perform set_config('pds.change_reason', coalesce(pds_private.clean_text(p_change_reason), ''), true);

  update public.plans
     set title             = pds_private.clean_text(p_title),
         success_criteria  = pds_private.clean_text(p_success_criteria),
         start_date        = p_start_date,
         end_date          = p_end_date,
         priority          = p_priority,
         estimated_minutes = p_estimated_minutes
   where id = p_id
  returning * into v;

  perform set_config('pds.change_reason', '', true);
  return to_jsonb(v);
end
$$;

-- 돌아보기의 고칠 점을 이미 있는 다른 계획으로 넘기기
create or replace function public.carry_review(p_review_id bigint, p_plan_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.reviews;
  v_plan   public.plans;
begin
  select * into v_review from public.reviews where id = p_review_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '돌아보기를 찾을 수 없습니다.';
  end if;
  select * into v_plan from public.plans where id = p_plan_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = format('계획 #%s을(를) 찾을 수 없습니다.', p_plan_id);
  end if;

  if v_plan.carried_from_review_id = p_review_id then
    return to_jsonb(v_plan) || jsonb_build_object('created', false);  -- 이미 넘어간 상태(같은 요청 반복)
  end if;

  perform pds_private.check_arg(v_review.plan_id <> p_plan_id, '고칠 점은 돌아본 계획이 아닌 "다음" 계획으로 넘겨야 합니다.');
  perform pds_private.check_arg(v_plan.carried_from_review_id is null, '그 계획은 이미 다른 고칠 점을 넘겨받았습니다.');
  perform pds_private.check_arg(not exists (select 1 from public.plans where carried_from_review_id = p_review_id),
                                '이 고칠 점은 이미 다른 계획으로 넘어갔습니다.');

  update public.plans set carried_from_review_id = p_review_id where id = p_plan_id returning * into v_plan;
  return to_jsonb(v_plan) || jsonb_build_object('created', true);
end
$$;

-- 할 일 만들기
create or replace function public.create_task(
  p_plan_id           bigint,
  p_title             text,
  p_note              text,
  p_due_date          date,
  p_priority          smallint,
  p_tags              text[],
  p_estimated_minutes integer,
  p_request_key       uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      public.tasks;
  v_tags text[] := pds_private.clean_tags(p_tags);
begin
  if p_request_key is not null then
    select * into v from public.tasks where request_key = p_request_key;
    if found then
      return to_jsonb(v) || jsonb_build_object('created', false);
    end if;
  end if;

  perform pds_private.check_arg(exists (select 1 from public.plans where id = p_plan_id), '계획을 찾을 수 없습니다.');
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_title), '')) between 1 and 200,
                                '할 일 내용은 1~200자로 적어 주세요.');
  perform pds_private.check_arg(p_note is null or char_length(p_note) <= 2000, '메모는 2000자 이내로 적어 주세요.');
  perform pds_private.check_arg(p_priority between 1 and 3, '우선순위는 1(높음)~3(낮음) 가운데 하나입니다.');
  perform pds_private.check_arg(pds_private.tags_ok(v_tags), '태그는 10개까지, 하나에 20자까지 넣을 수 있습니다.');
  perform pds_private.check_arg(p_estimated_minutes between 0 and 100000, '예상 시간은 0분 이상으로 적어 주세요.');

  insert into public.tasks (plan_id, title, note, due_date, priority, tags, estimated_minutes, request_key)
  values (p_plan_id, pds_private.clean_text(p_title), pds_private.clean_text(p_note), p_due_date,
          p_priority, v_tags, p_estimated_minutes, p_request_key)
  returning * into v;

  return to_jsonb(v) || jsonb_build_object('created', true);
end
$$;

-- 할 일 고치기
create or replace function public.update_task(
  p_id                bigint,
  p_title             text,
  p_note              text,
  p_due_date          date,
  p_priority          smallint,
  p_tags              text[],
  p_estimated_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      public.tasks;
  v_tags text[] := pds_private.clean_tags(p_tags);
begin
  select * into v from public.tasks where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = format('할 일 #%s을(를) 찾을 수 없습니다.', p_id);
  end if;
  perform pds_private.check_arg(v.deleted_at is null, '지운 할 일은 고칠 수 없습니다. 먼저 되살려 주세요.');
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_title), '')) between 1 and 200,
                                '할 일 내용은 1~200자로 적어 주세요.');
  perform pds_private.check_arg(p_note is null or char_length(p_note) <= 2000, '메모는 2000자 이내로 적어 주세요.');
  perform pds_private.check_arg(p_priority between 1 and 3, '우선순위는 1(높음)~3(낮음) 가운데 하나입니다.');
  perform pds_private.check_arg(pds_private.tags_ok(v_tags), '태그는 10개까지, 하나에 20자까지 넣을 수 있습니다.');
  perform pds_private.check_arg(p_estimated_minutes between 0 and 100000, '예상 시간은 0분 이상으로 적어 주세요.');

  update public.tasks
     set title             = pds_private.clean_text(p_title),
         note              = pds_private.clean_text(p_note),
         due_date          = p_due_date,
         priority          = p_priority,
         tags              = v_tags,
         estimated_minutes = p_estimated_minutes
   where id = p_id
  returning * into v;

  return to_jsonb(v);
end
$$;

-- 완료로 바꾸기: 같은 요청 키로 여러 번 와도, 이미 완료 상태여도 완료 기록은 한 건만 남습니다.
create or replace function public.complete_task(p_id bigint, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
  v_done public.task_completions;
begin
  perform pds_private.check_arg(p_request_key is not null, '요청 키가 없습니다.');

  -- 같은 할 일에 대한 요청은 여기서 한 줄로 줄 세웁니다(동시에 두 번 와도 차례대로 처리).
  select * into v_task from public.tasks where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = format('할 일 #%s을(를) 찾을 수 없습니다.', p_id);
  end if;
  perform pds_private.check_arg(v_task.deleted_at is null, '지운 할 일은 완료할 수 없습니다.');

  -- (1) 이미 처리한 요청 키면 그때 결과를 그대로 돌려줍니다.
  select * into v_done from public.task_completions where request_key = p_request_key;
  if found then
    perform pds_private.check_arg(v_done.task_id = p_id, '이 요청 키는 다른 할 일에 이미 쓰였습니다.');
    return jsonb_build_object('task', to_jsonb(v_task), 'completion', to_jsonb(v_done), 'created', false);
  end if;

  -- (2) 이미 완료 상태면 새 기록을 만들지 않습니다.
  select * into v_done from public.task_completions where task_id = p_id and reverted_at is null;
  if found then
    return jsonb_build_object('task', to_jsonb(v_task), 'completion', to_jsonb(v_done), 'created', false);
  end if;

  -- (3) 처음 온 요청만 기록합니다. (DB 제약 task_completions_one_active가 마지막 안전장치)
  insert into public.task_completions (task_id, request_key)
  values (p_id, p_request_key)
  returning * into v_done;

  update public.tasks
     set status = 'done', completed_at = v_done.completed_at
   where id = p_id
  returning * into v_task;

  return jsonb_build_object('task', to_jsonb(v_task), 'completion', to_jsonb(v_done), 'created', true);
end
$$;

-- 완료한 할 일을 다시 진행 중으로 되돌리기 (완료 기록은 지우지 않고 reverted_at을 채움)
create or replace function public.reopen_task(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  select * into v_task from public.tasks where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = format('할 일 #%s을(를) 찾을 수 없습니다.', p_id);
  end if;
  perform pds_private.check_arg(v_task.deleted_at is null, '지운 할 일은 되돌릴 수 없습니다.');

  update public.task_completions set reverted_at = now()
   where task_id = p_id and reverted_at is null;

  update public.tasks set status = 'open', completed_at = null
   where id = p_id
  returning * into v_task;

  return jsonb_build_object('task', to_jsonb(v_task));
end
$$;

-- 할 일 지우기 (행은 남기고 deleted_at을 채움 → 집계에서 빠짐)
create or replace function public.delete_task(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.tasks;
begin
  update public.tasks set deleted_at = coalesce(deleted_at, now())
   where id = p_id
  returning * into v;
  if not found then
    raise exception using errcode = 'P0002', message = format('할 일 #%s을(를) 찾을 수 없습니다.', p_id);
  end if;
  return to_jsonb(v);
end
$$;

-- 지운 할 일 되살리기
create or replace function public.restore_task(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.tasks;
begin
  update public.tasks set deleted_at = null
   where id = p_id
  returning * into v;
  if not found then
    raise exception using errcode = 'P0002', message = format('할 일 #%s을(를) 찾을 수 없습니다.', p_id);
  end if;
  return to_jsonb(v);
end
$$;

-- 실행 기록 남기기 (계획·할 일의 예상 값은 건드리지 않음)
create or replace function public.add_run_log(
  p_task_id        bigint,
  p_started_at     timestamptz,
  p_ended_at       timestamptz,
  p_actual_minutes integer,
  p_blocked_reason text,
  p_note           text,
  p_request_key    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v        public.run_logs;
  v_span   integer;
  v_actual integer;
begin
  if p_request_key is not null then
    select * into v from public.run_logs where request_key = p_request_key;
    if found then
      return to_jsonb(v) || jsonb_build_object('created', false);
    end if;
  end if;

  perform pds_private.check_arg(exists (select 1 from public.tasks where id = p_task_id and deleted_at is null),
                                '기록을 붙일 할 일을 찾을 수 없습니다(지운 할 일에는 붙일 수 없음).');
  perform pds_private.check_arg(p_started_at is not null and p_ended_at is not null, '시작 시각과 끝난 시각을 모두 넣어 주세요.');
  perform pds_private.check_arg(p_ended_at >= p_started_at, '끝난 시각은 시작 시각과 같거나 뒤여야 합니다.');
  perform pds_private.check_arg(p_ended_at - p_started_at <= interval '24 hours', '기록 하나는 24시간을 넘길 수 없습니다.');

  v_span   := ceil(extract(epoch from (p_ended_at - p_started_at)) / 60.0)::integer;
  v_actual := coalesce(p_actual_minutes, round(extract(epoch from (p_ended_at - p_started_at)) / 60.0)::integer);
  perform pds_private.check_arg(v_actual >= 0, '실제로 걸린 시간은 0분 이상이어야 합니다.');
  perform pds_private.check_arg(v_actual <= v_span,
                                format('실제로 걸린 시간(%s분)이 시작~끝 사이(%s분)보다 길 수 없습니다.', v_actual, v_span));
  perform pds_private.check_arg(p_blocked_reason is null or char_length(p_blocked_reason) <= 500,
                                '막혔던 이유는 500자 이내로 적어 주세요.');
  perform pds_private.check_arg(p_note is null or char_length(p_note) <= 1000, '메모는 1000자 이내로 적어 주세요.');

  insert into public.run_logs (task_id, started_at, ended_at, actual_minutes, blocked_reason, note, request_key)
  values (p_task_id, p_started_at, p_ended_at, v_actual,
          pds_private.clean_text(p_blocked_reason), pds_private.clean_text(p_note), p_request_key)
  returning * into v;

  return to_jsonb(v) || jsonb_build_object('created', true);
end
$$;

-- 실행 기록 취소 (행은 남기고 deleted_at을 채움 → 집계에서 빠짐)
create or replace function public.delete_run_log(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.run_logs;
begin
  update public.run_logs set deleted_at = coalesce(deleted_at, now())
   where id = p_id
  returning * into v;
  if not found then
    raise exception using errcode = 'P0002', message = format('실행 기록 #%s을(를) 찾을 수 없습니다.', p_id);
  end if;
  return to_jsonb(v);
end
$$;

-- 돌아보기 저장 (저장하는 순간의 집계를 stats에 함께 남김)
create or replace function public.add_review(
  p_plan_id     bigint,
  p_reflection  text,
  p_next_fix    text,
  p_request_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v   public.reviews;
  v_s jsonb;
begin
  if p_request_key is not null then
    select * into v from public.reviews where request_key = p_request_key;
    if found then
      return to_jsonb(v) || jsonb_build_object('created', false);
    end if;
  end if;

  perform pds_private.check_arg(exists (select 1 from public.plans where id = p_plan_id), '계획을 찾을 수 없습니다.');
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_next_fix), '')) between 1 and 200,
                                '다음 계획으로 넘길 고칠 점을 한 줄(1~200자)로 적어 주세요.');
  perform pds_private.check_arg(p_reflection is null or char_length(p_reflection) <= 2000,
                                '돌아본 내용은 2000자 이내로 적어 주세요.');

  v_s := pds_private.plan_summary(p_plan_id);

  insert into public.reviews (plan_id, reflection, next_fix, stats, request_key)
  values (p_plan_id, pds_private.clean_text(p_reflection), pds_private.clean_text(p_next_fix),
          jsonb_build_object(
            'today_kst',         v_s -> 'today_kst',
            'planned',           v_s -> 'planned' -> 'count',
            'done',              v_s -> 'done' -> 'count',
            'overdue',           v_s -> 'overdue' -> 'count',
            'blocked',           v_s -> 'blocked' -> 'count',
            'estimated_minutes', v_s -> 'estimated_minutes' -> 'sum',
            'actual_minutes',    v_s -> 'actual_minutes' -> 'sum',
            'diff_minutes',      v_s -> 'diff_minutes'),
          p_request_key)
  returning * into v;

  return to_jsonb(v) || jsonb_build_object('created', true);
end
$$;


-- 7) 권한 --------------------------------------------------------------------
--    · 표: 브라우저 역할(anon, authenticated)은 직접 접근하지 않습니다. RLS도 켜 둡니다.
--    · 함수: PostgreSQL이 기본으로 PUBLIC에 주는 실행 권한을 걷고, 아래 RPC만 엽니다.

alter table public.plans            enable row level security;
alter table public.plan_revisions   enable row level security;
alter table public.tasks            enable row level security;
alter table public.task_completions enable row level security;
alter table public.run_logs         enable row level security;
alter table public.reviews          enable row level security;

revoke all on table
  public.plans, public.plan_revisions, public.tasks,
  public.task_completions, public.run_logs, public.reviews
  from public, anon, authenticated;

revoke all on all sequences in schema public from anon, authenticated;

revoke all on all functions in schema pds_private from public, anon, authenticated;

revoke all on function
  public.ping(),
  public.list_plans(),
  public.get_plan_bundle(bigint),
  public.review_summary(bigint),
  public.export_all(),
  public.create_plan(text, text, date, date, smallint, integer, bigint, uuid),
  public.update_plan(bigint, integer, text, text, date, date, smallint, integer, text),
  public.carry_review(bigint, bigint),
  public.create_task(bigint, text, text, date, smallint, text[], integer, uuid),
  public.update_task(bigint, text, text, date, smallint, text[], integer),
  public.complete_task(bigint, uuid),
  public.reopen_task(bigint),
  public.delete_task(bigint),
  public.restore_task(bigint),
  public.add_run_log(bigint, timestamptz, timestamptz, integer, text, text, uuid),
  public.delete_run_log(bigint),
  public.add_review(bigint, text, text, uuid)
  from public;

grant usage on schema public to anon, authenticated;

grant execute on function
  public.ping(),
  public.list_plans(),
  public.get_plan_bundle(bigint),
  public.review_summary(bigint),
  public.export_all(),
  public.create_plan(text, text, date, date, smallint, integer, bigint, uuid),
  public.update_plan(bigint, integer, text, text, date, date, smallint, integer, text),
  public.carry_review(bigint, bigint),
  public.create_task(bigint, text, text, date, smallint, text[], integer, uuid),
  public.update_task(bigint, text, text, date, smallint, text[], integer),
  public.complete_task(bigint, uuid),
  public.reopen_task(bigint),
  public.delete_task(bigint),
  public.restore_task(bigint),
  public.add_run_log(bigint, timestamptz, timestamptz, integer, text, text, uuid),
  public.delete_run_log(bigint),
  public.add_review(bigint, text, text, uuid)
  to anon, authenticated;

-- Data API가 새 함수를 바로 알아보도록 스키마 캐시를 다시 읽게 합니다.
notify pgrst, 'reload schema';

-- 끝. 아래 결과가 17이면 RPC 함수가 모두 만들어진 것입니다.
select count(*) as rpc_functions_ready
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('ping','list_plans','get_plan_bundle','review_summary','export_all',
                    'create_plan','update_plan','carry_review','create_task','update_task',
                    'complete_task','reopen_task','delete_task','restore_task',
                    'add_run_log','delete_run_log','add_review');
