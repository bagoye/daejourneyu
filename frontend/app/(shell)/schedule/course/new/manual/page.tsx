"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { CourseStepBar } from "@/components/course/CourseStepBar";
import { PlacePickerSheet } from "@/components/course/PlacePickerSheet";
import { LoginModal } from "@/components/my/LoginModal";
import { NightsStep } from "./steps/NightsStep";
import { PlacesStep } from "./steps/PlacesStep";
import { ReviewStep } from "./steps/ReviewStep";
import { useCreateCourse } from "@/hooks/useCourses";
import { useToastStore } from "@/stores/useToastStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { nearestNeighborRoute } from "@/lib/nearestNeighborRoute";
import { placeToStop } from "@/lib/courseFormat";
import type { Place } from "@/types";

const MANUAL_STEP_LABELS = ["설정", "장소", "동선"] as const;

function defaultCourseName() {
  const today = new Date();
  return `${today.getMonth() + 1}월 ${today.getDate()}일에 만든 코스`;
}

export default function ManualCourseWizardPage() {
  const router = useRouter();
  const { createCourse } = useCreateCourse();
  const showToast = useToastStore((state) => state.show);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);

  const [loginOpen, setLoginOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [nights, setNights] = useState(0);
  const [days, setDays] = useState<Place[][]>([[]]);
  const [startIds, setStartIds] = useState<Record<number, string>>({});
  const [activeDay, setActiveDay] = useState(0);
  const [reviewDays, setReviewDays] = useState<Place[][]>([[]]);
  const [reviewDay, setReviewDay] = useState(0);
  const [courseName, setCourseName] = useState("");

  const handleChangeNights = (next: number) => {
    setNights(next);
    setDays((prev) => {
      const needed = next + 1;
      const result = [...prev];
      while (result.length < needed) result.push([]);
      while (result.length > needed) {
        const removed = result.pop();
        if (removed?.length) result[result.length - 1] = [...result[result.length - 1], ...removed];
      }
      return result;
    });
    setActiveDay((prev) => Math.min(prev, next));
  };

  const handleApplyPicked = (dayIndex: number, places: Place[]) => {
    setDays((prev) => prev.map((day, index) => (index === dayIndex ? places : day)));
    setStartIds((prev) => {
      if (prev[dayIndex] && places.some((place) => place.id === prev[dayIndex])) return prev;
      const { [dayIndex]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const handleRemove = (dayIndex: number, placeId: string) => {
    setDays((prev) =>
      prev.map((day, index) => (index === dayIndex ? day.filter((place) => place.id !== placeId) : day))
    );
    setStartIds((prev) => {
      if (prev[dayIndex] !== placeId) return prev;
      const { [dayIndex]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const handleGoReview = () => {
    const computed = days.map((day, index) => {
      const startId = startIds[index];
      const startIndex = startId ? day.findIndex((place) => place.id === startId) : 0;
      return nearestNeighborRoute(day, startIndex < 0 ? 0 : startIndex);
    });
    setReviewDays(computed);
    setReviewDay(0);
    setStep(2);
  };

  const handleReorderDay = (dayIndex: number, nextDay: Place[]) => {
    setReviewDays((prev) => {
      const next = [...prev];
      next[dayIndex] = nextDay;
      return next;
    });
  };

  const handleSave = () => {
    if (!isLoggedIn) {
      setLoginOpen(true);
      return;
    }
    saveCourse();
  };

  const saveCourse = () => {
    const flat = reviewDays.flat();
    if (flat.length < 1) {
      showToast("장소를 1곳 이상 담아주세요");
      return;
    }
    const label = courseName.trim() || defaultCourseName();
    createCourse({
      label,
      nights,
      transport: "자차",
      source: "manual",
      shared: false,
      days: reviewDays.map((day) => day.map(placeToStop)),
    });
    showToast("보관함에 저장했어요 🐾 날짜는 나중에!");
    router.push("/schedule");
  };

  return (
    <>
      <TopBar
        title={step === 0 ? "직접 짓기" : step === 1 ? "장소 담기" : "동선 확인"}
        showBack
        onBack={() => (step > 0 ? setStep(step - 1) : router.back())}
      />
      <CourseStepBar active={step} labels={MANUAL_STEP_LABELS} />

      {step === 0 ? <NightsStep nights={nights} onChangeNights={handleChangeNights} onNext={() => setStep(1)} /> : null}

      {step === 1 ? (
        <PlacesStep
          days={days}
          startIds={startIds}
          activeDay={activeDay}
          onSetActiveDay={setActiveDay}
          onSetStart={(dayIndex, placeId) => setStartIds((prev) => ({ ...prev, [dayIndex]: placeId }))}
          onRemove={handleRemove}
          onApplyPicked={handleApplyPicked}
          onNext={handleGoReview}
        />
      ) : null}

      {step === 2 ? (
        <ReviewStep
          days={reviewDays}
          activeDay={reviewDay}
          onSetActiveDay={setReviewDay}
          onReorderDay={handleReorderDay}
          name={courseName}
          onChangeName={setCourseName}
          defaultName={defaultCourseName()}
          onSave={handleSave}
        />
      ) : null}

      <PlacePickerSheet />
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} onLoggedIn={saveCourse} />
    </>
  );
}
