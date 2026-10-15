import { useMemo } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePetStore } from "@/stores/usePetStore";
import { useReviews } from "@/hooks/useReviews";
import { useMyPosts } from "@/hooks/usePosts";
import { usePlaces } from "@/hooks/usePlaces";
import { NO_SCHEDULES, useSchedules } from "@/hooks/useSchedules";
import { NO_COURSES, useCourses } from "@/hooks/useCourses";
import {
  computeMyBadges,
  nearBadgeMessage,
  pickNearestBadge,
  todayString,
  type Badge,
  type BadgeInput,
} from "@/lib/badges";

interface MyBadges {
  badges: Badge[];
  got: Badge[];
  gotCount: number;
  total: number;
  /** 마이탭 '남은 거리' 한 줄에 띄울 뱃지. 코앞인 게 없으면 null이고 그때는 줄을 숨긴다. */
  nearest: Badge | null;
  /** 그 뱃지를 두고 할 말. nearest가 null이면 빈 문자열 */
  nearestMessage: string;
}

/**
 * 뱃지 계산에 필요한 스토어·훅 연결을 한곳에 모은다.
 * 마이탭 요약과 전체 목록 화면이 같은 기준을 봐야 해서 페이지마다 다시 엮지 않는다.
 */
export function useMyBadges(): MyBadges {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const pets = usePetStore((state) => state.pets);
  const activePet = usePetStore((state) => state.activePet());
  const { data: reviews = [] } = useReviews();
  // 뱃지가 보는 건 내 글이다(받은 좋아요 합계). 전체 목록은 서버 페이지 단위로 바뀌어 여기서 못 쓴다.
  // TODO(api): '이웃사랑'은 내가 남의 글에 누른 좋아요라 좋아요 영속화 뒤 별도 소스가 필요하다.
  const { data: posts } = useMyPosts("recent", isLoggedIn);
  // 취향 계열(소형견 전용·전 견종)은 CourseStop에 없는 조건을 Place에서 찾아야 한다.
  const { data: places = [] } = usePlaces();
  // 마이탭으로 바로 들어와도(딥링크 등) 캐시가 비어 있으면 두 훅이 서버에서 받는다.
  const { data: courses = NO_COURSES } = useCourses();
  const { data: schedules = NO_SCHEDULES } = useSchedules();

  const input = useMemo<BadgeInput>(
    () => ({
      isLoggedIn,
      pets,
      activePet,
      courses,
      schedules,
      reviews,
      posts,
      places,
      today: todayString(),
    }),
    [isLoggedIn, pets, activePet, courses, schedules, reviews, posts, places]
  );

  const badges = useMemo(() => computeMyBadges(input), [input]);
  const nearest = useMemo(() => pickNearestBadge(badges), [badges]);

  const got = badges.filter((badge) => badge.got);
  return {
    badges,
    got,
    gotCount: got.length,
    total: badges.length,
    nearest,
    nearestMessage: nearest ? nearBadgeMessage(nearest, input) : "",
  };
}
