import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 프론트 테스트 설정. 확장자로 환경을 가른다.
// - *.test.ts  → node  : 순수 함수·API 클라이언트·스토어
// - *.test.tsx → jsdom : 컴포넌트·페이지·훅(Testing Library)
export default defineConfig({
  resolve: {
    // tsconfig의 `@/*` → `./src/*` 별칭을 테스트에서도 그대로 쓴다.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // tsconfig는 jsx: "preserve"(변환은 Next 몫)라 테스트에서는 esbuild가 JSX를 직접 변환하게 한다.
  esbuild: { jsx: "automatic" },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "app/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx", "app/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.dom.tsx"],
          // Node의 fetch는 "/api/..." 같은 상대경로를 못 받는다. apiUrl이 절대 URL을 만들도록 오리진을
          // 넣고, MSW 핸들러(src/test/msw/handlers.ts)도 같은 오리진으로 맞춘다.
          env: { NEXT_PUBLIC_API_ORIGIN: "http://localhost" },
        },
      },
    ],
  },
});
