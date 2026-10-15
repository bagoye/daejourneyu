"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { cn } from "@/lib/cn";
import { nightsLabel } from "@/lib/courseFormat";
import { useCourseStore } from "@/stores/useCourseStore";
import { NO_COURSES, useCourses } from "@/hooks/useCourses";
import { useAuthStore } from "@/stores/useAuthStore";
import { useToastStore } from "@/stores/useToastStore";
import type { CourseSource } from "@/types";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const SOURCE_LABEL: Record<CourseSource, string> = {
  ai: "AI 추천",
  manual: "직접",
  saved: "내가 담은 코스",
};

const SOURCE_TONE: Record<CourseSource, "purple" | "brand" | "coral"> = {
  ai: "purple",
  manual: "brand",
  saved: "coral",
};

function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function toYmd(year: number, month0: number, day: number) {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

/**
 * 내 여정(SCHEDULE) 탭의 '캘린더' 세그. 홈의 축제 캘린더(app/(shell)/home/festival)와 달 그리드
 * 구조는 동일하지만, 표시 대상이 축제가 아니라 내가 코스에 등록한 일정(CourseSchedule)이다.
 */
export function ScheduleCalendar({ initialDate }: { initialDate?: string }) {
  const router = useRouter();
  const { data: courses = NO_COURSES } = useCourses();
  const schedules = useCourseStore((state) => state.schedules);
  const addSchedule = useCourseStore((state) => state.addSchedule);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const showToast = useToastStore((state) => state.show);
  const today = new Date();
  const initial = initialDate ? new Date(initialDate) : today;
  const [year, setYear] = useState(initial.getFullYear());
  const [month0, setMonth0] = useState(initial.getMonth());
  const [selectedDate, setSelectedDate] = useState(
    initialDate ?? toYmd(today.getFullYear(), today.getMonth(), today.getDate())
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addingCourseId, setAddingCourseId] = useState<string | null>(null);

  const handleAddToSelectedDate = async (courseId: string) => {
    setAddingCourseId(courseId);
    try {
      await addSchedule(courseId, selectedDate);
      showToast(`${selectedDate}에 일정을 추가했어요`);
      setPickerOpen(false);
    } catch {
      showToast("일정 등록에 실패했어요. 잠시 후 다시 시도해주세요");
    } finally {
      setAddingCourseId(null);
    }
  };

  const cells = useMemo(() => {
    const firstWeekday = new Date(year, month0, 1).getDay();
    const daysInMonth = new Date(year, month0 + 1, 0).getDate();
    const list: Array<{ day: number; date: string } | null> = [];
    for (let i = 0; i < firstWeekday; i++) list.push(null);
    for (let day = 1; day <= daysInMonth; day++) list.push({ day, date: toYmd(year, month0, day) });
    return list;
  }, [year, month0]);

  const changeMonth = (delta: number) => {
    let nextMonth = month0 + delta;
    let nextYear = year;
    if (nextMonth < 0) {
      nextMonth = 11;
      nextYear -= 1;
    } else if (nextMonth > 11) {
      nextMonth = 0;
      nextYear += 1;
    }
    setMonth0(nextMonth);
    setYear(nextYear);
  };

  const todayYmd = toYmd(today.getFullYear(), today.getMonth(), today.getDate());
  const selectedSchedules = schedules.filter((schedule) => schedule.date === selectedDate);

  return (
    <div className="px-4 pb-6 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" onClick={() => changeMonth(-1)} className="px-2 text-sm text-ink-muted">
          ‹
        </button>
        <span className="text-sm font-bold text-ink">
          {year}년 {month0 + 1}월
        </span>
        <button type="button" onClick={() => changeMonth(1)} className="px-2 text-sm text-ink-muted">
          ›
        </button>
      </div>

      <div className="grid grid-cols-7">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-1 text-center text-[9px] text-ink-muted">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`empty-${i}`} />;
          const hasSchedule = schedules.some((schedule) => schedule.date === cell.date);
          const isToday = cell.date === todayYmd;
          const isSelected = cell.date === selectedDate;
          return (
            <button
              key={cell.date}
              type="button"
              onClick={() => setSelectedDate(cell.date)}
              className={cn(
                "flex aspect-square flex-col items-center justify-start gap-1 rounded-lg border border-line pt-1 text-[10px] text-ink",
                isSelected && "border-brand-400 bg-brand-100",
                isToday && !isSelected && "border-brand"
              )}
            >
              <span>{cell.day}</span>
              {hasSchedule ? <span className="h-1 w-1 rounded-full bg-brand" /> : null}
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-ink-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-brand" /> 예정된 일정
      </div>

      <div className="mb-1 mt-5 flex items-center justify-between px-1">
        <span className="text-xs font-bold text-ink-muted">{selectedDate} 일정</span>
        {isLoggedIn ? (
          <button type="button" onClick={() => setPickerOpen(true)} className="text-xs font-semibold text-brand">
            + 코스 추가
          </button>
        ) : null}
      </div>
      {selectedSchedules.length === 0 ? (
        <div className="py-8 text-center text-xs text-ink-muted">이 날엔 등록된 일정이 없어요.</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {selectedSchedules.map((schedule) => {
            const course = courses.find((item) => item.id === schedule.courseId);
            if (!course) return null;
            const stopCount = course.days.reduce((sum, day) => sum + day.length, 0);
            return (
              <Card
                key={schedule.id}
                onClick={() => router.push(`/schedule/course/${course.id}`)}
                className="rounded-2xl px-4 py-3.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-bold text-ink">{course.label}</span>
                  <Tag tone={SOURCE_TONE[course.source]} className="shrink-0 cursor-default">
                    {SOURCE_LABEL[course.source]}
                  </Tag>
                </div>
                <div className="mt-1 text-xs text-ink-muted">
                  {nightsLabel(course.nights)} · {stopCount}곳
                </div>
                {schedule.festivalTitles.length > 0 ? (
                  <div className="mt-1.5 text-[11px] text-ink-muted">
                    🎪 근처 축제: {schedule.festivalTitles.join(", ")}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <BottomSheet open={pickerOpen} onClose={() => setPickerOpen(false)} title={`${selectedDate}에 추가할 코스`}>
        {courses.length === 0 ? (
          <div className="py-8 text-center">
            <div className="mb-3 text-xs text-ink-muted">보관함에 코스가 없어요. 먼저 코스를 만들어보세요.</div>
            <button
              type="button"
              onClick={() => router.push("/schedule/course/new/mbti")}
              className="rounded-full bg-brand px-4 py-2 text-xs font-bold text-white"
            >
              코스 만들러 가기
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {courses.map((course) => {
              const stopCount = course.days.reduce((sum, day) => sum + day.length, 0);
              return (
                <Card key={course.id} className="rounded-2xl px-4 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-ink">{course.label}</div>
                      <div className="mt-0.5 text-xs text-ink-muted">
                        {nightsLabel(course.nights)} · {stopCount}곳
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={addingCourseId === course.id}
                      onClick={() => handleAddToSelectedDate(course.id)}
                      className="shrink-0 rounded-full bg-brand px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                    >
                      {addingCourseId === course.id ? "추가 중…" : "추가"}
                    </button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
