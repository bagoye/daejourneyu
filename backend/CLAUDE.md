# CLAUDE.md — backend

`backend/` 작업 시 루트 `CLAUDE.md`(도메인 용어·Git 정책·공통 컨벤션)에 더해 적용되는 규칙.
프론트와의 데이터 모델 불일치는 루트 CLAUDE.md "현재 연동 상태"를 먼저 확인할 것.

## 현재 상태

Express 4 + Prisma 6 + PostgreSQL(운영 Supabase, 로컬 `prisma dev`/Docker). 인증(JWT 쿠키·카카오),
코스·일정·게시물·담기·후기·반려동물 API가 DB에 영속화되어 있다. 데이터 정합성·성능 작업의 근거는
`docs/db-optimization/`에 있다.

```
src/
├─ index.ts          서버 진입점 (CORS·미들웨어·라우트·에러 핸들러·종료 처리)
├─ lib/
│  ├─ prisma.ts      PrismaClient 싱글턴 + 느린 쿼리 로그(SLOW_QUERY_MS)
│  ├─ errorHandler.ts 공통 에러 미들웨어(Prisma 경합 오류 → 404/409, 풀 고갈 → 503)
│  ├─ asyncHandler.ts async 라우트 예외를 에러 미들웨어로 넘기는 래퍼 — 모든 async 라우트에 쓴다
│  ├─ cursor.ts      값 기반 커서(목록 페이지네이션)
│  ├─ searchText.ts  게시물 검색 문서 — 글을 쓰는 모든 경로가 이 함수를 쓴다
│  └─ shutdown.ts    SIGTERM/SIGINT 시 진행 중 요청 완료 → DB 연결 종료
└─ routes/           도메인별 라우터. 파일 하나 = 도메인 하나
test/integration/    실제 PostgreSQL 통합 테스트(npm run test:int)
scripts/perf/        대량 데이터 시드·실행계획·pgbench
scripts/load/        k6 부하 시나리오·성능 회귀 게이트(perf-gate.sh → compare.mjs, CI: .github/workflows/perf.yml)·캐시 일관성 확인
scripts/ops/         커넥션 풀 측정·정합성 점검·사용자 선택 복구·최소 권한 역할
```

## 명령어

```bash
npm run dev      # tsx watch src/index.ts — http://localhost:4000
npm run build    # tsc → dist/ (타입 체크 겸용)
npm start        # node dist/index.js
npm test         # vitest run (1회 실행)
npm run test:watch  # vitest 감시 모드
```

**변경 후 `npm test`와 `npm run build`를 둘 다 통과시킨다.** 테스트는 Vitest
(`vitest.config.mts`, 환경 `node`)로 대상 파일 옆 `src/**/*.test.ts`에 두며, `tsconfig.json`에서
제외되어 `dist/`에는 빌드되지 않는다(테스트 파일 자체의 타입은 `tsc`가 검사하지 않는다).
라우트 테스트는 supertest로 라우터를 작은 Express 앱에 붙여 호출하고, `../lib/prisma`와
`../lib/auth`는 `vi.mock`으로 바꿔 DB·`JWT_SECRET` 없이 돈다(`src/routes/posts.test.ts` 참고).
쿠키 `daejourneyu_token=valid:<userId>`를 보내면 그 사용자로 로그인한 것으로 취급한다.
Prisma를 mock하므로 **쿼리 인자가 맞는지까지만** 보장된다 — 실제 DB 동작(제약·트랜잭션)은
확인되지 않으니, 테스트가 없는 라우트는 물론 스키마를 건드린 변경도 `curl`로 실제 응답까지 확인한다.

## 규약

- **모든 엔드포인트는 `/api` 프리픽스 아래.** 프론트의 `next.config.mjs` rewrites가 `/api/*`만
  이 서버로 프록시하므로, 프리픽스를 벗어난 경로는 프론트에서 도달할 수 없다.
- 라우터는 `express.Router()`를 만들어 **default export**하고, `index.ts`에서
  `app.use("/api/<도메인>", router)`로 마운트한다(`routes/places.ts` 패턴 그대로).
  라우터 내부 경로는 `/`, `/:id`처럼 마운트 지점 기준 상대 경로로 쓴다.
- 목록 조회의 필터는 **쿼리스트링**으로 받는다 (`GET /api/places?gu=서구&cat=산책`).
- 에러 응답은 `res.status(<코드>).json({ error: "<메시지>" })` 형태로 통일한다.
  없는 리소스는 404, 잘못된 입력은 400.
- TypeScript `strict`, `module: commonjs`, `target: ES2020`. `any` 금지 — `unknown` 또는 명시적 타입.
- 응답 타입(위 `Place`처럼)은 라우터 파일 안에서 `type`으로 선언한다. 여러 라우터가 공유하게 되면
  그때 `src/types/`로 승격시킨다 — 미리 만들지 않는다.
- 주석은 한국어.

## 주의사항

- **async 라우트는 반드시 `asyncHandler`로 감싼다.** Express 4는 async 핸들러의 reject를 잡지 않아
  요청이 멈추고 Unhandled Rejection으로 프로세스가 죽는다(실제로 재현됨).
- **동시성**: 존재 확인 → 쓰기 사이에 다른 요청이 끼어들 수 있다. 중복은 유니크 제약으로 막고 P2002를 해석하며,
  여러 테이블을 지우거나 바꾸는 트랜잭션은 **Course → 하위 테이블(CourseDay·PostSave)** 순으로 잠근다
  (반대 순서에서 교착이 재현됐다 — `docs/db-optimization/02-transaction.md`).
- `Post.saves`는 DB 트리거가 유지한다. 앱에서 직접 증감하지 않는다.
- `Post.searchText`는 앱이 유지한다. 게시물을 만들거나 caption·text를 바꾸는 경로는 `buildSearchText`로 함께 갱신한다.
- 새 FK를 추가하면 자식 쪽 컬럼에 인덱스를 함께 단다(없으면 부모 삭제 때 자식 테이블 전체 스캔 —
  `scripts/ops`의 점검 쿼리는 `docs/db-optimization/04-database-operations.md`).
- 스키마 변경은 새 마이그레이션으로만. **이미 커밋·배포된 마이그레이션 파일은 고치지 않는다.**
- `prisma/seed.ts`는 DATABASE_URL이 로컬이 아니면 멈춘다(원격에 넣으려면 `ALLOW_REMOTE_SEED=true`).
- 린터가 없다(`npm run lint` 스크립트도 없음). 프론트는 `next lint`가 있어 비대칭 상태다.
