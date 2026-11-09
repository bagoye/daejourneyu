import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authCookie, createApp, createPost, createUser, prisma, resetDb } from "./helpers";

/**
 * 게시물·후기 목록의 커서 페이지네이션 정합성 — 실제 PostgreSQL 16.
 *
 * "정상"의 정의(03이 아니라 02-transaction.md §6과 동일):
 *  - 데이터가 바뀌지 않으면 끝까지 넘겼을 때 모든 항목이 정확히 한 번씩 나온다(정렬 값이 같아도).
 *  - 커서로 쓴 글이 지워져도 나머지 목록은 이어서 받을 수 있다.
 *  - 커서로 쓴 글의 정렬 값(담긴 수)이 바뀌어도, 값이 그대로인 다른 글은 건너뛰거나 다시 나오지 않는다.
 *  - 스크롤 도중 새 글이 올라와도 이미 받은 글이 다시 나오지 않는다.
 */

const app = createApp();

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

type Page = { items: { id: string }[]; nextCursor: string | null };

async function fetchPage(query: string, cursor?: string | null): Promise<Page> {
  const qs = new URLSearchParams(query);
  if (cursor) qs.set("cursor", cursor);
  const res = await request(app).get(`/api/posts?${qs}`);
  expect(res.status).toBe(200);
  return res.body as Page;
}

async function fetchAll(query: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page: Page = await fetchPage(query, cursor);
    ids.push(...page.items.map((p) => p.id));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error("페이지가 끝나지 않음");
}

/** saves·createdAt을 직접 지정한 글 여러 개. 담긴 수는 트리거 대상이 아닌 테스트용 직접 값이다. */
async function seedPosts(specs: { saves: number; createdAt: Date }[]) {
  const author = await createUser("author");
  const ids: string[] = [];
  for (const spec of specs) {
    const post = await createPost(author.id, null, 1);
    await prisma.post.update({ where: { id: post.id }, data: { saves: spec.saves, createdAt: spec.createdAt } });
    ids.push(post.id);
  }
  return { author, ids };
}

describe("게시물 커서 — 정렬 값이 같은 글", () => {
  it("담긴 수·작성 시각이 전부 같은 23개도 끝까지 넘기면 정확히 한 번씩 나온다", async () => {
    const same = new Date("2026-10-01T00:00:00.000Z");
    const { ids } = await seedPosts(Array.from({ length: 23 }, () => ({ saves: 3, createdAt: same })));

    for (const sort of ["saves", "recent"]) {
      const seen = await fetchAll(`sort=${sort}&limit=5`);
      expect(seen).toHaveLength(23);
      expect(new Set(seen)).toEqual(new Set(ids));
    }
  });
});

describe("게시물 커서 — 페이지 사이에 데이터가 바뀌는 경우", () => {
  const t = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, n));

  it("커서로 쓴 글이 지워져도 나머지를 이어서 받는다", async () => {
    await seedPosts(Array.from({ length: 6 }, (_, i) => ({ saves: 0, createdAt: t(i) })));

    const first = await fetchPage("sort=recent&limit=2");
    const cursorPost = first.items.at(-1)!.id;
    await prisma.post.delete({ where: { id: cursorPost } });
    const rest = await fetchAll(`sort=recent&limit=2&cursor=${first.nextCursor}`);

    // 앞 페이지 2개 + 나머지 4개 = 원래 6개 중 지운 1개 빼고 빠짐없이
    expect(first.items.length + rest.length).toBe(6);
    expect(rest).not.toContain(cursorPost);
  });

  it("커서 글의 담긴 수가 올라가도, 값이 그대로인 다른 글은 건너뛰거나 다시 나오지 않는다", async () => {
    // 담긴 수 5,4,3,2,1,0 — 2개씩 받는다
    const { ids } = await seedPosts([5, 4, 3, 2, 1, 0].map((saves, i) => ({ saves, createdAt: t(i) })));

    const first = await fetchPage("sort=saves&limit=2");
    expect(first.items.map((p) => p.id)).toEqual([ids[0], ids[1]]);
    // 첫 페이지 마지막 글(담긴 수 4)이 그 사이 인기 글이 됐다
    await prisma.post.update({ where: { id: ids[1] }, data: { saves: 10 } });

    const second = await fetchPage("sort=saves&limit=2", first.nextCursor);

    expect(second.items.map((p) => p.id)).toEqual([ids[2], ids[3]]);
  });

  it("스크롤 도중 새 글이 올라와도 이미 받은 글이 다시 나오지 않는다", async () => {
    const { author } = await seedPosts(Array.from({ length: 4 }, (_, i) => ({ saves: 0, createdAt: t(i) })));

    const first = await fetchPage("sort=recent&limit=2");
    await createPost(author.id, null, 1); // 지금 시각 → 최신순 맨 위
    const second = await fetchPage("sort=recent&limit=2", first.nextCursor);

    const firstIds = first.items.map((p) => p.id);
    expect(second.items.map((p) => p.id).filter((id) => firstIds.includes(id))).toEqual([]);
    expect(second.items).toHaveLength(2);
  });

  it("예전 형식(글 id) 커서도 계속 받아준다", async () => {
    const { ids } = await seedPosts(Array.from({ length: 4 }, (_, i) => ({ saves: 0, createdAt: t(i) })));
    const newestFirst = [...ids].reverse();

    const page = await fetchPage("sort=recent&limit=2", newestFirst[1]);

    expect(page.items.map((p) => p.id)).toEqual([newestFirst[2], newestFirst[3]]);
  });

  it("해석할 수 없는 커서는 400", async () => {
    const res = await request(app).get("/api/posts?cursor=" + encodeURIComponent("v1.@@@"));
    expect(res.status).toBe(400);
  });
});

describe("후기 목록", () => {
  async function seedReviews() {
    const me = await createUser("me");
    const other = await createUser("other");
    const tag = await prisma.reviewTagOption.create({ data: { code: "LEASH", label: "목줄", category: "CAUTION" } });
    const same = new Date("2026-10-01T00:00:00.000Z");
    const make = (authorId: string, placeId: string, createdAt: Date) =>
      prisma.review.create({
        data: { authorId, placeId, placeName: placeId, createdAt, tags: { create: [{ tagId: tag.id }] } },
      });
    for (let i = 0; i < 3; i++) await make(me.id, `place-${i}`, same);
    for (let i = 0; i < 9; i++) await make(other.id, "place-0", same);
    return { me, other };
  }

  it("mine=true면 내 후기만 내려준다(전 사용자 후기를 받아 화면에서 거르지 않는다)", async () => {
    const { me } = await seedReviews();

    const res = await request(app).get("/api/reviews?mine=true").set("Cookie", authCookie(me.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.every((r: { isMine: boolean }) => r.isMine)).toBe(true);
  });

  it("mine=true는 로그인이 필요하다", async () => {
    expect((await request(app).get("/api/reviews?mine=true")).status).toBe(401);
  });

  it("장소 후기를 limit 단위로 끝까지 넘기면 작성 시각이 같아도 정확히 한 번씩 나온다", async () => {
    await seedReviews();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const qs = new URLSearchParams({ placeId: "place-0", limit: "4" });
      if (cursor) qs.set("cursor", cursor);
      const res = await request(app).get(`/api/reviews?${qs}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((r: { id: string }) => r.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    // place-0: 내 후기 1 + 남의 후기 9
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it("limit을 보내지 않으면 예전처럼 배열 전체를 준다(하위 호환)", async () => {
    await seedReviews();
    const res = await request(app).get("/api/reviews?placeId=place-0");
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(10);
  });
});
