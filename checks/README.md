# 검사

## 실제 서버 확인 기록 — `auth-evidence.html`
배포된 주소의 `checks/auth-evidence.html`을 열고 [검사 실행]을 누르면, 실제 Supabase에 시험 계정 A·B(같은 비밀번호)·C를 만들어
로그인 없이 / 로그아웃·비밀번호 변경 뒤 같은 토큰 / 남의 자료 읽기·수정·삭제(양방향) / 주인 바꿔치기 / 계정 삭제를 요청하고,
성공한 요청과 거절된 요청을 나란히 Markdown으로 남깁니다. 비밀번호는 페이지 안에서 무작위로 만들고 버리며, 기록의 비밀번호·토큰은 가립니다.

## 로컬 검사
PostgreSQL 16 + PostgREST에 Supabase와 비슷한 역할·`auth` 스키마를 만들고, `devserver.mjs`가 화면 파일·`/rest/v1`(PostgREST 중계)·
`/auth/v1`(Supabase Auth 흉내: bcrypt, 세션 표, 로그아웃 시 세션 삭제, 비밀번호 변경 시 다른 세션 삭제)을 맡습니다.
DB는 **T06 운영 상태(스키마 + 실제 자료 스냅숏)** 위에 `supabase/schema.sql`을 올려 업그레이드 경로 그대로 검사합니다.

- `api_test.py` — API 검사 100개. PostgREST 12.2.3 · 12.2.12 · 13.0.7 · 14.0 모두 **100/100**
- `e2e.mjs` — Playwright 화면 검사 27개 **27/27** (브라우저 시간대 America/Los_Angeles, 폭 390px 포함)

마지막 실행: 2026-09-21
