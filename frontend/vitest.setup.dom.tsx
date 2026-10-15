import type { AnchorHTMLAttributes, ReactNode } from "react";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "@/test/msw/server";

// 화면 테스트의 가짜 백엔드(MSW). 핸들러가 없는 요청은 에러로 실패시킨다 — 조용히 실제 네트워크로
// 나가거나 무시되면, 테스트가 무엇에 기대고 있는지 모르는 채로 통과하게 된다.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

// globals를 켜지 않아 Testing Library의 자동 정리가 걸리지 않는다 — 테스트마다 직접 비운다.
afterEach(() => {
  cleanup();
  // 테스트가 server.use()로 바꾼 응답을 기본 핸들러로 되돌린다.
  server.resetHandlers();
});

afterAll(() => server.close());

interface LinkMockProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children?: ReactNode;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

/**
 * next/link는 앱 라우터·프리페치에 기대고 있어 jsdom에서 그대로 쓰면 부수효과가 많다.
 * 테스트가 확인하는 건 "어디로 가는 링크인가"뿐이라 모든 테스트에서 평범한 <a>로 바꾼다.
 */
vi.mock("next/link", () => ({
  default: function LinkMock({
    href,
    children,
    prefetch: _prefetch,
    replace: _replace,
    scroll: _scroll,
    ...rest
  }: LinkMockProps) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));
