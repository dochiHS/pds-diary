# Plan · Do · See — ALEPH T07 (플랜두씨 다이어리 2: 인증)

T06 다이어리에 **가입·로그인**을 이어 붙여, 내 기록을 **나만** 보게 만든 판입니다.

- 이어 붙인 T06 최종 제출: 결과물 <https://dochihs.github.io/pds-diary/#plan=1> · 소스 commit `c55e544c1bfd8b0485017e11dafa9d7fc9a10eec`
  (이 저장소의 git 이력에 그 commit이 그대로 조상으로 남아 있습니다)
- 결과물 첫 화면은 **로그인 화면**입니다. 계정 없이도 그 화면까지는 열리고, 기록은 로그인한 뒤에만 보입니다.
- 인증 방식·이유·고친 곳·확인 기록은 [`docs/AUTH.md`](docs/AUTH.md)(인증 구현 설명서 여섯 항목)에 있습니다.

## 무엇으로 막았나 (요약)

| 층 | 하는 일 |
|---|---|
| Supabase Auth (GoTrue v2.197.0) | 가입·로그인·로그아웃·비밀번호 변경. 비밀번호는 bcrypt로 보관. 액세스 토큰(JWT, ES256, 1시간) + 리프레시 토큰 |
| 화면 `app.js` | 토큰을 탭의 `sessionStorage`에만 두고 `Authorization` 헤더로만 보냄(URL에 안 실음). 로그인 전에는 어떤 주소로 와도 로그인 화면 |
| DB 함수 `supabase/schema.sql` | 모든 함수 맨 앞 `pds_private.require_user()` — 토큰의 사용자·**세션이 살아 있는지** 확인(로그아웃·비밀번호 변경 뒤 같은 토큰 401). 모든 행에 `owner_id`, 남의 행·없는 행은 **404** |
| DB 권한 | 표 직접 접근 없음(RLS + 권한 회수). 로그인 안 한 역할(anon)은 `ping()`만 |

## 파일

| 파일 | 하는 일 |
|---|---|
| `index.html` · `app.js` · `style.css` | 화면 (외부 라이브러리 없음, CSP로 같은 출처 스크립트만) |
| `config.js` | Supabase Project URL과 **Publishable key(공개용)**만 |
| `supabase/schema.sql` | T06 DB를 T07로 올리는 SQL(빈 DB에도 가능, 다시 실행해도 안전) |
| `supabase/claim_t06_rows.sql` | T06 자료를 가입한 내 계정으로 옮기는 한 줄(한 번만) |
| `contracts/pds-schema-v3.json` | 최종 DB 구조·규칙 |
| `docs/AUTH.md` | 인증 구현 설명서 ①~⑥ |
| `checks/auth-evidence.html` | 실제 서버에 시험 계정을 만들어 성공·거절 요청을 나란히 기록하는 페이지 |
| `checks/api_test.py` · `checks/e2e.mjs` · `checks/devserver.mjs` | 로컬 검사(PostgREST 12.2.3·12.2.12·13.0.7·14.0에서 API 100/100, 화면 27/27) |

## 설치 순서

1. Supabase → Authentication → Sign In / Providers → Email: **Confirm email 끄기**, 비밀번호 최소 8자·영문+숫자.
2. SQL Editor에서 `supabase/schema.sql` 전체 실행 → `rpc_functions_ready = 23`, `anon_can_call = ping`.
3. 앱에서 내 계정으로 가입 → SQL Editor에서 `claim_t06_rows.sql`의 이메일만 바꿔 실행.
4. GitHub에 올리면 Pages가 그대로 배포합니다(`main` / root).

## 5일 관찰 (카드 5)

앱의 **5 · 5일 관찰**에서 1일차에 질문·지표(그날 끝낸 할 일 수)·단위(개)·계산 규칙·빠짐/중복/튐/반올림/주 시작 요일을 고정하고,
서로 다른 날짜 5일을 기록합니다. 날짜는 서버의 오늘(서울), 값은 기록 순간 서버가 다이어리 완료 기록에서 셉니다.
2일차 뒤·3일차 앞에 계획 규칙을 한 번만 바꿀 수 있고, 전후 평균은 같은 지표·단위·규칙으로 비교합니다.

## 규칙 (T06과 같음)

날짜는 서울 달력 날짜, 시각은 절대 시각으로 저장하고 화면은 서울 시간(KST)으로 보여 줍니다. 시간 값은 모두 분 단위입니다.
