import { useMemo, useSyncExternalStore } from "react";
import { vi } from "vitest";

/**
 * next/navigation 대체품 — 앱 라우터 없이 도는 "메모리 라우터".
 *
 * router.push/replace를 부르면 주소가 실제로 바뀌고, usePathname·useSearchParams를 쓰는 컴포넌트가
 * 다시 렌더된다. 그래서 "카테고리를 누르면 목록이 바뀐다"처럼 URL을 상태로 쓰는 화면도 사용자 행동
 * 그대로 테스트할 수 있다. 이동 여부는 router.push 호출이 아니라 `currentUrl()`로 확인하는 걸 권한다.
 *
 * 사용법(테스트 파일 맨 위):
 *   vi.mock("next/navigation", async () => (await import("@/test/navigation")).navigationMock);
 *   beforeEach(() => resetNavigation("/map?district=유성구"));
 */
const BASE = "http://localhost";

let url = new URL("/", BASE);
const listeners = new Set<() => void>();

function navigate(href: string) {
  url = new URL(href, url);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const router = {
  push: vi.fn(navigate),
  replace: vi.fn(navigate),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

/** 테스트 시작 주소를 정하고 이전 테스트의 호출 기록을 지운다. */
export function resetNavigation(href = "/") {
  url = new URL(href, BASE);
  Object.values(router).forEach((fn) => fn.mockClear());
}

/** 지금 주소(경로 + 쿼리). 한글 쿼리는 디코딩해서 돌려준다. 예: "/map?district=유성구" */
export function currentUrl(): string {
  return decodeURIComponent(url.pathname + url.search);
}

export const navigationMock = {
  useRouter: () => router,
  usePathname: () => useSyncExternalStore(subscribe, () => url.pathname),
  useSearchParams: () => {
    const search = useSyncExternalStore(subscribe, () => url.search);
    return useMemo(() => new URLSearchParams(search), [search]);
  },
  useParams: () => ({}),
  redirect: vi.fn(),
  notFound: vi.fn(),
};
