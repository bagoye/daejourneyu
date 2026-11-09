import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authCookie, createApp, createUser, prisma, resetDb } from "./helpers";

/**
 * 게시물 검색(GET /api/posts?q=) — 검색 문서(searchText) + trigram/태그 인덱스로 바꾼 뒤에도
 * 검색 결과의 **의미가 예전과 같은지** 실제 PostgreSQL에서 확인한다.
 *
 * 범위: caption·text·authorName·태그·방문 장소명·자치구 부분일치(대소문자 무시).
 * 태그는 서버 검색 이전 프론트(searchPosts)처럼 부분일치다 — 직전 서버 구현의 정확일치는 배열 부분검색이
 * 안 돼서 생긴 우회책이었다(docs/db-optimization/03-query-performance.md §5.1).
 */

const app = createApp();

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const stop = (name: string, district: string) => ({
  placeId: name,
  name,
  category: "산책",
  district,
  condition: "전 견종",
  petFriendly: true,
});

async function publish(userId: string, body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/posts")
    .set("Cookie", authCookie(userId))
    .send({
      caption: "기본 코스",
      text: "",
      tags: [],
      authorName: "작성자",
      authorEmoji: "🐶",
      petTypeName: "유형",
      stops: [stop("기본 장소", "중구")],
      ...body,
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function search(q: string): Promise<string[]> {
  const res = await request(app).get(`/api/posts?q=${encodeURIComponent(q)}&limit=50`);
  expect(res.status).toBe(200);
  return (res.body.items as { id: string }[]).map((p) => p.id).sort();
}

describe("검색 범위", () => {
  it("제목·한마디·작성자·태그·방문 장소명·자치구를 부분일치로 찾는다", async () => {
    const user = await createUser("author");
    const byCaption = await publish(user.id, { caption: "갑천 벚꽃 산책" });
    const byText = await publish(user.id, { text: "갑천변이 시원했어요" });
    const byAuthor = await publish(user.id, { authorName: "갑천러버" });
    const byStop = await publish(user.id, { stops: [stop("갑천 물놀이장", "서구")] });
    const byDistrict = await publish(user.id, { stops: [stop("어딘가", "유성구")] });
    const byTag = await publish(user.id, { tags: ["당일치기"] });
    await publish(user.id, {}); // 아무 데도 해당 없음

    expect(await search("갑천")).toEqual([byCaption, byText, byAuthor, byStop].sort());
    expect(await search("유성")).toEqual([byDistrict]);
    // 태그도 부분일치
    expect(await search("당일치기")).toEqual([byTag]);
    expect(await search("당일")).toEqual([byTag]);
    // 없는 검색어는 빈 결과
    expect(await search("없는검색어")).toEqual([]);
  });

  it("대소문자를 구분하지 않는다", async () => {
    const user = await createUser("author");
    const id = await publish(user.id, { caption: "Expo Park" });
    expect(await search("expo")).toEqual([id]);
  });

  it("검색어가 두 필드에 걸쳐 이어지는 경우는 매칭하지 않는다(예전 필드별 검색과 같음)", async () => {
    const user = await createUser("author");
    await publish(user.id, { caption: "산책 코스", text: "좋았어요" });
    // 이어 붙이면 "...코스 좋았어요..."가 되지만, 필드 사이가 줄바꿈이라 걸리지 않는다
    expect(await search("코스 좋았")).toEqual([]);
  });

  it("글을 고치면 바뀐 제목으로 찾을 수 있고, 옛 제목으로는 안 나온다", async () => {
    const user = await createUser("author");
    const id = await publish(user.id, { caption: "옛 제목" });

    await request(app).patch(`/api/posts/${id}`).set("Cookie", authCookie(user.id)).send({ caption: "새 제목 보문산" }).expect(200);

    expect(await search("보문산")).toEqual([id]);
    expect(await search("옛 제목")).toEqual([]);
  });

  it("% · _ 같은 LIKE 와일드카드는 글자 그대로 찾는다", async () => {
    const user = await createUser("author");
    const id = await publish(user.id, { caption: "할인 50% 카페" });
    await publish(user.id, { caption: "할인 500원" });
    expect(await search("50%")).toEqual([id]);
  });
});
