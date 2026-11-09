-- 앱 런타임 전용 최소 권한 역할. 마이그레이션(DDL)은 소유자 계정(DIRECT_URL)으로, 앱(DATABASE_URL)은 이 역할로 붙는다.
--
--   docker exec -i daejourneyu-test-pg psql -U test -d <DB> -v app_password="'<비밀번호>'" -v owner=test < scripts/ops/create-app-role.sql
--
-- 운영(Supabase)에 적용할 때: SQL Editor에서 owner를 postgres로 바꿔 실행하고, 풀러 접속 사용자명은
-- "app_rw.<project-ref>" 형식이 된다(Supabase Supavisor 규칙 — 적용 전 Supabase 문서로 확인).
-- 비밀번호는 이 파일에 적지 않는다(psql 변수로 넘긴다).
--
-- 주는 것: 스키마 사용, 테이블 SELECT/INSERT/UPDATE/DELETE (앱이 실제로 쓰는 DML만)
-- 주지 않는 것: CREATE(스키마 객체 생성)·ALTER·DROP·TRUNCATE·REFERENCES·TRIGGER, 다른 DB 접속, 역할 생성
-- → 앱 코드나 의존성이 탈취돼도 테이블을 지우거나(DROP/TRUNCATE) 스키마를 바꿀 수 없다.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;
ALTER ROLE app_rw PASSWORD :app_password;
-- 실수로 무거운 쿼리가 커넥션을 오래 붙잡지 않게(운영 값은 측정 후 조정)
ALTER ROLE app_rw SET statement_timeout = '5s';
ALTER ROLE app_rw SET idle_in_transaction_session_timeout = '10s';

-- public 스키마에 아무나 객체를 만들 수 있는 기본 권한 제거(PostgreSQL 15부터 기본값이지만 명시)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_rw;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
-- 마이그레이션 기록은 읽기만(앱이 고칠 이유가 없다)
REVOKE INSERT, UPDATE, DELETE ON "_prisma_migrations" FROM app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- 앞으로 마이그레이션(소유자 계정)이 만드는 테이블에도 같은 권한이 자동으로 붙게
ALTER DEFAULT PRIVILEGES FOR ROLE :owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE :owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
