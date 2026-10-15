"use client";

interface LoadErrorStateProps {
  /** 무엇을 못 불러왔는지. 예: "후기를 불러오지 못했어요" */
  message: string;
  onRetry: () => void;
}

/**
 * 서버 목록을 처음부터 못 받았을 때의 안내. 실패를 "목록이 비어 있음"으로 보여주면 사용자는 정말
 * 데이터가 없다고 오해하므로, 빈 상태와 구분해 다시 시도할 수 있게 한다.
 * 이미 받은 목록이 있는 상태에서 재조회만 실패했다면 이걸 띄우지 말고 기존 목록을 그대로 둔다.
 */
export function LoadErrorState({ message, onRetry }: LoadErrorStateProps) {
  return (
    <div role="alert" className="py-10 text-center">
      <div className="text-xs text-ink-muted">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-lg border border-line bg-surface px-4 py-2 text-xs font-semibold text-ink"
      >
        다시 시도
      </button>
    </div>
  );
}
