import { delay, http, HttpResponse } from "msw";

/** vitest.config.mts의 dom 프로젝트가 NEXT_PUBLIC_API_ORIGIN으로 넣는 값과 같아야 한다. */
export const API_ORIGIN = "http://localhost";

/** 핸들러 경로를 앱의 apiUrl과 같은 절대 URL로 만든다. 예: api("/api/reviews") */
export function api(path: string): string {
  return `${API_ORIGIN}${path}`;
}

/**
 * 기본 핸들러 — "아무 데이터도 없는 정상 서버". 화면마다 필요한 데이터는 각 테스트가
 * `server.use()`로 덮어써서 넣는다. 기본값을 빈 응답으로 둬야 한 테스트의 데이터가 다른 테스트의
 * 전제가 되는 일이 없다.
 */
export const handlers = [
  http.get(api("/api/reviews"), () => HttpResponse.json([])),
  http.get(api("/api/courses"), () => HttpResponse.json([])),
  http.get(api("/api/courses/schedules"), () => HttpResponse.json([])),
  http.get(api("/api/places"), () => HttpResponse.json([])),
];

/** 서버 오류 응답. `server.use(http.get(api("/api/reviews"), serverError))`처럼 쓴다. */
export function serverError() {
  return HttpResponse.json({ error: "서버 오류" }, { status: 500 });
}

/**
 * 응답을 테스트가 원하는 시점까지 붙잡아 두는 핸들러 리졸버. 낙관적 업데이트처럼 "응답 오기 전 화면"을
 * 확인할 때 쓴다. release()를 부르기 전까지 요청은 계속 대기한다.
 */
export function holdResponse(respond: () => Response | Promise<Response>) {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    resolver: async () => {
      await released;
      return respond();
    },
    release: () => release(),
  };
}

export { delay, http, HttpResponse };
