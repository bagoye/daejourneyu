"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { CourseStepBar } from "@/components/course/CourseStepBar";
import { IntroStep } from "./steps/IntroStep";
import { QuestionStep } from "./steps/QuestionStep";
import { ResultStep } from "./steps/ResultStep";
import { NightsStep } from "./steps/NightsStep";
import { GeneratedResultStep } from "./steps/GeneratedResultStep";
import { LoginModal } from "@/components/my/LoginModal";
import { MBTI_QUESTIONS, resolveMbtiType, scoreAnswers, topTheme, type CourseTheme, type MbtiAnswer } from "@/lib/mbti";
import { placeToStop } from "@/lib/courseFormat";
import { useCreateCourse } from "@/hooks/useCourses";
import { useToastStore } from "@/stores/useToastStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePetStore } from "@/stores/usePetStore";
import { usePickablePlaces } from "@/hooks/usePickablePlaces";
import { ensureCategoryMinimum, type PickablePlace } from "@/lib/petTourMapper";
import { mockPlaces } from "@/mocks";
import type { DaejeonDistrict, Place, PlaceCategory } from "@/types";

type Phase = "intro" | "quiz" | "result" | "nights" | "generated";

const GENERATE_STEP_LABELS = ["기간", "코스"] as const;
/** 직접짓기 위저드와 동일하게 이동수단 선택 단계를 없애고 자차로 고정한다. */
const DEFAULT_TRANSPORT = "자차" as const;
const MIN_PER_CATEGORY = 3;
const COURSE_TITLES: Record<CourseTheme, string> = {
  산책: "청량 힐링 산책 데이",
  맛집: "댕댕이랑 빵지순례 데이",
  문화: "호기심 가득 문화 나들이",
};

const ALL_CATEGORIES: PlaceCategory[] = ["산책", "놀이터", "맛집", "문화"];
const ALL_DISTRICTS: DaejeonDistrict[] = ["유성구", "중구", "동구", "대덕구", "서구"];

type SourcePlace = Place | PickablePlace;

/** backend가 매긴 소스 신뢰도(1=식약처·관광공사 등 인증 소스, 2=공공데이터 미인증). mockPlaces처럼
 * 신뢰도 정보가 없는 폴백 데이터는 미인증과 동급(2)으로 취급한다. */
function getSourceTier(place: SourcePlace): number {
  return "sourceTier" in place && typeof place.sourceTier === "number" ? place.sourceTier : 2;
}

const byQuality = (a: SourcePlace, b: SourcePlace) =>
  getSourceTier(a) - getSourceTier(b) || Number(b.petFriendly) - Number(a.petFriendly) || a.name.localeCompare(b.name);

/**
 * 후보군(pool)에서 테마 카테고리를 2번 뽑을 때 다른 카테고리를 1번씩 라운드로빈으로 섞어
 * count개를 채운다 — 테마 색은 유지하되 한 카테고리로 도배되지 않게 한다. 카테고리 안에서는
 * 신뢰도 높은(정제된) 소스를 우선한다.
 */
function pickBalancedByCategory(theme: CourseTheme, pool: SourcePlace[], count: number): SourcePlace[] {
  const buckets = new Map<PlaceCategory, SourcePlace[]>(
    ALL_CATEGORIES.map((category) => [category, pool.filter((place) => place.category === category).sort(byQuality)])
  );
  const otherCategories = ALL_CATEGORIES.filter((category) => category !== theme);

  const result: SourcePlace[] = [];
  let otherIndex = 0;
  while (result.length < count) {
    const before = result.length;

    const themeBucket = buckets.get(theme)!;
    for (let i = 0; i < 2 && result.length < count; i++) {
      const place = themeBucket.shift();
      if (place) result.push(place);
    }

    if (result.length < count) {
      for (let tries = 0; tries < otherCategories.length; tries++) {
        const bucket = buckets.get(otherCategories[otherIndex % otherCategories.length])!;
        otherIndex++;
        const place = bucket.shift();
        if (place) {
          result.push(place);
          break;
        }
      }
    }

    if (result.length === before) break; // 후보군 소진 — 더 뽑을 게 없음
  }
  return result;
}

/**
 * 여행인데 밥 먹을 곳이 하루에 하나도 없으면 안 되니, 테마가 맛집이 아닌 날은 신뢰도 높은
 * 맛집(식약처 인증 등 sourceTier 1 우선)을 한 곳 무조건 먼저 담고 시작한다.
 */
function pickGuaranteedRestaurant(pool: SourcePlace[]): SourcePlace | null {
  const restaurants = pool.filter((place) => place.category === "맛집").sort(byQuality);
  return restaurants[0] ?? null;
}

/**
 * 대전 여행이니만큼 하루는 한 자치구 위주로 묶어서(그래야 실제로 다닐 수 있는 동선이 된다),
 * 여러 날이면 서로 다른 구를 하루씩 배정해 대전 여러 지역을 골고루 둘러보게 한다. 구를 정할
 * 땐 그 구 안에 테마 카테고리 장소가 많은 순으로 우선순위를 매긴다. 각 날은 맛집을 하나
 * 보장하고, 나머지는 `pickBalancedByCategory`로 테마 카테고리를 중심으로 다른 카테고리도
 * 섞는다. 배정된 구에 장소(특히 맛집)가 모자라면 이미 쓰지 않은 다른 구의 장소로 채운다.
 */
function generateCourseDays(theme: CourseTheme, nights: number, source: SourcePlace[]): SourcePlace[][] {
  const daysCount = nights + 1;
  const perDay = daysCount === 1 ? 3 : 2;

  const districtRichness = ALL_DISTRICTS.map((district) => ({
    district,
    themeCount: source.filter((place) => place.district === district && place.category === theme).length,
    totalCount: source.filter((place) => place.district === district).length,
  })).sort((a, b) => b.themeCount - a.themeCount || b.totalCount - a.totalCount);

  const assignedDistricts = Array.from(
    { length: daysCount },
    (_, i) => districtRichness[i % districtRichness.length].district
  );

  const usedIds = new Set<string>();
  return assignedDistricts.map((district) => {
    const districtPool = () => source.filter((place) => place.district === district && !usedIds.has(place.id));
    const remainingPool = () => source.filter((place) => !usedIds.has(place.id));

    const picked: SourcePlace[] = [];

    if (theme !== "맛집") {
      const restaurant = pickGuaranteedRestaurant(districtPool()) ?? pickGuaranteedRestaurant(remainingPool());
      if (restaurant) {
        picked.push(restaurant);
        usedIds.add(restaurant.id);
      }
    }

    const rest = pickBalancedByCategory(theme, districtPool(), perDay - picked.length);
    picked.push(...rest);
    rest.forEach((place) => usedIds.add(place.id));

    if (picked.length < perDay) {
      const fallback = pickBalancedByCategory(theme, remainingPool(), perDay - picked.length);
      picked.push(...fallback);
      fallback.forEach((place) => usedIds.add(place.id));
    }

    return picked;
  });
}

export default function MbtiCourseWizardPage() {
  return (
    <Suspense fallback={null}>
      <MbtiCourseWizard />
    </Suspense>
  );
}

function MbtiCourseWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { createCourse } = useCreateCourse();
  const showToast = useToastStore((state) => state.show);
  const { data: apiPlaces } = usePickablePlaces();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const activePet = usePetStore((state) => state.activePet());
  const saveMbti = usePetStore((state) => state.saveMbti);
  // 검사 결과는 반려동물에 저장된다 — 다시 들어와도(새로고침해도) 그대로 남아 있어야 한다.
  const savedMbtiCode = activePet?.mbti?.code ?? null;

  // 로그인 상태에서 저장된 MBTI 결과가 있고, "MBTI 맞춤 코스" 타일에서 바로가기로 들어온 경우엔
  // 인트로/퀴즈 단계를 건너뛰고 바로 저장된 결과 화면부터 보여준다. 거기서 "이 성향으로 코스
  // 만들기"를 눌러야 코스 생성(기간→이동→코스)으로 넘어간다.
  // 로그인 안 했거나 저장된 결과가 없으면(=quick이어도) 평소와 똑같이 인트로부터 시작한다.
  const quickStart = searchParams.get("quick") === "1" && isLoggedIn && !!savedMbtiCode;

  const [phase, setPhase] = useState<Phase>(quickStart ? "result" : "intro");
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [answers, setAnswers] = useState<MbtiAnswer[]>(() => Array(MBTI_QUESTIONS.length).fill(null));
  const [mbtiCode, setMbtiCode] = useState(quickStart ? savedMbtiCode! : "");
  const [theme, setTheme] = useState<CourseTheme>("산책");
  const [nights, setNights] = useState(0);
  const [generatedDays, setGeneratedDays] = useState<Place[][]>([]);
  const [loginOpen, setLoginOpen] = useState(false);

  const startQuiz = () => {
    setAnswers(Array(MBTI_QUESTIONS.length).fill(null));
    setCurrentQuestion(0);
    setPhase("quiz");
  };

  const advanceQuestion = (answer: MbtiAnswer) => {
    const next = [...answers];
    next[currentQuestion] = answer;
    setAnswers(next);
    if (currentQuestion + 1 >= MBTI_QUESTIONS.length) {
      const code = scoreAnswers(next);
      setMbtiCode(code);
      void persistMbti(code);
      setPhase("result");
    } else {
      setCurrentQuestion((prev) => prev + 1);
    }
  };

  /**
   * 검사 결과를 활성 반려동물에 저장한다.
   * 로그인 전이거나 등록된 반려동물이 없으면 저장할 대상이 없으므로 화면 흐름만 이어간다 —
   * 이 경우 결과는 이번 코스 만들기에만 쓰이고 남지 않는다.
   */
  const persistMbti = async (code: string) => {
    if (!isLoggedIn || !activePet) return;

    const type = resolveMbtiType(code);
    const result = await saveMbti(activePet.id, {
      code: type.code,
      name: type.name,
      theme: topTheme(type),
      traits: type.traits,
    });
    if (!result.ok) showToast(result.message ?? "여행 유형을 저장하지 못했어요");
  };

  const goNightsFrom = (chosenTheme: CourseTheme) => {
    setTheme(chosenTheme);
    setNights(0);
    setPhase("nights");
  };

  const handleGenerate = () => {
    const source = ensureCategoryMinimum(apiPlaces ?? [], mockPlaces, MIN_PER_CATEGORY);
    setGeneratedDays(generateCourseDays(theme, nights, source));
    setPhase("generated");
  };

  const handleReorderDay = (dayIndex: number, nextDay: Place[]) => {
    setGeneratedDays((prev) => {
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
    const flat = generatedDays.flat();
    if (flat.length < 2) {
      showToast("추천할 장소가 부족해요");
      return;
    }
    createCourse({
      label: COURSE_TITLES[theme],
      nights,
      transport: DEFAULT_TRANSPORT,
      source: "ai",
      shared: false,
      days: generatedDays.map((day) => day.map(placeToStop)),
    });
    showToast("보관함에 저장했어요 🐾 날짜는 나중에!");
    router.push("/schedule");
  };

  const stepBarActive = ["nights", "generated"].indexOf(phase);

  const titleByPhase: Record<Phase, string> = {
    intro: "반려동물 여행 MBTI",
    quiz: "반려동물 여행 MBTI",
    result: "테스트 결과",
    nights: `${theme}형 코스`,
    generated: `${theme}형 코스`,
  };

  const handleBack = () => {
    switch (phase) {
      // 퀴즈 문항 하나씩 되돌아가는 건 QuestionStep 안의 "‹ 이전 질문" 버튼이 따로 맡고 있다 —
      // 상단 뒤로가기는 검사 도중에도 언제든 내 여정 탭으로 바로 나갈 수 있어야 해서 기본
      // 동작(default: router.back())으로 흘려보낸다.
      case "result":
        setPhase("intro");
        return;
      case "nights":
        setPhase("result");
        return;
      case "generated":
        setPhase("nights");
        return;
      default:
        router.back();
    }
  };

  return (
    <>
      <TopBar title={titleByPhase[phase]} showBack onBack={handleBack} />
      {stepBarActive >= 0 ? <CourseStepBar active={stepBarActive} labels={GENERATE_STEP_LABELS} /> : null}

      {phase === "intro" ? <IntroStep onStart={startQuiz} /> : null}

      {phase === "quiz" ? (
        <QuestionStep
          key={currentQuestion}
          question={MBTI_QUESTIONS[currentQuestion]}
          index={currentQuestion}
          total={MBTI_QUESTIONS.length}
          selected={answers[currentQuestion]}
          onSelect={advanceQuestion}
          onBack={() => setCurrentQuestion((prev) => Math.max(0, prev - 1))}
          onSkip={() => advanceQuestion(null)}
          canGoBack={currentQuestion > 0}
        />
      ) : null}

      {phase === "result" ? (
        <ResultStep code={mbtiCode} onContinue={(chosenTheme) => goNightsFrom(chosenTheme)} onRetake={startQuiz} />
      ) : null}

      {phase === "nights" ? (
        <NightsStep theme={theme} nights={nights} onChangeNights={setNights} onNext={handleGenerate} />
      ) : null}

      {phase === "generated" ? (
        <GeneratedResultStep
          theme={theme}
          nights={nights}
          transport={DEFAULT_TRANSPORT}
          days={generatedDays}
          courseTitle={COURSE_TITLES[theme]}
          onReorderDay={handleReorderDay}
          onSave={handleSave}
          onGoHome={() => router.push("/home")}
        />
      ) : null}
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} onLoggedIn={saveCourse} />
    </>
  );
}
