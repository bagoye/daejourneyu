import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * 같은 도메인의 mutation이 모두 끝났을 때만 목록을 다시 받는다. mutation은 같은 queryKey를
 * mutationKey로 달아 둬야 한다.
 *
 * 저장 두 개가 동시에 진행 중일 때 먼저 끝난 쪽이 바로 재조회하면, 아직 응답 안 온 나머지의 낙관적
 * 항목이 서버 목록으로 덮여 잠깐 사라졌다가 다시 나타난다. onSettled 시점에는 자기 자신이 아직
 * 진행 중으로 세어지므로 "1개"가 곧 "나 하나만 남았다"는 뜻이다.
 */
export function invalidateWhenIdle(queryClient: QueryClient, queryKey: QueryKey) {
  if (queryClient.isMutating({ mutationKey: queryKey }) === 1) {
    return queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * 낙관적으로 지운 항목을 원래 위치에 되살린다. 그 사이 목록이 다시 받아져 이미 들어 있으면 그대로 둔다.
 * 스냅샷으로 목록 전체를 되돌리지 않는 이유: 그 사이 끝난 다른 변경까지 같이 지워진다.
 */
export function restoreAt<T extends { id: string }>(list: T[] | undefined, item: T, index: number): T[] | undefined {
  if (!list || list.some((entry) => entry.id === item.id)) return list;
  const next = [...list];
  next.splice(Math.min(index, next.length), 0, item);
  return next;
}
