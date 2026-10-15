"use client";

import { cn } from "@/lib/cn";

interface FeedPagerProps {
  /** 0부터 시작하는 현재 페이지 */
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}

/** 내 글 목록 페이지네이션. 한 페이지뿐이면 호출부에서 렌더하지 않는다. */
export function FeedPager({ page, totalPages, onChange }: FeedPagerProps) {
  return (
    <div className="mt-3.5 flex items-center justify-center gap-1.5">
      <PagerButton label="이전 페이지" disabled={page === 0} onClick={() => onChange(page - 1)}>
        ‹
      </PagerButton>

      {Array.from({ length: totalPages }, (_, index) => (
        <button
          key={index}
          type="button"
          onClick={() => onChange(index)}
          aria-current={index === page ? "page" : undefined}
          className={cn(
            "inline-flex h-6 min-w-6 items-center justify-center rounded-lg px-1.5 text-[11px] font-bold transition-colors",
            index === page ? "bg-brand text-white" : "bg-surface text-ink-muted"
          )}
        >
          {index + 1}
        </button>
      ))}

      <PagerButton
        label="다음 페이지"
        disabled={page === totalPages - 1}
        onClick={() => onChange(page + 1)}
      >
        ›
      </PagerButton>
    </div>
  );
}

interface PagerButtonProps {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}

function PagerButton({ label, disabled, onClick, children }: PagerButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 w-7 rounded-lg bg-surface text-base text-ink transition-opacity disabled:opacity-35"
    >
      {children}
    </button>
  );
}
