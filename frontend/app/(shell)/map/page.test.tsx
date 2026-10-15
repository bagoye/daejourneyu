import { beforeEach, describe, it, vi } from "vitest";
import type { Place } from "@/types";
import { makePlace } from "@/test/fixtures";
import { api, http, HttpResponse } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { resetNavigation } from "@/test/navigation";

vi.mock("next/navigation", async () => (await import("@/test/navigation")).navigationMock);

/**
 * ✍️ 직접 작성할 화면 테스트 — 댕댕지도 장소 목록(필터·검색).
 * 참고 구현: app/(shell)/my/reviews/page.test.tsx
 *
 * 렌더: renderWithProviders(<MapPage />) — import MapPage from "./page";
 * 이 화면은 구·카테고리를 URL(?district=&category=)에 담는다. 메모리 라우터라 카테고리를 누르면 주소가
 * 실제로 바뀌고 화면도 다시 그려진다 — 주소는 currentUrl()로, 목록은 화면 글자로 확인한다.
 * 서버가 받은 필터는 아래 `requested`에 쌓인다(MSW 핸들러가 요청 URL을 기록).
 */

/** 서버 DB 역할. 유성구 장소들. */
let places: Place[];
/** 서버가 받은 쿼리스트링 기록. 예: [{ district: "유성구", category: "산책" }] */
let requested: Record<string, string>[];

beforeEach(() => {
  resetNavigation("/map?district=유성구");
  requested = [];
  places = [
    makePlace({ id: "p1", name: "갑천 산책로", district: "유성구", category: "산책" }),
    makePlace({ id: "p2", name: "댕댕 놀이터", district: "유성구", category: "놀이터" }),
    makePlace({ id: "p3", name: "멍멍 식당", district: "유성구", category: "맛집" }),
  ];

  server.use(
    http.get(api("/api/places"), ({ request }) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      requested.push(query);
      return HttpResponse.json(
        places.filter((place) => !query.category || place.category === query.category)
      );
    })
  );
});

describe("댕댕지도 — 목록", () => {
  it.todo("불러오는 동안 '불러오는 중…'을 보여주고, 도착하면 유성구 장소 카드 3개를 보여준다");
  it.todo("서버가 실패해도 에러 화면 대신 목데이터(mockPlaces)의 유성구 장소를 보여준다");
  it.todo("장소가 하나도 없으면 '유성구에 조건에 맞는 장소가 아직 없어요.'를 보여준다");
});

describe("댕댕지도 — 필터·검색", () => {
  it.todo("'산책' 태그를 누르면 주소가 /map?district=유성구&category=산책 으로 바뀌고, 서버에 category=산책이 실려 가고, 산책 장소만 보인다");
  it.todo("'전체'를 누르면 카테고리 필터가 풀리고 다시 3곳이 보인다");
  it.todo("검색창에 '놀이터'를 입력하면 이름·조건에 맞는 장소만 남는다");
  it.todo("검색 결과가 없으면 '‘없는장소’ 검색 결과가 없어요.'를 보여준다");
  it.todo("21곳 이상이면 '더 보기 · N곳 남음' 버튼이 보이고, 누르면 나머지가 보인다");
});
