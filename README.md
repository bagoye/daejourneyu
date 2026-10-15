# Daejourneyu — 프로젝트 기초 세팅

**Daejourneyu** = Dae(대전) + journey + 유(충청 사투리 / "you")
반려동물과 함께하는 대전 여행 플랫폼. 로고 워드마크는 `DaeJourneyU` (끝 U 강조 → journey with **you**).

Next.js 14 (App Router) + TypeScript + PWA 프론트엔드 / Node.js(Express) + TypeScript 백엔드.

```
daejourneyu-starter/
├─ frontend/                 # Next.js + TS + PWA
│  ├─ app/
│  │  ├─ layout.tsx          # 루트 레이아웃 (manifest·테마색·Pretendard)
│  │  ├─ page.tsx            # 홈 (백엔드 /api/places 연동 예시)
│  │  └─ globals.css         # 디자인 토큰(티일 팔레트)
│  ├─ public/
│  │  ├─ manifest.json       # PWA 매니페스트
│  │  └─ icons/              # icon-192.png / icon-512.png 넣기
│  ├─ next.config.mjs        # next-pwa + /api 프록시
│  ├─ tsconfig.json
│  └─ package.json
└─ backend/                  # Node.js + Express + TS
   ├─ src/
   │  ├─ index.ts            # 서버 진입점 (CORS·라우트)
   │  └─ routes/places.ts    # /api/places
   ├─ tsconfig.json
   └─ package.json
```

## 실행 방법

### 1) 백엔드 (터미널 A)
```bash
cd backend
npm install
npm run dev          # http://localhost:4000  (tsx watch)
```

### 2) 프론트엔드 (터미널 B)
```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```
브라우저에서 http://localhost:3000 접속 → 백엔드의 장소 목록이 보이면 연동 성공.

## 테스트

```bash
cd frontend
npm test             # 전체 1회 실행 (Vitest)
npm run test:watch   # 파일 저장할 때마다 다시 실행
npm run typecheck    # tsc --noEmit
npm run lint         # next lint

cd backend
npm test && npm run typecheck
```
PR을 올리면 GitHub Actions(`.github/workflows/ci.yml`)가 프론트·백엔드의 타입 검사·린트·테스트를 같은 명령으로 돌린다.

**테스트 전략.** 순수 계산(`src/lib`)은 단위 테스트로 촘촘하게 확인하고, 화면은 **사용자가 보는 것** 기준으로
검증한다. 화면 테스트는 버튼·글자를 역할과 이름(`getByRole`, `getByText`)으로 찾아 클릭·입력하고, state나 내부
함수는 들여다보지 않는다. 네트워크는 fetch를 직접 mock하지 않고 **MSW**(`src/test/msw`)로 가짜 서버를 세워
"화면 → TanStack Query 훅 → fetch" 전 구간을 실제로 태운다. 그래서 쿼리키·캐시 무효화·낙관적 업데이트와 롤백이
맞물리지 않으면 테스트가 깨진다. 테스트마다 새 QueryClient를 쓰고(`renderWithProviders`, 캐시 공유 방지),
라우터는 메모리 라우터(`src/test/navigation.ts`)로 바꿔 URL 상태까지 사용자 행동으로 검증한다. 서버 컴포넌트,
카카오맵 SDK처럼 jsdom에서 의미 있게 돌릴 수 없는 부분은 화면 테스트 대상에서 뺐다.

## PWA
- `public/manifest.json` + `next-pwa`로 서비스워커 자동 생성 (프로덕션 빌드 시).
- **아이콘 필요**: `public/icons/icon-192.png`, `icon-512.png` 를 넣어주세요 (프로토타입 로고 SVG → PNG export).
- 개발 모드에선 SW 비활성(`disable: NODE_ENV==='development'`). 테스트는 `npm run build && npm start`.

## 브랜딩
- 앱 표시명: **Daejourneyu** / 워드마크: `DaeJourneyU`
- 공식 로마자 병기 필요 시: `Daejeoniyu`
- 태그라인 예: *"Journey Daejeon, with you & your dog."*
- 팔레트: Main #35AD90 / Orange #FF8A3D / Navy #183B56 / Blue #4F7CF7

## 다음 단계 (권장)
- **DB**: Prisma + PostgreSQL (또는 Supabase) — `routes`의 임시 배열을 DB 쿼리로 교체
- **데이터패칭**: TanStack Query (React Query)
- **지도**: 카카오맵 (`react-kakao-maps-sdk`)
- **인증**: NextAuth.js (카카오 로그인)
- **배포**: 프론트 = Vercel, 백엔드 = Railway/Render, DB = Supabase
