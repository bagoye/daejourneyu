"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { TabPlaceholder } from "@/components/shell/TabPlaceholder";
import { CourseCard } from "@/components/course/CourseCard";
import { ScheduleCalendar } from "@/components/course/ScheduleCalendar";
import { LoginRequiredGate } from "@/components/course/LoginRequiredGate";
import { TileButton } from "@/components/ui/TileButton";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePetStore } from "@/stores/usePetStore";
import { NO_SCHEDULES, useSchedules } from "@/hooks/useSchedules";
import { useCourses } from "@/hooks/useCourses";
import { resolveMbtiType } from "@/lib/mbti";

type ScheduleSegment = "내 코스" | "캘린더";

const VAULT_PREVIEW_COUNT = 5;

export default function SchedulePage() {
  return (
    <Suspense fallback={null}>
      <ScheduleTabContent />
    </Suspense>
  );
}

function ScheduleTabContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialDate = searchParams.get("date") ?? undefined;
  const [segment, setSegment] = useState<ScheduleSegment>(
    searchParams.get("tab") === "calendar" ? "캘린더" : "내 코스"
  );
  // data가 undefined면 아직 서버 목록을 한 번도 못 받은 것 — 그동안은 "불러오는 중…"을 띄운다.
  const { data: apiCourses } = useCourses();
  const hasSynced = apiCourses !== undefined;
  const { data: schedules = NO_SCHEDULES } = useSchedules();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  // 검사 결과는 반려동물에 저장돼 있다(PUT /api/pets/:id/mbti).
  const savedMbtiCode = usePetStore((state) => state.activePet()?.mbti?.code ?? null);

  const courses = [...(apiCourses ?? [])].reverse();
  const preview = courses.slice(0, VAULT_PREVIEW_COUNT);
  const scheduleCountByCourse = new Map<string, number>();
  for (const schedule of schedules) {
    scheduleCountByCourse.set(schedule.courseId, (scheduleCountByCourse.get(schedule.courseId) ?? 0) + 1);
  }

  // 로그인 + 저장된 MBTI 결과가 있을 때만 "바로 추천" 지름길을 보여준다.
  // 둘 중 하나라도 없으면 로그인 안 했을 때와 동일하게 기본 테스트 진입 타일을 보여준다.
  const savedMbtiType = isLoggedIn && savedMbtiCode ? resolveMbtiType(savedMbtiCode) : null;

  return (
    <>
      <TopBar title="내 여정" />
      <div className="flex rounded-xl bg-line p-1 mx-4 mt-4">
        {(["내 코스", "캘린더"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setSegment(tab)}
            className={
              segment === tab
                ? "flex-1 rounded-lg bg-card py-2.5 text-center text-xs font-semibold text-ink shadow-sm"
                : "flex-1 rounded-lg py-2.5 text-center text-xs font-semibold text-ink-muted"
            }
          >
            {tab}
          </button>
        ))}
      </div>

      {segment === "내 코스" ? (
        <div className="px-4 pb-6 pt-5">
          <div className="mb-2 px-1 text-xs font-bold text-ink-muted">코스 만들기</div>
          <div className="mb-6 grid grid-cols-3 gap-2.5">
            <TileButton
              icon3D
              variant="filled"
              tone="brand"
              emoji={savedMbtiType ? savedMbtiType.emoji : "✨"}
              title="MBTI 맞춤 코스"
              subtitle={savedMbtiType ? `${savedMbtiType.code}로 바로 추천받기` : "성향 테스트로 코스 자동 생성"}
              onClick={() =>
                router.push(savedMbtiType ? "/schedule/course/new/mbti?quick=1" : "/schedule/course/new/mbti")
              }
            />
            <TileButton
              icon3D
              variant="filled"
              tone="purple"
              emoji="🤖"
              title="AI에게 물어보기"
              subtitle="말로 원하는 여행을 설명해요"
              onClick={() => router.push("/home/chatbot")}
            />
            <TileButton
              icon3D
              variant="filled"
              tone="coral"
              emoji="📍"
              title="직접 짓기"
              subtitle="가고 싶은 곳만 담아서"
              onClick={() => router.push("/schedule/course/new/manual")}
            />
          </div>

          {!isLoggedIn ? (
            <LoginRequiredGate compact message="보관함에 저장한 코스를 보려면 로그인해주세요" />
          ) : !hasSynced ? (
            <div className="py-10 text-center text-xs text-ink-muted">코스 보관함을 불러오는 중…</div>
          ) : (
            <>
              <div className="mb-2.5 flex items-center justify-between px-1">
                <div className="text-xs font-bold text-ink-muted">코스 보관함</div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-muted">{courses.length}개</span>
                  {courses.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => router.push("/schedule/vault")}
                      className="text-xs font-semibold text-brand"
                    >
                      전체 보기 ›
                    </button>
                  ) : null}
                </div>
              </div>

              {courses.length > 0 ? (
                <>
                  {preview.map((course) => (
                    <CourseCard
                      key={course.id}
                      course={course}
                      scheduleCount={scheduleCountByCourse.get(course.id) ?? 0}
                      onClick={() => router.push(`/schedule/course/${course.id}`)}
                      onAddSchedule={() => router.push(`/schedule/course/${course.id}/schedule`)}
                    />
                  ))}
                  {courses.length > VAULT_PREVIEW_COUNT ? (
                    <button
                      type="button"
                      onClick={() => router.push("/schedule/vault")}
                      className="flex min-h-11 w-full items-center justify-center rounded-lg border border-line-strong text-xs font-semibold text-ink-muted"
                    >
                      코스 보관함 전체 보기 ({courses.length}개) ›
                    </button>
                  ) : null}
                </>
              ) : (
                <TabPlaceholder emoji="🐾" message={"보관함이 비어 있어요\n첫 코스를 만들어보세요"} />
              )}
            </>
          )}
        </div>
      ) : (
        <ScheduleCalendar initialDate={initialDate} />
      )}
    </>
  );
}
