# PgBouncer 실습용 이미지. Debian 기본 저장소의 pgbouncer(bookworm: 1.18)를 쓴다 — PGDG 저장소가 이 네트워크에서
# 막혀 있어서다. 1.18은 트랜잭션 모드에서 prepared statement를 지원하지 않아(1.21부터 지원), Prisma의
# `pgbouncer=true`가 왜 필요한지 그대로 재현된다.
FROM postgres:16-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbouncer \
 && rm -rf /var/lib/apt/lists/*
COPY pgbouncer.ini userlist.txt /etc/pgbouncer/
RUN chown -R postgres:postgres /etc/pgbouncer
USER postgres
EXPOSE 6432
CMD ["pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
