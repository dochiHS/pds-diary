// Supabase 연결 설정 — 공개해도 되는 값만 넣습니다.
//
// · SUPABASE_URL
//     Supabase 대시보드의 Project URL (https://<프로젝트ID>.supabase.co)
// · SUPABASE_PUBLISHABLE_KEY
//     Settings → API Keys 의 Publishable key (sb_publishable_… 로 시작)
//     브라우저에 공개되도록 만든 키입니다. 이 키로 할 수 있는 일은
//     supabase/schema.sql 에서 열어 둔 DB 함수(RPC) 실행뿐입니다.
//
// !! Secret key(sb_secret_…)나 service_role 키는 절대 넣지 마세요.
//    (넣으면 앱이 스스로 멈추고 경고를 띄웁니다)
window.PDS_CONFIG = {
  SUPABASE_URL: 'https://kkwiaqyiktvejylfdwov.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_MLsgr6OLWYz6bImODWn8vw_5CTYOcJp',
  SOURCE_URL: 'https://github.com/dochiHS/pds-diary',
};
