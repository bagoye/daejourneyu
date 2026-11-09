/**
 * 로컬 개발 DB 시드. `npm run db:seed`로 실행한다.
 * 프론트 목데이터(frontend/src/mocks/courses.ts)를 정본으로 삼아 구조를 맞추고,
 * 캘린더·보관함 화면을 다양한 케이스로 볼 수 있도록 종류를 늘렸다.
 * ⚠ 한글 카피는 프론트 CLAUDE.md와 마찬가지로 잠정 데이터로 취급한다.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { buildSearchText } from "../src/lib/searchText";

/**
 * 안전장치: 시드는 목데이터(가짜 사용자·코스·게시물)를 넣는다. docs/deployment.md 절차대로 backend/.env에
 * Supabase 주소를 넣어 둔 상태에서 습관적으로 db:seed를 돌리면 운영 DB에 그대로 섞인다 — 로컬이 아니면 멈춘다.
 * 정말 원격(스테이징 등)에 넣어야 하면 ALLOW_REMOTE_SEED=true를 명시한다.
 */
function assertSafeTarget() {
  const raw = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    throw new Error("DATABASE_URL을 해석할 수 없습니다");
  }
  const local = host === "localhost" || host === "127.0.0.1";
  if (!local && process.env.ALLOW_REMOTE_SEED !== "true") {
    throw new Error(
      `시드 중단: DATABASE_URL이 원격(${host})을 가리킵니다. 목데이터를 넣으려면 ALLOW_REMOTE_SEED=true를 명시하세요.`
    );
  }
}
assertSafeTarget();

const prisma = new PrismaClient();

type SeedStop = {
  placeId: string;
  name: string;
  category: string;
  district: string;
  condition: string;
  petFriendly: boolean;
};

type SeedCourse = {
  id: string;
  label: string;
  nights: number;
  transport: "자차" | "대중교통";
  source: "ai" | "manual" | "saved";
  shared: boolean;
  days: SeedStop[][];
  schedule?: { date: string; festivalTitles: string[] };
};

const stop = (
  placeId: string,
  name: string,
  category: string,
  district: string,
  condition: string,
  petFriendly = true
): SeedStop => ({ placeId, name, category, district, condition, petFriendly });

const courses: SeedCourse[] = [
  {
    id: "course-1",
    label: "콩이랑 유성 나들이",
    nights: 0,
    transport: "자차",
    source: "manual",
    shared: true,
    days: [
      [
        stop("place-1", "한밭수목원", "산책", "서구", "전 견종 · 목줄 필수"),
        stop("place-4", "유성 반려동물 놀이터", "놀이터", "유성구", "대형견 구역 분리"),
        stop("place-5", "댕댕 베이커리", "맛집", "유성구", "실내 동반 가능"),
      ],
    ],
    schedule: { date: "2026-08-23", festivalTitles: ["유성 반려동물 마켓"] },
  },
  {
    id: "course-2",
    label: "AI 추천 · 산책형 코스",
    nights: 1,
    transport: "대중교통",
    source: "ai",
    shared: false,
    days: [
      [stop("place-2", "계족산 황톳길", "산책", "대덕구", "전 견종 · 배변봉투 지참")],
      [stop("place-3", "대청호 오백리길", "산책", "동구", "전 견종 · 목줄 필수")],
    ],
  },
  {
    id: "course-3",
    label: "대흥동 감성 카페 투어",
    nights: 0,
    transport: "대중교통",
    source: "manual",
    shared: false,
    days: [
      [
        stop("place-6", "대흥동 감성 카페", "맛집", "중구", "소형견만 가능"),
        stop("place-7", "성심당 본점", "맛집", "중구", "매장 내 동반 불가 · 포장만", false),
      ],
    ],
  },
  {
    id: "course-4",
    label: "소형견 전용 힐링 코스",
    nights: 0,
    transport: "자차",
    source: "manual",
    shared: true,
    days: [
      [
        stop("place-6", "대흥동 감성 카페", "맛집", "중구", "소형견만 가능"),
        stop("place-5", "댕댕 베이커리", "맛집", "유성구", "실내 동반 가능"),
      ],
    ],
    schedule: { date: "2026-08-25", festivalTitles: [] },
  },
  {
    id: "course-5",
    label: "AI 추천 · 문화형 코스",
    nights: 1,
    transport: "자차",
    source: "ai",
    shared: false,
    days: [
      [
        stop("place-8", "이응노미술관", "문화", "서구", "실내 동반 불가", false),
        stop("place-9", "엑스포과학공원", "문화", "유성구", "야외만 동반 가능"),
      ],
      [stop("place-10", "유성온천 족욕체험장", "문화", "유성구", "실외 구역만 동반 가능")],
    ],
  },
  {
    id: "course-6",
    label: "대덕구 황톳길 2박 3일",
    nights: 2,
    transport: "자차",
    source: "manual",
    shared: false,
    days: [
      [stop("place-2", "계족산 황톳길", "산책", "대덕구", "전 견종 · 배변봉투 지참")],
      [stop("place-3", "대청호 오백리길", "산책", "동구", "전 견종 · 목줄 필수")],
      [stop("place-4", "유성 반려동물 놀이터", "놀이터", "유성구", "대형견 구역 분리")],
    ],
    schedule: { date: "2026-09-05", festivalTitles: ["대덕 황톳길 축제"] },
  },
  {
    id: "course-7",
    label: "겨울 유성온천 나들이",
    nights: 0,
    transport: "대중교통",
    source: "saved",
    shared: false,
    days: [
      [
        stop("place-10", "유성온천 족욕체험장", "문화", "유성구", "실외 구역만 동반 가능"),
        stop("place-5", "댕댕 베이커리", "맛집", "유성구", "실내 동반 가능"),
      ],
    ],
  },
  {
    id: "course-8",
    label: "엄마아빠랑 대전 한바퀴",
    nights: 1,
    transport: "자차",
    source: "saved",
    shared: true,
    days: [
      [
        stop("place-1", "한밭수목원", "산책", "서구", "전 견종 · 목줄 필수"),
        stop("place-8", "이응노미술관", "문화", "서구", "실내 동반 불가", false),
      ],
      [
        stop("place-9", "엑스포과학공원", "문화", "유성구", "야외만 동반 가능"),
        stop("place-3", "대청호 오백리길", "산책", "동구", "전 견종 · 목줄 필수"),
      ],
    ],
    schedule: { date: "2026-08-30", festivalTitles: ["대전 사이언스 페스티벌", "유성 반려동물 마켓"] },
  },
];

type SeedPost = {
  id: string;
  userId: string;
  courseId?: string;
  authorName: string;
  authorEmoji: string;
  petTypeName: string;
  caption: string;
  text: string;
  tags: string[];
  likes: number;
  /* saves는 넣지 않는다 — PostSave 행 수에서 트리거가 계산하는 값이라, 직접 적으면 실제 행 수와 어긋난다. */
  stops: SeedStop[];
};

/** 둘러보기 초기 게시물 — 프론트 목데이터(mocks/posts.ts)를 옮긴 것이라 카피는 잠정 데이터다. */
const posts: SeedPost[] = [
  {
    id: "post-1",
    userId: "user-2",
    authorName: "보리",
    authorEmoji: "🦮",
    petTypeName: "정겹게 달려가는 페스티벌러",
    caption: "대청호 1박 2일, 대형견도 편했어요",
    text: "첫날 산책로, 둘째 날 반려동물 놀이터까지 여유롭게 돌았어요.",
    tags: ["대형견 OK", "자차", "1박 2일"],
    likes: 24,
    stops: [
      stop("place-3", "대청호 오백리길", "산책", "동구", "전 견종 · 목줄 필수"),
      stop("place-4", "유성 반려동물 놀이터", "놀이터", "유성구", "대형견 구역 분리"),
    ],
  },
  {
    id: "post-2",
    userId: "user-1",
    courseId: "course-1",
    authorName: "콩이맘",
    authorEmoji: "🐕",
    petTypeName: "여기저기 뛰어다니는 모험견",
    caption: "콩이랑 유성 나들이",
    text: "놀이터에서 실컷 뛰고 베이커리에서 마무리했어요.",
    tags: ["대형견 OK", "당일치기"],
    likes: 9,
    stops: [
      stop("place-1", "한밭수목원", "산책", "서구", "전 견종 · 목줄 필수"),
      stop("place-5", "댕댕 베이커리", "맛집", "유성구", "실내 동반 가능"),
    ],
  },
];

/** 후기 태그 사전 — 자유 입력을 막는 대신 여기 등록된 것만 고를 수 있다(root CLAUDE.md 도메인 용어 §후기). */
type SeedReviewTag = { code: string; label: string; category: string; sortOrder: number };

const reviewTagOptions: SeedReviewTag[] = [
  // 반려동물 동반 조건
  { code: "LEASH_REQUIRED", label: "목줄 필수", category: "PET_CONDITION", sortOrder: 0 },
  { code: "SMALL_DOG_ONLY", label: "소형견만", category: "PET_CONDITION", sortOrder: 1 },
  { code: "LARGE_DOG_OK", label: "대형견 동반 가능", category: "PET_CONDITION", sortOrder: 2 },
  { code: "LARGE_DOG_ZONE", label: "대형견 구역 분리", category: "PET_CONDITION", sortOrder: 3 },
  { code: "INDOOR_ALLOWED", label: "실내 동반 가능", category: "PET_CONDITION", sortOrder: 4 },
  { code: "WASTE_BAG_PROVIDED", label: "배변봉투 비치", category: "PET_CONDITION", sortOrder: 5 },
  { code: "PET_MENU", label: "반려동물 전용 메뉴/간식", category: "PET_CONDITION", sortOrder: 6 },
  // 공간 · 환경
  { code: "GOOD_WALK", label: "산책로 좋아요", category: "ENVIRONMENT", sortOrder: 0 },
  { code: "GRASS_FIELD", label: "잔디밭 있어요", category: "ENVIRONMENT", sortOrder: 1 },
  { code: "SHADY", label: "그늘 많아요", category: "ENVIRONMENT", sortOrder: 2 },
  { code: "GOOD_VIEW", label: "경치 좋아요", category: "ENVIRONMENT", sortOrder: 3 },
  { code: "QUIET", label: "조용해요", category: "ENVIRONMENT", sortOrder: 4 },
  // 편의시설
  { code: "WATER_BOWL", label: "물그릇 제공", category: "AMENITY", sortOrder: 0 },
  { code: "PARKING_EASY", label: "주차 편해요", category: "AMENITY", sortOrder: 1 },
  { code: "CLEAN_RESTROOM", label: "화장실 깨끗해요", category: "AMENITY", sortOrder: 2 },
  { code: "COMFY_SEATING", label: "좌석 편안해요", category: "AMENITY", sortOrder: 3 },
  // 서비스 · 분위기
  { code: "KIND_STAFF", label: "직원이 친절해요", category: "SERVICE", sortOrder: 0 },
  { code: "PET_FRIENDLY_STAFF", label: "반려동물에 친절해요", category: "SERVICE", sortOrder: 1 },
  { code: "PHOTO_SPOT", label: "사진찍기 좋아요", category: "SERVICE", sortOrder: 2 },
  { code: "REASONABLE_PRICE", label: "가격이 합리적이에요", category: "SERVICE", sortOrder: 3 },
  // 주의할 점
  { code: "LACK_SHADE", label: "그늘 부족", category: "CAUTION", sortOrder: 0 },
  { code: "MANY_STAIRS", label: "계단 많아요", category: "CAUTION", sortOrder: 1 },
  { code: "NOISY", label: "소음 있어요", category: "CAUTION", sortOrder: 2 },
  { code: "SLIPPERY_FLOOR", label: "바닥이 미끄러워요", category: "CAUTION", sortOrder: 3 },
  { code: "PARKING_HARD", label: "주차 불편해요", category: "CAUTION", sortOrder: 4 },
];

/** frontend/src/mocks/reviews.ts를 옮긴 초기 후기 — 태그는 위 사전의 code로 연결한다. */
type SeedReview = {
  id: string;
  placeId: string;
  placeName: string;
  authorId: string;
  text: string;
  tagCodes: string[];
  likesCount: number;
};

const reviews: SeedReview[] = [
  {
    id: "review-1",
    placeId: "place-1",
    placeName: "한밭수목원",
    authorId: "user-1",
    text: "물가 산책로가 넓어서 콩이가 신나게 뛰어다녔어요. 목줄은 필수지만 사람도 적당히 붐벼서 좋았습니다.",
    tagCodes: ["GOOD_WALK", "WATER_BOWL"],
    likesCount: 6,
  },
  {
    id: "review-2",
    placeId: "place-4",
    placeName: "유성 반려동물 놀이터",
    authorId: "user-1",
    text: "대형견 구역이 따로 있어서 안심하고 풀어놓을 수 있었어요. 그늘이 부족한 게 아쉬워요.",
    tagCodes: ["LARGE_DOG_ZONE", "LACK_SHADE"],
    likesCount: 3,
  },
  {
    id: "review-3",
    placeId: "place-6",
    placeName: "대흥동 감성 카페",
    authorId: "user-2",
    text: "소형견만 가능하다는 걸 미리 안내해줘서 헷갈리지 않았어요. 자리도 편안했습니다.",
    tagCodes: ["SMALL_DOG_ONLY", "COMFY_SEATING"],
    likesCount: 4,
  },
];

async function main() {
  await prisma.user.upsert({
    where: { id: "user-1" },
    update: {},
    create: { id: "user-1", email: "kong.owner@example.com", nickname: "콩이맘" },
  });

  // 둘러보기에 "남의 글"이 하나는 있어야 내 글/남의 글 구분과 담기 동작을 볼 수 있다.
  await prisma.user.upsert({
    where: { id: "user-2" },
    update: {},
    create: { id: "user-2", email: "bori.owner@example.com", nickname: "보리아빠" },
  });

  for (const course of courses) {
    await prisma.course.upsert({
      where: { id: course.id },
      update: {},
      create: {
        id: course.id,
        label: course.label,
        nights: course.nights,
        transport: course.transport,
        source: course.source,
        shared: course.shared,
        userId: "user-1",
        days: {
          create: course.days.map((stops, dayIndex) => ({
            dayIndex,
            stops: {
              create: stops.map((s, order) => ({ ...s, order })),
            },
          })),
        },
        ...(course.schedule
          ? {
              schedules: {
                create: {
                  date: course.schedule.date,
                  festivalTitles: {
                    create: course.schedule.festivalTitles.map((title) => ({ title })),
                  },
                },
              },
            }
          : {}),
      },
    });
  }

  for (const post of posts) {
    // 검색 문서는 라우터와 같은 함수로 만든다 — 빠뜨리면 시드 글이 검색에 안 걸린다(실제로 빠졌던 적 있음).
    // 이미 있는 시드 글도 검색 문서만은 다시 맞춘다(파생값이라 덮어써도 안전).
    const searchText = buildSearchText(post, post.stops);
    await prisma.post.upsert({
      where: { id: post.id },
      update: { searchText },
      create: {
        id: post.id,
        caption: post.caption,
        text: post.text,
        tags: post.tags,
        authorName: post.authorName,
        authorEmoji: post.authorEmoji,
        petTypeName: post.petTypeName,
        searchText,
        likes: post.likes,
        userId: post.userId,
        courseId: post.courseId ?? null,
        stops: { create: post.stops.map((s, order) => ({ ...s, order })) },
      },
    });
  }

  for (const tag of reviewTagOptions) {
    await prisma.reviewTagOption.upsert({
      where: { code: tag.code },
      update: { label: tag.label, category: tag.category, sortOrder: tag.sortOrder },
      create: tag,
    });
  }

  for (const review of reviews) {
    await prisma.review.upsert({
      where: { id: review.id },
      update: {},
      create: {
        id: review.id,
        placeId: review.placeId,
        placeName: review.placeName,
        text: review.text,
        likesCount: review.likesCount,
        authorId: review.authorId,
        tags: { create: review.tagCodes.map((code) => ({ tag: { connect: { code } } })) },
      },
    });
  }

  console.log(
    `✅ 시드 완료: 사용자 2명, 코스 ${courses.length}개, 둘러보기 게시물 ${posts.length}개, ` +
      `후기 태그 ${reviewTagOptions.length}개, 후기 ${reviews.length}개`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
