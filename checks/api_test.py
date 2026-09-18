"""API-level checks against local PostgREST (Supabase-like).
Run: python3 api_test.py [base_url]
"""
import json, sys, uuid, threading, subprocess, datetime
import urllib.request, urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000"
import os, shlex
PSQL = shlex.split(os.environ.get("PSQL", "psql -h /tmp -p 54322 -U postgres")) + ["-At", "-c"]
results = []


def rpc(fn, args=None, expect_ok=True):
    data = json.dumps(args or {}).encode()
    req = urllib.request.Request(f"{BASE}/rpc/{fn}", data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = r.read().decode()
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return e.code, (json.loads(body) if body else None)


def sql(q):
    return subprocess.check_output(PSQL + [q]).decode().strip()


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {detail}" if detail and not cond else ""))


def kst_today():
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=9)).date()


today = kst_today()
d = lambda n: (today + datetime.timedelta(days=n)).isoformat()

# --- plans ---------------------------------------------------------------
k = str(uuid.uuid4())
st, p1 = rpc("create_plan", dict(p_title="  ALEPH T06 완주  ", p_success_criteria="카드 1~5 통과 기준을 모두 확인하고 제출",
                                 p_start_date=d(0), p_end_date=d(6), p_priority=1, p_estimated_minutes=600, p_request_key=k))
check("C04-C07 plan saved (period, priority, criteria, estimate)",
      st == 200 and p1["start_date"] == d(0) and p1["end_date"] == d(6) and p1["priority"] == 1
      and p1["success_criteria"].startswith("카드") and p1["estimated_minutes"] == 600 and p1["title"] == "ALEPH T06 완주",
      f"{st} {p1}")
st, p1b = rpc("create_plan", dict(p_title="ALEPH T06 완주", p_success_criteria="x", p_start_date=d(0), p_end_date=d(6),
                                  p_priority=1, p_estimated_minutes=600, p_request_key=k))
check("create_plan idempotent by request key", st == 200 and p1b["id"] == p1["id"] and p1b["created"] is False, f"{p1b}")
st, bad = rpc("create_plan", dict(p_title="x", p_success_criteria="y", p_start_date=d(3), p_end_date=d(1),
                                  p_priority=1, p_estimated_minutes=10))
check("create_plan rejects end<start with Korean message", st == 400 and "끝일" in bad["message"], f"{st} {bad}")
st, bad = rpc("create_plan", dict(p_title="", p_success_criteria="y", p_start_date=d(1), p_end_date=d(1),
                                  p_priority=1, p_estimated_minutes=10))
check("create_plan rejects empty title", st == 400 and "이름" in bad["message"], f"{st} {bad}")

pid = p1["id"]
st, up = rpc("update_plan", dict(p_id=pid, p_expected_revision=1, p_title="ALEPH T06 완주(수정)",
                                 p_success_criteria="카드 1~5 통과 + 제출", p_start_date=d(0), p_end_date=d(7),
                                 p_priority=1, p_estimated_minutes=720, p_change_reason="카드 5가 생각보다 커서 하루 늘림"))
check("C08 update keeps same ID and bumps revision", st == 200 and up["id"] == pid and up["revision"] == 2, f"{st} {up}")
rev = json.loads(sql(f"select to_json(r) from public.plan_revisions r where plan_id={pid} and revision=1"))
check("C08 original plan preserved in plan_revisions",
      rev["title"] == "ALEPH T06 완주" and rev["estimated_minutes"] == 600 and rev["end_date"] == d(6)
      and rev["change_reason"] == "카드 5가 생각보다 커서 하루 늘림", f"{rev}")
st, stale = rpc("update_plan", dict(p_id=pid, p_expected_revision=1, p_title="x", p_success_criteria="y",
                                    p_start_date=d(0), p_end_date=d(1), p_priority=1, p_estimated_minutes=5))
check("update_plan rejects stale revision", st == 400 and "먼저 고쳤" in stale["message"], f"{st} {stale}")
st, same = rpc("update_plan", dict(p_id=pid, p_expected_revision=2, p_title="ALEPH T06 완주(수정)",
                                   p_success_criteria="카드 1~5 통과 + 제출", p_start_date=d(0), p_end_date=d(7),
                                   p_priority=1, p_estimated_minutes=720))
check("no-op update does not create a revision", st == 200 and same["revision"] == 2
      and sql(f"select count(*) from public.plan_revisions where plan_id={pid}") == "1", f"{same}")
try:
    sql(f"delete from public.plan_revisions where plan_id={pid}")
    check("plan_revisions is append-only", False)
except subprocess.CalledProcessError:
    check("plan_revisions is append-only", True)

# --- tasks ---------------------------------------------------------------
tasks = []
spec = [
    ("카드 1 계획 세우기", d(-2), 1, ["카드1", "DB"], 60),
    ("카드 2 할 일 다루기", d(-1), 1, ["카드2"], 120),
    ("카드 3 실행 기록", d(0), 2, ["카드3"], 90),
    ("카드 4 돌아보기", d(-3), 2, ["카드4"], 90),
    ("카드 5 내 것으로 채우기", d(2), 3, ["카드5", " 제출 ", "제출", ""], 60),
    ("<img src=x onerror=alert(1)>", None, 3, ["<b>xss</b>"], 0),
]
for title, due, pr, tags, est in spec:
    st, t = rpc("create_task", dict(p_plan_id=pid, p_title=title, p_note=None, p_due_date=due, p_priority=pr,
                                    p_tags=tags, p_estimated_minutes=est, p_request_key=str(uuid.uuid4())))
    assert st == 200, (st, t)
    tasks.append(t)
check("C09 C14-C17 tasks saved with due/priority/tags/estimate",
      tasks[0]["due_date"] == d(-2) and tasks[0]["priority"] == 1 and tasks[0]["tags"] == ["카드1", "DB"]
      and tasks[1]["estimated_minutes"] == 120, f"{tasks[0]}")
check("tags cleaned (trim, dedupe, drop empty)", tasks[4]["tags"] == ["카드5", "제출"], f"{tasks[4]['tags']}")
check("C57 script-like text stored verbatim", tasks[5]["title"] == "<img src=x onerror=alert(1)>")
st, bad = rpc("create_task", dict(p_plan_id=pid, p_title="x", p_note=None, p_due_date=None, p_priority=1,
                                  p_tags=["a" * 21], p_estimated_minutes=1))
check("create_task rejects 21-char tag", st == 400 and "태그" in bad["message"], f"{st} {bad}")

t0, t1, t2, t3, t4, t5 = [t["id"] for t in tasks]
st, ut = rpc("update_task", dict(p_id=t1, p_title="카드 2 할 일 다루기 (검색·정렬 포함)", p_note="정렬 기준 화면에 적기",
                                 p_due_date=d(-1), p_priority=1, p_tags=["카드2", "정렬"], p_estimated_minutes=150))
check("C10 update task", st == 200 and ut["title"].endswith("(검색·정렬 포함)") and ut["estimated_minutes"] == 150
      and ut["tags"] == ["카드2", "정렬"], f"{st} {ut}")

# --- completion: double submit ------------------------------------------
before = rpc("review_summary", dict(p_plan_id=pid))[1]
key = str(uuid.uuid4())
out = []
def fire(kk):
    out.append(rpc("complete_task", dict(p_id=t0, p_request_key=kk)))
ths = [threading.Thread(target=fire, args=(key,)) for _ in range(5)]
[t.start() for t in ths]; [t.join() for t in ths]
created = sum(1 for s, b in out if s == 200 and b["created"])
check("C21 5 concurrent completes (same key) -> 1 record",
      created == 1 and sql(f"select count(*) from public.task_completions where task_id={t0}") == "1", f"{out}")
out = []
ths = [threading.Thread(target=fire, args=(str(uuid.uuid4()),)) for _ in range(5)]
[t.start() for t in ths]; [t.join() for t in ths]
check("C21 5 concurrent completes (different keys) -> still 1 active record",
      all(s == 200 for s, _ in out) and sum(1 for s, b in out if b["created"]) == 0
      and sql(f"select count(*) from public.task_completions where task_id={t0}") == "1", f"{out}")
after = rpc("review_summary", dict(p_plan_id=pid))[1]
check("C22 done count increased by exactly 1", after["done"]["count"] - before["done"]["count"] == 1,
      f"{before['done']} -> {after['done']}")
check("C11 status done", json.loads(sql(f"select to_json(t) from public.tasks t where id={t0}"))["status"] == "done")

st, ro = rpc("reopen_task", dict(p_id=t0))
check("C12 reopen -> open, completion reverted", st == 200 and ro["task"]["status"] == "open"
      and sql(f"select count(*) from public.task_completions where task_id={t0} and reverted_at is null") == "0", f"{ro}")
st, again = rpc("complete_task", dict(p_id=t0, p_request_key=str(uuid.uuid4())))
check("complete again after reopen creates a new active record", st == 200 and again["created"] is True
      and sql(f"select count(*) from public.task_completions where task_id={t0} and reverted_at is null") == "1")

st, dl = rpc("delete_task", dict(p_id=t5))
check("C13 delete task (soft)", st == 200 and dl["deleted_at"] is not None)
st, bad = rpc("complete_task", dict(p_id=t5, p_request_key=str(uuid.uuid4())))
check("deleted task cannot be completed", st == 400, f"{st} {bad}")

# --- run logs ------------------------------------------------------------
plan_before = sql(f"select to_json(p) from public.plans p where id={pid}")
tasks_before = sql(f"select json_agg(json_build_object('id',id,'est',estimated_minutes,'due',due_date) order by id) from public.tasks where plan_id={pid}")
logs = [
    (t0, f"{d(0)}T09:00:00+09:00", f"{d(0)}T10:30:00+09:00", 80, None),
    (t1, f"{d(0)}T11:00:00+09:00", f"{d(0)}T13:30:00+09:00", 150, "정렬 기준이 같을 때 순서가 흔들림"),
    (t2, f"{d(0)}T14:00:00+09:00", f"{d(0)}T14:45:00+09:00", None, "   "),
]
log_ids = []
for tid, s, e, a, br in logs:
    kk = str(uuid.uuid4())
    st, lg = rpc("add_run_log", dict(p_task_id=tid, p_started_at=s, p_ended_at=e, p_actual_minutes=a,
                                     p_blocked_reason=br, p_note=None, p_request_key=kk))
    assert st == 200, (st, lg)
    st2, lg2 = rpc("add_run_log", dict(p_task_id=tid, p_started_at=s, p_ended_at=e, p_actual_minutes=a,
                                       p_blocked_reason=br, p_note=None, p_request_key=kk))
    assert lg2["id"] == lg["id"] and lg2["created"] is False
    log_ids.append(lg["id"])
lg0 = json.loads(sql(f"select to_json(r) from public.run_logs r where id={log_ids[0]}"))
check("C23 C24 started/ended stored (KST 09:00 -> UTC 00:00)",
      lg0["started_at"].startswith(f"{d(0)}T00:00:00") and lg0["ended_at"].startswith(f"{d(0)}T01:30:00"), f"{lg0}")
check("C25 actual minutes stored", lg0["actual_minutes"] == 80)
lg2 = json.loads(sql(f"select to_json(r) from public.run_logs r where id={log_ids[2]}"))
check("actual defaults to span when omitted; blank blocked reason -> null",
      lg2["actual_minutes"] == 45 and lg2["blocked_reason"] is None, f"{lg2}")
lg1 = json.loads(sql(f"select to_json(r) from public.run_logs r where id={log_ids[1]}"))
check("C26 blocked reason stored", lg1["blocked_reason"] == "정렬 기준이 같을 때 순서가 흔들림")
st, bad = rpc("add_run_log", dict(p_task_id=t3, p_started_at=f"{d(0)}T09:00:00+09:00", p_ended_at=f"{d(0)}T09:30:00+09:00",
                                  p_actual_minutes=45, p_blocked_reason=None, p_note=None))
check("actual > span rejected", st == 400 and "길 수 없습니다" in bad["message"], f"{st} {bad}")
st, bad = rpc("add_run_log", dict(p_task_id=t3, p_started_at=f"{d(0)}T10:00:00+09:00", p_ended_at=f"{d(0)}T09:30:00+09:00",
                                  p_actual_minutes=None, p_blocked_reason=None, p_note=None))
check("end<start rejected", st == 400, f"{st} {bad}")
check("C27 plan unchanged after run logs", sql(f"select to_json(p) from public.plans p where id={pid}") == plan_before)
check("C27 task estimates unchanged after run logs",
      sql(f"select json_agg(json_build_object('id',id,'est',estimated_minutes,'due',due_date) order by id) from public.tasks where plan_id={pid}") == tasks_before)

# complete t3 (due tomorrow) and leave t1 (due yesterday) open -> overdue; t0 open due -2 -> overdue
rpc("complete_task", dict(p_id=t1, p_request_key=str(uuid.uuid4())))   # t1 done though overdue date -> not overdue
# --- summary vs independent SQL -----------------------------------------
st, s = rpc("review_summary", dict(p_plan_id=pid))
ind = json.loads(sql(f"""
with base as (select * from public.tasks where plan_id={pid} and deleted_at is null),
lg as (select r.* from public.run_logs r join base b on b.id=r.task_id where r.deleted_at is null)
select json_build_object(
 'planned',(select count(*) from base),
 'done',(select count(*) from base where status='done'),
 'overdue',(select count(*) from base where status<>'done' and due_date < (now() at time zone 'Asia/Seoul')::date),
 'blocked',(select count(distinct b.id) from base b join lg on lg.task_id=b.id where coalesce(btrim(lg.blocked_reason),'')<>''),
 'est',(select coalesce(sum(estimated_minutes),0) from base),
 'act',(select coalesce(sum(actual_minutes),0) from lg))"""))
check("C28 planned = non-deleted tasks", s["planned"]["count"] == ind["planned"] == 5, f"{s['planned']} {ind}")
check("C29 done = tasks currently done", s["done"]["count"] == ind["done"] == 2, f"{s['done']} {ind}")
check("C30 overdue = open & due<today(KST), done not counted",
      s["overdue"]["count"] == ind["overdue"] == 1 and s["overdue"]["task_ids"] == [t3] and t1 not in s["overdue"]["task_ids"],
      f"{s['overdue']} {ind}")
check("C31 blocked = tasks with any blocked reason", s["blocked"]["count"] == ind["blocked"] == 1
      and s["blocked"]["task_ids"] == [t1], f"{s['blocked']}")
check("C32 estimated/actual/diff", s["estimated_minutes"]["sum"] == ind["est"] and s["actual_minutes"]["sum"] == ind["act"]
      and s["diff_minutes"] == ind["act"] - ind["est"], f"{s} {ind}")
check("C83 summary returns evidence ids", sorted(s["actual_minutes"]["run_log_ids"]) == sorted(log_ids)
      and s["planned"]["task_ids"] == [t0, t1, t2, t3, t4])

st, p2 = rpc("create_plan", dict(p_title="빈 계획", p_success_criteria="없음", p_start_date=d(0), p_end_date=d(0),
                                 p_priority=3, p_estimated_minutes=1, p_request_key=str(uuid.uuid4())))
st, s0 = rpc("review_summary", dict(p_plan_id=p2["id"]))
check("C32 empty plan -> all zeros", s0["planned"]["count"] == 0 and s0["estimated_minutes"]["sum"] == 0
      and s0["actual_minutes"]["sum"] == 0 and s0["diff_minutes"] == 0, f"{s0}")

# deleted run log excluded
st, dl = rpc("delete_run_log", dict(p_id=log_ids[2]))
st, s2 = rpc("review_summary", dict(p_plan_id=pid))
check("cancelled run log excluded from actual sum", s2["actual_minutes"]["sum"] == s["actual_minutes"]["sum"] - 45)
rpc("restore_task", dict(p_id=t5))
st, s3 = rpc("review_summary", dict(p_plan_id=pid))
check("restored task counted again", s3["planned"]["count"] == 6)
rpc("delete_task", dict(p_id=t5))

# --- review + carry over -------------------------------------------------
rk = str(uuid.uuid4())
st, rv = rpc("add_review", dict(p_plan_id=pid, p_reflection="정렬·중복 방지에서 시간이 더 걸림",
                                p_next_fix="DB 작업은 예상 시간을 1.5배로 잡는다", p_request_key=rk))
check("review saved with stats snapshot", st == 200 and rv["stats"]["planned"] == 5 and rv["next_fix"].startswith("DB"), f"{rv}")
st, rv2 = rpc("add_review", dict(p_plan_id=pid, p_reflection=None, p_next_fix="x", p_request_key=rk))
check("add_review idempotent", rv2["id"] == rv["id"] and rv2["created"] is False)
st, bad = rpc("carry_review", dict(p_review_id=rv["id"], p_plan_id=pid))
check("carry to same plan rejected", st == 400, f"{st} {bad}")
st, p3 = rpc("create_plan", dict(p_title="T07 다이어리2 준비", p_success_criteria="로그인 붙이기", p_start_date=d(7),
                                 p_end_date=d(13), p_priority=1, p_estimated_minutes=900,
                                 p_carried_from_review_id=rv["id"], p_request_key=str(uuid.uuid4())))
check("C33 next plan carries the fix", st == 200 and p3["carried_from_review_id"] == rv["id"], f"{st} {p3}")
st, b3 = rpc("get_plan_bundle", dict(p_plan_id=p3["id"]))
check("C33 bundle of next plan shows carried fix", b3["carried_review"]["next_fix"] == "DB 작업은 예상 시간을 1.5배로 잡는다")
st, bad = rpc("carry_review", dict(p_review_id=rv["id"], p_plan_id=p2["id"]))
check("same fix cannot be carried twice", st == 400, f"{st} {bad}")
st, b1 = rpc("get_plan_bundle", dict(p_plan_id=pid))
check("bundle of reviewed plan shows carried_to_plan", b1["reviews"][0]["carried_to_plan"]["id"] == p3["id"])
check("bundle has revisions, tasks, logs, completions",
      len(b1["revisions"]) == 1 and len(b1["tasks"]) == 6 and len(b1["run_logs"]) == 3 and len(b1["completions"]) >= 2)

# --- export --------------------------------------------------------------
st, ex = rpc("export_all")
check("C36 export has all tables", st == 200 and ex["schema"] == "pds-schema-v2"
      and all(k in ex for k in ["plans", "plan_revisions", "tasks", "task_completions", "run_logs", "reviews"])
      and len(ex["plans"]) == 3)

# --- security ------------------------------------------------------------
req = urllib.request.Request(f"{BASE}/tasks", method="GET")
try:
    urllib.request.urlopen(req); check("anon cannot read tables directly", False)
except urllib.error.HTTPError as e:
    check("anon cannot read tables directly", e.code in (401, 403))
req = urllib.request.Request(f"{BASE}/tasks?id=eq.{t0}", method="DELETE")
try:
    urllib.request.urlopen(req); check("anon cannot delete rows directly", False)
except urllib.error.HTTPError as e:
    check("anon cannot delete rows directly", e.code in (401, 403))
st, bad = rpc("plan_summary", dict(p_plan_id=pid))
check("private helper not callable", st in (404, 401, 403), f"{st}")

fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
