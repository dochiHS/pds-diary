-- =============================================================================
-- 플랜두씨 다이어리 2 (ALEPH T07) · Supabase 스키마 pds-schema-v3
--   T06 최종 제출(pds-schema-v2, commit c55e544c1bfd8b0485017e11dafa9d7fc9a10eec)에
--   가입·로그인(Supabase Auth)을 이어 붙인 판입니다.
--
-- 실행 방법
--   Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣기 → Run
--   · T06 DB 위에 그대로 실행하면 T07로 올라갑니다. 표와 자료는 그대로 두고
--     주인 칸(owner_id)·함수·권한만 바뀝니다. 빈 DB에 실행해도 되고, 다시 실행해도 안전합니다.
--   · 마지막 결과가 rpc_functions_ready = 23, anon_can_call = ping 이면 성공입니다.
--   · T06 자료를 내 계정으로 옮기는 일은 앱에서 가입한 뒤 supabase/claim_t06_rows.sql로 한 번만 합니다.
--
-- T07에서 바뀐 것
--   1) 누가 요청했는지는 Supabase Auth가 발급한 토큰(JWT)으로만 정합니다.
--      모든 함수는 맨 앞에서 pds_private.require_user()를 부릅니다. 이 함수는
--        ① 토큰의 사용자 ID(sub)를 꺼내고
--        ② 토큰에 적힌 session_id가 auth.sessions에 아직 있는지 확인합니다.
--      로그아웃하거나 비밀번호를 바꾸면 Supabase Auth가 그 세션 행을 지우므로,
--      같은 토큰으로 다시 요청해도 401(로그인이 끝났습니다)로 거절됩니다.
--   2) 모든 표에 owner_id(주인)를 붙였습니다. 함수는 "id = 요청한 id AND owner_id = 토큰의 사용자"로만 찾습니다.
--      남의 자료든 없는 자료든 똑같이 404(찾을 수 없습니다)로 답해, 있는지 없는지조차 알려 주지 않습니다.
--      부모·자식 표는 (id, owner_id) 짝으로 연결해, 주인이 다른 자식 행은 DB가 만들지 못하게 막습니다.
--   3) 로그인하지 않은 브라우저 역할(anon)은 ping() 말고는 어떤 함수도 부를 수 없습니다(401).
--   4) 할 일에 "할 날·시간대"를 더했고, 5일 관찰(질문·지표·단위·계산 규칙을 1일차에 고정 →
--      서로 다른 날짜 5일 기록 → 2일차 뒤·3일차 앞에 계획 규칙 한 번 변경) 표와 함수를 더했습니다.
--   5) 계정 삭제: 내 자료를 모두 지우고 auth.users의 내 계정도 지웁니다(세션도 함께 사라짐).
--
-- 그대로인 규칙(T06)
--   · 날짜(date)는 서울 달력 날짜, 시각(timestamptz)은 절대 시각으로 저장하고 화면은 서울 시간(KST)으로 보여 줍니다.
--   · 시간 값(*_minutes)은 모두 '분' 단위 정수입니다.
--   · 계획을 고치면 고치기 전 판이 plan_revisions에 쌓입니다(고치거나 지울 수 없음 — 계정을 지울 때만 함께 지워짐).
-- =============================================================================

begin;

-- 0) 미리 확인 -----------------------------------------------------------------
--    이 스크립트를 실행하는 역할(SQL Editor의 postgres)이 auth 표를 읽고 참조할 수 있어야 합니다.
do $$
begin
  if not has_table_privilege('auth.sessions', 'SELECT') then
    raise exception 'auth.sessions를 읽을 권한이 없습니다(로그아웃 확인에 필요). SQL Editor에서 실행했는지 확인하세요.';
  end if;
  if not has_table_privilege('auth.users', 'SELECT') or not has_table_privilege('auth.users', 'REFERENCES') then
    raise exception 'auth.users를 읽거나 참조할 권한이 없습니다. SQL Editor에서 실행했는지 확인하세요.';
  end if;
  if not has_table_privilege('auth.users', 'DELETE') then
    raise warning 'auth.users를 지울 권한이 없습니다. 계정 삭제(delete_my_account)가 실패할 수 있습니다.';
  end if;
end
$$;


-- 1) 내부 전용 스키마와 도우미 함수 ----------------------------------------------
--    Data API에 노출하지 않는 도우미는 pds_private에 둡니다.
create schema if not exists pds_private;
revoke all on schema pds_private from public;
revoke all on schema pds_private from anon, authenticated;

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

-- HTTP 상태 코드를 정해서 오류를 냅니다(PostgREST의 RAISE SQLSTATE 'PGRST' 약속).
create or replace function pds_private.http_error(p_status integer, p_code text, p_message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise sqlstate 'PGRST' using
    message = json_build_object('code', p_code, 'message', p_message, 'details', null, 'hint', null)::text,
    detail  = json_build_object('status', p_status, 'headers', json_build_object())::text;
end
$$;

-- 404: 남의 자료와 없는 자료를 같은 문구로 답합니다(있는지 없는지 알려 주지 않음).
create or replace function pds_private.not_found(p_message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pds_private.http_error(404, 'PDS404', p_message);
end
$$;

-- ★ 요청한 사람 확인 — 모든 공개 함수가 맨 앞에서 부릅니다.
--   ① 토큰(JWT)이 로그인 사용자 것인지(role = authenticated, sub = 사용자 ID)
--   ② 토큰의 session_id가 auth.sessions에 아직 살아 있는지
--      (로그아웃·비밀번호 변경·계정 삭제 때 Supabase Auth가 세션 행을 지움 → 같은 토큰도 401)
--   토큰의 서명과 만료(exp)는 Data API(PostgREST)가 이 함수보다 먼저 확인합니다.
create or replace function pds_private.require_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_uid    uuid;
  v_sid    uuid;
begin
  begin
    v_uid := (v_claims ->> 'sub')::uuid;
    v_sid := (v_claims ->> 'session_id')::uuid;
  exception when invalid_text_representation then
    v_uid := null;
    v_sid := null;
  end;

  if v_uid is null or coalesce(v_claims ->> 'role', '') <> 'authenticated' then
    perform pds_private.http_error(401, 'PDS401', '로그인이 필요합니다.');
  end if;

  if v_sid is null or not exists (
       select 1 from auth.sessions s where s.id = v_sid and s.user_id = v_uid) then
    perform pds_private.http_error(401, 'PDS401',
      '로그인이 끝났습니다(로그아웃했거나 비밀번호가 바뀌었습니다). 다시 로그인해 주세요.');
  end if;

  return v_uid;
end
$$;


-- 2) 표 ----------------------------------------------------------------------
--    T06 표는 이미 있으면 건너뜁니다. T07에서 더한 칸·제약은 아래에서 따로 붙입니다.

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

-- 계획 수정 이력: 계획을 고칠 때마다 "고치기 전" 판이 한 줄씩 쌓입니다.
create table if not exists public.plan_revisions (
  id                bigint generated always as identity primary key,
  plan_id           bigint      not null references public.plans(id) on delete cascade,
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
  plan_id           bigint      not null references public.plans(id) on delete cascade,
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
  task_id      bigint      not null references public.tasks(id) on delete cascade,
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
  task_id        bigint      not null references public.tasks(id) on delete cascade,
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
  plan_id     bigint      not null references public.plans(id) on delete cascade,
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
      foreign key (carried_from_review_id) references public.reviews(id) on delete cascade;
  end if;
end
$$;

-- 2-1) T07: 주인 칸 ----------------------------------------------------------
--   T06에서 넘어온 행은 주인이 비어 있다가(아무도 못 봄) claim_t06_rows로 내 계정에 옮겨집니다.
alter table public.plans            add column if not exists owner_id uuid;
alter table public.plan_revisions   add column if not exists owner_id uuid;
alter table public.tasks            add column if not exists owner_id uuid;
alter table public.task_completions add column if not exists owner_id uuid;
alter table public.run_logs         add column if not exists owner_id uuid;
alter table public.reviews          add column if not exists owner_id uuid;

-- 2-2) T07: 할 일에 "할 날·시간대" (3일차 전에 바꾸는 계획 규칙을 앱 안에서 지킬 수 있게)
alter table public.tasks add column if not exists planned_on   date;
alter table public.tasks add column if not exists planned_slot text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_planned_slot') then
    alter table public.tasks add constraint tasks_planned_slot
      check (planned_slot is null or (planned_slot in ('아침', '오전', '오후', '저녁', '밤') and planned_on is not null));
  end if;
end
$$;

-- 2-3) T07: 표 사이 연결을 RESTRICT → CASCADE로 (T06 DB를 올릴 때)
--   계정을 지울 때 그 계정의 자료가 한 번에 지워지게 하려는 것입니다.
--   화면·API에는 계획·돌아보기를 지우는 기능이 없으므로 평소 동작은 그대로입니다.
do $$
declare
  r record;
begin
  for r in select * from (values
      ('plan_revisions',   'plan_revisions_plan_id_fkey',   'plan_id',                'plans'),
      ('tasks',            'tasks_plan_id_fkey',            'plan_id',                'plans'),
      ('task_completions', 'task_completions_task_id_fkey', 'task_id',                'tasks'),
      ('run_logs',         'run_logs_task_id_fkey',         'task_id',                'tasks'),
      ('reviews',          'reviews_plan_id_fkey',          'plan_id',                'plans'),
      ('plans',            'plans_carried_from_review_fk',  'carried_from_review_id', 'reviews')
    ) as v(tbl, con, col, ref)
  loop
    if exists (select 1 from pg_constraint where conname = r.con and confdeltype <> 'c') then
      execute format('alter table public.%I drop constraint %I', r.tbl, r.con);
    end if;
    if not exists (select 1 from pg_constraint where conname = r.con) then
      execute format('alter table public.%I add constraint %I foreign key (%I) references public.%I(id) on delete cascade',
                     r.tbl, r.con, r.col, r.ref);
    end if;
  end loop;
end
$$;

-- 2-4) T07: 주인 → auth.users (계정이 지워지면 자료도 함께 지워짐), 주인별 찾기 색인
do $$
declare
  t text;
begin
  foreach t in array array['plans', 'plan_revisions', 'tasks', 'task_completions', 'run_logs', 'reviews'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_owner_fk') then
      execute format('alter table public.%I add constraint %I foreign key (owner_id) references auth.users(id) on delete cascade',
                     t, t || '_owner_fk');
    end if;
    execute format('create index if not exists %I on public.%I(owner_id)', t || '_owner_idx', t);
  end loop;
end
$$;

-- 2-5) T07: 부모와 자식의 주인이 같아야만 연결되게 (id, owner_id) 짝으로 한 번 더 묶습니다.
--   함수에 실수가 있어도 "남의 계획에 내 할 일"이나 "내 계획에 남의 기록" 같은 행은 DB가 만들지 않습니다.
do $$
declare
  r record;
begin
  for r in select * from (values ('plans'), ('tasks'), ('reviews')) as v(tbl) loop
    if not exists (select 1 from pg_constraint where conname = r.tbl || '_id_owner_key') then
      execute format('alter table public.%I add constraint %I unique (id, owner_id)', r.tbl, r.tbl || '_id_owner_key');
    end if;
  end loop;
  for r in select * from (values
      ('plan_revisions',   'plan_revisions_same_owner_fk',   'plan_id',                'plans'),
      ('tasks',            'tasks_same_owner_fk',            'plan_id',                'plans'),
      ('task_completions', 'task_completions_same_owner_fk', 'task_id',                'tasks'),
      ('run_logs',         'run_logs_same_owner_fk',         'task_id',                'tasks'),
      ('reviews',          'reviews_same_owner_fk',          'plan_id',                'plans'),
      ('plans',            'plans_carried_same_owner_fk',    'carried_from_review_id', 'reviews')
    ) as v(tbl, con, col, ref)
  loop
    if not exists (select 1 from pg_constraint where conname = r.con) then
      execute format('alter table public.%I add constraint %I foreign key (%I, owner_id) references public.%I(id, owner_id) on delete cascade',
                     r.tbl, r.con, r.col, r.ref);
    end if;
  end loop;
end
$$;

-- 2-6) T07: 5일 관찰 --------------------------------------------------------
-- 관찰 설정: 1일차 전에 한 번 정합니다(질문·지표·단위·계산 규칙·빠짐·중복·튐·반올림·주 시작 요일·바꾸기 전 계획 규칙).
--   1일차 기록이 생기면 트리거가 고치지 못하게 막습니다. 한 사람에 관찰 하나.
create table if not exists public.observations (
  id               bigint generated always as identity primary key,
  owner_id         uuid        not null references auth.users(id) on delete cascade,
  question         text        not null,
  metric           text        not null,
  unit             text        not null,
  calc_rule        text        not null,
  missing_rule     text        not null,
  duplicate_rule   text        not null,
  outlier_rule     text        not null,
  rounding_rule    text        not null,
  week_start       text        not null,
  plan_rule_before text        not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint observations_one_per_owner unique (owner_id),
  constraint observations_id_owner_key  unique (id, owner_id),
  constraint observations_question_len  check (char_length(question) between 1 and 200),
  constraint observations_rule_len      check (char_length(plan_rule_before) between 1 and 300)
);

-- 하루 기록: 서버가 정한 그날(서울) 날짜로만 들어가고, 값은 기록 버튼을 누른 순간 서버가 다이어리에서 셉니다.
create table if not exists public.observation_days (
  id               bigint generated always as identity primary key,
  observation_id   bigint      not null,
  owner_id         uuid        not null references auth.users(id) on delete cascade,
  day_no           smallint    not null,
  day_date         date        not null,
  value            integer     not null,
  counted_task_ids bigint[]    not null default '{}'::bigint[],
  note             text,
  recorded_at      timestamptz not null default now(),
  recount_count    integer     not null default 0,
  recounted_at     timestamptz,
  constraint observation_days_obs_fk      foreign key (observation_id, owner_id)
                                          references public.observations(id, owner_id) on delete cascade,
  constraint observation_days_one_per_day unique (observation_id, day_date),
  constraint observation_days_one_per_no  unique (observation_id, day_no),
  constraint observation_days_id_owner_key unique (id, owner_id),
  constraint observation_days_no          check (day_no between 1 and 5),
  constraint observation_days_value       check (value >= 0),
  constraint observation_days_note_len    check (note is null or char_length(note) <= 300)
);

-- 계획 규칙 변경: 관찰마다 딱 한 번. 1일차·2일차 기록을 정확히 가리키고, 2일차 뒤·3일차 앞에만 만들 수 있습니다.
create table if not exists public.observation_rule_changes (
  id             bigint generated always as identity primary key,
  observation_id bigint      not null,
  owner_id       uuid        not null references auth.users(id) on delete cascade,
  rule_before    text        not null,
  rule_after     text        not null,
  reason         text        not null,
  after_day1_id  bigint      not null,
  after_day2_id  bigint      not null,
  changed_at     timestamptz not null default now(),
  constraint rule_changes_obs_fk   foreign key (observation_id, owner_id)
                                   references public.observations(id, owner_id) on delete cascade,
  constraint rule_changes_day1_fk  foreign key (after_day1_id, owner_id)
                                   references public.observation_days(id, owner_id) on delete cascade,
  constraint rule_changes_day2_fk  foreign key (after_day2_id, owner_id)
                                   references public.observation_days(id, owner_id) on delete cascade,
  constraint rule_changes_once     unique (observation_id),
  constraint rule_changes_after_len  check (char_length(rule_after) between 1 and 300),
  constraint rule_changes_reason_len check (char_length(reason) between 1 and 300)
);
create index if not exists observation_days_owner_idx on public.observation_days(owner_id);
create index if not exists rule_changes_owner_idx on public.observation_rule_changes(owner_id);


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
    (plan_id, owner_id, revision, title, success_criteria, start_date, end_date, priority,
     estimated_minutes, valid_from, replaced_at, change_reason)
  values
    (old.id, old.owner_id, old.revision, old.title, old.success_criteria, old.start_date, old.end_date, old.priority,
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

-- 수정 이력은 한 번 쌓이면 고치거나 지울 수 없습니다. 예외는 두 가지뿐입니다.
--   · 계정을 지울 때(그 계정의 이력만): delete_my_account가 pds.purge_owner를 켜거나, auth.users에서 계정이 이미 지워진 경우
--   · T06 자료를 내 계정으로 옮길 때: 주인 칸만 비어 있던 것을 채우는 경우(pds.claim)
create or replace function pds_private.block_history_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.owner_id is not null and (
         current_setting('pds.purge_owner', true) = old.owner_id::text
         or not exists (select 1 from auth.users u where u.id = old.owner_id)) then
      return old;
    end if;
  elsif current_setting('pds.claim', true) = 'on'
        and old.owner_id is null and new.owner_id is not null
        and (to_jsonb(new) - 'owner_id') = (to_jsonb(old) - 'owner_id') then
    return new;
  end if;
  raise exception using errcode = '42501', message = '계획 수정 이력은 고치거나 지울 수 없습니다.';
end
$$;

drop trigger if exists plan_revisions_append_only on public.plan_revisions;
create trigger plan_revisions_append_only
  before update or delete on public.plan_revisions
  for each row execute function pds_private.block_history_change();

-- 할 일을 고치면 updated_at을 갱신합니다. (T06 자료를 옮길 때 주인 칸만 채우는 경우는 그대로 둠)
create or replace function pds_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('pds.claim', true) = 'on' and old.owner_id is null and new.owner_id is not null then
    return new;
  end if;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function pds_private.touch_updated_at();

-- 5일 관찰 기록 지키기
--   · 관찰 설정: 1일차 기록이 생긴 뒤에는 고칠 수 없음(1일차에 고정)
--   · 하루 기록: 날짜·차례·기록 시각은 못 바꿈(같은 날 다시 세기는 값·다시 센 횟수만 바뀜)
--   · 규칙 변경: 고칠 수 없음
--   · 지우기: 계정을 지울 때만
create or replace function pds_private.observation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('pds.purge_owner', true) = old.owner_id::text
       or not exists (select 1 from auth.users u where u.id = old.owner_id) then
      return old;
    end if;
    raise exception using errcode = '42501', message = '관찰 기록은 지울 수 없습니다(계정을 지울 때만 함께 지워집니다).';
  end if;

  if tg_table_name = 'observations' then
    if exists (select 1 from public.observation_days d where d.observation_id = old.id) then
      raise exception using errcode = '42501',
        message = '1일차 기록이 생긴 뒤에는 질문·지표·단위·계산 규칙·계획 규칙을 바꿀 수 없습니다(1일차에 고정).';
    end if;
    if (new.id, new.owner_id, new.created_at) is distinct from (old.id, old.owner_id, old.created_at) then
      raise exception using errcode = '42501', message = '관찰의 주인·ID·만든 시각은 바꿀 수 없습니다.';
    end if;
    new.updated_at := now();
    return new;
  elsif tg_table_name = 'observation_days' then
    if (new.id, new.observation_id, new.owner_id, new.day_no, new.day_date, new.recorded_at)
       is distinct from (old.id, old.observation_id, old.owner_id, old.day_no, old.day_date, old.recorded_at) then
      raise exception using errcode = '42501', message = '기록의 날짜·차례·기록 시각은 바꿀 수 없습니다.';
    end if;
    return new;
  end if;

  raise exception using errcode = '42501', message = '계획 규칙 변경 기록은 고칠 수 없습니다.';
end
$$;

drop trigger if exists observations_guard on public.observations;
create trigger observations_guard
  before update or delete on public.observations
  for each row execute function pds_private.observation_guard();
drop trigger if exists observation_days_guard on public.observation_days;
create trigger observation_days_guard
  before update or delete on public.observation_days
  for each row execute function pds_private.observation_guard();
drop trigger if exists rule_changes_guard on public.observation_rule_changes;
create trigger rule_changes_guard
  before update or delete on public.observation_rule_changes
  for each row execute function pds_private.observation_guard();


-- 4) 집계 ---------------------------------------------------------------------

-- 4-1) 돌아보기 (T06과 같은 정의 · 부르는 쪽 함수가 먼저 주인을 확인)
--   대상 할 일   = 이 계획에 딸린, 지우지 않은 할 일
--   계획 수      = 대상 할 일 수
--   완료 수      = 대상 할 일 중 지금 완료 상태인 수
--   지연 수      = 대상 할 일 중 완료되지 않았고 마감일 < 오늘(서울) 인 수 (완료한 할 일은 세지 않음)
--   막힘 수      = 대상 할 일 중 막힌 이유가 하나라도 적힌 실행 기록(취소 안 한 것)이 있는 수
--   예상 시간    = 대상 할 일의 예상 시간 합계 (분)
--   실제 시간    = 대상 할 일의 실행 기록(취소 안 한 것) 실제 시간 합계 (분)
--   차이         = 실제 시간 - 예상 시간 (분). 아무것도 없으면 0
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

-- 4-2) 5일 관찰의 고정 규칙 — 관찰을 시작하는 순간 이 문장들이 관찰 행에 그대로 복사되어 고정됩니다.
create or replace function pds_private.observation_rules()
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'metric',         '그날 끝낸 할 일 수',
    'unit',           '개',
    'calc_rule',      '기록 버튼을 누른 순간, 그날(서울 날짜 00:00~23:59)에 다이어리에서 ''완료''로 바꾼 할 일 수를 서버가 셉니다. '
                      || '관찰을 시작하기 전에 완료한 것, 되돌린 완료, 지운 할 일은 빼고, 같은 할 일은 한 번만 셉니다. '
                      || '어느 계획의 할 일이든 모두 셉니다.',
    'missing_rule',   '기록 버튼을 누르지 않은 날은 0으로 채우지 않고 5일에 넣지 않습니다. 다음에 기록한 날이 다음 차례(n일차)가 됩니다. '
                      || '완료가 하나도 없던 날에 기록하면 그날 값은 0(빠진 값이 아님)입니다.',
    'duplicate_rule', '같은 날짜 기록은 한 줄만 둡니다. 같은 날 다시 누르면 새 줄을 만들지 않고 그 줄의 값을 그 순간 다시 센 값으로 바꾸며, '
                      || '다시 센 횟수와 시각을 남깁니다. 지난 날짜는 다시 셀 수 없고, 계획 규칙을 바꾼 뒤에는 2일차도 다시 셀 수 없습니다.',
    'outlier_rule',   '어느 날 값이 나머지 날 평균의 2배를 넘으면 ''튐'' 표시를 붙입니다. 5일뿐이라 빼면 비교가 더 흔들리므로 '
                      || '합계·평균에서 빼지 않고 그대로 넣고, 그날 메모에 이유를 적습니다.',
    'rounding_rule',  '합계는 정수 그대로 둡니다. 평균과 평균의 차이는 나누기를 끝낸 뒤 마지막에 한 번만, '
                      || '소수 둘째 자리에서 반올림해 첫째 자리까지 보입니다(예: 11 ÷ 3 = 3.666… → 3.7, 0.25 → 0.3).',
    'week_start',     '월요일(ISO 8601). 주별 합계는 월요일~일요일로 나눕니다.',
    'default_question',         '할 일마다 할 날과 시간대를 미리 정해 두면, 하루에 끝내는 할 일이 늘어날까?',
    'default_plan_rule_before', '할 일에는 마감일만 적는다. 언제 할지는 따로 정하지 않는다.',
    'default_plan_rule_after',  '마감일만 적지 말고, 그 일을 할 날과 시간대를 같이 정한다.'
  )
$$;

-- 4-3) 그날(서울 날짜) 끝낸 할 일 — 관찰 시작(p_since) 뒤에 만든, 되돌리지 않은 완료 기록이 그날에 있는 할 일
--      (지운 할 일 제외, 할 일마다 한 번)
drop function if exists pds_private.done_on(uuid, date);
create or replace function pds_private.done_on(p_owner uuid, p_day date, p_since timestamptz)
returns table (task_id bigint, title text, plan_id bigint, completed_at timestamptz)
language sql stable
security definer
set search_path = ''
as $$
  select distinct on (t.id) t.id, t.title, t.plan_id, c.completed_at
  from public.task_completions c
  join public.tasks t on t.id = c.task_id and t.owner_id = p_owner
  where c.owner_id = p_owner
    and c.reverted_at is null
    and t.deleted_at is null
    and c.completed_at >= p_since
    and (c.completed_at at time zone 'Asia/Seoul')::date = p_day
  order by t.id, c.completed_at
$$;

-- 4-4) 5일 관찰 집계 — 합계·평균, 바꾸기 전(1~2일차)·뒤(3~5일차) 비교, 튄 날, 주별 합계(월요일 시작)
create or replace function pds_private.observation_summary(p_observation_id bigint)
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  with d as (
    select day_no, day_date, value from public.observation_days where observation_id = p_observation_id
  ),
  agg as (
    select count(*)                                    as n_all,
           coalesce(sum(value), 0)                     as s_all,
           count(*) filter (where day_no <= 2)         as n_before,
           coalesce(sum(value) filter (where day_no <= 2), 0) as s_before,
           count(*) filter (where day_no >= 3)         as n_after,
           coalesce(sum(value) filter (where day_no >= 3), 0) as s_after
    from d
  ),
  raw as (
    select agg.*,
           case when n_all    > 0 then s_all::numeric    / n_all    end as avg_all,
           case when n_before > 0 then s_before::numeric / n_before end as avg_before,
           case when n_after  > 0 then s_after::numeric  / n_after  end as avg_after
    from agg
  )
  select jsonb_build_object(
    'count', n_all,
    'sum',   s_all,
    'avg_raw', avg_all,
    'avg',     round(avg_all, 1),
    'before', jsonb_build_object('days', '1~2일차', 'count', n_before, 'sum', s_before,
                                 'avg_raw', avg_before, 'avg', round(avg_before, 1)),
    'after',  jsonb_build_object('days', '3~5일차', 'count', n_after, 'sum', s_after,
                                 'avg_raw', avg_after, 'avg', round(avg_after, 1)),
    'diff_avg', case when avg_before is not null and avg_after is not null
                     then round(avg_after - avg_before, 1) end,
    'spike_day_nos', coalesce((
        select jsonb_agg(d1.day_no order by d1.day_no)
        from d d1
        where n_all >= 2
          and d1.value > 2 * (select avg(d2.value) from d d2 where d2.day_no <> d1.day_no)), '[]'::jsonb),
    'weeks', coalesce((
        select jsonb_agg(jsonb_build_object('week_start', w.ws, 'count', w.n, 'sum', w.s) order by w.ws)
        from (select d.day_date - (extract(isodow from d.day_date)::int - 1) as ws, count(*) as n, sum(d.value) as s
              from d group by 1) w), '[]'::jsonb)
  )
  from raw
$$;


-- 5) 인자가 바뀐 T06 함수는 지우고 다시 만듭니다 ------------------------------------
drop function if exists public.list_plans();
drop function if exists public.get_plan_bundle(bigint);
drop function if exists public.export_all();
drop function if exists public.create_task(bigint, text, text, date, smallint, text[], integer, uuid);
drop function if exists public.update_task(bigint, text, text, date, smallint, text[], integer);


-- 6) 읽기 함수 (RPC) ----------------------------------------------------------

-- 살아 있는지 확인(keepalive용). 로그인 없이 부를 수 있는 유일한 함수라, 자료 수 같은 것은 돌려주지 않습니다.
create or replace function public.ping()
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'at', now())
$$;

-- 지금 로그인한 사람과 이 로그인(세션)의 정보. 토큰 원문은 돌려주지 않습니다.
create or replace function public.whoami()
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid  := pds_private.require_user();
  v_claims  jsonb := auth.jwt();
  v_email   text;
  v_created timestamptz;
  v_last    timestamptz;
  v_session timestamptz;
begin
  select u.email, u.created_at, u.last_sign_in_at into v_email, v_created, v_last
  from auth.users u where u.id = v_uid;
  select s.created_at into v_session
  from auth.sessions s where s.id = (v_claims ->> 'session_id')::uuid;
  return jsonb_build_object(
    'user_id',            v_uid,
    'email',              v_email,
    'account_created_at', v_created,
    'last_sign_in_at',    v_last,
    'session_id',         v_claims ->> 'session_id',
    'session_created_at', v_session,
    'token_issued_at',    to_timestamp((v_claims ->> 'iat')::double precision),
    'token_expires_at',   to_timestamp((v_claims ->> 'exp')::double precision),
    'server_time',        now());
end
$$;

-- 내 계획 목록.
--   p_owner_id는 받기만 하고 쓰지 않습니다. 주인은 토큰에서만 정합니다.
--   (주소·요청 본문에 남의 계정을 적어 보내도 내 자료만 돌아오는지 확인할 때 씁니다)
create or replace function public.list_plans(p_owner_id uuid default null)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := pds_private.require_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id',                     p.id,
             'title',                  p.title,
             'start_date',             p.start_date,
             'end_date',               p.end_date,
             'priority',               p.priority,
             'revision',               p.revision,
             'carried_from_review_id', p.carried_from_review_id,
             'task_count', (select count(*) from public.tasks t
                            where t.plan_id = p.id and t.owner_id = v_uid and t.deleted_at is null)
           ) order by p.id desc)
    from public.plans p
    where p.owner_id = v_uid), '[]'::jsonb);
end
$$;

-- 계획 하나에 딸린 모든 자료(계획·수정 이력·할 일·실행 기록·완료 기록·돌아보기·집계)를 한 번에.
--   내 계획이 아니면(없는 계획이어도) 404. p_owner_id는 받기만 하고 쓰지 않습니다.
create or replace function public.get_plan_bundle(p_plan_id bigint, p_owner_id uuid default null)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := pds_private.require_user();
  v_plan  public.plans;
  v_today date := pds_private.today_kst();
begin
  select * into v_plan from public.plans where id = p_plan_id and owner_id = v_uid;
  if not found then
    perform pds_private.not_found(format('계획 #%s을(를) 찾을 수 없습니다.', p_plan_id));
  end if;

  return jsonb_build_object(
    'today_kst',   v_today,
    'server_time', now(),
    'plan',        to_jsonb(v_plan),
    'revisions',   coalesce((
        select jsonb_agg(to_jsonb(r) order by r.revision)
        from public.plan_revisions r where r.plan_id = p_plan_id and r.owner_id = v_uid), '[]'::jsonb),
    'carried_review', (
        select jsonb_build_object('id', rv.id, 'plan_id', rv.plan_id, 'plan_title', p.title,
                                  'next_fix', rv.next_fix, 'created_at', rv.created_at)
        from public.reviews rv join public.plans p on p.id = rv.plan_id
        where rv.id = v_plan.carried_from_review_id and rv.owner_id = v_uid),
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
        from public.tasks t where t.plan_id = p_plan_id and t.owner_id = v_uid), '[]'::jsonb),
    'run_logs', coalesce((
        select jsonb_agg(to_jsonb(r) order by r.started_at desc, r.id desc)
        from public.run_logs r join public.tasks t on t.id = r.task_id
        where t.plan_id = p_plan_id and r.owner_id = v_uid), '[]'::jsonb),
    'completions', coalesce((
        select jsonb_agg(to_jsonb(c) order by c.id)
        from public.task_completions c join public.tasks t on t.id = c.task_id
        where t.plan_id = p_plan_id and c.owner_id = v_uid), '[]'::jsonb),
    'reviews', coalesce((
        select jsonb_agg(to_jsonb(rv) || jsonb_build_object(
                 'carried_to_plan', (select jsonb_build_object('id', p2.id, 'title', p2.title)
                                     from public.plans p2
                                     where p2.carried_from_review_id = rv.id and p2.owner_id = v_uid)
               ) order by rv.id desc)
        from public.reviews rv where rv.plan_id = p_plan_id and rv.owner_id = v_uid), '[]'::jsonb),
    'summary', pds_private.plan_summary(p_plan_id)
  );
end
$$;

create or replace function public.review_summary(p_plan_id bigint)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := pds_private.require_user();
begin
  if not exists (select 1 from public.plans where id = p_plan_id and owner_id = v_uid) then
    perform pds_private.not_found(format('계획 #%s을(를) 찾을 수 없습니다.', p_plan_id));
  end if;
  return pds_private.plan_summary(p_plan_id);
end
$$;

-- 내 자료 전체를 파일 하나(JSON)로. p_owner_id는 받기만 하고 쓰지 않습니다.
create or replace function public.export_all(p_owner_id uuid default null)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := pds_private.require_user();
begin
  return jsonb_build_object(
    'schema',       'pds-schema-v3',
    'exported_at',  now(),
    'account',      (select jsonb_build_object('user_id', u.id, 'email', u.email, 'created_at', u.created_at)
                     from auth.users u where u.id = v_uid),
    'rules', jsonb_build_object(
        'date',        'date 칸은 서울(Asia/Seoul) 달력 날짜 YYYY-MM-DD',
        'timestamptz', 'timestamptz 칸은 ISO 8601(UTC 오프셋 포함). 화면은 서울 시간(KST, UTC+9)으로 표시',
        'minutes',     '*_minutes 칸은 모두 분 단위 정수',
        'owner',       '모든 행의 owner_id는 이 파일을 내보낸 계정(account.user_id)입니다'),
    'plans',            coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.plans x where x.owner_id = v_uid), '[]'::jsonb),
    'plan_revisions',   coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.plan_revisions x where x.owner_id = v_uid), '[]'::jsonb),
    'tasks',            coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.tasks x where x.owner_id = v_uid), '[]'::jsonb),
    'task_completions', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.task_completions x where x.owner_id = v_uid), '[]'::jsonb),
    'run_logs',         coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.run_logs x where x.owner_id = v_uid), '[]'::jsonb),
    'reviews',          coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.reviews x where x.owner_id = v_uid), '[]'::jsonb),
    'observations',             coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.observations x where x.owner_id = v_uid), '[]'::jsonb),
    'observation_days',         coalesce((select jsonb_agg(to_jsonb(x) order by x.day_no) from public.observation_days x where x.owner_id = v_uid), '[]'::jsonb),
    'observation_rule_changes', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.observation_rule_changes x where x.owner_id = v_uid), '[]'::jsonb)
  );
end
$$;


-- 7) 쓰기 함수 (RPC) ----------------------------------------------------------

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
  v_uid uuid := pds_private.require_user();
  v     public.plans;
begin
  if p_request_key is not null then
    select * into v from public.plans where request_key = p_request_key and owner_id = v_uid;
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
    if not exists (select 1 from public.reviews where id = p_carried_from_review_id and owner_id = v_uid) then
      perform pds_private.not_found(format('돌아보기 #%s을(를) 찾을 수 없습니다.', p_carried_from_review_id));
    end if;
    perform pds_private.check_arg(not exists (select 1 from public.plans where carried_from_review_id = p_carried_from_review_id),
                                  '이 고칠 점은 이미 다른 계획으로 넘어갔습니다.');
  end if;

  insert into public.plans
    (owner_id, title, success_criteria, start_date, end_date, priority, estimated_minutes,
     carried_from_review_id, request_key)
  values
    (v_uid, pds_private.clean_text(p_title), pds_private.clean_text(p_success_criteria), p_start_date, p_end_date,
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
  v_uid uuid := pds_private.require_user();
  v     public.plans;
begin
  select * into v from public.plans where id = p_id and owner_id = v_uid for update;
  if not found then
    perform pds_private.not_found(format('계획 #%s을(를) 찾을 수 없습니다.', p_id));
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
   where id = p_id and owner_id = v_uid
  returning * into v;

  perform set_config('pds.change_reason', '', true);
  return to_jsonb(v);
end
$$;

-- 돌아보기의 고칠 점을 이미 있는 다른 계획으로 넘기기 (둘 다 내 것이어야 함)
create or replace function public.carry_review(p_review_id bigint, p_plan_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := pds_private.require_user();
  v_review public.reviews;
  v_plan   public.plans;
begin
  select * into v_review from public.reviews where id = p_review_id and owner_id = v_uid for update;
  if not found then
    perform pds_private.not_found(format('돌아보기 #%s을(를) 찾을 수 없습니다.', p_review_id));
  end if;
  select * into v_plan from public.plans where id = p_plan_id and owner_id = v_uid for update;
  if not found then
    perform pds_private.not_found(format('계획 #%s을(를) 찾을 수 없습니다.', p_plan_id));
  end if;

  if v_plan.carried_from_review_id = p_review_id then
    return to_jsonb(v_plan) || jsonb_build_object('created', false);  -- 이미 넘어간 상태(같은 요청 반복)
  end if;

  perform pds_private.check_arg(v_review.plan_id <> p_plan_id, '고칠 점은 돌아본 계획이 아닌 "다음" 계획으로 넘겨야 합니다.');
  perform pds_private.check_arg(v_plan.carried_from_review_id is null, '그 계획은 이미 다른 고칠 점을 넘겨받았습니다.');
  perform pds_private.check_arg(not exists (select 1 from public.plans where carried_from_review_id = p_review_id),
                                '이 고칠 점은 이미 다른 계획으로 넘어갔습니다.');

  update public.plans set carried_from_review_id = p_review_id
   where id = p_plan_id and owner_id = v_uid
  returning * into v_plan;
  return to_jsonb(v_plan) || jsonb_build_object('created', true);
end
$$;

-- 할 일 만들기 (T07: 할 날·시간대를 함께 적을 수 있음)
create or replace function public.create_task(
  p_plan_id           bigint,
  p_title             text,
  p_note              text,
  p_due_date          date,
  p_priority          smallint,
  p_tags              text[],
  p_estimated_minutes integer,
  p_planned_on        date   default null,
  p_planned_slot      text   default null,
  p_request_key       uuid   default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid   := pds_private.require_user();
  v      public.tasks;
  v_tags text[] := pds_private.clean_tags(p_tags);
  v_slot text   := pds_private.clean_text(p_planned_slot);
begin
  if p_request_key is not null then
    select * into v from public.tasks where request_key = p_request_key and owner_id = v_uid;
    if found then
      return to_jsonb(v) || jsonb_build_object('created', false);
    end if;
  end if;

  if not exists (select 1 from public.plans where id = p_plan_id and owner_id = v_uid) then
    perform pds_private.not_found(format('계획 #%s을(를) 찾을 수 없습니다.', p_plan_id));
  end if;
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_title), '')) between 1 and 200,
                                '할 일 내용은 1~200자로 적어 주세요.');
  perform pds_private.check_arg(p_note is null or char_length(p_note) <= 2000, '메모는 2000자 이내로 적어 주세요.');
  perform pds_private.check_arg(p_priority between 1 and 3, '우선순위는 1(높음)~3(낮음) 가운데 하나입니다.');
  perform pds_private.check_arg(pds_private.tags_ok(v_tags), '태그는 10개까지, 하나에 20자까지 넣을 수 있습니다.');
  perform pds_private.check_arg(p_estimated_minutes between 0 and 100000, '예상 시간은 0분 이상으로 적어 주세요.');
  perform pds_private.check_arg(v_slot is null or v_slot in ('아침', '오전', '오후', '저녁', '밤'),
                                '시간대는 아침·오전·오후·저녁·밤 가운데 하나입니다.');
  perform pds_private.check_arg(v_slot is null or p_planned_on is not null, '시간대를 고르려면 할 날도 함께 정해 주세요.');

  insert into public.tasks
    (owner_id, plan_id, title, note, due_date, priority, tags, estimated_minutes, planned_on, planned_slot, request_key)
  values
    (v_uid, p_plan_id, pds_private.clean_text(p_title), pds_private.clean_text(p_note), p_due_date,
     p_priority, v_tags, p_estimated_minutes, p_planned_on, v_slot, p_request_key)
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
  p_estimated_minutes integer,
  p_planned_on        date default null,
  p_planned_slot      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid   := pds_private.require_user();
  v      public.tasks;
  v_tags text[] := pds_private.clean_tags(p_tags);
  v_slot text   := pds_private.clean_text(p_planned_slot);
begin
  select * into v from public.tasks where id = p_id and owner_id = v_uid for update;
  if not found then
    perform pds_private.not_found(format('할 일 #%s을(를) 찾을 수 없습니다.', p_id));
  end if;
  perform pds_private.check_arg(v.deleted_at is null, '지운 할 일은 고칠 수 없습니다. 먼저 되살려 주세요.');
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_title), '')) between 1 and 200,
                                '할 일 내용은 1~200자로 적어 주세요.');
  perform pds_private.check_arg(p_note is null or char_length(p_note) <= 2000, '메모는 2000자 이내로 적어 주세요.');
  perform pds_private.check_arg(p_priority between 1 and 3, '우선순위는 1(높음)~3(낮음) 가운데 하나입니다.');
  perform pds_private.check_arg(pds_private.tags_ok(v_tags), '태그는 10개까지, 하나에 20자까지 넣을 수 있습니다.');
  perform pds_private.check_arg(p_estimated_minutes between 0 and 100000, '예상 시간은 0분 이상으로 적어 주세요.');
  perform pds_private.check_arg(v_slot is null or v_slot in ('아침', '오전', '오후', '저녁', '밤'),
                                '시간대는 아침·오전·오후·저녁·밤 가운데 하나입니다.');
  perform pds_private.check_arg(v_slot is null or p_planned_on is not null, '시간대를 고르려면 할 날도 함께 정해 주세요.');

  update public.tasks
     set title             = pds_private.clean_text(p_title),
         note              = pds_private.clean_text(p_note),
         due_date          = p_due_date,
         priority          = p_priority,
         tags              = v_tags,
         estimated_minutes = p_estimated_minutes,
         planned_on        = p_planned_on,
         planned_slot      = v_slot
   where id = p_id and owner_id = v_uid
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
  v_uid  uuid := pds_private.require_user();
  v_task public.tasks;
  v_done public.task_completions;
begin
  -- 같은 할 일에 대한 요청은 여기서 한 줄로 줄 세웁니다(동시에 두 번 와도 차례대로 처리).
  select * into v_task from public.tasks where id = p_id and owner_id = v_uid for update;
  if not found then
    perform pds_private.not_found(format('할 일 #%s을(를) 찾을 수 없습니다.', p_id));
  end if;
  perform pds_private.check_arg(p_request_key is not null, '요청 키가 없습니다.');
  perform pds_private.check_arg(v_task.deleted_at is null, '지운 할 일은 완료할 수 없습니다.');

  -- (1) 이미 처리한 요청 키면 그때 결과를 그대로 돌려줍니다.
  select * into v_done from public.task_completions where request_key = p_request_key and owner_id = v_uid;
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
  insert into public.task_completions (owner_id, task_id, request_key)
  values (v_uid, p_id, p_request_key)
  returning * into v_done;

  update public.tasks
     set status = 'done', completed_at = v_done.completed_at
   where id = p_id and owner_id = v_uid
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
  v_uid  uuid := pds_private.require_user();
  v_task public.tasks;
begin
  select * into v_task from public.tasks where id = p_id and owner_id = v_uid for update;
  if not found then
    perform pds_private.not_found(format('할 일 #%s을(를) 찾을 수 없습니다.', p_id));
  end if;
  perform pds_private.check_arg(v_task.deleted_at is null, '지운 할 일은 되돌릴 수 없습니다.');

  update public.task_completions set reverted_at = now()
   where task_id = p_id and owner_id = v_uid and reverted_at is null;

  update public.tasks set status = 'open', completed_at = null
   where id = p_id and owner_id = v_uid
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
  v_uid uuid := pds_private.require_user();
  v     public.tasks;
begin
  update public.tasks set deleted_at = coalesce(deleted_at, now())
   where id = p_id and owner_id = v_uid
  returning * into v;
  if not found then
    perform pds_private.not_found(format('할 일 #%s을(를) 찾을 수 없습니다.', p_id));
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
  v_uid uuid := pds_private.require_user();
  v     public.tasks;
begin
  update public.tasks set deleted_at = null
   where id = p_id and owner_id = v_uid
  returning * into v;
  if not found then
    perform pds_private.not_found(format('할 일 #%s을(를) 찾을 수 없습니다.', p_id));
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
  v_uid    uuid := pds_private.require_user();
  v        public.run_logs;
  v_task   public.tasks;
  v_span   integer;
  v_actual integer;
begin
  if p_request_key is not null then
    select * into v from public.run_logs where request_key = p_request_key and owner_id = v_uid;
    if found then
      return to_jsonb(v) || jsonb_build_object('created', false);
    end if;
  end if;

  select * into v_task from public.tasks where id = p_task_id and owner_id = v_uid;
  if not found then
    perform pds_private.not_found(format('할 일 #%s을(를) 찾을 수 없습니다.', p_task_id));
  end if;
  perform pds_private.check_arg(v_task.deleted_at is null, '지운 할 일에는 실행 기록을 붙일 수 없습니다.');
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

  insert into public.run_logs (owner_id, task_id, started_at, ended_at, actual_minutes, blocked_reason, note, request_key)
  values (v_uid, p_task_id, p_started_at, p_ended_at, v_actual,
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
  v_uid uuid := pds_private.require_user();
  v     public.run_logs;
begin
  update public.run_logs set deleted_at = coalesce(deleted_at, now())
   where id = p_id and owner_id = v_uid
  returning * into v;
  if not found then
    perform pds_private.not_found(format('실행 기록 #%s을(를) 찾을 수 없습니다.', p_id));
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
  v_uid uuid := pds_private.require_user();
  v     public.reviews;
  v_s   jsonb;
begin
  if p_request_key is not null then
    select * into v from public.reviews where request_key = p_request_key and owner_id = v_uid;
    if found then
      return to_jsonb(v) || jsonb_build_object('created', false);
    end if;
  end if;

  if not exists (select 1 from public.plans where id = p_plan_id and owner_id = v_uid) then
    perform pds_private.not_found(format('계획 #%s을(를) 찾을 수 없습니다.', p_plan_id));
  end if;
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_next_fix), '')) between 1 and 200,
                                '다음 계획으로 넘길 고칠 점을 한 줄(1~200자)로 적어 주세요.');
  perform pds_private.check_arg(p_reflection is null or char_length(p_reflection) <= 2000,
                                '돌아본 내용은 2000자 이내로 적어 주세요.');

  v_s := pds_private.plan_summary(p_plan_id);

  insert into public.reviews (owner_id, plan_id, reflection, next_fix, stats, request_key)
  values (v_uid, p_plan_id, pds_private.clean_text(p_reflection), pds_private.clean_text(p_next_fix),
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


-- 8) 5일 관찰 (RPC) -----------------------------------------------------------

-- 관찰 한눈에: 설정·하루 기록·규칙 변경·집계, 그리고 "오늘 기록하면 몇이 될지"(그 근거 할 일 목록)
create or replace function public.get_observation()
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := pds_private.require_user();
  v_obs   public.observations;
  v_today date := pds_private.today_kst();
  v_now   jsonb;
begin
  select * into v_obs from public.observations where owner_id = v_uid;
  if not found then
    return jsonb_build_object('observation', null, 'days', '[]'::jsonb, 'rule_change', null,
                              'summary', null, 'rules', pds_private.observation_rules(),
                              'today', jsonb_build_object('date', v_today, 'value', null, 'tasks', '[]'::jsonb),
                              'server_time', now());
  end if;

  select jsonb_build_object(
           'date',  v_today,
           'since', v_obs.created_at,
           'value', count(*),
           'tasks', coalesce(jsonb_agg(jsonb_build_object('task_id', d.task_id, 'title', d.title,
                                                          'plan_id', d.plan_id, 'completed_at', d.completed_at)
                                       order by d.completed_at, d.task_id), '[]'::jsonb))
    into v_now
  from pds_private.done_on(v_uid, v_today, v_obs.created_at) d;

  return jsonb_build_object(
    'observation', to_jsonb(v_obs),
    'days', coalesce((
        select jsonb_agg(to_jsonb(d) || jsonb_build_object(
                 'phase',      case when d.day_no <= 2 then 'before' else 'after' end,
                 'week_start', d.day_date - (extract(isodow from d.day_date)::int - 1),
                 'counted_tasks', coalesce((
                     select jsonb_agg(jsonb_build_object('task_id', t.id, 'title', t.title, 'plan_id', t.plan_id) order by t.id)
                     from public.tasks t where t.owner_id = v_uid and t.id = any(d.counted_task_ids)), '[]'::jsonb)
               ) order by d.day_no)
        from public.observation_days d where d.observation_id = v_obs.id and d.owner_id = v_uid), '[]'::jsonb),
    'rule_change', (select to_jsonb(c) from public.observation_rule_changes c
                    where c.observation_id = v_obs.id and c.owner_id = v_uid),
    'summary', pds_private.observation_summary(v_obs.id),
    'rules', pds_private.observation_rules(),
    'today', v_now,
    'server_time', now());
end
$$;

-- 관찰 시작(1일차 전에 한 번 정하기). 1일차 기록이 생기기 전까지는 다시 불러 고칠 수 있고, 그 뒤에는 고정됩니다.
--   지표·단위·계산 규칙·빠짐·중복·튐·반올림·주 시작 요일은 이 앱이 실제로 계산하는 방식 그대로 서버가 채웁니다.
create or replace function public.start_observation(p_question text, p_plan_rule_before text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid  := pds_private.require_user();
  v     public.observations;
  r     jsonb := pds_private.observation_rules();
begin
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_question), '')) between 1 and 200,
                                '5일 동안 답할 질문을 한 문장(1~200자)으로 적어 주세요.');
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_plan_rule_before), '')) between 1 and 300,
                                '지금(바꾸기 전) 계획 규칙을 1~300자로 적어 주세요.');

  select * into v from public.observations where owner_id = v_uid for update;
  if found then
    perform pds_private.check_arg(not exists (select 1 from public.observation_days d where d.observation_id = v.id),
                                  '1일차 기록이 있어 질문·계획 규칙을 바꿀 수 없습니다(1일차에 고정).');
    update public.observations
       set question = pds_private.clean_text(p_question),
           plan_rule_before = pds_private.clean_text(p_plan_rule_before),
           metric = r ->> 'metric', unit = r ->> 'unit', calc_rule = r ->> 'calc_rule',
           missing_rule = r ->> 'missing_rule', duplicate_rule = r ->> 'duplicate_rule',
           outlier_rule = r ->> 'outlier_rule', rounding_rule = r ->> 'rounding_rule',
           week_start = r ->> 'week_start'
     where id = v.id
    returning * into v;
    return to_jsonb(v) || jsonb_build_object('created', false);
  end if;

  insert into public.observations
    (owner_id, question, metric, unit, calc_rule, missing_rule, duplicate_rule, outlier_rule,
     rounding_rule, week_start, plan_rule_before)
  values
    (v_uid, pds_private.clean_text(p_question), r ->> 'metric', r ->> 'unit', r ->> 'calc_rule',
     r ->> 'missing_rule', r ->> 'duplicate_rule', r ->> 'outlier_rule', r ->> 'rounding_rule',
     r ->> 'week_start', pds_private.clean_text(p_plan_rule_before))
  returning * into v;
  return to_jsonb(v) || jsonb_build_object('created', true);
end
$$;

-- 오늘 기록 남기기: 날짜는 서버의 오늘(서울), 값은 지금 이 순간 서버가 다이어리 완료 기록에서 센 수.
--   · 같은 날 다시 부르면 새 줄 대신 그 줄을 다시 센 값으로 바꿈(다시 센 횟수·시각 남김)
--   · 5일을 넘길 수 없음 · 3일차는 계획 규칙을 바꾼 뒤에만 · 날짜는 앞 기록보다 뒤
create or replace function public.record_observation_day(p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := pds_private.require_user();
  v_obs     public.observations;
  v_day     public.observation_days;
  v_today   date := pds_private.today_kst();
  v_ids     bigint[];
  v_count   integer;
  v_last    date;
  v_changed boolean;
begin
  select * into v_obs from public.observations where owner_id = v_uid for update;
  if not found then
    perform pds_private.check_arg(false, '먼저 5일 관찰을 시작하세요(질문과 지금 계획 규칙 정하기).');
  end if;
  perform pds_private.check_arg(p_note is null or char_length(p_note) <= 300, '메모는 300자 이내로 적어 주세요.');

  select coalesce(array_agg(d.task_id order by d.task_id), '{}'::bigint[]) into v_ids
  from pds_private.done_on(v_uid, v_today, v_obs.created_at) d;

  select count(*), max(day_date) into v_count, v_last
  from public.observation_days where observation_id = v_obs.id;
  v_changed := exists (select 1 from public.observation_rule_changes where observation_id = v_obs.id);

  select * into v_day from public.observation_days
   where observation_id = v_obs.id and day_date = v_today for update;
  if found then
    perform pds_private.check_arg(not (v_day.day_no = 2 and v_changed),
                                  '계획 규칙을 바꾼 뒤에는 2일차 값을 다시 셀 수 없습니다.');
    update public.observation_days
       set value            = cardinality(v_ids),
           counted_task_ids = v_ids,
           recount_count    = recount_count + 1,
           recounted_at     = now(),
           note             = coalesce(pds_private.clean_text(p_note), note)
     where id = v_day.id
    returning * into v_day;
    return to_jsonb(v_day) || jsonb_build_object('created', false);
  end if;

  perform pds_private.check_arg(v_count < 5, '5일 기록을 모두 채웠습니다.');
  perform pds_private.check_arg(not (v_count = 2 and not v_changed),
                                '3일차를 적기 전에 계획 규칙을 먼저 한 번 바꾸세요.');
  perform pds_private.check_arg(v_last is null or v_today > v_last, '기록 날짜는 앞 기록보다 뒤여야 합니다.');

  insert into public.observation_days (observation_id, owner_id, day_no, day_date, value, counted_task_ids, note)
  values (v_obs.id, v_uid, v_count + 1, v_today, cardinality(v_ids), v_ids, pds_private.clean_text(p_note))
  returning * into v_day;
  return to_jsonb(v_day) || jsonb_build_object('created', true);
end
$$;

-- 계획 규칙 바꾸기: 딱 한 번, 2일차를 적은 뒤·3일차를 적기 전에만. 바꾼 시각은 서버 시각.
create or replace function public.change_plan_rule(p_rule_after text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := pds_private.require_user();
  v_obs   public.observations;
  v_d1    public.observation_days;
  v_d2    public.observation_days;
  v_count integer;
  v       public.observation_rule_changes;
begin
  select * into v_obs from public.observations where owner_id = v_uid for update;
  if not found then
    perform pds_private.check_arg(false, '먼저 5일 관찰을 시작하세요.');
  end if;
  perform pds_private.check_arg(not exists (select 1 from public.observation_rule_changes where observation_id = v_obs.id),
                                '계획 규칙은 한 번만 바꿉니다(이미 바꿨습니다).');
  select count(*) into v_count from public.observation_days where observation_id = v_obs.id;
  perform pds_private.check_arg(v_count = 2,
    format('계획 규칙은 2일차를 적은 뒤, 3일차를 적기 전에 바꿉니다(지금 %s일차까지 적음).', v_count));
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_rule_after), '')) between 1 and 300,
                                '바꾼 계획 규칙을 1~300자로 적어 주세요.');
  perform pds_private.check_arg(char_length(coalesce(pds_private.clean_text(p_reason), '')) between 1 and 300,
                                '바꾼 이유를 1~300자로 적어 주세요.');
  perform pds_private.check_arg(pds_private.clean_text(p_rule_after) is distinct from v_obs.plan_rule_before,
                                '바꾼 규칙이 바꾸기 전 규칙과 같습니다.');

  select * into v_d1 from public.observation_days where observation_id = v_obs.id and day_no = 1;
  select * into v_d2 from public.observation_days where observation_id = v_obs.id and day_no = 2;

  insert into public.observation_rule_changes
    (observation_id, owner_id, rule_before, rule_after, reason, after_day1_id, after_day2_id)
  values
    (v_obs.id, v_uid, v_obs.plan_rule_before, pds_private.clean_text(p_rule_after), pds_private.clean_text(p_reason),
     v_d1.id, v_d2.id)
  returning * into v;
  return to_jsonb(v);
end
$$;


-- 9) 계정 ---------------------------------------------------------------------

-- 계정 삭제: 내 자료(계획·수정 이력·할 일·완료 기록·실행 기록·돌아보기·관찰 기록)를 모두 지우고
--   auth.users의 내 계정을 지웁니다. auth.sessions·auth.refresh_tokens도 함께 지워지므로 쓰던 토큰은 곧바로 401이 됩니다.
--   되살릴 수 없습니다. 실수로 누르지 않도록 확인 문구 '계정 삭제'를 받아야 실행합니다.
create or replace function public.delete_my_account(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := pds_private.require_user();
  v_counts jsonb;
begin
  perform pds_private.check_arg(p_confirm = '계정 삭제', '확인 칸에 "계정 삭제"라고 정확히 적어 주세요.');

  v_counts := jsonb_build_object(
    'plans',                    (select count(*) from public.plans            where owner_id = v_uid),
    'plan_revisions',           (select count(*) from public.plan_revisions   where owner_id = v_uid),
    'tasks',                    (select count(*) from public.tasks            where owner_id = v_uid),
    'task_completions',         (select count(*) from public.task_completions where owner_id = v_uid),
    'run_logs',                 (select count(*) from public.run_logs         where owner_id = v_uid),
    'reviews',                  (select count(*) from public.reviews          where owner_id = v_uid),
    'observations',             (select count(*) from public.observations     where owner_id = v_uid),
    'observation_days',         (select count(*) from public.observation_days where owner_id = v_uid),
    'observation_rule_changes', (select count(*) from public.observation_rule_changes where owner_id = v_uid));

  perform set_config('pds.purge_owner', v_uid::text, true);
  delete from public.observations where owner_id = v_uid;   -- 하루 기록·규칙 변경도 함께
  delete from public.plans        where owner_id = v_uid;   -- 수정 이력·할 일·완료·실행 기록·돌아보기도 함께
  delete from auth.users          where id = v_uid;         -- 세션·리프레시 토큰도 함께
  perform set_config('pds.purge_owner', '', true);

  return jsonb_build_object('deleted', v_counts, 'user_id', v_uid, 'deleted_at', now());
end
$$;


-- 10) T06 자료를 내 계정으로 옮기기 (SQL Editor에서 한 번만: supabase/claim_t06_rows.sql)
--   주인이 비어 있는 T06 행을 그 이메일로 가입한 계정으로 옮기고, 남은 빈 주인이 없으면 주인 칸을 NOT NULL로 잠급니다.
--   API로는 부를 수 없습니다(pds_private).
create or replace function pds_private.claim_t06_rows(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  n1    integer;
  n2    integer;
  n     integer;
  t     text;
  v     jsonb;
begin
  select u.id into v_uid from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_uid is null then
    raise exception '그 이메일로 가입한 계정이 없습니다. 앱에서 먼저 가입한 뒤 다시 실행하세요.';
  end if;

  perform set_config('pds.claim', 'on', true);
  -- 계획 ↔ 돌아보기는 서로 가리킬 수 있어서(고칠 점 넘기기) 주인이 정해진 쪽부터 차례로 옮깁니다.
  loop
    update public.plans p set owner_id = v_uid
     where p.owner_id is null
       and (p.carried_from_review_id is null
            or exists (select 1 from public.reviews r where r.id = p.carried_from_review_id and r.owner_id = v_uid));
    get diagnostics n1 = row_count;
    update public.reviews r set owner_id = v_uid
     where r.owner_id is null
       and exists (select 1 from public.plans p where p.id = r.plan_id and p.owner_id = v_uid);
    get diagnostics n2 = row_count;
    exit when n1 = 0 and n2 = 0;
  end loop;
  update public.plan_revisions x set owner_id = v_uid
   where x.owner_id is null and exists (select 1 from public.plans p where p.id = x.plan_id and p.owner_id = v_uid);
  update public.tasks x set owner_id = v_uid
   where x.owner_id is null and exists (select 1 from public.plans p where p.id = x.plan_id and p.owner_id = v_uid);
  update public.task_completions x set owner_id = v_uid
   where x.owner_id is null and exists (select 1 from public.tasks k where k.id = x.task_id and k.owner_id = v_uid);
  update public.run_logs x set owner_id = v_uid
   where x.owner_id is null and exists (select 1 from public.tasks k where k.id = x.task_id and k.owner_id = v_uid);
  perform set_config('pds.claim', '', true);

  v := jsonb_build_object('user_id', v_uid,
    'plans',            (select count(*) from public.plans            where owner_id = v_uid),
    'plan_revisions',   (select count(*) from public.plan_revisions   where owner_id = v_uid),
    'tasks',            (select count(*) from public.tasks            where owner_id = v_uid),
    'task_completions', (select count(*) from public.task_completions where owner_id = v_uid),
    'run_logs',         (select count(*) from public.run_logs         where owner_id = v_uid),
    'reviews',          (select count(*) from public.reviews          where owner_id = v_uid));

  foreach t in array array['plans', 'plan_revisions', 'tasks', 'task_completions', 'run_logs', 'reviews'] loop
    execute format('select count(*) from public.%I where owner_id is null', t) into n;
    if n = 0 then
      execute format('alter table public.%I alter column owner_id set not null', t);
    end if;
    v := v || jsonb_build_object(t || '_without_owner', n);
  end loop;
  return v;
end
$$;


-- 11) 권한 --------------------------------------------------------------------
--    · 표: 브라우저 역할(anon, authenticated)은 직접 읽거나 쓰지 않습니다. RLS도 켜 둡니다(정책 없음 = 모두 거절).
--    · 함수: PostgreSQL이 기본으로 PUBLIC에 주는 실행 권한과 Supabase가 자동으로 주는 권한을 모두 걷고,
--            로그인한 역할(authenticated)에만 아래 RPC를 엽니다. 로그인 안 한 역할(anon)은 ping()만.

alter table public.plans                    enable row level security;
alter table public.plan_revisions           enable row level security;
alter table public.tasks                    enable row level security;
alter table public.task_completions         enable row level security;
alter table public.run_logs                 enable row level security;
alter table public.reviews                  enable row level security;
alter table public.observations             enable row level security;
alter table public.observation_days         enable row level security;
alter table public.observation_rule_changes enable row level security;

revoke all on table
  public.plans, public.plan_revisions, public.tasks, public.task_completions, public.run_logs, public.reviews,
  public.observations, public.observation_days, public.observation_rule_changes
  from public, anon, authenticated;

revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema pds_private from public, anon, authenticated;

grant usage on schema public to anon, authenticated;

grant execute on function public.ping() to anon, authenticated;

grant execute on function
  public.whoami(),
  public.list_plans(uuid),
  public.get_plan_bundle(bigint, uuid),
  public.review_summary(bigint),
  public.export_all(uuid),
  public.create_plan(text, text, date, date, smallint, integer, bigint, uuid),
  public.update_plan(bigint, integer, text, text, date, date, smallint, integer, text),
  public.carry_review(bigint, bigint),
  public.create_task(bigint, text, text, date, smallint, text[], integer, date, text, uuid),
  public.update_task(bigint, text, text, date, smallint, text[], integer, date, text),
  public.complete_task(bigint, uuid),
  public.reopen_task(bigint),
  public.delete_task(bigint),
  public.restore_task(bigint),
  public.add_run_log(bigint, timestamptz, timestamptz, integer, text, text, uuid),
  public.delete_run_log(bigint),
  public.add_review(bigint, text, text, uuid),
  public.get_observation(),
  public.start_observation(text, text),
  public.record_observation_day(text),
  public.change_plan_rule(text, text),
  public.delete_my_account(text)
  to authenticated;

-- Data API가 새 함수를 바로 알아보도록 스키마 캐시를 다시 읽게 합니다.
notify pgrst, 'reload schema';

commit;

-- 끝. rpc_functions_ready = 23, anon_can_call = ping 이면 성공입니다.
--     t06_rows_without_owner는 claim_t06_rows를 실행하기 전까지 T06 계획 수(2)로 보입니다.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('ping', 'whoami', 'list_plans', 'get_plan_bundle', 'review_summary', 'export_all',
                        'create_plan', 'update_plan', 'carry_review', 'create_task', 'update_task',
                        'complete_task', 'reopen_task', 'delete_task', 'restore_task',
                        'add_run_log', 'delete_run_log', 'add_review',
                        'get_observation', 'start_observation', 'record_observation_day', 'change_plan_rule',
                        'delete_my_account')) as rpc_functions_ready,
  (select string_agg(p.proname, ', ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_can_call,
  (select count(*) from public.plans where owner_id is null) as t06_rows_without_owner;
