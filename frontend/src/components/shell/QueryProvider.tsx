"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createQueryClient } from "@/lib/queryClient";

export function QueryProvider({ children }: { children: ReactNode }) {
  // useState 초기화 함수로 만들어야 리렌더마다 새 클라이언트(=빈 캐시)가 생기지 않는다.
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
