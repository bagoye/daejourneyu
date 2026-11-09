import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../lib/asyncHandler";

type Transport = "자차" | "대중교통";
type CourseSource = "ai" | "manual" | "saved";

type CourseStop = {
  placeId: string;
  name: string;
  category: string;
  district: string;
  condition: string;
  petFriendly: boolean;
  imageUrl?: string | null;
};

type Course = {
  id: string;
  label: string;
  /** 티켓 카드 대표 이모지. 사용자가 직접 고르지 않았으면 null. */
  emoji: string | null;
  nights: number;
  transport: Transport;
  source: CourseSource;
  shared: boolean;
  days: CourseStop[][];
};

type CourseSchedule = {
  id: string;
  courseId: string;
  /** YYYY-MM-DD */
  date: string;
  festivalTitles: string[];
};

const courseWithRelations = {
  days: {
    orderBy: { dayIndex: "asc" as const },
    include: { stops: { orderBy: { order: "asc" as const } } },
  },
};

type CourseRow = Prisma.CourseGetPayload<{ include: typeof courseWithRelations }>;

function toCourse(row: CourseRow): Course {
  return {
    id: row.id,
    label: row.label,
    emoji: row.emoji,
    nights: row.nights,
    transport: row.transport as Transport,
    source: row.source as CourseSource,
    shared: row.shared,
    days: row.days.map((day) =>
      day.stops.map((s) => ({
        placeId: s.placeId,
        name: s.name,
        category: s.category,
        district: s.district,
        condition: s.condition,
        petFriendly: s.petFriendly,
        imageUrl: s.imageUrl,
      }))
    ),
  };
}

const scheduleWithRelations = { festivalTitles: true };
type CourseScheduleRow = Prisma.CourseScheduleGetPayload<{ include: typeof scheduleWithRelations }>;

function toCourseSchedule(row: CourseScheduleRow): CourseSchedule {
  return {
    id: row.id,
    courseId: row.courseId,
    date: row.date,
    festivalTitles: row.festivalTitles.map((f) => f.title),
  };
}

/** YYYY-MM-DD 형식만 허용한다 — Date 파싱에 기대면 "2026-2-3" 같은 값도 통과해버린다. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TRANSPORTS: Transport[] = ["자차", "대중교통"];
const SOURCES: CourseSource[] = ["ai", "manual", "saved"];

function isValidStop(s: unknown): s is CourseStop {
  if (typeof s !== "object" || s === null) return false;
  const stop = s as CourseStop;
  if (typeof stop.placeId !== "string") return false;
  if (typeof stop.name !== "string") return false;
  if (typeof stop.category !== "string") return false;
  if (typeof stop.district !== "string") return false;
  if (typeof stop.condition !== "string") return false;
  if (typeof stop.petFriendly !== "boolean") return false;
  if (stop.imageUrl !== undefined && stop.imageUrl !== null && typeof stop.imageUrl !== "string") return false;
  return true;
}

function isValidDays(days: unknown): days is CourseStop[][] {
  return Array.isArray(days) && days.length > 0 && days.every((day) => Array.isArray(day) && day.every(isValidStop));
}

function validateCourseInput(body: unknown): body is Omit<Course, "id"> {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.label !== "string" || b.label.trim().length === 0) return false;
  if (b.emoji !== undefined && b.emoji !== null && typeof b.emoji !== "string") return false;
  // Int 컬럼이라 1.5 같은 값은 Prisma가 거부한다 — 검증 단계에서 400으로 끊는다.
  if (typeof b.nights !== "number" || !Number.isInteger(b.nights) || b.nights < 0) return false;
  if (!TRANSPORTS.includes(b.transport as Transport)) return false;
  if (!SOURCES.includes(b.source as CourseSource)) return false;
  if (typeof b.shared !== "boolean") return false;
  return isValidDays(b.days);
}

// PATCH는 label/emoji/days 중 보내진 필드만 검증한다(부분 수정).
function validateCourseUpdateInput(
  body: unknown
): body is Partial<Pick<Course, "label" | "emoji" | "days">> {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b.label !== undefined && (typeof b.label !== "string" || b.label.trim().length === 0)) return false;
  if (b.emoji !== undefined && b.emoji !== null && typeof b.emoji !== "string") return false;
  if (b.days !== undefined && !isValidDays(b.days)) return false;
  return true;
}

const router = Router();

// 이 라우터의 모든 엔드포인트는 로그인이 필요하다 — 코스는 회원 전용 데이터다.
router.use(requireAuth);

// GET /api/courses — 내 코스 보관함 전체 목록(로그인한 사용자 소유만)
router.get("/", asyncHandler(async (req, res) => {
  const rows = await prisma.course.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "asc" },
    include: courseWithRelations,
  });
  res.json(rows.map(toCourse));
}));

// GET /api/courses/schedules — 내 코스들에 등록된 일정 전체(홈 D-day 카드·캘린더 세그가 씀).
// ":id" 라우트보다 먼저 등록해야 "schedules"가 :id로 잡아먹히지 않는다.
router.get("/schedules", asyncHandler(async (req, res) => {
  const rows = await prisma.courseSchedule.findMany({
    where: { course: { userId: req.userId! } },
    include: scheduleWithRelations,
  });
  res.json(rows.map(toCourseSchedule));
}));

// GET /api/courses/:id — 코스 상세. 다른 사람 코스면 존재 여부도 노출하지 않고 404로 통일한다.
router.get("/:id", asyncHandler(async (req, res) => {
  const row = await prisma.course.findUnique({
    where: { id: req.params.id },
    include: courseWithRelations,
  });
  if (!row || row.userId !== req.userId) {
    return res.status(404).json({ error: "코스를 찾을 수 없어요" });
  }
  res.json(toCourse(row));
}));

// POST /api/courses — 코스 위저드(MBTI/직접 짓기)에서 만든 코스를 저장
router.post("/", asyncHandler(async (req, res) => {
  if (!validateCourseInput(req.body)) {
    return res.status(400).json({ error: "코스 형식이 올바르지 않아요" });
  }
  const input = req.body;

  const created = await prisma.course.create({
    data: {
      label: input.label,
      emoji: input.emoji ?? null,
      nights: input.nights,
      transport: input.transport,
      source: input.source,
      shared: input.shared,
      userId: req.userId!,
      days: {
        create: input.days.map((stops, dayIndex) => ({
          dayIndex,
          stops: { create: stops.map((stop, order) => ({ ...stop, order })) },
        })),
      },
    },
    include: courseWithRelations,
  });

  res.status(201).json(toCourse(created));
}));

// PATCH /api/courses/:id — 코스 상세에서 이름·대표 이모지·동선(순서/삭제)을 수정. 소유자만 가능.
router.patch("/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.course.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ error: "코스를 찾을 수 없어요" });
  }

  if (!validateCourseUpdateInput(req.body)) {
    return res.status(400).json({ error: "코스 수정 형식이 올바르지 않아요" });
  }
  const input = req.body;

  /*
   * 동선은 "전체 삭제 후 재생성"으로 교체한다(부분 UPDATE를 택하지 않은 근거는 docs/db-optimization/
   * 02-transaction.md). 이 방식이 동시성에서 안전하려면 **트랜잭션 첫 문장에서 Course 행을 잠가야** 한다:
   *
   *  - 동시 PATCH: 잠금이 없으면 뒤 요청의 DELETE가 앞 요청이 막 넣은 일차를 보지 못한 채(READ COMMITTED
   *    문장 스냅샷) 지나가고, 자기 일차를 넣다가 (courseId, dayIndex) 유니크 위반으로 실패했다.
   *    잠그면 요청이 줄을 서고, 각자 최신 상태를 지우고 다시 쓰므로 마지막 요청이 깔끔하게 이긴다.
   *  - PATCH와 DELETE: 잠금이 없으면 PATCH는 CourseDay→Course(FK 검사), DELETE는 Course→CourseDay
   *    (CASCADE) 순으로 잠가 교착(40P01)이 났다. 둘 다 Course부터 잡게 해 순서를 맞춘다.
   *
   * 소유자 조건도 잠금 쿼리에 함께 건다 — 위의 사전 확인과 실제 쓰기 사이에 코스가 지워졌으면 여기서
   * 0행이 되어 404로 끝난다.
   */
  const updated = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Course" WHERE "id" = ${req.params.id} AND "userId" = ${req.userId!} FOR UPDATE`;
    if (locked.length === 0) return null;

    if (input.days) {
      // 일차별 동선을 통째로 교체한다 — CourseDay 삭제 시 CourseStop은 cascade로 함께 지워진다.
      await tx.courseDay.deleteMany({ where: { courseId: req.params.id } });
    }
    return tx.course.update({
      where: { id: req.params.id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
        ...(input.days
          ? {
              days: {
                create: input.days.map((stops, dayIndex) => ({
                  dayIndex,
                  stops: { create: stops.map((stop, order) => ({ ...stop, order })) },
                })),
              },
            }
          : {}),
      },
      include: courseWithRelations,
    });
  });

  if (!updated) return res.status(404).json({ error: "코스를 찾을 수 없어요" });
  res.json(toCourse(updated));
}));

// DELETE /api/courses/:id — 보관함에서 코스 삭제. 소유자만 가능.
router.delete("/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.course.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ error: "코스를 찾을 수 없어요" });
  }

  await prisma.course.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

// POST /api/courses/:id/schedule — 코스에 날짜를 붙여 "내 일정"에 새로 등록한다.
// 코스 1개가 여러 날짜에 등록될 수 있어(schema.prisma CourseSchedule은 1:N) 매번 새로 만든다 —
// 날짜를 바꾸려면 기존 일정을 지우고 새로 등록한다(DELETE /schedule/:scheduleId).
router.post("/:id/schedule", asyncHandler(async (req, res) => {
  const existing = await prisma.course.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ error: "코스를 찾을 수 없어요" });
  }

  const date = (req.body as Record<string, unknown> | null)?.date;
  if (typeof date !== "string" || !DATE_RE.test(date)) {
    return res.status(400).json({ error: "날짜는 YYYY-MM-DD 형식이어야 해요" });
  }

  const schedule = await prisma.courseSchedule.create({
    data: { courseId: req.params.id, date },
    include: scheduleWithRelations,
  });

  res.json(toCourseSchedule(schedule));
}));

// DELETE /api/courses/schedule/:scheduleId — 등록된 일정 하나를 취소한다(일정 id 기준).
router.delete("/schedule/:scheduleId", asyncHandler(async (req, res) => {
  const existing = await prisma.courseSchedule.findUnique({
    where: { id: req.params.scheduleId },
    include: { course: true },
  });
  if (!existing || existing.course.userId !== req.userId) {
    return res.status(404).json({ error: "일정을 찾을 수 없어요" });
  }

  await prisma.courseSchedule.delete({ where: { id: req.params.scheduleId } });
  res.status(204).send();
}));

export default router;
