"use client";

import { useMemo, useState } from "react";
import { TopBar } from "@/components/shell/TopBar";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { FeedPager } from "@/components/feed/FeedPager";
import { LoadErrorState } from "@/components/shell/LoadErrorState";
import { useReviews, useDeleteReview } from "@/hooks/useReviews";
import { useToastStore } from "@/stores/useToastStore";
import { paginate } from "@/lib/feed";

/** 한 페이지에 보여줄 후기 개수 — 둘러보기 '내 글' 목록(MY_POSTS_PER_PAGE)과 동일한 값을 쓴다. */
const REVIEWS_PER_PAGE = 4;

export default function MyReviewsPage() {
  const { data, isLoading, isError, refetch } = useReviews();
  const reviews = useMemo(() => data ?? [], [data]);
  const deleteReview = useDeleteReview();
  const showToast = useToastStore((state) => state.show);

  const [page, setPage] = useState(0);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const myReviews = useMemo(() => reviews.filter((review) => review.isMine), [reviews]);
  const myPage = paginate(myReviews, page, REVIEWS_PER_PAGE);

  const confirmDelete = async () => {
    if (!pendingDeleteId) return;
    const targetId = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await deleteReview.mutateAsync(targetId);
      showToast("후기를 삭제했어요");
    } catch {
      showToast("삭제하지 못했어요. 잠시 후 다시 시도해주세요");
    }
  };

  return (
    <>
      <TopBar title="내가 쓴 후기" showBack />
      <div className="flex flex-col gap-2.5 px-4 pb-6 pt-3">
        {isLoading ? (
          <div className="py-10 text-center text-xs text-ink-muted">불러오는 중…</div>
        ) : isError && !data ? (
          <LoadErrorState message="후기를 불러오지 못했어요" onRetry={() => void refetch()} />
        ) : myReviews.length === 0 ? (
          <div className="py-10 text-center text-xs text-ink-muted">
            아직 작성한 후기가 없어요. 장소 상세에서 후기를 남겨보세요.
          </div>
        ) : (
          <>
            {myPage.items.map((review) => (
              <Card key={review.id}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-ink">{review.placeName}</div>
                    <div className="mt-0.5 text-[10px] text-ink-muted">
                      {review.createdAtLabel}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingDeleteId(review.id)}
                    aria-label={`${review.placeName} 후기 삭제`}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface text-[13px] text-ink-muted transition-colors hover:bg-accent-coral hover:text-white"
                  >
                    ✕
                  </button>
                </div>
                {review.text ? <div className="mt-1.5 text-xs text-ink">{review.text}</div> : null}
                <div className="mt-2 flex flex-wrap gap-1">
                  {review.tags.map((tag) => (
                    <Tag
                      key={tag.code}
                      tone={tag.category === "CAUTION" ? "amber" : "brand"}
                      className="cursor-default px-2 py-1 text-[10px]"
                    >
                      {tag.label}
                    </Tag>
                  ))}
                </div>
              </Card>
            ))}
            {myPage.totalPages > 1 ? (
              <FeedPager page={myPage.page} totalPages={myPage.totalPages} onChange={setPage} />
            ) : null}
          </>
        )}
      </div>

      <Modal
        open={pendingDeleteId !== null}
        onClose={() => setPendingDeleteId(null)}
        title="이 후기를 삭제할까요?"
        description="삭제하면 되돌릴 수 없어요"
      >
        <Button variant="primary" disabled={deleteReview.isPending} onClick={confirmDelete}>
          {deleteReview.isPending ? "삭제 중…" : "삭제하기"}
        </Button>
        <Button variant="secondary" onClick={() => setPendingDeleteId(null)}>
          취소
        </Button>
      </Modal>
    </>
  );
}
