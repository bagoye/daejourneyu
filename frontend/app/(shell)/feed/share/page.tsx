"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { TopBar } from "@/components/shell/TopBar";
import { Button } from "@/components/ui/Button";
import { FeedEmptyState } from "@/components/feed/FeedEmptyState";
import { ShareCourseSummary } from "@/components/feed/ShareCourseSummary";
import { useMyPosts, useCreatePost } from "@/hooks/usePosts";
import { useCourses } from "@/hooks/useCourses";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePetStore } from "@/stores/usePetStore";
import { useToastStore } from "@/stores/useToastStore";
import { buildPostInputFromCourse, findPostByCourseId } from "@/lib/feed";

export default function CourseShareToFeedPage() {
  return (
    <>
      <TopBar title="코스 자랑하기" showBack />
      <Suspense fallback={<LoadingState />}>
        <CourseShareToFeedPageInner />
      </Suspense>
    </>
  );
}

/**
 * 보관함 코스를 둘러보기에 올리는 화면.
 * 코스는 앞 화면(코스 상세의 '이 코스 둘러보기에 공유하기')에서 이미 정해져 `?courseId`로 넘어온다 —
 * 그래서 여기서는 다시 고르게 하지 않고 어떤 코스인지 확인만 시키고, 사용자는 한마디만 쓴다.
 */
function CourseShareToFeedPageInner() {
  const router = useRouter();
  const courseId = useSearchParams().get("courseId");

  // 코스 상세에서 바로 넘어오지 않고 링크로 직접 들어와도 캐시가 비어 있으면 useCourses가 서버에서 받는다.
  const { data: courses } = useCourses();
  const course = courses?.find((item) => item.id === courseId) ?? null;

  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const hydrated = useAuthStore((state) => state.hydrated);
  const user = useAuthStore((state) => state.user);
  const activePet = usePetStore((state) => state.activePet());
  const createPost = useCreatePost();
  const showToast = useToastStore((state) => state.show);
  // 이미 자랑한 코스인지 보는 용도라 내 글만 있으면 된다.
  const { data: posts } = useMyPosts("recent", isLoggedIn);

  const [text, setText] = useState("");

  // 세션 복구 전에는 로그인 여부를 알 수 없으므로 게이팅을 미룬다.
  if (!hydrated) return <LoadingState />;

  if (!isLoggedIn) {
    return (
      <div className="px-4 pb-6 pt-3">
        <FeedEmptyState
          emoji="🔒"
          title="로그인이 필요해요"
          description="로그인하면 내 코스를 둘러보기에 자랑할 수 있어요"
        />
        <Link href="/onboarding/login?next=/schedule/vault" className="mt-4 block">
          <Button variant="primary">로그인하러 가기</Button>
        </Link>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="px-4 pb-6 pt-3">
        <FeedEmptyState
          emoji="🧭"
          title="자랑할 코스를 찾지 못했어요"
          description="보관함에서 코스를 고른 뒤 다시 시도해주세요"
        />
        <Link href="/schedule/vault" className="mt-4 block">
          <Button variant="primary">코스 보관함 열기</Button>
        </Link>
      </div>
    );
  }

  // 이미 올린 코스를 또 올리면 둘러보기에 같은 글이 두 개 생긴다. 링크로 직접 들어온 경우까지 막는다.
  const sharedPost = findPostByCourseId(posts, course.id);
  if (sharedPost) {
    return (
      <div className="px-4 pb-6 pt-3">
        <ShareCourseSummary course={course} />
        <FeedEmptyState
          emoji="🎉"
          title="이미 자랑한 코스예요"
          description="한 코스는 한 번만 올릴 수 있어요"
        />
        <Link href={`/feed/post/${sharedPost.id}`} className="block">
          <Button variant="primary">올린 글 보러 가기</Button>
        </Link>
      </div>
    );
  }

  const handleSubmit = async () => {
    if (createPost.isPending) return;

    const input = buildPostInputFromCourse(course, text, {
      name: user?.nickname ?? activePet?.name ?? "나",
      emoji: activePet?.emoji ?? "🐾",
      petTypeName: activePet?.mbti?.name ?? "여행 유형 미검사",
    });

    try {
      const created = await createPost.mutateAsync(input);
      showToast("둘러보기에 코스를 자랑했어요");
      // replace: 뒤로 가면 이미 올린 자랑하기 화면이 아니라 코스 상세로 돌아가야 한다.
      router.replace(`/feed/post/${created.id}`);
    } catch {
      showToast("올리지 못했어요. 잠시 후 다시 시도해주세요");
    }
  };

  return (
    <div className="px-4 pb-6 pt-3">
      <div className="mb-2 text-sm font-bold text-ink">자랑할 코스</div>
      <ShareCourseSummary course={course} />

      <div className="mb-2 mt-5 text-sm font-bold text-ink">한마디 남기기</div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={"어떤 점이 좋았는지 알려주세요\n예: 펜션 마당이 넓어서 계속 뛰어놀았어요"}
        rows={5}
        className="w-full resize-none rounded-lg border border-line bg-card p-3 text-sm text-ink outline-none focus:border-brand-400"
      />

      <p className="mt-4 rounded-2xl bg-brand-100/60 px-3.5 py-3 text-xs leading-relaxed text-brand-700">
        🐾 코스의 장소·동선·조건 뱃지는 자동으로 함께 올라가요
      </p>

      <Button
        variant="primary"
        className="mt-5"
        disabled={createPost.isPending}
        onClick={handleSubmit}
      >
        {createPost.isPending ? "올리는 중…" : "둘러보기에 올리기"}
      </Button>
    </div>
  );
}

function LoadingState() {
  return <div className="py-10 text-center text-xs text-ink-muted">불러오는 중…</div>;
}
