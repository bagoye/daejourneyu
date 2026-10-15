"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { LoadErrorState } from "@/components/shell/LoadErrorState";
import { CourseButton as Button } from "@/components/course/CourseButton";
import { Card } from "@/components/ui/Card";
import { LoginRequiredGate } from "@/components/course/LoginRequiredGate";
import { MonthCalendarGrid } from "@/components/course/MonthCalendarGrid";
import { useAuthStore } from "@/stores/useAuthStore";
import { NO_SCHEDULES, useCreateSchedule, useDeleteSchedule, useSchedules } from "@/hooks/useSchedules";
import { useCourses } from "@/hooks/useCourses";
import { useToastStore } from "@/stores/useToastStore";

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function CourseScheduleAddPage({ params }: { params: { courseId: string } }) {
  const router = useRouter();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const showToast = useToastStore((state) => state.show);

  const { data: courses, isError: coursesFailed, refetch: refetchCourses } = useCourses();
  const course = courses?.find((c) => c.id === params.courseId);
  const { data: schedules = NO_SCHEDULES } = useSchedules();
  // 렌더마다 .filter().sort()로 새 배열을 만들지 않도록 schedules 값 자체가 바뀔 때만 다시 계산한다.
  const courseSchedules = useMemo(
    () => schedules.filter((s) => s.courseId === params.courseId).sort((a, b) => a.date.localeCompare(b.date)),
    [schedules, params.courseId]
  );
  const { mutateAsync: addSchedule } = useCreateSchedule();
  const { mutateAsync: removeSchedule } = useDeleteSchedule();

  const [date, setDate] = useState(todayYmd());
  const [saving, setSaving] = useState(false);

  if (!isLoggedIn) {
    return (
      <>
        <TopBar title="일정 추가" showBack />
        <LoginRequiredGate message="일정을 등록하려면 로그인해주세요" />
      </>
    );
  }

  // 코스 목록을 아직 못 받았으면 "찾을 수 없음"으로 단정하지 않는다 — 로딩 중이거나 실패한 것이다.
  if (!courses) {
    return (
      <>
        <TopBar title="일정 추가" showBack />
        {coursesFailed ? (
          <LoadErrorState message="코스를 불러오지 못했어요" onRetry={() => void refetchCourses()} />
        ) : (
          <div className="py-16 text-center text-xs text-ink-muted">불러오는 중…</div>
        )}
      </>
    );
  }

  if (!course) {
    return (
      <>
        <TopBar title="일정 추가" showBack />
        <div className="px-4 py-16 text-center text-sm text-ink-muted">코스를 찾을 수 없어요</div>
      </>
    );
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      await addSchedule({ courseId: course.id, date });
      showToast("일정을 등록했어요");
      router.push(`/schedule?tab=calendar&date=${date}`);
    } catch {
      showToast("일정 등록에 실패했어요. 잠시 후 다시 시도해주세요");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (scheduleId: string) => {
    setSaving(true);
    try {
      await removeSchedule(scheduleId);
      showToast("일정을 취소했어요");
    } catch {
      showToast("일정 취소에 실패했어요. 잠시 후 다시 시도해주세요");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <TopBar title="일정 추가" showBack />
      <div className="px-4 pb-6 pt-3">
        <Card className="flex items-center gap-2">
          <span className="text-lg">🐾</span>
          <span className="text-sm font-bold text-ink">{course.label}</span>
        </Card>

        {courseSchedules.length > 0 ? (
          <div className="mt-4">
            <div className="mb-1.5 text-xs font-semibold text-ink-muted">등록된 일정</div>
            <div className="flex flex-col gap-1.5">
              {courseSchedules.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded-lg border border-line bg-card px-3 py-2 text-sm"
                >
                  <span className="text-ink">📅 {s.date}</span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => handleRemove(s.id)}
                    className="text-xs font-semibold text-accent-coral disabled:opacity-40"
                  >
                    취소
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <label className="mt-4 mb-1.5 block text-xs font-semibold text-ink-muted">새 날짜에 추가할까요?</label>
        <MonthCalendarGrid
          selectedDate={date}
          onSelectDate={setDate}
          markedDates={new Set(courseSchedules.map((s) => s.date))}
        />
        <div className="mt-1.5 px-1 text-[11px] text-ink-muted">📅 선택한 날짜: {date}</div>

        <Button className="mt-5" onClick={handleSave} disabled={saving}>
          <span>📅</span>일정 등록하기
        </Button>
      </div>
    </>
  );
}
