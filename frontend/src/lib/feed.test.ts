import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPostInputFromCourse,
  findPostByCourseId,
  formatFeedDate,
  formatPostDate,
  formatStopSummary,
  paginate,
  resolveArticleLike,
  resolvePostInteraction,
  sortArticles,
  visiblePostTags,
} from "@/lib/feed";
import { makeArticle, makeCourse, makePost, makeStop } from "@/test/fixtures";

describe("resolvePostInteraction", () => {
  it("토글한 적이 없으면 게시물 값을 그대로 쓴다", () => {
    const post = makePost({ likes: 5, liked: true, saves: 3, saved: true });
    expect(resolvePostInteraction(post, undefined)).toEqual({
      liked: true,
      likes: 5,
      saved: true,
      saves: 3,
    });
  });

  it("좋아요를 새로 누르면 1 늘고, 취소하면 1 줄어든다", () => {
    expect(resolvePostInteraction(makePost({ likes: 5, liked: false }), { liked: true })).toMatchObject(
      { liked: true, likes: 6 }
    );
    expect(resolvePostInteraction(makePost({ likes: 5, liked: true }), { liked: false })).toMatchObject(
      { liked: false, likes: 4 }
    );
  });

  it("원본과 같은 값으로 토글돼 있으면 좋아요 수를 바꾸지 않는다", () => {
    expect(resolvePostInteraction(makePost({ likes: 5, liked: true }), { liked: true })).toMatchObject({
      liked: true,
      likes: 5,
    });
  });

  it("담기는 서버가 정본이라 오버라이드와 무관하게 게시물 값을 쓴다", () => {
    expect(resolvePostInteraction(makePost({ saves: 7, saved: false }), { liked: true })).toMatchObject({
      saves: 7,
      saved: false,
    });
  });
});

describe("resolveArticleLike", () => {
  it("오버라이드가 없으면 원본 값을 쓴다", () => {
    expect(resolveArticleLike({ likes: 3, liked: false }, undefined)).toEqual({ liked: false, likes: 3 });
  });

  it("누르면 1 늘고, 이미 누른 걸 취소하면 1 줄어든다", () => {
    expect(resolveArticleLike({ likes: 3, liked: false }, true)).toEqual({ liked: true, likes: 4 });
    expect(resolveArticleLike({ likes: 3, liked: true }, false)).toEqual({ liked: false, likes: 2 });
  });
});

describe("formatStopSummary", () => {
  it("방문 장소 이름을 › 로 이어 붙인다", () => {
    const post = makePost({
      stops: [makeStop({ name: "한밭수목원" }), makeStop({ name: "댕댕 베이커리" })],
    });
    expect(formatStopSummary(post)).toBe("한밭수목원 › 댕댕 베이커리");
  });
});

describe("sortArticles", () => {
  const older = makeArticle({ id: "older", likes: 9, date: "2026-08-01" });
  const newer = makeArticle({ id: "newer", likes: 9, date: "2026-08-20" });
  const lessLiked = makeArticle({ id: "less", likes: 1, date: "2026-08-25" });

  it("인기순은 좋아요 많은 순, 같으면 최신 글이 위로 온다", () => {
    expect(sortArticles([lessLiked, older, newer], "popular").map((a) => a.id)).toEqual([
      "newer",
      "older",
      "less",
    ]);
  });

  it("최신순은 좋아요와 무관하게 날짜 내림차순이다", () => {
    expect(sortArticles([older, lessLiked, newer], "recent").map((a) => a.id)).toEqual([
      "less",
      "newer",
      "older",
    ]);
  });

  it("원본 배열을 바꾸지 않는다", () => {
    const input = [lessLiked, older, newer];
    sortArticles(input, "popular");
    expect(input.map((a) => a.id)).toEqual(["less", "older", "newer"]);
  });
});

describe("paginate", () => {
  const items = [1, 2, 3, 4, 5];

  it("perPage 단위로 자르고 전체 페이지 수를 알려준다", () => {
    expect(paginate(items, 1, 2)).toEqual({ items: [3, 4], page: 1, totalPages: 3 });
  });

  it("범위를 벗어난 페이지는 처음·마지막 페이지로 보정한다", () => {
    expect(paginate(items, 9, 2)).toEqual({ items: [5], page: 2, totalPages: 3 });
    expect(paginate(items, -1, 2)).toEqual({ items: [1, 2], page: 0, totalPages: 3 });
  });

  it("항목이 없어도 1페이지로 본다", () => {
    expect(paginate([], 0, 4)).toEqual({ items: [], page: 0, totalPages: 1 });
  });
});

describe("formatFeedDate", () => {
  it("YYYY-MM-DD를 앞자리 0 없이 'M월 D일'로 줄인다", () => {
    expect(formatFeedDate("2026-08-02")).toBe("8월 2일");
  });
});

describe("formatPostDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("올해 글은 연도 없이 표기한다", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 14, 12));
    expect(formatPostDate("2026-08-12T09:00:00.000Z")).toBe("8월 12일");
  });

  it("해가 넘어간 글은 연도를 붙인다", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 14, 12));
    expect(formatPostDate("2025-12-31T23:00:00.000Z")).toBe("2025년 12월 31일");
  });

  it("날짜 형식이 아니면 빈 문자열을 돌려준다", () => {
    expect(formatPostDate("")).toBe("");
  });
});

describe("visiblePostTags", () => {
  it("일정 길이와 자치구 태그만 남기고 이동수단·견종 같은 옛 태그는 거른다", () => {
    expect(
      visiblePostTags(["당일치기", "자차", "2박 3일", "유성구", "말티즈", "대중교통", "서울"])
    ).toEqual(["당일치기", "2박 3일", "유성구"]);
  });
});

describe("buildPostInputFromCourse", () => {
  it("코스의 제목·동선을 옮기고 일정 길이와 자치구(중복 제거)로 태그를 만든다", () => {
    const stopA = makeStop({ placeId: "a", district: "유성구" });
    const stopB = makeStop({ placeId: "b", district: "서구" });
    const stopC = makeStop({ placeId: "c", district: "유성구" });
    const course = makeCourse({
      id: "course-7",
      label: "갑천 1박 코스",
      nights: 1,
      days: [[stopA], [stopB, stopC]],
    });

    expect(
      buildPostInputFromCourse(course, "  마당이 넓어요 \n", {
        name: "콩이네",
        emoji: "🐶",
        petTypeName: "유형",
      })
    ).toEqual({
      caption: "갑천 1박 코스",
      text: "마당이 넓어요",
      stops: [stopA, stopB, stopC],
      tags: ["1박 2일", "유성구", "서구"],
      authorName: "콩이네",
      authorEmoji: "🐶",
      petTypeName: "유형",
      courseId: "course-7",
    });
  });

  it("당일치기 코스는 '당일치기' 태그가 붙는다", () => {
    const input = buildPostInputFromCourse(makeCourse({ nights: 0 }), "", {
      name: "나",
      emoji: "🐾",
      petTypeName: "여행 유형 미검사",
    });
    expect(input.tags[0]).toBe("당일치기");
  });
});

describe("findPostByCourseId", () => {
  const posts = [makePost({ id: "p1", courseId: "c1" }), makePost({ id: "p2" })];

  it("같은 코스로 올린 글을 찾는다", () => {
    expect(findPostByCourseId(posts, "c1")?.id).toBe("p1");
  });

  it("없으면 null", () => {
    expect(findPostByCourseId(posts, "c9")).toBeNull();
  });
});
