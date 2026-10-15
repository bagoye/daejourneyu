"use client";

import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { TabPlaceholder } from "@/components/shell/TabPlaceholder";
import { Tag } from "@/components/ui/Tag";
import { CourseButton as Button } from "@/components/course/CourseButton";
import { Modal } from "@/components/ui/Modal";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { ResultShareActions } from "@/components/course/ResultShareActions";
import { CourseRouteMap } from "@/components/course/CourseRouteMap";
import { PlacePickerSheet } from "@/components/course/PlacePickerSheet";
import { KakaoPlacePreviewSheet } from "@/components/course/KakaoPlacePreviewSheet";
import { StopThumbnail } from "@/components/course/StopThumbnail";
import { LoginRequiredGate } from "@/components/course/LoginRequiredGate";
import {
  conditionSourceLabel,
  isUnverifiedCondition,
  NEEDS_CHECK_LABEL,
  nightsLabel,
  placeToStop,
  resolveCourseEmoji,
  SOURCE_LABEL,
  SOURCE_TONE,
} from "@/lib/courseFormat";
import { cn } from "@/lib/cn";
import { useCourseStore } from "@/stores/useCourseStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useSyncCoursesFromApi } from "@/hooks/useSyncCoursesFromApi";
import { useCourses, useDeleteCourse, useUpdateCourse } from "@/hooks/useCourses";
import { useSheetStore } from "@/stores/useSheetStore";
import type { CourseStop } from "@/types";

/** 티켓 배경(브랜드 민트) 위에서도 태그 경계가 보이도록 배경을 흰색으로 고정한다 —
 * tone별 배경이 티켓 배경색과 같은 계열이면 경계가 안 보이는 문제 방지. 글자색은 tone 그대로 유지. */
const TICKET_TAG_CLASS = "cursor-default border border-line bg-card";

const EMOJI_CHOICES = [
  "🐾", "🐶", "🐕", "🐩", "🦮", "🐈",
  "🌳", "🌲", "🏞️", "🌸", "🍁", "❄️",
  "🚶", "🏃", "🎾", "🏖️", "🌊", "⛺",
  "🍖", "🍰", "☕", "🎨", "🏛️", "🎪",
  "🚗", "🚌", "📍", "🌙", "☀️", "❤️",
];

export default function CourseDetailPage({ params }: { params: { courseId: string } }) {
  const router = useRouter();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  useSyncCoursesFromApi();
  const { data: courses } = useCourses();
  const hasSynced = courses !== undefined;
  const { mutate: updateCourse } = useUpdateCourse();
  const { mutate: deleteCourse } = useDeleteCourse();
  const schedules = useCourseStore((state) => state.schedules);
  const course = courses?.find((item) => item.id === params.courseId);
  const courseSchedules = schedules
    .filter((item) => item.courseId === params.courseId)
    .sort((a, b) => a.date.localeCompare(b.date));

  const captureRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeDay, setActiveDay] = useState(0);

  const [editMode, setEditMode] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftEmoji, setDraftEmoji] = useState<string | null>(null);
  const [draftDays, setDraftDays] = useState<CourseStop[][]>([]);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [kakaoPreview, setKakaoPreview] = useState<CourseStop | null>(null);
  const openPlaceSheet = useSheetStore((state) => state.open);

  if (!isLoggedIn) {
    return (
      <>
        <TopBar title="코스 상세" showBack />
        <LoginRequiredGate message="저장된 코스는 로그인해야 볼 수 있어요" />
      </>
    );
  }

  if (!course) {
    // 로그인 직후엔 courses가 아직 undefined(첫 응답 전)일 수 있어, 실제로 존재하는 코스인데도
    // 서버 목록이 도착하기 전이라 "찾을 수 없음"으로 오판할 수 있다 — 동기화가 끝난 뒤에만 진짜로 없다고 안내한다.
    if (!hasSynced) {
      return (
        <>
          <TopBar title="코스 상세" showBack />
          <div className="py-16 text-center text-xs text-ink-muted">불러오는 중…</div>
        </>
      );
    }
    return (
      <>
        <TopBar title="코스 상세" showBack />
        <TabPlaceholder emoji="🐾" message={"코스를 찾을 수 없어요\n삭제되었거나 접근할 수 없는 코스예요"} />
      </>
    );
  }

  const displayDays = editMode ? draftDays : course.days;
  const displayLabel = editMode ? draftLabel : course.label;
  const displayEmoji = editMode ? draftEmoji || resolveCourseEmoji(null, course.source) : resolveCourseEmoji(course.emoji, course.source);
  const stopCount = displayDays.reduce((sum, day) => sum + day.length, 0);
  const isMultiDay = displayDays.length > 1;

  const goToPlace = (stop: CourseStop) => {
    // 카카오맵 검색으로 담긴 장소는 /api/places·mockPlaces에 없어 우리 상세 페이지 조회가 항상
    // 실패한다 — 대신 같은 앱 안에서 우리 상세 페이지와 비슷한 생김새의 미리보기 시트를 띄운다.
    // 지도는 KakaoPlacePreviewSheet 안에서 CourseRouteMap이 그때그때 좌표를 다시 구해서 그리므로
    // placeUrl 유무와 무관하게(예전에 저장된 코스도) 항상 뜬다 — "카카오맵에서 보기" 버튼만
    // placeUrl이 있을 때 추가로 보인다.
    if (stop.placeId.startsWith("kakao-")) {
      setKakaoPreview(stop);
      return;
    }
    router.push(`/place/${encodeURIComponent(stop.name)}`);
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || el.clientWidth === 0) return;
    setActiveDay(Math.round(el.scrollLeft / el.clientWidth));
  };

  const goToDay = (index: number) => {
    scrollRef.current?.scrollTo({ left: index * (scrollRef.current?.clientWidth ?? 0), behavior: "smooth" });
    setActiveDay(index);
  };

  const enterEditMode = () => {
    setDraftLabel(course.label);
    setDraftEmoji(course.emoji ?? null);
    setDraftDays(course.days.map((day) => day.map((stop) => ({ ...stop }))));
    setEditMode(true);
  };

  const cancelEditMode = () => setEditMode(false);

  const saveEditMode = () => {
    if (draftLabel.trim().length === 0 || draftDays.every((day) => day.length === 0)) return;
    updateCourse({ courseId: course.id, patch: { label: draftLabel.trim(), emoji: draftEmoji, days: draftDays } });
    setEditMode(false);
  };

  const reorderDay = (dayIndex: number, nextDay: CourseStop[]) => {
    setDraftDays((prev) => {
      const next = [...prev];
      next[dayIndex] = nextDay;
      return next;
    });
  };

  const removeStop = (dayIndex: number, index: number) => {
    setDraftDays((prev) => {
      if (prev[dayIndex].length <= 1) return prev; // 일차당 최소 1곳은 남긴다
      const next = [...prev];
      next[dayIndex] = prev[dayIndex].filter((_, i) => i !== index);
      return next;
    });
  };

  const addPlacesToDay = (dayIndex: number) => {
    openPlaceSheet({
      title: displayDays.length > 1 ? `${dayIndex + 1}일차에 장소 추가` : "장소 추가",
      initialSelected: [],
      onDone: (picked) => {
        if (picked.length === 0) return;
        setDraftDays((prev) => {
          const existingIds = new Set(prev[dayIndex].map((stop) => stop.placeId));
          const toAdd = picked.filter((place) => !existingIds.has(place.id)).map(placeToStop);
          if (toAdd.length === 0) return prev;
          const next = [...prev];
          next[dayIndex] = [...prev[dayIndex], ...toAdd];
          return next;
        });
      },
    });
  };

  const handleDelete = () => {
    deleteCourse(course.id);
    router.replace("/schedule/vault");
  };

  return (
    <>
      <TopBar title={editMode ? "코스 편집" : course.label} showBack onBack={editMode ? cancelEditMode : undefined} />

      <div className="px-4 pb-3 pt-3">
        {/* 여행 티켓 카드 — 상단 탑승권 스트립 + 절취선(펀치홀) + 일차 스탬프 */}
        <div ref={captureRef} className="overflow-hidden rounded-2xl bg-brand-100 shadow-sm">
          <div className="flex items-center justify-between px-4 pt-3 font-mono text-[9px] font-bold tracking-widest text-brand-700/70">
            <span>COURSE TICKET</span>
            <span>DAEJEON</span>
          </div>

          <div className="px-4 pb-3 pt-2 text-center">
            <div className="text-4xl">{displayEmoji}</div>
            {editMode ? (
              <button
                type="button"
                onClick={() => setEmojiPickerOpen(true)}
                className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-brand-300 bg-card px-2.5 py-1 text-[11px] font-semibold text-brand-700"
              >
                <span>🎨</span>대표 이모지 바꾸기
              </button>
            ) : null}

            {editMode ? (
              <input
                value={draftLabel}
                onChange={(event) => setDraftLabel(event.target.value)}
                className="mt-2.5 w-full rounded-lg border border-brand-300 bg-card px-3 py-2 text-center text-base font-extrabold tracking-tight text-brand-700 outline-none"
                placeholder="코스 이름"
              />
            ) : (
              <div className="mt-1 text-base font-extrabold tracking-tight text-brand-700">{displayLabel}</div>
            )}

            <div className="mt-2 flex flex-wrap justify-center gap-1">
              <Tag tone={SOURCE_TONE[course.source]} className={TICKET_TAG_CLASS}>
                {SOURCE_LABEL[course.source]}
              </Tag>
              <Tag tone="brand" className={TICKET_TAG_CLASS}>
                {course.nights > 0 ? "🌙" : "☀️"} {nightsLabel(course.nights)}
              </Tag>
              <Tag tone="purple" className={TICKET_TAG_CLASS}>
                {course.transport === "자차" ? "🚗" : "🚌"} {course.transport}
              </Tag>
              {course.shared ? (
                <Tag tone="amber" className={TICKET_TAG_CLASS}>
                  🔗 공유됨
                </Tag>
              ) : null}
            </div>

            {courseSchedules.length > 0 ? (
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {courseSchedules.map((s) => (
                  <div key={s.id} className="rounded-xl bg-card px-3 py-2 text-xs font-semibold text-brand-700">
                    📅 {s.date}에 가기로 했어요
                    {s.festivalTitles.length > 0 ? ` · ${s.festivalTitles.join(", ")}` : ""}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="relative mx-3.5 h-0 border-t border-dashed border-brand-700/25">
            <span className="absolute -left-[22px] -top-2 h-4 w-4 rounded-full bg-surface" />
            <span className="absolute -right-[22px] -top-2 h-4 w-4 rounded-full bg-surface" />
          </div>

          {isMultiDay ? (
            <>
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className={cn(
                  "flex overflow-x-auto scroll-smooth no-scrollbar",
                  !editMode && "snap-x snap-mandatory"
                )}
              >
                {displayDays.map((day, dayIndex) => (
                  <div key={dayIndex} className="w-full shrink-0 snap-center px-4 py-3">
                    <DayStops
                      day={day}
                      dayIndex={dayIndex}
                      totalDays={displayDays.length}
                      onStopClick={goToPlace}
                      editMode={editMode}
                      onReorderDay={(nextDay) => reorderDay(dayIndex, nextDay)}
                      onRemove={(index) => removeStop(dayIndex, index)}
                      onAddPlace={() => addPlacesToDay(dayIndex)}
                    />
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-center gap-1.5 pb-3">
                {displayDays.map((_, index) => (
                  <button
                    key={index}
                    type="button"
                    aria-label={`${index + 1}일차 보기`}
                    onClick={() => goToDay(index)}
                    className={cn(
                      "h-1.5 rounded-full transition-all",
                      index === activeDay ? "w-4 bg-brand-700" : "w-1.5 bg-brand-700/30"
                    )}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="px-4 py-3">
              <DayStops
                day={displayDays[0] ?? []}
                dayIndex={0}
                totalDays={1}
                onStopClick={goToPlace}
                editMode={editMode}
                onReorderDay={(nextDay) => reorderDay(0, nextDay)}
                onRemove={(index) => removeStop(0, index)}
                onAddPlace={() => addPlacesToDay(0)}
              />
            </div>
          )}
        </div>

        {editMode ? (
          <>
            <Button className="mt-3" onClick={saveEditMode}>
              <span>💾</span>저장하기
            </Button>
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={cancelEditMode}>
                취소
              </Button>
              <Button
                variant="secondary"
                className="flex-1 text-accent-coral"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <span>🗑️</span>삭제
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button className="mt-3" onClick={() => router.push(`/schedule/course/${course.id}/schedule`)}>
              {courseSchedules.length > 0 ? (
                <>
                  <span>✏️</span>여행 계획 편집하기
                </>
              ) : (
                <>
                  <span>📅</span>일정을 추가하기
                </>
              )}
            </Button>
            <Button variant="secondary" className="mt-2" onClick={enterEditMode}>
              <span>✏️</span>코스 편집하기
            </Button>
            <ResultShareActions
              captureRef={captureRef}
              fileName={`대저니유-${course.label}`}
              kakaoTitle={course.label}
              kakaoDescription={`${nightsLabel(course.nights)} · ${stopCount}곳 · 대저니유에서 만든 반려동물 여행 코스예요 🐾`}
              path={`/schedule/course/${course.id}`}
            />
            {course.source !== "saved" && !course.shared ? (
              <Button
                variant="text"
                className="mt-1"
                onClick={() => router.push(`/schedule/course/${course.id}/share`)}
              >
                <span>🧭</span>이 코스 둘러보기에 공유하기
              </Button>
            ) : null}
          </>
        )}
      </div>

      <PlacePickerSheet />
      <KakaoPlacePreviewSheet stop={kakaoPreview} onClose={() => setKakaoPreview(null)} />

      <BottomSheet open={emojiPickerOpen} onClose={() => setEmojiPickerOpen(false)} title="대표 이모지 고르기">
        <div className="grid grid-cols-6 gap-2">
          {EMOJI_CHOICES.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                setDraftEmoji(emoji);
                setEmojiPickerOpen(false);
              }}
              className={cn(
                "flex h-11 items-center justify-center rounded-xl text-2xl",
                draftEmoji === emoji ? "bg-brand-100 ring-2 ring-brand" : "bg-surface"
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      </BottomSheet>

      <Modal
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        emoji="🗑️"
        title="이 코스를 삭제할까요?"
        description="삭제하면 되돌릴 수 없어요"
      >
        <Button variant="primary" className="bg-accent-coral active:bg-accent-coral" onClick={handleDelete}>
          삭제하기
        </Button>
        <Button variant="text" onClick={() => setDeleteConfirmOpen(false)}>
          취소
        </Button>
      </Modal>
    </>
  );
}

function DayStops({
  day,
  dayIndex,
  totalDays,
  onStopClick,
  editMode,
  onReorderDay,
  onRemove,
  onAddPlace,
}: {
  day: CourseStop[];
  dayIndex: number;
  totalDays: number;
  onStopClick: (stop: CourseStop) => void;
  editMode: boolean;
  onReorderDay: (nextDay: CourseStop[]) => void;
  onRemove: (index: number) => void;
  onAddPlace: () => void;
}) {
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const handlePointerDown = (placeId: string) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDraggingId(placeId);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingId) return;
    const pointerY = event.clientY;
    const currentIndex = day.findIndex((s) => s.placeId === draggingId);
    if (currentIndex === -1) return;
    for (let i = 0; i < day.length; i++) {
      if (i === currentIndex) continue;
      const el = rowRefs.current[day[i].placeId];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const crossing = (i < currentIndex && pointerY < mid) || (i > currentIndex && pointerY > mid);
      if (crossing) {
        const next = [...day];
        const [moved] = next.splice(currentIndex, 1);
        next.splice(i, 0, moved);
        onReorderDay(next);
        break;
      }
    }
  };

  const handlePointerUp = () => setDraggingId(null);

  return (
    <div>
      <div className="mb-2 text-xs font-bold text-brand-700">
        {totalDays > 1 ? `📍 ${dayIndex + 1}일차 동선` : "📍 동선"} · {day.length}곳
      </div>
      {!editMode ? <CourseRouteMap stops={day} /> : null}
      <div className="overflow-hidden rounded-2xl border border-line bg-card">
        {day.map((stop, stopIndex) => (
          <div
            key={stop.placeId}
            ref={(el) => {
              rowRefs.current[stop.placeId] = el;
            }}
            className={cn(
              "flex items-center gap-2.5 border-b border-line px-4 py-3 last:border-b-0",
              draggingId === stop.placeId && "relative z-10 bg-brand-100"
            )}
            onClick={editMode ? undefined : () => onStopClick(stop)}
          >
            {editMode ? (
              <button
                type="button"
                onPointerDown={handlePointerDown(stop.placeId)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className="flex h-9 w-6 shrink-0 touch-none items-center justify-center text-base text-ink-muted"
                aria-label="순서 바꾸기(드래그)"
              >
                ⠿
              </button>
            ) : null}
            <StopThumbnail category={stop.category} imageUrl={stop.imageUrl} badge={stopIndex + 1} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-ink">{stop.name}</div>
              <div className="mt-0.5 text-xs text-ink-muted">
                {stop.district} · {stop.category}
              </div>
              {!editMode ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {/* "확인해주세요" 류 비확정 안내(카카오·공공데이터 tier2)는 확정형 동반가능
                      배지와 같이 두면 서로 모순돼 보인다 — 이 경우엔 출처 태그 + 표준 안내 태그
                      두 개로 짧게 보여준다(원문은 소스마다 길이가 다 달라 그대로 쓰면 너무 길다). */}
                  {isUnverifiedCondition(stop.condition) ? (
                    <>
                      <Tag tone="neutral" className="cursor-default px-2 py-1 text-[10px]">
                        {conditionSourceLabel(stop.condition)}
                      </Tag>
                      <Tag tone="neutral" className="cursor-default px-2 py-1 text-[10px]">
                        {NEEDS_CHECK_LABEL}
                      </Tag>
                    </>
                  ) : (
                    <>
                      <Tag tone={stop.petFriendly ? "brand" : "coral"} className="cursor-default px-2 py-1 text-[10px]">
                        {stop.petFriendly ? "🐾 동반 가능" : "🚫 동반 불가"}
                      </Tag>
                      {/* 식약처·문체부처럼 실제로 확정된 소스도 원문 조건이 길면(대표메뉴·견종 제한 등
                          세부사항까지 다 붙어서) 카드 한 줄에 넘친다 — 출처만 짧게 보여준다. */}
                      <Tag tone="neutral" className="cursor-default px-2 py-1 text-[10px]">
                        {conditionSourceLabel(stop.condition)}
                      </Tag>
                    </>
                  )}
                </div>
              ) : null}
            </div>
            {editMode ? (
              <button
                type="button"
                disabled={day.length <= 1}
                onClick={() => onRemove(stopIndex)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-coral-light text-xs text-accent-coral disabled:opacity-30"
              >
                ✕
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {editMode ? (
        <button
          type="button"
          onClick={onAddPlace}
          className="mt-2.5 flex h-12 w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-card text-sm font-bold text-brand-700 active:bg-brand-100"
        >
          <span>➕</span>장소 추가하기
        </button>
      ) : null}
    </div>
  );
}
