import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  authCookie,
  createApp,
  createCourse,
  createPost,
  createUser,
  prisma,
  resetDb,
  stop,
} from "./helpers";

/**
 * 코스 수정(PATCH /api/courses/:id) 동시성·원자성 통합 테스트 — 실제 PostgreSQL 16.
 *
 * "정상"의 정의(02-transaction.md와 동일):
 *  - 같은 코스에 동시 PATCH N건 → 모두 200. 최종 동선은 보낸 페이로드 중 **정확히 하나와 통째로 같다**
 *    (일차·장소가 섞이지 않음). 마지막으로 커밋된 요청이 이긴다(last-writer-wins).
 *  - PATCH와 DELETE가 겹치면 → PATCH는 200 또는 404(이미 삭제됨). 500은 없다.
 *  - 트랜잭션 중간 실패 → 기존 동선이 그대로 남는다.
 */

const app = createApp();

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

/** 각 요청이 구분되는 동선: variant k는 일차 수와 placeId 접두사가 다르다. */
function daysVariant(k: number) {
  const dayCount = (k % 3) + 1;
  return Array.from({ length: dayCount }, (_, d) =>
    Array.from({ length: 2 }, (_, i) => ({ ...stop(i), placeId: `v${k}-d${d}-${i}` }))
  );
}

async function readDays(courseId: string) {
  const days = await prisma.courseDay.findMany({
    where: { courseId },
    orderBy: { dayIndex: "asc" },
    include: { stops: { orderBy: { order: "asc" } } },
  });
  return days.map((d) => d.stops.map((s) => s.placeId));
}

const patch = (courseId: string, userId: string, body: object) =>
  request(app).patch(`/api/courses/${courseId}`).set("Cookie", authCookie(userId)).send(body);

describe("같은 코스 동시 수정", () => {
  it("동시에 8번 수정해도 모두 200이고, 최종 동선은 보낸 것 중 하나와 통째로 같다", async () => {
    const owner = await createUser("owner");
    const course = await createCourse(owner.id, [2, 2]);
    const variants = Array.from({ length: 8 }, (_, k) => daysVariant(k));

    const responses = await Promise.all(variants.map((days) => patch(course.id, owner.id, { days })));

    expect(responses.map((r) => [r.status, r.body.error])).toEqual(Array(8).fill([200, undefined]));
    const final = await readDays(course.id);
    const candidates = variants.map((days) => days.map((day) => day.map((s) => s.placeId)));
    expect(candidates).toContainEqual(final);
  });

  it("이름만 바꾸는 요청과 동선을 바꾸는 요청이 겹쳐도 둘 다 반영된다", async () => {
    const owner = await createUser("owner");
    const course = await createCourse(owner.id, [2]);
    const days = daysVariant(4);

    const [a, b] = await Promise.all([
      patch(course.id, owner.id, { label: "새 이름" }),
      patch(course.id, owner.id, { days }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const row = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
    expect(row.label).toBe("새 이름");
    expect(await readDays(course.id)).toEqual(days.map((d) => d.map((s) => s.placeId)));
  });

  it("수정과 삭제가 겹치면 수정은 200 또는 404이고 500은 없다", async () => {
    const owner = await createUser("owner");
    for (let round = 0; round < 5; round++) {
      const course = await createCourse(owner.id, [2]);
      const [p, d] = await Promise.all([
        patch(course.id, owner.id, { days: daysVariant(round) }),
        request(app).delete(`/api/courses/${course.id}`).set("Cookie", authCookie(owner.id)),
      ]);
      expect([200, 404]).toContain(p.status);
      expect(d.status).toBe(204);
      // 삭제가 이겼든 졌든 남은 일차·장소가 없어야 한다(고아 행 없음)
      expect(await prisma.courseDay.count({ where: { courseId: course.id } })).toBe(0);
    }
  });
});

describe("소유권", () => {
  it("남의 코스는 404이고 동선이 바뀌지 않는다", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    const course = await createCourse(owner.id, [2]);
    const before = await readDays(course.id);

    const res = await patch(course.id, other.id, { days: daysVariant(1), label: "탈취" });

    expect(res.status).toBe(404);
    expect(await readDays(course.id)).toEqual(before);
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).label).toBe("테스트 코스");
  });
});

describe("트랜잭션 중간 실패 시 롤백", () => {
  it("새 장소를 넣다가 실패하면 기존 동선이 그대로 남는다", async () => {
    const owner = await createUser("owner");
    const course = await createCourse(owner.id, [2, 1]);
    const before = await readDays(course.id);

    // DB 레벨 장애 주입: 특정 placeId가 들어오는 순간 예외 — 기존 일차 삭제 이후 시점이다.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_stop_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."placeId" = 'boom' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_fail_stop_insert BEFORE INSERT ON "CourseStop" FOR EACH ROW EXECUTE FUNCTION test_fail_stop_insert()`
    );
    try {
      const res = await patch(course.id, owner.id, {
        days: [[stop(9)], [{ ...stop(10), placeId: "boom" }]],
      });
      expect(res.status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_stop_insert ON "CourseStop"`);
    }

    expect(await readDays(course.id)).toEqual(before);
  });
});

describe("코스 삭제 시 참조 무결성", () => {
  it("일차·장소·일정은 함께 지워지고, 글과 담기 기록은 남되 연결만 끊긴다", async () => {
    const owner = await createUser("owner");
    const saver = await createUser("saver");
    const course = await createCourse(owner.id, [2, 1]);
    await prisma.courseSchedule.create({
      data: { courseId: course.id, date: "2026-12-01", festivalTitles: { create: [{ title: "축제" }] } },
    });
    const post = await createPost(owner.id, course.id, 3);
    // 담은 사람의 보관함 사본을 삭제 대상으로 쓴다 — PostSave.courseId가 SetNull 되는지 본다
    const saved = await request(app).post(`/api/posts/${post.id}/save`).set("Cookie", authCookie(saver.id));

    await request(app).delete(`/api/courses/${course.id}`).set("Cookie", authCookie(owner.id)).expect(204);
    await request(app)
      .delete(`/api/courses/${saved.body.courseId}`)
      .set("Cookie", authCookie(saver.id))
      .expect(204);

    expect(await prisma.courseDay.count({ where: { courseId: course.id } })).toBe(0);
    expect(await prisma.courseStop.count()).toBe(0);
    expect(await prisma.courseSchedule.count()).toBe(0);
    expect(await prisma.courseScheduleFestival.count()).toBe(0);
    const postAfter = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(postAfter.courseId).toBeNull();
    // 사본을 지워도 "담았다"는 기록과 담긴 수는 유지된다(취소가 아니므로)
    const saveRow = await prisma.postSave.findFirstOrThrow({ where: { postId: post.id } });
    expect(saveRow.courseId).toBeNull();
    expect(postAfter.saves).toBe(1);
  });
});
