"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { Button } from "@/components/ui/Button";
import { LoginModal } from "@/components/my/LoginModal";
import { PlaceMap } from "@/components/place/PlaceMap";
import { usePlaces } from "@/hooks/usePlaces";
import { usePlaceReviews } from "@/hooks/useReviews";
import { useAuthStore } from "@/stores/useAuthStore";
import { getConditionTags } from "@/lib/placeFilters";
import { conditionSourceLabel } from "@/lib/courseFormat";

export default function PlaceDetailPage({ params }: { params: { name: string } }) {
  const router = useRouter();
  const placeName = decodeURIComponent(params.name);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const { data: places = [], isLoading: placesLoading } = usePlaces();
  const [loginOpen, setLoginOpen] = useState(false);

  const place = places.find((p) => p.name === placeName);
  const {
    reviews: placeReviews,
    isLoading: reviewsLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = usePlaceReviews(place?.id);
  const conditionTags = place ? getConditionTags(place.condition, place.smallDogOnly) : [];

  const handleWriteReview = () => {
    if (!isLoggedIn) {
      setLoginOpen(true);
      return;
    }
    router.push(`/place/${encodeURIComponent(placeName)}/review`);
  };

  if (placesLoading) {
    return (
      <>
        <TopBar title="장소 정보" showBack />
        <div className="py-16 text-center text-xs text-ink-muted">불러오는 중…</div>
      </>
    );
  }

  if (!place) {
    return (
      <>
        <TopBar title="장소 정보" showBack />
        <div className="py-16 text-center text-xs text-ink-muted">
          존재하지 않는 장소예요.
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title={place.name} showBack />
      <div className="px-4 pb-6 pt-3">
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Tag tone="brand" className="cursor-default px-2.5 py-1 text-[11px]">
            {place.category}
          </Tag>
          <Tag tone="neutral" className="cursor-default px-2.5 py-1 text-[11px]">
            {place.district}
          </Tag>
          {place.smallDogOnly ? (
            <Tag tone="amber" className="cursor-default px-2.5 py-1 text-[11px]">
              소형견만
            </Tag>
          ) : null}
        </div>

        <Card highlighted={place.petFriendly} className="mb-5">
          <div className="text-xs font-bold text-ink">
            {place.petFriendly ? "🐾 반려동물 동반 가능" : "🚫 반려동물 동반 불가"}
          </div>
          {conditionTags.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {conditionTags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-line-strong bg-surface px-2 py-0.5 text-[10px] font-medium text-ink-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-1.5 text-xs text-ink-muted">
            {conditionTags.length > 0 ? conditionSourceLabel(place.condition) : place.condition}
          </div>
        </Card>

        <div className="mb-2 px-1 text-xs font-bold text-ink-muted">위치</div>
        <div className="mb-5">
          <PlaceMap name={place.name} lat={place.lat} lng={place.lng} />
        </div>

        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-xs font-bold text-ink-muted">후기 {placeReviews.length}개</span>
          <button
            type="button"
            onClick={handleWriteReview}
            className="text-xs font-semibold text-brand"
          >
            후기 쓰기 ›
          </button>
        </div>

        <div className="flex flex-col gap-2.5">
          {reviewsLoading ? (
            <div className="py-8 text-center text-xs text-ink-muted">불러오는 중…</div>
          ) : placeReviews.length === 0 ? (
            <div className="py-8 text-center text-xs text-ink-muted">
              아직 후기가 없어요. 첫 후기를 남겨보세요.
            </div>
          ) : (
            placeReviews.map((review) => (
              <Card key={review.id}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-ink">{review.authorName}</span>
                  <span className="text-[10px] text-ink-muted">{review.createdAtLabel}</span>
                </div>
                {review.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- data URL이라 next/image 최적화 대상이 아님
                  <img
                    src={review.photoUrl}
                    alt={`${review.authorName}님이 첨부한 사진`}
                    className="mt-2 h-32 w-full rounded-lg object-cover"
                  />
                ) : null}
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
            ))
          )}
          {hasNextPage ? (
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="py-2 text-xs font-semibold text-brand disabled:text-ink-muted"
            >
              {isFetchingNextPage ? "불러오는 중…" : "후기 더보기"}
            </button>
          ) : null}
        </div>

        <div className="mt-6">
          <Button variant="primary" onClick={handleWriteReview}>
            후기 쓰기
          </Button>
        </div>
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onLoggedIn={() => router.push(`/place/${encodeURIComponent(placeName)}/review`)}
      />
    </>
  );
}
