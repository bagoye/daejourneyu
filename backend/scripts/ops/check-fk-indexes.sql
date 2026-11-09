-- 인덱스가 없는 외래키 점검. 자식 쪽 FK 컬럼(들)로 시작하는 인덱스가 없으면, 부모 행을 지우거나 키를 바꿀 때
-- (CASCADE·SET NULL·RESTRICT 검사) 자식 테이블을 전체 스캔한다. 새 마이그레이션 뒤에 돌려 0행인지 확인한다.
--
--   docker exec -i daejourneyu-test-pg psql -U test -d <DB> < scripts/ops/check-fk-indexes.sql
--
-- 이 쿼리로 PostSave.courseId·CourseScheduleFestival.courseScheduleId를 찾았다(코스 삭제 13.0ms → 1.7ms).

SELECT c.conrelid::regclass                         AS child_table,
       string_agg(a.attname, ', ' ORDER BY x.n)     AS fk_columns,
       c.confrelid::regclass                        AS parent_table,
       CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'r' THEN 'RESTRICT'
                          WHEN 'a' THEN 'NO ACTION' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
       pg_size_pretty(pg_relation_size(c.conrelid)) AS child_size
FROM pg_constraint c
CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS x(attnum, n)
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum
WHERE c.contype = 'f'
  AND c.connamespace = 'public'::regnamespace
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] = c.conkey
  )
GROUP BY c.conrelid, c.confrelid, c.confdeltype, c.conname
ORDER BY pg_relation_size(c.conrelid) DESC;
