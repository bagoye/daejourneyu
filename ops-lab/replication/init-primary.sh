#!/bin/bash
# primary 최초 기동 시 1회: 복제 전용 역할을 만들고, 컨테이너 네트워크에서의 복제 접속을 허용한다.
# 복제 역할은 REPLICATION 권한만 갖는다(로그인해 테이블을 읽고 쓸 수 없다 — 최소 권한).
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replpass';
SQL
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
