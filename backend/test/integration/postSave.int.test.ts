import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  authCookie,
  countOrphanSavedCourses,
  createApp,
  createCourse,
  createPost,
  createUser,
  findSaveCountDrift,
  prisma,
  resetDb,
} from "./helpers";

/**
 * 담기(POST/DELETE /api/posts/:id/save) 동시성·정합성 통합 테스트 — 실제 PostgreSQL 16.
 *
 * "정상"의 정의(02-transaction.md와 동일):
 *  - 같은 사용자의 동시 담기 N건 → PostSave 1행, 보관함 사본 1개, saves +1, 모든 요청이 200·같은 courseId
 *  - 같은 사용자의 동시 취소 N건 → 행 0개, saves −1 한 번, 모든 요청이 200 saved:false
 *  - 담기와 취소가 섞여도 → 최종 상태는 어떤 직렬 순서의 결과와 같고, saves = 실제 행 수
 *  - 서로 다른 사용자 M명 → saves +M (갱신 유실 없음)
 *  - 트랜잭션 중간 실패 → 사본·기록·saves 모두 요청 전과 동일
 */

const app = createApp();
const N = 10;

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const author = await createUser("author");
  const viewer = await createUser("viewer");
  const course = await createCourse(author.id, [2]);
  const post = await createPost(author.id, course.id, 2);
  return { author, viewer, post };
}

const save = (postId: string, userId: string) =>
  request(app).post(`/api/posts/${postId}/save`).set("Cookie", authCookie(userId));
const unsave = (postId: string, userId: string) =>
  request(app).delete(`/api/posts/${postId}/save`).set("Cookie", authCookie(userId));

async function savedCopies(userId: string) {
  return prisma.course.count({ where: { userId, source: "saved" } });
}

describe("같은 사용자의 중복 담기", () => {
  it(`동시에 ${N}번 담아도 기록·사본은 하나, 모든 요청이 같은 결과를 받는다`, async () => {
    const { viewer, post } = await setup();

    const responses = await Promise.all(Array.from({ length: N }, () => save(post.id, viewer.id)));

    expect(responses.map((r) => r.status)).toEqual(Array(N).fill(200));
    const courseIds = new Set(responses.map((r) => r.body.courseId));
    expect(courseIds.size).toBe(1);
    expect(await prisma.postSave.count({ where: { postId: post.id } })).toBe(1);
    expect(await savedCopies(viewer.id)).toBe(1);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).saves).toBe(1);
    expect(await findSaveCountDrift()).toEqual([]);
    expect(await countOrphanSavedCourses()).toBe(0);
  });

  it("순차로 반복 전송해도 멱등이다", async () => {
    const { viewer, post } = await setup();

    const first = await save(post.id, viewer.id);
    const second = await save(post.id, viewer.id);
    const third = await save(post.id, viewer.id);

    for (const res of [first, second, third]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ saves: 1, saved: true, courseId: first.body.courseId });
    }
    expect(await savedCopies(viewer.id)).toBe(1);
  });
});

describe("서로 다른 사용자의 동시 담기", () => {
  it("20명이 동시에 담으면 saves는 정확히 20이다(갱신 유실 없음)", async () => {
    const { post } = await setup();
    const users = await Promise.all(Array.from({ length: 20 }, (_, i) => createUser(`saver-${i}`)));

    const responses = await Promise.all(users.map((u) => save(post.id, u.id)));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).saves).toBe(20);
    expect(await prisma.postSave.count()).toBe(20);
    expect(await findSaveCountDrift()).toEqual([]);
  });
});

describe("담기 취소의 동시성", () => {
  it(`동시에 ${N}번 취소해도 saves는 한 번만 줄고 모든 요청이 200이다`, async () => {
    const { viewer, post } = await setup();
    await save(post.id, viewer.id);

    const responses = await Promise.all(Array.from({ length: N }, () => unsave(post.id, viewer.id)));

    expect(responses.map((r) => r.status)).toEqual(Array(N).fill(200));
    expect(responses.every((r) => r.body.saved === false && r.body.saves === 0)).toBe(true);
    expect(await prisma.postSave.count()).toBe(0);
    expect(await savedCopies(viewer.id)).toBe(0);
    expect(await findSaveCountDrift()).toEqual([]);
  });

  it("취소와 보관함 사본 직접 삭제가 겹쳐도 둘 다 성공하고 정합성이 유지된다", async () => {
    const { viewer, post } = await setup();
    const { body } = await save(post.id, viewer.id);

    const [unsaveRes, deleteRes] = await Promise.all([
      unsave(post.id, viewer.id),
      request(app).delete(`/api/courses/${body.courseId}`).set("Cookie", authCookie(viewer.id)),
    ]);

    expect(unsaveRes.status).toBe(200);
    // 코스 삭제는 취소가 먼저 사본을 지웠으면 404, 아니면 204 — 둘 다 정상
    expect([204, 404]).toContain(deleteRes.status);
    expect(await prisma.postSave.count()).toBe(0);
    expect(await savedCopies(viewer.id)).toBe(0);
    expect(await findSaveCountDrift()).toEqual([]);
  });

  it("담기·취소를 무작위로 섞어 동시에 보내도 최종 saves = 실제 행 수", async () => {
    const { post } = await setup();
    const users = await Promise.all(Array.from({ length: 5 }, (_, i) => createUser(`mix-${i}`)));

    // 고정 시드 의사난수 — 실패하면 같은 순서로 재현할 수 있게
    let s = 42;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const ops = Array.from({ length: 60 }, () => {
      const user = users[Math.floor(rand() * users.length)]!;
      return rand() < 0.5 ? save(post.id, user.id) : unsave(post.id, user.id);
    });
    const responses = await Promise.all(ops);

    expect(responses.filter((r) => r.status !== 200).map((r) => [r.status, r.body])).toEqual([]);
    expect(await findSaveCountDrift()).toEqual([]);
    expect(await countOrphanSavedCourses()).toBe(0);
    // 사용자별로 기록이 있으면 사본도 정확히 하나, 없으면 0
    for (const user of users) {
      const rows = await prisma.postSave.count({ where: { userId: user.id } });
      expect(await savedCopies(user.id)).toBe(rows);
    }
  });
});

describe("트랜잭션 중간 실패 시 롤백", () => {
  /**
   * DB 레벨 장애 주입: 이 트랜잭션이 Post 행을 갱신하는 순간 예외를 일으킨다. 담기는 사본 생성·기록
   * 삽입 뒤에 담긴 수를 바꾸므로, 앞선 쓰기까지 함께 되돌려지는지 확인할 수 있다(구현과 무관하게 동작).
   */
  async function failOnPostUpdate<T>(fn: () => Promise<T>): Promise<T> {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_post_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$;`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_fail_post_update BEFORE UPDATE ON "Post" FOR EACH ROW EXECUTE FUNCTION test_fail_post_update()`
    );
    try {
      return await fn();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_post_update ON "Post"`);
    }
  }

  it("담기 도중 실패하면 사본·기록·saves가 모두 원래대로다", async () => {
    const { viewer, post } = await setup();

    const res = await failOnPostUpdate(() => save(post.id, viewer.id));

    expect(res.status).toBe(500);
    expect(await prisma.postSave.count()).toBe(0);
    expect(await savedCopies(viewer.id)).toBe(0);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).saves).toBe(0);
  });

  it("취소 도중 실패하면 기록·사본이 그대로 남는다", async () => {
    const { viewer, post } = await setup();
    await save(post.id, viewer.id);

    const res = await failOnPostUpdate(() => unsave(post.id, viewer.id));

    expect(res.status).toBe(500);
    expect(await prisma.postSave.count()).toBe(1);
    expect(await savedCopies(viewer.id)).toBe(1);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).saves).toBe(1);
  });
});

describe("Cascade 삭제와 담긴 수", () => {
  it("담은 사용자가 탈퇴(삭제)되면 그 기록이 사라진 만큼 saves도 줄어든다", async () => {
    const { post } = await setup();
    const a = await createUser("leaver");
    const b = await createUser("stayer");
    await save(post.id, a.id);
    await save(post.id, b.id);

    await prisma.user.delete({ where: { id: a.id } });

    expect(await prisma.postSave.count()).toBe(1);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).saves).toBe(1);
    expect(await findSaveCountDrift()).toEqual([]);
  });

  it("글이 지워지면 담기 기록은 사라지고, 담은 사람의 보관함 사본은 남는다", async () => {
    const { author, viewer, post } = await setup();
    await save(post.id, viewer.id);

    const res = await request(app).delete(`/api/posts/${post.id}`).set("Cookie", authCookie(author.id));

    expect(res.status).toBe(204);
    expect(await prisma.postSave.count()).toBe(0);
    expect(await savedCopies(viewer.id)).toBe(1);
  });
});
