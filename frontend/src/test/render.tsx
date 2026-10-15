import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastViewport } from "@/components/ui/Toast";
import { createTestQueryClient } from "./query";

/**
 * 화면 테스트용 렌더 헬퍼. 앱의 Providers(app/layout.tsx)에서 화면 테스트에 필요한 것만 감싼다.
 *
 * - 부를 때마다 **새 QueryClient**를 만든다. 같은 클라이언트를 공유하면 앞 테스트가 받아 둔 캐시가 다음
 *   테스트에서 "이미 불러온 데이터"로 보여서, 로딩 상태 테스트가 순서에 따라 깨진다.
 * - 재시도는 끈다(createTestQueryClient). 켜 두면 실패 테스트가 재시도 대기만큼 느려진다.
 * - 토스트를 화면으로 확인할 수 있게 ToastViewport를 같이 그린다.
 * - Splash·AuthHydrator는 그리지 않는다. 로그인 상태는 테스트가 useAuthStore에 직접 넣는다.
 */
export function renderWithProviders(ui: ReactElement) {
  const client = createTestQueryClient();
  const user = userEvent.setup();
  const result = render(
    <QueryClientProvider client={client}>
      {ui}
      <ToastViewport />
    </QueryClientProvider>
  );
  return { ...result, user, client };
}
