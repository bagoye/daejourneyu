#!/bin/bash
# primary 최초 기동 시 1회: 복제 역할, 모니터링 역할, pg_stat_statements 확장.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
-- 복제 전용(REPLICATION 권한만)
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replpass';
-- 모니터링 전용: pg_monitor(통계 뷰·설정 읽기)만. 테이블 데이터는 읽을 수 없다 — exporter가 탈취돼도 데이터 유출 없음
CREATE ROLE exporter WITH LOGIN PASSWORD 'exporterpass' CONNECTION LIMIT 5;
GRANT pg_monitor TO exporter;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- 장애 주입용 테이블(교착·쓰기 부하)
CREATE TABLE incident_probe (id int PRIMARY KEY, v int);
INSERT INTO incident_probe SELECT g, 0 FROM generate_series(1, 100) g;
SQL
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
