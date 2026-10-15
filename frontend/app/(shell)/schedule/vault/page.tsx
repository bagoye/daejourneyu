"use client";

import { useRouter } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { TabPlaceholder } from "@/components/shell/TabPlaceholder";
import { CourseCard } from "@/components/course/CourseCard";
import { LoginRequiredGate } from "@/components/course/LoginRequiredGate";
import { useAuthStore } from "@/stores/useAuthStore";
import { NO_SCHEDULES, useSchedules } from "@/hooks/useSchedules";
import { useCourses } from "@/hooks/useCourses";

export default function CourseVaultPage() {
  const router = useRouter();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const { data: apiCourses } = useCourses();
  const hasSynced = apiCourses !== undefined;
  const { data: schedules = NO_SCHEDULES } = useSchedules();
  const courses = [...(apiCourses ?? [])].reverse();
  const scheduleCountByCourse = new Map<string, number>();
  for (const schedule of schedules) {
    scheduleCountByCourse.set(schedule.courseId, (scheduleCountByCourse.get(schedule.courseId) ?? 0) + 1);
  }

  if (!isLoggedIn) {
    return (
      <>
        <TopBar title="코스 보관함" showBack />
        <LoginRequiredGate message="보관함에 담긴 코스는 로그인해야 볼 수 있어요" />
      </>
    );
  }

  if (!hasSynced) {
    return (
      <>
        <TopBar title="코스 보관함" showBack />
        <div className="py-16 text-center text-xs text-ink-muted">불러오는 중…</div>
      </>
    );
  }

  return (
    <>
      <TopBar title="코스 보관함" showBack />
      <div className="px-4 pb-6 pt-3">
        <div className="mb-2 px-1 text-xs text-ink-muted">보관함 코스 {courses.length}개</div>
        {courses.length > 0 ? (
          courses.map((course) => (
            <CourseCard
              key={course.id}
              course={course}
              scheduleCount={scheduleCountByCourse.get(course.id) ?? 0}
              onClick={() => router.push(`/schedule/course/${course.id}`)}
              onAddSchedule={() => router.push(`/schedule/course/${course.id}/schedule`)}
            />
          ))
        ) : (
          <TabPlaceholder emoji="🐾" message={"보관함이 비어 있어요\n코스를 만들어 보세요"} />
        )}
      </div>
    </>
  );
}
