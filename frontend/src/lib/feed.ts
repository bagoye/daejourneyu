import type { Article, Course, FeedPost } from "@/types";
import type { PostCreateInput } from "@/lib/api/posts";
import type { FeedInteraction } from "@/stores/useFeedStore";
import { nightsLabel } from "@/lib/courseFormat";
import { DISTRICTS } from "@/lib/placeFilters";

export interface ResolvedPostInteraction {
  liked: boolean;
  likes: number;
  saved: boolean;
  saves: number;
}

/**
 * 화면에 보일 값을 계산한다.
 *
 * 담기(saved/saves)는 서버가 정본이라 게시물 값을 그대로 쓴다 — 낙관적 표시는 useToggleSave가
 * 쿼리 캐시를 직접 갈아끼우는 쪽에서 처리한다. 아직 서버가 없는 좋아요만 로컬 오버라이드로 덮는다.
 */
export function resolvePostInteraction(
  post: FeedPost,
  override: FeedInteraction | undefined
): ResolvedPostInteraction {
  const liked = override?.liked ?? post.liked;

  return {
    liked,
    likes: post.likes + (liked === post.liked ? 0 : liked ? 1 : -1),
    saved: post.saved,
    saves: post.saves,
  };
}

/** 코스 게시물의 방문 장소를 "한밭수목원 › 댕댕 베이커리" 형태의 한 줄 요약으로 만든다. */
export function formatStopSummary(post: FeedPost): string {
  return post.stops.map((stop) => stop.name).join(" › ");
}

/** 아티클 좋아요 — 게시물과 동일하게 원본 값 + 토글 오버라이드로 표시값을 계산한다. */
export function resolveArticleLike(
  article: { likes: number; liked: boolean },
  override: boolean | undefined
): { liked: boolean; likes: number } {
  const liked = override ?? article.liked;
  return { liked, likes: article.likes + (liked === article.liked ? 0 : liked ? 1 : -1) };
}

/** 코스 탭 정렬 — 프로토타입의 jyBrowseSort('담긴순' | '최신순')에 대응 */
export type PostSortMode = "saves" | "recent";
/** 아티클 탭 정렬 — 프로토타입의 jyArticleSort('인기순' | '최신순')에 대응 */
export type ArticleSortMode = "popular" | "recent";

export function sortArticles(articles: Article[], mode: ArticleSortMode): Article[] {
  return [...articles].sort((a, b) => {
    // 좋아요 수가 같으면 최신 글을 위로 — 동률일 때 순서가 렌더마다 흔들리지 않게 한다.
    if (mode === "popular" && b.likes !== a.likes) return b.likes - a.likes;
    return b.date.localeCompare(a.date);
  });
}

export interface PageSlice<T> {
  items: T[];
  /** 범위를 벗어난 요청을 보정한 뒤의 실제 페이지 번호(0부터) */
  page: number;
  totalPages: number;
}

/** 마이탭 '내가 쓴 후기' 페이지네이션. 항목이 없어도 totalPages는 1로 둬서 "1/1 페이지"로 표시된다. */
export function paginate<T>(items: T[], page: number, perPage: number): PageSlice<T> {
  const totalPages = Math.max(Math.ceil(items.length / perPage), 1);
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);

  return {
    items: items.slice(safePage * perPage, safePage * perPage + perPage),
    page: safePage,
    totalPages,
  };
}

/** 아티클 카드의 날짜 표기 — 프로토타입 jyFmt와 동일하게 "8월 12일" 형태로 줄인다. */
export function formatFeedDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

/**
 * 게시물 카드의 등록일 표기 — createdAt은 ISO 문자열이라 날짜 부분만 잘라 쓴다.
 * 같은 해면 아티클과 똑같이 "8월 12일", 해가 넘어간 글만 연도를 붙여 구분한다.
 */
export function formatPostDate(createdAt: string): string {
  const [year, month, day] = createdAt.slice(0, 10).split("-");
  if (!year || !month || !day) return "";
  const label = `${Number(month)}월 ${Number(day)}일`;
  return Number(year) === new Date().getFullYear() ? label : `${year}년 ${label}`;
}

/** 자랑하기 글에 자동으로 붙는 태그 — 코스를 훑어볼 때 필요한 일정 길이와 자치구만 넣는다. */
function buildCourseTags(course: Course): string[] {
  const stops = course.days.flat();
  const districts = [...new Set(stops.map((stop) => stop.district))];
  return [nightsLabel(course.nights), ...districts];
}

/** "당일치기" 또는 "2박 3일" — nightsLabel이 만들어내는 두 가지 형태. */
const NIGHTS_TAG_PATTERN = /^(당일치기|\d+박 \d+일)$/;
const DISTRICT_TAGS = new Set<string>(DISTRICTS);

/**
 * 화면에 실제로 보여줄 태그만 남긴다 — 일정 길이와 자치구 둘뿐이다.
 *
 * 예전에 올라간 글에는 이동수단("자차"/"대중교통")이나 견종 태그가 섞여 있는데, 목록에서
 * 코스를 고를 때 훑는 정보는 "며칠짜리인지"와 "어느 동네인지"라 나머지는 태그 줄만 길게 만든다.
 * 저장된 값을 지우지 않고 표시할 때 거르는 이유는 이동수단 태그를 담기(보관함 사본)가
 * 아직 참고하기 때문이다 — backend/src/routes/posts.ts의 buildSavedCourseData 참고.
 */
export function visiblePostTags(tags: string[]): string[] {
  return tags.filter((tag) => NIGHTS_TAG_PATTERN.test(tag) || DISTRICT_TAGS.has(tag));
}

export interface CoursePostAuthor {
  name: string;
  emoji: string;
  petTypeName: string;
}

/**
 * 보관함 코스 하나를 둘러보기에 올릴 형태로 옮긴다.
 * 사용자가 직접 쓰는 건 한마디(text)뿐이고, 제목·동선·태그는 코스에서 그대로 끌어온다.
 * id와 좋아요·담기 수는 서버(POST /api/posts)가 정하므로 여기서 만들지 않는다.
 */
export function buildPostInputFromCourse(
  course: Course,
  text: string,
  author: CoursePostAuthor
): PostCreateInput {
  return {
    caption: course.label,
    text: text.trim(),
    stops: course.days.flat(),
    tags: buildCourseTags(course),
    authorName: author.name,
    authorEmoji: author.emoji,
    petTypeName: author.petTypeName,
    courseId: course.id,
  };
}

/** 이 코스를 이미 자랑했는지 — 같은 코스로 두 번 들어와도 글이 두 개 생기지 않게 막는 데 쓴다. */
export function findPostByCourseId(posts: FeedPost[], courseId: string): FeedPost | null {
  return posts.find((post) => post.courseId === courseId) ?? null;
}
