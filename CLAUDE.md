# CLAUDE.md

이 파일은 이 저장소에서 작업하는 Claude Code에게 저장소 **전체** 가이드를 제공한다.
`frontend/` 안에서 작업할 때는 `frontend/CLAUDE.md`(상세 아키텍처·컨벤션)와 `frontend/PLAN.md`
(화면 인벤토리·구조 결정 근거)가 추가로 적용되며, 충돌 시 하위 디렉터리 파일이 우선한다.

## 프로젝트

**Daejourneyu (대저니유)** = Dae(대전) + journey + 유(충청 사투리 / "you").
반려동물과 함께하는 대전 여행 PWA. 단일 HTML 프로토타입을 Next.js + Express로 재구축하는 중이다.

- 워드마크 `DaeJourneyU` (끝 U 강조), 공식 로마자 병기는 `Daejeoniyu`
- 서비스 범위는 **대전 5개 자치구로 한정** — 유성구/중구/동구/대덕구/서구

## 저장소 구조

```
daejourneyu/
├─ frontend/     Next.js 14 App Router + TS + Tailwind v4 + TanStack Query + Zustand + PWA
│  ├─ CLAUDE.md  ← FE 작업 시 반드시 함께 읽을 것 (아키텍처·컨벤션·3인 분업표)
│  └─ PLAN.md    ← 화면 인벤토리, 구조 결정 근거, 포팅 제외 화면 목록
├─ backend/      Node.js + Express 4 + TS + Prisma + PostgreSQL
│  └─ src/routes/  도메인별 라우터
├─ ops-lab/      DB 운영 실습실(Docker) — PITR·보관 정책(54330, docs 06), 복제·장애 전환(replication/, 54331·54332, docs 07), PgBouncer(pgbouncer/, 6432, docs 08), 모니터링(monitoring/, Grafana 3001, docs 09)
├─ .github/workflows/perf.yml  백엔드 PR 성능 게이트(k6, base·head 번갈아 측정 — backend/scripts/load, docs 10)
└─ docs/db-optimization/  정합성·성능·운영 작업의 근거와 측정 결과(01~10)
```

## 실행

로컬 개발에는 **DB · 백엔드 · 프론트 세 가지**가 떠 있어야 한다. DB는 Prisma가 관리하는 로컬
Postgres로 `--detach`를 붙이면 백그라운드로 돌아가고, 백엔드/프론트는 터미널 2개를 잡는다.
프론트의 `/api/*`는 `next.config.mjs`의 rewrites로 `localhost:4000`에 프록시된다 — 백엔드가
꺼져 있으면 API 호출이 실패한다.

```bash
cd backend  && npx prisma dev --name daejourneyu --detach   # localhost:51214, 이미 떠 있으면 그대로 재사용
cd backend  && npm install && npm run dev    # http://localhost:4000 (tsx watch)
cd frontend && npm install && npm run dev    # http://localhost:3000
```

**IMPORTANT: DB는 `npm run dev`에 딸려 오지 않는다.** 재부팅·절전으로 detach된 Postgres가
사라져도 백엔드·프론트는 멀쩡히 뜨고 화면도 그려지기 때문에, 증상이 DB와 무관해 보이는 곳에서
나타난다 — 카카오 로그인이 `?error=kakao_db`로 되돌아오거나, 로그인·가입 API가 500을 뱉는 식이다.
**인증 계열이 갑자기 안 되면 카카오 콘솔을 뒤지기 전에 DB 상태부터 확인한다.**

```bash
cd backend && npx prisma dev ls        # status가 running인지 확인. 꺼져 있으면 위 --detach 명령으로 다시 기동
```

DB를 다시 띄운 뒤 백엔드를 재시작할 필요는 없다 — Prisma가 다음 쿼리에서 알아서 재연결한다.
접속 URL은 `backend/.env`의 `DATABASE_URL`이 정본이고, 포트(51214)는 `--name`으로 구분되는
서버마다 고정이다. 서버 목록·정지는 `prisma dev ls|stop|rm`으로 다룬다.

| | build | test | 그 외 |
|---|---|---|---|
| frontend | `npm run build` (타입 체크 포함) | `npm test` (`npm run test:watch`) | `npm run lint`, `npm start` |
| backend | `npm run build` (tsc → `dist/`) | `npm test` (`npm run test:watch`) | `npm start` |

양쪽 다 **Vitest**로 테스트를 돌린다. 테스트는 대상 파일 옆에 둔다
(`src/lib/feed.ts` ↔ `src/lib/feed.test.ts`, `app/(shell)/feed/page.tsx` ↔ `page.test.tsx`).

- **프론트**: 확장자로 환경이 갈린다. `*.test.ts`는 node(순수 함수·API 클라이언트·스토어),
  `*.test.tsx`는 jsdom + Testing Library(컴포넌트·페이지·훅). 픽스처는 `src/test/`에 있다.
- **백엔드**: 라우트는 supertest로 실제 라우터를 태우되 `lib/prisma`·`lib/auth`를 mock해서
  DB·`JWT_SECRET` 없이 돈다(`src/routes/posts.test.ts` 참고).
- **백엔드 통합 테스트**(`backend/test/integration/*.int.test.ts`): 실제 PostgreSQL 16에서 동시성·트랜잭션·
  트리거·CASCADE를 검증한다. `npm run db:test:up`(Docker, 127.0.0.1:54329) → `.env.test.example`을 `.env.test`로
  복사 → `npm run test:int`. 기본 `npm test`에는 포함되지 않으며, 원격 호스트를 가리키면 시작 전에 중단된다.
  `prisma dev`(PGlite)는 단일 연결이라 동시성 재현에 쓰지 않는다. 설계 근거는 `docs/db-optimization/`.
- `Post.saves`는 **DB 트리거가 유지**한다(`migrations/20261109000000_post_saves_counter_trigger`) — 앱에서 직접
  증감하지 않는다. 쓰기 경로를 추가할 때는 잠금 순서 **Course → 하위 테이블(CourseDay·PostSave)**을 지킨다.
- `Post.searchText`(검색 문서)는 **앱이 유지**한다 — 게시물을 만들거나 caption·text를 바꾸는 경로는 반드시
  `buildSearchText`로 함께 갱신한다(안 하면 그 글이 검색에 안 걸린다). 성능 실험 스크립트는 `backend/scripts/perf/`,
  결과는 `docs/db-optimization/03-query-performance.md`.
  API 부하·성능 회귀 게이트는 `bash backend/scripts/load/perf-gate.sh`(테스트 DB 필요, 결과 `backend/perf-out/`) — `docs/db-optimization/10`.

변경 후에는 **`npm test`와 `npm run build`를 둘 다 통과시킨다.** 프론트 테스트 파일은 `next build`의
타입 체크 대상이고, 백엔드 테스트 파일은 `tsconfig.json`에서 제외되어 `dist/`에 빌드되지 않는다.
현재 테스트가 있는 범위는 둘러보기·마이 탭과 `/api/posts`·`/api/reviews`다.

양쪽 `package.json`의 `"overrides": { "vite": "$vite" }`는 지우지 않는다. 없으면 vitest의 peer
계산이 vite 8을 끌어오고, vite 8 → `@vitejs/devtools` → `vitest@*`(5.x) 순환 때문에 npm 10이
`Cannot read properties of null (reading 'edgesOut')`로 설치에 실패한다. vite 7은 `@types/node
^20.19`를 요구해서 `@types/node`도 20.19.x로 올려 두었다.

## 배포

Vercel(프론트) + Railway(백엔드) + Supabase(DB)로 스테이징 배포돼 있다. 계정 연결·환경변수·
겪었던 문제까지 전체 절차는 `docs/deployment.md` 참고 — 재배포하거나 새로 세팅할 때 그 문서
순서를 따라가면 이미 겪은 함정(Root Directory 미지정, Vercel Production Branch 등)을 피할 수 있다.

| | URL |
|---|---|
| 프론트 | https://daejourneyu.vercel.app |
| 백엔드 | https://daejourneyu-production.up.railway.app |

## 현재 연동 상태 (중요)

README의 "홈에서 백엔드 `/api/places`를 불러온다"는 설명은 **더 이상 맞지 않는다.** 초기 스캐폴딩
이후 프론트가 재구축되면서 `app/page.tsx`는 `/home`으로 리다이렉트하고, 화면 데이터는 대부분
`frontend/src/mocks`의 목데이터를 TanStack Query 훅으로 읽는다. 실제 API 교체 지점은 코드에
`// TODO(api)`로 표시되어 있다.

**`Place`는 이제 Prisma로 영속화되어 있고, 프론트·백엔드 필드가 일치한다.** `/api/places`가
`district`/`category`/`petFriendly`/`smallDogOnly`/`lat`/`lng`/`imageUrl` 등 프론트
`src/types/place.ts` 필드명을 그대로 응답한다(예전엔 `gu`/`cat`처럼 백엔드 자체 필드명을 썼는데,
그 불일치를 이 작업에서 없앴다). `backend/scripts/syncPlaces.ts`가 관광공사·대전관광공사·식약처·
대전시·고캠핑·문체부 반려동물 동반가능 시설 현황(총 9개 소스 + CSV 1건)을 정규화·dedupe해서
`npm run sync:places`로 채워 넣는다 — 수동 실행이라 소스가 갱신되면 다시 돌려야 한다.

다만 이 데이터를 실제로 쓰는 건 아직 `frontend/src/components/course/PlacePickerSheet.tsx`(코스
위저드 장소 선택 시트)뿐이다. 홈/맵 탭이 쓰는 `frontend/src/hooks/usePlaces.ts`는 여전히
`mockPlaces`를 반환하는 상태(`TODO(api)` 그대로 남아 있음) — 실제 API로 바꾸는 건 그 탭 담당자가
할 일로 남겨뒀다.

## 도메인 용어

프로젝트 안에서만 통하는 의미이므로 아래 정의를 따른다.

- **장소(Place)**: 반려동물 동반 관점에서 관리하는 개별 지점. `petFriendly`는 동반 가능 여부,
  `condition`은 그 조건 설명(예: "전 견종 · 목줄 필수"). `smallDogOnly`처럼 조건이 세분화되므로
  "반려동물 가능"을 단일 불리언으로 뭉뚱그리지 않는다.
- **코스(Course)**: 여러 장소를 묶은 여행 일정 **템플릿**. 일차별 2차원 배열(`days`)이며,
  **당일치기도 `nights: 0` + `days.length === 1`로 통일**한다. 생성 출처는 `ai`(MBTI 기반) /
  `manual`(직접 구성) / `saved`.
- **일정(CourseSchedule)**: 코스에 실제 날짜를 붙여 내 여정에 등록한 것. 코스와 별개 개념이다.
- **MBTI**: 사람이 아니라 **반려동물의 성향 유형**. 결과가 AI 코스 추천 테마로 이어진다.
- **피드 포스트(FeedPost)**: 둘러보기 탭에 공유되는 "코스 게시물"(단순 사진 글이 아니라
  방문 장소 목록을 포함).
- **후기(Review)**: 장소에 달리는 평가. 피드 포스트와 별개 도메인이다.

## 공통 컨벤션

- **UI 카피·코드 주석은 한국어**로 작성한다.
- TypeScript `strict` 모드(프론트/백엔드 공통). `any` 대신 `unknown` 또는 명시적 타입.
- 시크릿·API 키는 `.env`에만 둔다(`.gitignore` 처리됨). **하드코딩 금지.**
- 날짜 문자열은 `YYYY-MM-DD` 형식으로 통일한다.
- 새 패키지 추가는 조용히 하지 말고 먼저 팀에 알린다 — 프론트는 3인이 동시 작업 중이다.

## Git 운영

- 브랜치는 담당 범위 단위로 분리한다(예: `feat/player1-home-map`). 커밋은 화면/스텝 단위로 작게.
- 프론트는 3인이 탭 경계로 분업 중이다. 세션 시작 시 **"나는 Player N"**을 밝히고,
  담당 범위는 `frontend/CLAUDE.md`의 팀 협업 표를 따른다. 담당 밖 파일은 건드리지 않는다.
- 공용 리소스(`src/components/ui`, 남의 `src/mocks`·`src/types` 파일, 공용 스토어)는 직접 고치지
  말고 소유자에게 요청한다.

## 주의사항

- `frontend/PLAN.md` §1에서 레거시/오펀으로 표시한 프로토타입 화면 8종은 **포팅 금지** — 예외 없다.
- 목데이터의 한글 *내용*은 프로토타입 HTML의 인코딩 깨짐 때문에 재구성된 것이라 잠정적이다.
  신뢰할 수 있는 건 *구조*(필드·유니언·관계)뿐이므로, 카피를 정본처럼 인용하지 않는다.
- PWA 서비스워커는 개발 모드에서 비활성이다. PWA 동작 확인은 `npm run build && npm start`로 한다.
- `frontend/public/manifest.json`은 `/icons/icon-192.png`·`icon-512.png`를 참조하지만
  `public/icons/` 폴더 자체가 아직 없다 — PWA 설치 아이콘 미완성 상태다.
