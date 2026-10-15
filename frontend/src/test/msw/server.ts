import { setupServer } from "msw/node";
import { handlers } from "./handlers";

/**
 * 화면 테스트용 가짜 백엔드. fetch 자체는 진짜로 실행되고, 네트워크로 나가기 직전에 MSW가 가로채
 * handlers의 응답을 돌려준다. 테스트마다 응답을 바꾸려면 `server.use(...)`로 덮어쓴다 —
 * vitest.setup.dom.tsx가 테스트가 끝날 때마다 resetHandlers()로 기본값으로 되돌린다.
 */
export const server = setupServer(...handlers);
