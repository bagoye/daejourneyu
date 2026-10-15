"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { LoginModal } from "@/components/my/LoginModal";
import { Emoji3D } from "@/components/ui/Emoji3D";
import { useToastStore } from "@/stores/useToastStore";
import { useCreateCourse } from "@/hooks/useCourses";
import { useAuthStore } from "@/stores/useAuthStore";
import { cn } from "@/lib/cn";
import { apiUrl } from "@/lib/api/authFetch";
import { mockPlaces } from "@/mocks";
import type { Course, CourseStop } from "@/types";

type CourseSuggestion = Omit<Course, "id">;

interface ChatMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  pending?: boolean;
  stops?: CourseStop[];
  course?: CourseSuggestion;
  action?: { label: string; href: string };
}

interface FaqItem {
  q: string;
  a: string;
  /** 정확히 같은 문장이 아니어도 이 키워드 중 하나라도 포함되면 같은 답으로 매칭한다(자유 입력 대응). */
  keywords: string[];
  actionLabel?: string;
  href?: string;
}

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "이 앱은 뭐 하는 곳이야?",
    a: "대전 5개 구의 반려동물 동반 여행지를 소개하고, 그걸 묶어 여행 코스로 만들어주는 앱이에요 🐾",
    keywords: ["뭐 하는", "뭐하는", "무슨 서비스", "무슨 앱", "서비스 설명", "앱 설명", "서비스 소개", "앱 소개", "설명해줘", "소개해줘", "뭐야"],
  },
  {
    q: "코스는 어떻게 만들어?",
    a: "내 여정 탭에서 MBTI 추천·AI 추천·직접 짓기 중 하나로 만들 수 있어요. 저장하면 보관함에 담겨요.",
    keywords: ["코스 어떻게", "코스는 어떻게", "코스 만들", "코스 짜"],
    actionLabel: "코스 만들러 가기",
    href: "/schedule",
  },
  {
    q: "MBTI가 뭐야?",
    a: "반려동물의 여행 성향을 진단하는 테스트예요. 결과에 따라 어울리는 코스 테마를 추천해드려요.",
    keywords: ["mbti가", "mbti는", "mbti 뭐", "엠비티아이"],
    actionLabel: "MBTI 검사하러 가기",
    href: "/schedule/course/new/mbti",
  },
];

const QUICK_PROMPTS = ["조용히 산책하기 좋은 곳", "당일치기 코스 추천해줘", "실내 카페 위주로", "소형견도 갈 수 있는 곳"];

const THINKING_PHRASES = ["킁킁 냄새 맡는 중...", "지도를 펼치는 중...", "발자국 따라가는 중...", "코스를 그리는 중..."];

/** "생각하는 중..." 고정 문구 대신 문구를 순환시키며 발바닥이 통통 튀는 로딩 인터랙션. */
function ThinkingIndicator() {
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setPhraseIndex((prev) => (prev + 1) % THINKING_PHRASES.length), 1100);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="inline-block animate-bounce" style={{ animationDelay: `${i * 0.15}s` }}>
            <Emoji3D emoji="🐾" size={16} />
          </span>
        ))}
      </div>
      <span className="text-xs text-ink-muted">{THINKING_PHRASES[phraseIndex]}</span>
    </div>
  );
}

function matchFaq(text: string): FaqItem | undefined {
  const normalized = text.replace(/\s/g, "");
  return FAQ_ITEMS.find(
    (item) => item.q === text || item.keywords.some((keyword) => normalized.includes(keyword.replace(/\s/g, "")))
  );
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function ChatbotPage() {
  const router = useRouter();
  const showToast = useToastStore((state) => state.show);
  const { createCourse } = useCreateCourse();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);

  const [loginOpen, setLoginOpen] = useState(false);
  const [pendingCourse, setPendingCourse] = useState<CourseSuggestion | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "greeting",
      role: "bot",
      text: "안녕하세요! 대저니유 안내입니다 🐾\n반려동물이랑 갈 곳을 추천해드리거나, 코스로 짜드릴게요. 아래에서 골라보거나 편하게 물어보세요!",
    },
  ]);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const appendMessage = (message: ChatMessage) => setMessages((prev) => [...prev, message]);

  const replacePending = (id: string, patch: Partial<ChatMessage>) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false, ...patch } : m)));

  const requestCourseSuggestion = async (prompt: string) => {
    const pendingId = makeId();
    appendMessage({ id: pendingId, role: "bot", text: "생각하는 중...", pending: true });

    // 응답이 너무 오래 걸리면(기본 fetch는 브라우저 기본 타임아웃까지 무한정 기다린다) 안내
    // 메시지로 대신 끊는다 — 사용자가 "생각하는 중..." 애니메이션만 하염없이 보는 걸 막는다.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(apiUrl("/api/ai/course-suggestion"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, nights: 0, transport: "자차", candidatePlaces: mockPlaces }),
        signal: controller.signal,
      });
      // 코스 추천 요청이어도 AI가 판단해서 잡담/설명이면 chat으로, 실제 코스 요청이면 course로 답한다
      // (백엔드 /api/ai/course-suggestion 참고) — 매번 코스를 억지로 지어내지 않게 하기 위함.
      const data:
        | { responseType: "chat"; message: string }
        | (CourseSuggestion & { responseType: "course" })
        | { error: string } = await res.json();
      if (!res.ok || "error" in data) {
        replacePending(pendingId, {
          text: "error" in data ? data.error : "답을 만들지 못했어요. 잠시 후 다시 시도해주세요",
        });
        return;
      }
      if (data.responseType === "chat") {
        replacePending(pendingId, { text: data.message });
        return;
      }
      const stops = data.days.flat();
      replacePending(pendingId, {
        text: `말씀하신 조건에 맞춰 골라봤어요 🐾\n"${data.label}"`,
        stops,
        course: data,
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      replacePending(pendingId, {
        text: timedOut
          ? "지금은 답변하기 어려워요. 잠시 후 다시 시도해주세요"
          : "답을 만들지 못했어요. 잠시 후 다시 시도해주세요",
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleSend = (presetText?: string) => {
    const text = (presetText ?? input).trim();
    if (!text) return;
    appendMessage({ id: makeId(), role: "user", text });
    setInput("");

    const faq = matchFaq(text);
    if (faq) {
      appendMessage({
        id: makeId(),
        role: "bot",
        text: faq.a,
        action: faq.href && faq.actionLabel ? { label: faq.actionLabel, href: faq.href } : undefined,
      });
      return;
    }

    requestCourseSuggestion(text);
  };

  const handleSaveCourse = (course: CourseSuggestion) => {
    if (!isLoggedIn) {
      setPendingCourse(course);
      setLoginOpen(true);
      return;
    }
    saveCourse(course);
  };

  const saveCourse = (course: CourseSuggestion) => {
    const saved = createCourse(course);
    showToast("코스를 보관함에 저장했어요 🐾");
    router.push(`/schedule/course/${saved.id}`);
  };

  return (
    <div className="flex flex-col" style={{ height: "calc(100dvh - 76px)" }}>
      <TopBar title="AI에게 물어보기" showBack />

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3">
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn("mb-3 flex items-end gap-1.5", message.role === "user" ? "justify-end" : "justify-start")}
          >
            {message.role === "bot" ? (
              <span className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-purple-light">
                <Emoji3D emoji="🤖" size={22} shadow={false} />
              </span>
            ) : null}
            <div
              className={cn(
                "max-w-[76%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                message.role === "user"
                  ? "bg-accent-purple text-white"
                  : "border border-line bg-card text-ink"
              )}
            >
              {message.pending ? (
                <ThinkingIndicator />
              ) : (
                <span className="whitespace-pre-line">{message.text}</span>
              )}

              {message.stops && message.stops.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  {message.stops.map((stop) => (
                    <button
                      key={stop.placeId}
                      type="button"
                      onClick={() => router.push(`/place/${encodeURIComponent(stop.name)}`)}
                      className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-bold text-ink">{stop.name}</div>
                        <div className="mt-0.5 truncate text-[10px] text-ink-muted">
                          {stop.district} · {stop.category}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs">
                        {stop.petFriendly ? <Emoji3D emoji="🐾" size={16} shadow={false} /> : "🚫"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              {message.course ? (
                <button
                  type="button"
                  onClick={() => handleSaveCourse(message.course!)}
                  className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand text-xs font-bold text-white"
                >
                  <Emoji3D emoji="🐾" size={16} shadow={false} />이 코스 저장하기
                </button>
              ) : null}

              {message.action ? (
                <button
                  type="button"
                  onClick={() => router.push(message.action!.href)}
                  className="mt-2 flex h-9 w-full items-center justify-center rounded-lg border border-brand-300 bg-brand-100 text-xs font-bold text-brand-700"
                >
                  {message.action.label} ›
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-line px-4 pb-3 pt-2.5">
        <div className="mb-1.5 text-[10px] font-bold text-ink-muted">💬 자주 묻는 질문</div>
        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
          {FAQ_ITEMS.map((item) => (
            <button
              key={item.q}
              type="button"
              onClick={() => handleSend(item.q)}
              className="shrink-0 rounded-full bg-brand-100 px-3 py-1.5 text-[11px] font-semibold text-brand-700"
            >
              {item.q}
            </button>
          ))}
        </div>
        <div className="mb-1.5 text-[10px] font-bold text-ink-muted">✨ 빠른 추천</div>
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => handleSend(q)}
              className="rounded-full bg-line px-3 py-1.5 text-[11px] font-semibold text-ink-muted"
            >
              {q}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSend();
            }}
            placeholder="예: 유성구에서 산책하기 좋은 곳 알려줘"
            className="flex-1 rounded-lg border border-line bg-card px-3.5 py-3 text-sm text-ink outline-none focus:border-brand"
          />
          <button
            type="button"
            onClick={() => handleSend()}
            className="shrink-0 rounded-lg bg-brand px-4 text-sm font-bold text-white"
          >
            전송
          </button>
        </div>
      </div>
      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onLoggedIn={() => {
          if (pendingCourse) saveCourse(pendingCourse);
        }}
      />
    </div>
  );
}
