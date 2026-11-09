-- 인덱스가 없던 외래키 2개에 인덱스를 단다. 발견 경로: pg_stat_statements 상위 SQL → EXPLAIN의 FK 트리거 시간 →
-- 카탈로그 점검 쿼리(자식 FK 컬럼으로 시작하는 인덱스가 없는 제약). 상세: docs/db-optimization/04-database-operations.md

-- 코스 삭제 시 ON DELETE SET NULL이 PostSave를 courseId로 찾는다. 인덱스가 없어 담기 전체를 스캔했다
-- (담기 30만 건 기준 코스 1개 삭제 13.0ms 중 FK 트리거 11.1ms). 담기 취소·코스 삭제·회원 탈퇴 모두 이 경로를 탄다.
CREATE INDEX "PostSave_courseId_idx" ON "PostSave"("courseId");

-- 일정 삭제(CASCADE)와 일정 조회(festivalTitles를 courseScheduleId IN (...)로 읽음)가 이 컬럼을 쓴다.
CREATE INDEX "CourseScheduleFestival_courseScheduleId_idx" ON "CourseScheduleFestival"("courseScheduleId");
