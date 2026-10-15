"use client";

import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { useToastStore } from "@/stores/useToastStore";

const AUTO_HIDE_MS = 2200;

export function ToastViewport() {
  const { message, key, hide } = useToastStore();

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(hide, AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [key, message, hide]);

  return (
    // 스크린리더가 토스트 문구를 읽어 주도록 라이브 영역으로 둔다(포커스는 옮기지 않는다).
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed left-1/2 z-[200] max-w-[85%] -translate-x-1/2 whitespace-pre-line rounded-full bg-ink px-4 py-2.5 text-center text-xs text-white shadow-lg transition-all",
        "bottom-[calc(72px+env(safe-area-inset-bottom))]",
        message ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      )}
    >
      {message}
    </div>
  );
}
