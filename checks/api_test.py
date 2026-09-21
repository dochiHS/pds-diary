"""T07 API 검사 — 로컬 "Supabase 흉내"(PostgREST + 가입·로그인 흉내 서버) 위에서 돌립니다.

  · 가입·로그인·로그아웃·비밀번호 변경 (카드 1~3)
  · 로그아웃·비밀번호 변경 뒤 같은 토큰 거절 (카드 3)
  · 남의 자료 읽기·수정·삭제 양방향 거절, 주인 바꿔치기, 목록 섞임 (카드 4)
  · T06 자료를 내 계정으로 옮기기(claim)와 옮긴 뒤 값이 그대로인지 (카드 1 C100)
  · 5일 관찰: 고정·5일·규칙 변경 순서·합계/평균·튐 (카드 5)
  · 계정 삭제 (카드 5 C134)

실행: ./reset_db.sh && ./start_stack.sh && python3 checks/api_test.py
"""
import base64, datetime, json, os, shlex, subprocess, sys, urllib.error, urllib.request, uuid

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8080")
KEY = "sb_publishable_localtest_0123456789"
PSQL = shlex.split(os.environ.get("PSQL", "psql -h /tmp -p 54322 -U postgres -d pds")) + ["-At", "-v", "ON_ERROR_STOP=1", "-c"]
SNAP = json.load(open(os.environ.get("SNAPSHOT", "/home/claude/t07/t06_snapshot_before_t07.json")))
results = []


def http(method, path, body=None, token=None, headers=None):
    h = {"apikey": KEY, "Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    h.update(headers or {})
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, (json.loads(raw) if raw else None)
        except json.JSONDecodeError:
            return e.code, raw


def rpc(fn, args=None, token=None, headers=None, get=False, query=""):
    if get:
        return http("GET", f"/rest/v1/rpc/{fn}{query}", None, token, headers)
    return http("POST", f"/rest/v1/rpc/{fn}{query}", args or {}, token, headers)


def sql(q):
    return subprocess.check_output(PSQL + [q]).decode().strip()


def check(cid, name, cond, detail=""):
    results.append((cid, name, bool(cond), str(detail)[:500]))
    print(("PASS " if cond else "FAIL ") + f"{cid} {name}" + ("" if cond else f"  -- {str(detail)[:500]}"))


def signup(email, pw):
    return http("POST", "/auth/v1/signup", {"email": email, "password": pw})


def login(email, pw):
    return http("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": pw})


def jwt_payload(tok):
    p = tok.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


def set_today(d):
    sql("delete from pds_test.fake_today" if d is None else f"delete from pds_test.fake_today; insert into pds_test.fake_today values ('{d}')")


run = uuid.uuid4().hex[:6]
EA, EB, EC = f"t07-a-{run}@example.com", f"t07-b-{run}@example.com", f"t07-c-{run}@example.com"
PW = "Pw" + uuid.uuid4().hex[:10] + "7"          # A·B는 일부러 같은 비밀번호 (저장된 값이 달라야 함)
PWC = "Cw" + uuid.uuid4().hex[:10] + "3"
kst_today = (datetime.datetime.utcnow() + datetime.timedelta(hours=9)).date()
D = lambda n: (kst_today + datetime.timedelta(days=n)).isoformat()
set_today(None)

# ---------------------------------------------------------------- 카드 1: 가입·로그인·로그아웃
st, sa = signup(EA, PW)
check("C94", "가입 화면(API)에서 새 계정 만들기", st == 200 and sa.get("access_token") and sa.get("refresh_token"), f"{st} {sa}")
st, sb = signup(EB, PW)
check("C94b", "두 번째 계정 만들기(같은 비밀번호)", st == 200, f"{st} {sb}")
st, dup = signup(EA.upper(), PW)
check("C98", "같은 이메일로 두 번 가입되지 않음(대소문자 달라도)", st == 422 and dup.get("error_code") == "user_already_exists", f"{st} {dup}")
st, weak = signup(f"t07-w-{run}@example.com", "short1")
check("PW", "약한 비밀번호 가입 거절", st == 422 and weak.get("error_code") == "weak_password", f"{st} {weak}")
st, la = login(EA, PW)
check("C95", "만든 계정으로 로그인", st == 200 and la.get("access_token"), f"{st} {la}")
st1, bad1 = login(EA, PW + "x")
st2, bad2 = login(f"nobody-{run}@example.com", PW)
check("C99", "비밀번호만 틀림 / 아이디 없음 — 같은 상태·같은 문구",
      st1 == st2 == 400 and bad1 == bad2 and bad1.get("error_code") == "invalid_credentials", f"{st1} {bad1} | {st2} {bad2}")
UA, UB = sa["user"]["id"], sb["user"]["id"]
TA, TB = la["access_token"], sb["access_token"]
pa = jwt_payload(TA)
check("C108", "토큰(JWT)에 사용자 ID·세션 ID·만료가 있음", pa["sub"] == UA and pa.get("session_id") and pa["role"] == "authenticated", pa)
check("C111", "토큰 만료 시각 = 발급 + 3600초", pa["exp"] - pa["iat"] == 3600, pa)

# 비밀번호 저장 모습 (카드 2)
rows = sql(f"select email || '|' || encrypted_password from auth.users where email in ('{EA}','{EB}') order by email").splitlines()
ha, hb = rows[0].split("|")[1], rows[1].split("|")[1]
check("C103", "저장된 비밀번호에 입력한 글자가 보이지 않음(bcrypt)", ha.startswith("$2") and PW not in ha and len(ha) == 60, ha[:7])
check("C104", "같은 비밀번호로 만든 두 계정의 저장값이 다름(소금값)", ha != hb and ha[7:29] != hb[7:29], f"{ha[:29]} / {hb[:29]}")

# ---------------------------------------------------------------- 로그인 안 한 요청 (카드 4 C124)
for fn, args in [("list_plans", {}), ("get_plan_bundle", {"p_plan_id": 1}), ("export_all", {}), ("whoami", {}),
                 ("create_plan", {"p_title": "x", "p_success_criteria": "y", "p_start_date": D(0), "p_end_date": D(1),
                                  "p_priority": 2, "p_estimated_minutes": 10}),
                 ("get_observation", {}), ("delete_my_account", {"p_confirm": "계정 삭제"})]:
    st, body = rpc(fn, args)
    check("C124", f"로그인 없이 {fn} → 401", st == 401, f"{st} {body}")
st, body = rpc("ping")
check("PING", "로그인 없이 ping만 200, 자료 수는 안 알려 줌", st == 200 and set(body) == {"ok", "at"}, body)
st, body = http("GET", "/rest/v1/plans?select=*", token=TA)
check("TBL", "표 직접 읽기 거절(로그인해도)", st in (401, 403, 404), f"{st} {body}")

# ---------------------------------------------------------------- 로그아웃 뒤 같은 토큰 (카드 3)
st, who = rpc("whoami", token=TA)
check("C109a", "로그인 상태: whoami 200", st == 200 and who["user_id"] == UA, f"{st} {who}")
st, _ = http("POST", "/auth/v1/logout?scope=local", token=TA)
check("C96", "로그아웃 204", st == 204, st)
st, after = rpc("whoami", token=TA)
check("C109", "로그아웃 뒤 같은 토큰·같은 주소·같은 방식 → 401", st == 401 and after.get("code") == "PDS401", f"{st} {after}")
st, after2 = rpc("list_plans", token=TA)
check("C114a", "로그아웃 뒤 같은 토큰으로 목록도 401", st == 401, f"{st} {after2}")
st, la2 = login(EA, PW)
TA = la2["access_token"]

# 비밀번호 변경 → 이전 세션 토큰 무효 (카드 3 C114)
st, sc = signup(EC, PWC)
UC = sc["user"]["id"]
st, c1 = login(EC, PWC)
st, c2 = login(EC, PWC)
TC1, TC2 = c1["access_token"], c2["access_token"]
st, _ = rpc("whoami", token=TC1)
check("C114b", "변경 전: 세션1 토큰 200", st == 200, st)
NEWPWC = "Nw" + uuid.uuid4().hex[:10] + "9"
st, upd = http("PUT", "/auth/v1/user", {"password": NEWPWC}, token=TC2)
check("C114c", "세션2에서 비밀번호 변경 200", st == 200, f"{st} {upd}")
st, r1 = rpc("whoami", token=TC1)
check("C114", "비밀번호 변경 뒤 세션1의 예전 토큰 → 401", st == 401 and r1.get("code") == "PDS401", f"{st} {r1}")
st, _ = http("POST", "/auth/v1/logout?scope=global", token=TC2)
st, r2 = rpc("whoami", token=TC2)
check("C114d", "변경 후 전체 로그아웃 → 세션2 토큰도 401", st == 401, f"{st} {r2}")
st, old = login(EC, PWC)
st2, new = login(EC, NEWPWC)
check("C114e", "예전 비밀번호 로그인 400 / 새 비밀번호 200", st == 400 and st2 == 200, f"{st} {st2}")
TC = new["access_token"]

# 위조·만료 토큰
fake = jwt_payload(TA)
fake["sub"] = UB
parts = TA.split(".")
forged = parts[0] + "." + base64.urlsafe_b64encode(json.dumps(fake).encode()).decode().rstrip("=") + "." + parts[2]
st, fb = rpc("list_plans", token=forged)
check("C123-token", "토큰 안의 사용자 ID를 B로 바꾸면(서명 불일치) 401", st == 401, f"{st} {fb}")

# ---------------------------------------------------------------- 카드 4: 계정 두 개에 자료 넣기
def mk_plan(tok, title):
    return rpc("create_plan", {"p_title": title, "p_success_criteria": "시험 자료", "p_start_date": D(0), "p_end_date": D(4),
                               "p_priority": 2, "p_estimated_minutes": 60, "p_request_key": str(uuid.uuid4())}, tok)


def mk_task(tok, plan_id, title):
    return rpc("create_task", {"p_plan_id": plan_id, "p_title": title, "p_note": None, "p_due_date": D(2), "p_priority": 2,
                               "p_tags": ["시험"], "p_estimated_minutes": 30, "p_request_key": str(uuid.uuid4())}, tok)


st, PA = mk_plan(TA, "A의 시험 계획")
st, TA1 = mk_task(TA, PA["id"], "A의 할 일 1")
st, TA2 = mk_task(TA, PA["id"], "A의 할 일 2")
st, LA = rpc("add_run_log", {"p_task_id": TA1["id"], "p_started_at": f"{D(0)}T09:00:00+09:00", "p_ended_at": f"{D(0)}T09:30:00+09:00",
                            "p_actual_minutes": 30, "p_blocked_reason": None, "p_note": None, "p_request_key": str(uuid.uuid4())}, TA)
st, PB = mk_plan(TB, "B의 시험 계획")
st, TB1 = mk_task(TB, PB["id"], "B의 할 일 1")
check("C116", "계정 두 개에 각각 자료 넣기", PA.get("id") and TA1.get("id") and LA.get("id") and PB.get("id") and TB1.get("id"),
      f"{PA} {TB1}")

def snapshot(tok):
    st, ex = rpc("export_all", token=tok)
    return {k: ex[k] for k in ("plans", "tasks", "run_logs", "task_completions", "reviews")}

before_a, before_b = snapshot(TA), snapshot(TB)

attacks = [
    ("C117", "읽기", "get_plan_bundle", {"p_plan_id": None}),
    ("C117", "읽기(집계)", "review_summary", {"p_plan_id": None}),
    ("C118", "수정(할 일)", "update_task", {"p_id": None, "p_title": "남이 고침", "p_note": None, "p_due_date": None, "p_priority": 1,
                                        "p_tags": [], "p_estimated_minutes": 1}),
    ("C118", "수정(계획)", "update_plan", {"p_id": None, "p_expected_revision": None, "p_title": "남이 고침", "p_success_criteria": "x",
                                       "p_start_date": D(0), "p_end_date": D(1), "p_priority": 1, "p_estimated_minutes": 1}),
    ("C118", "수정(완료로 바꾸기)", "complete_task", {"p_id": None, "p_request_key": None}),
    ("C118", "수정(남의 할 일에 기록 붙이기)", "add_run_log", {"p_task_id": None, "p_started_at": f"{D(0)}T10:00:00+09:00",
                                                    "p_ended_at": f"{D(0)}T10:10:00+09:00", "p_actual_minutes": 10,
                                                    "p_blocked_reason": None, "p_note": None}),
    ("C118", "수정(남의 계획에 할 일 넣기)", "create_task", {"p_plan_id": None, "p_title": "끼워넣기", "p_note": None, "p_due_date": None,
                                                  "p_priority": 2, "p_tags": [], "p_estimated_minutes": 0}),
    ("C119", "삭제(할 일)", "delete_task", {"p_id": None}),
    ("C119", "삭제(실행 기록)", "delete_run_log", {"p_id": None}),
]


def aim(args, plan_id, task_id, log_id):
    a = dict(args)
    for k in list(a):
        if a[k] is None and k in ("p_plan_id",):
            a[k] = plan_id
        elif a[k] is None and k in ("p_id", "p_task_id"):
            a[k] = task_id
        elif a[k] is None and k == "p_request_key":
            a[k] = str(uuid.uuid4())
    return a


for direction, tok, victim_plan, victim_task, victim_log in [
        ("A→B", TA, PB["id"], TB1["id"], None),
        ("B→A", TB, PA["id"], TA1["id"], LA["id"])]:
    for cid, what, fn, args in attacks:
        a = aim(args, victim_plan, victim_task, victim_log)
        if fn == "update_plan":
            a["p_id"] = victim_plan
        if fn == "delete_run_log":
            if victim_log is None:
                continue
            a["p_id"] = victim_log
        st, body = rpc(fn, a, tok)
        check(cid if direction == "A→B" else "C120", f"{direction} {what}: {fn} → 404",
              st == 404 and body.get("code") == "PDS404", f"{st} {body}")

after_a, after_b = snapshot(TA), snapshot(TB)
check("C122", "공격 앞뒤로 A·B 자료가 한 글자도 안 바뀜", before_a == after_a and before_b == after_b,
      f"A {before_a == after_a} B {before_b == after_b}")
st, nx = rpc("get_plan_bundle", {"p_plan_id": 999999}, TA)
st2, fr = rpc("get_plan_bundle", {"p_plan_id": PB["id"]}, TA)
check("C121", "없는 계획과 남의 계획이 같은 404(존재 자체를 감춤)",
      st == st2 == 404 and nx["code"] == fr["code"] == "PDS404" and "찾을 수 없습니다" in nx["message"] and "찾을 수 없습니다" in fr["message"],
      f"{nx} | {fr}")

# 주소·헤더·본문에 남의 계정을 적어 보내기 (C123)
ida = sorted(p["id"] for p in rpc("list_plans", token=TA)[1])
st, q1 = rpc("list_plans", token=TA, get=True, query=f"?p_owner_id={UB}")
check("C123-url", "주소에 B 계정 → A 자료만", st == 200 and sorted(p["id"] for p in q1) == ida and PB["id"] not in [p["id"] for p in q1], f"{st} {q1}")
st, q2 = rpc("list_plans", {}, TA, headers={"X-Owner-Id": UB, "X-User-Id": UB})
check("C123-header", "헤더에 B 계정 → A 자료만", st == 200 and sorted(p["id"] for p in q2) == ida, f"{st} {q2}")
st, q3 = rpc("list_plans", {"p_owner_id": UB}, TA)
check("C123-body", "본문에 B 계정 → A 자료만", st == 200 and sorted(p["id"] for p in q3) == ida, f"{st} {q3}")
st, q4 = rpc("export_all", {"p_owner_id": UB}, TA)
owners = {r["owner_id"] for k in ("plans", "tasks", "run_logs", "task_completions", "reviews") for r in q4[k]}
check("C123-export", "내보내기 본문에 B 계정 → A 행만", st == 200 and owners <= {UA} and q4["account"]["user_id"] == UA, owners)
st, q5 = rpc("get_plan_bundle", {"p_plan_id": PB["id"], "p_owner_id": UB}, TA)
check("C123-bundle", "B 계획 + 본문에 B 계정 → 그래도 404", st == 404, f"{st} {q5}")
st, lb = rpc("list_plans", token=TB)
check("C125", "B의 목록에 A 자료 0건", st == 200 and all(p["id"] != PA["id"] for p in lb) and len(lb) == 1, lb)

# ---------------------------------------------------------------- T06 자료를 A 계정으로 옮기기 (C100)
claim = json.loads(sql(f"select pds_private.claim_t06_rows('{EA}')"))
check("C100a", "claim: T06 행이 A 계정으로(계획 2 + 새로 만든 1)", claim["plans"] == 3 and claim["tasks"] == 8 and claim["plans_without_owner"] == 0, claim)
nn = sql("select string_agg(attname || '=' || attnotnull, ',' order by attrelid::regclass::text) from pg_attribute "
         "where attname = 'owner_id' and attrelid in ('public.plans'::regclass,'public.tasks'::regclass,'public.run_logs'::regclass,"
         "'public.plan_revisions'::regclass,'public.task_completions'::regclass,'public.reviews'::regclass)")
check("C100b", "옮긴 뒤 주인 칸 NOT NULL로 잠김", nn.count("=true") == 6, nn)
st, b1 = rpc("get_plan_bundle", {"p_plan_id": 1}, TA)
same = st == 200 and len(b1["tasks"]) == 6 and len(b1["run_logs"]) == 6 and len(b1["revisions"]) == 1 and len(b1["reviews"]) == 1
for t in SNAP["tasks"]:
    bt = next((x for x in b1["tasks"] if x["id"] == t["id"]), None) if st == 200 else None
    same = same and bt is not None and all(str(bt[k]) == str(t[k]) or (bt[k] is not None and t[k] is not None
               and k.endswith("_at") and datetime.datetime.fromisoformat(bt[k]) == datetime.datetime.fromisoformat(t[k]))
               for k in ("title", "status", "due_date", "estimated_minutes", "updated_at", "completed_at"))
check("C100c", "T06 계획 #1의 할 일 6·기록 6·이력 1·돌아보기 1이 값 그대로", same, st)
st, b2 = rpc("get_plan_bundle", {"p_plan_id": 2}, TA)
check("C100d", "T06 계획 #2가 넘겨받은 고칠 점 연결도 그대로", st == 200 and b2["carried_review"]["id"] == 1, st)
st, x = rpc("get_plan_bundle", {"p_plan_id": 1}, TB)
check("C100e", "B는 T06 계획 #1을 못 봄(404)", st == 404, st)
st, up = rpc("update_plan", {"p_id": 2, "p_expected_revision": 1, "p_title": "ALEPH T07 — 다이어리 2 (로그인)",
                             "p_success_criteria": "로그인한 사람만 자기 계획·기록을 보고 고칠 수 있게 잠근다",
                             "p_start_date": "2026-09-21", "p_end_date": "2026-09-25", "p_priority": 1,
                             "p_estimated_minutes": 480, "p_change_reason": "T07 실제 일정으로 맞춤"}, TA)
rv = sql("select owner_id::text || '|' || revision from public.plan_revisions where plan_id = 2")
check("REV", "옮긴 계획을 고치면 수정 이력이 A 주인으로 쌓임", st == 200 and up["revision"] == 2 and rv == f"{UA}|1", f"{st} {rv}")
try:
    sql("delete from public.plan_revisions where plan_id = 1")
    check("REV2", "수정 이력은 여전히 지울 수 없음", False)
except subprocess.CalledProcessError:
    check("REV2", "수정 이력은 여전히 지울 수 없음", True)

# ---------------------------------------------------------------- 카드 5: 5일 관찰
st, g0 = rpc("get_observation", token=TA)
check("OBS0", "관찰 시작 전: 설정 없음 + 고정 규칙 안내", st == 200 and g0["observation"] is None and g0["rules"]["unit"] == "개", g0)
st, e0 = rpc("record_observation_day", {}, TA)
check("OBS1", "시작 전 기록 거절", st == 400, f"{st} {e0}")
Q = "할 일마다 할 날과 시간대를 미리 정해 두면, 하루에 끝내는 할 일이 늘어날까?"
RB = "할 일에는 마감일만 적는다. 언제 할지는 따로 정하지 않는다."
st, o1 = rpc("start_observation", {"p_question": "초안 질문", "p_plan_rule_before": RB}, TA)
st, o2 = rpc("start_observation", {"p_question": Q, "p_plan_rule_before": RB}, TA)
check("OBS2", "1일차 전에는 질문 고치기 가능(같은 관찰 행)", st == 200 and o2["created"] is False and o2["id"] == o1["id"] and o2["question"] == Q, o2)
for k in ("metric", "unit", "calc_rule", "missing_rule", "duplicate_rule", "outlier_rule", "rounding_rule", "week_start"):
    check({"metric": "C05", "unit": "C06", "calc_rule": "C08", "missing_rule": "C23", "duplicate_rule": "C24",
           "outlier_rule": "C25", "rounding_rule": "C26", "week_start": "C27"}[k], f"관찰에 {k} 적혀 있음", bool(o2.get(k)), o2.get(k))


def complete_on(tok, plan_id, n, day):
    """할 일 n개를 만들어 완료하고, 완료 시각을 그날(서울) 낮으로 옮깁니다(검사용)."""
    ids = []
    for i in range(n):
        st, t = mk_task(tok, plan_id, f"관찰 시험 {day} #{i + 1}")
        st, c = rpc("complete_task", {"p_id": t["id"], "p_request_key": str(uuid.uuid4())}, tok)
        ids.append(t["id"])
        if day != D(0):   # 오늘 것은 지금 시각 그대로(관찰 시작 뒤), 다른 날은 그날 낮으로 옮김
            sql(f"update public.task_completions set completed_at = '{day}T12:0{i}:00+09:00' where task_id = {t['id']};"
                f"update public.tasks set completed_at = '{day}T12:0{i}:00+09:00' where id = {t['id']}")
    return ids


set_today(D(0))
d1_ids = complete_on(TA, 2, 2, D(0))
st, day1 = rpc("record_observation_day", {"p_note": "1일차"}, TA)
check("OBS3", "1일차 기록: 관찰 시작 뒤 그날 끝낸 할 일 2개만 셈(오늘 아침 T06 완료 6개는 뺌)", st == 200 and day1["day_no"] == 1 and day1["value"] == 2
      and sorted(day1["counted_task_ids"]) == sorted(d1_ids) and day1["day_date"] == D(0), f"{st} {day1}")
st, again = rpc("record_observation_day", {}, TA)
check("C24", "같은 날 다시 누르면 새 줄 없이 다시 셈(횟수 남김)", st == 200 and again["created"] is False and again["id"] == day1["id"]
      and again["recount_count"] == 1, again)
st, fix = rpc("start_observation", {"p_question": "바꾸려는 질문", "p_plan_rule_before": RB}, TA)
check("C04", "1일차 뒤에는 질문을 바꿀 수 없음(고정)", st == 400, f"{st} {fix}")
try:
    sql("update public.observations set unit = '분'")
    check("C06-db", "DB에서 직접 단위를 바꿔도 막힘", False)
except subprocess.CalledProcessError:
    check("C06-db", "DB에서 직접 단위를 바꿔도 막힘", True)
st, early = rpc("change_plan_rule", {"p_rule_after": "x", "p_reason": "y"}, TA)
check("C09a", "1일차만 있을 때 규칙 변경 거절", st == 400, f"{st} {early}")

set_today(D(1))
complete_on(TA, 2, 1, D(1))
st, day2 = rpc("record_observation_day", {"p_note": "2일차"}, TA)
check("OBS4", "2일차 기록(값 1)", st == 200 and day2["day_no"] == 2 and day2["value"] == 1, day2)
set_today(D(2))
st, noc = rpc("record_observation_day", {}, TA)
check("C09b", "규칙을 안 바꾸고 3일차를 적으면 거절", st == 400 and "규칙" in noc["message"], f"{st} {noc}")
RA = "마감일만 적지 말고, 그 일을 할 날과 시간대를 같이 정한다."
st, same_rule = rpc("change_plan_rule", {"p_rule_after": RB, "p_reason": "같음"}, TA)
check("CHG0", "바꾸기 전과 같은 규칙은 거절", st == 400, same_rule)
st, chg = rpc("change_plan_rule", {"p_rule_after": RA, "p_reason": "T06 돌아보기: 마감이 밀린 건 언제 할지 정하지 않아서였다"}, TA)
check("C10-12", "규칙 변경: 시각·이유·1일차/2일차 기록을 정확히 가리킴",
      st == 200 and chg["after_day1_id"] == day1["id"] and chg["after_day2_id"] == day2["id"] and chg["changed_at"] and chg["reason"]
      and chg["rule_before"] == RB and chg["rule_after"] == RA, chg)
st, twice = rpc("change_plan_rule", {"p_rule_after": RA + "!", "p_reason": "두 번"}, TA)
check("CHG2", "규칙은 한 번만 바꿈", st == 400, twice)
set_today(D(1))
st, rec2 = rpc("record_observation_day", {}, TA)
check("CHG3", "규칙을 바꾼 뒤에는 2일차를 다시 셀 수 없음", st == 400, rec2)
vals = {2: 3, 3: 0, 4: 4}
for n, v in vals.items():
    set_today(D(n))
    complete_on(TA, 2, v, D(n))
    st, dn = rpc("record_observation_day", {"p_note": f"{n + 1}일차"}, TA)
    check("C07", f"{n + 1}일차 기록(값 {v})", st == 200 and dn["day_no"] == n + 1 and dn["value"] == v, f"{st} {dn}")
set_today(D(5))
st, six = rpc("record_observation_day", {}, TA)
check("C07b", "6번째 날은 거절(정확히 5일)", st == 400, six)
st, g = rpc("get_observation", token=TA)
s = g["summary"]
chg_at = datetime.datetime.fromisoformat(g["rule_change"]["changed_at"])
d2_at = datetime.datetime.fromisoformat(g["days"][1]["recorded_at"])
d3_at = datetime.datetime.fromisoformat(g["days"][2]["recorded_at"])
check("C09", "규칙 변경 시각이 2일차 기록 뒤·3일차 기록 앞", d2_at < chg_at < d3_at, f"{d2_at} {chg_at} {d3_at}")
days_vals = [d["value"] for d in g["days"]]
check("C132", "화면 합계·평균 = 손으로 더한 값 (2+1+3+0+4=10, 10÷5=2.0)",
      days_vals == [2, 1, 3, 0, 4] and s["sum"] == sum(days_vals) == 10 and float(s["avg"]) == 2.0, s)
check("C13-15", "전후 비교: 같은 지표·단위·규칙으로 1~2일차 평균 1.5, 3~5일차 평균 2.3, 차이 0.8",
      float(s["before"]["avg"]) == 1.5 and float(s["after"]["avg"]) == 2.3 and float(s["diff_avg"]) == 0.8, s)
check("C25", "튐 표시: 5일차 4 > 나머지 평균 1.5의 2배", s["spike_day_nos"] == [5], s["spike_day_nos"])
check("C27", "주별 합계(월요일 시작)", sum(w["sum"] for w in s["weeks"]) == 10, s["weeks"])
check("C07c", "서로 다른 날짜 5개", len({d["day_date"] for d in g["days"]}) == 5, [d["day_date"] for d in g["days"]])
st, gb = rpc("get_observation", token=TB)
check("OBS-B", "B는 A의 관찰을 못 봄", st == 200 and gb["observation"] is None, gb)
set_today(None)

# ---------------------------------------------------------------- 카드 5: 계정 삭제 (C134)
st, PC = mk_plan(TC, "C의 계획")
st, TC_1 = mk_task(TC, PC["id"], "C의 할 일")
st, o = rpc("start_observation", {"p_question": Q, "p_plan_rule_before": RB}, TC)
st, wrong = rpc("delete_my_account", {"p_confirm": "삭제"}, TC)
check("C134a", "확인 문구가 틀리면 계정 삭제 거절", st == 400, wrong)
st, gone = rpc("delete_my_account", {"p_confirm": "계정 삭제"}, TC)
check("C134", "계정 삭제: 지운 자료 수를 돌려줌", st == 200 and gone["deleted"]["plans"] == 1 and gone["deleted"]["tasks"] == 1
      and gone["deleted"]["observations"] == 1, gone)
left = sql(f"select (select count(*) from public.plans where owner_id='{UC}') + (select count(*) from public.tasks where owner_id='{UC}')"
           f" + (select count(*) from public.observations where owner_id='{UC}') + (select count(*) from auth.users where id='{UC}')"
           f" + (select count(*) from auth.sessions where user_id='{UC}')")
check("C134b", "지운 뒤 C의 자료·계정·세션 0건", left == "0", left)
st, x = rpc("whoami", token=TC)
st2, y = login(EC, NEWPWC)
check("C134c", "지운 계정의 토큰 401, 로그인 400", st == 401 and st2 == 400, f"{st} {st2}")

# 대시보드에서 사용자를 지우는 경우(연결된 자료도 오류 없이 함께 지워지는지)
sql(f"delete from auth.users where id = '{UB}'")
left_b = sql(f"select count(*) from public.plans where owner_id='{UB}'")
check("DEL-DASH", "관리 화면에서 사용자를 지워도 자료가 함께 지워짐", left_b == "0", left_b)

passed = sum(1 for r in results if r[2])
print(f"\n{passed}/{len(results)} passed")
json.dump([{"id": r[0], "name": r[1], "pass": r[2], "detail": r[3]} for r in results],
          open(os.environ.get("RESULT_JSON", "/tmp/pgt07/api_result.json"), "w"), ensure_ascii=False, indent=1)
sys.exit(0 if passed == len(results) else 1)
