/**
 * 같은 id가 여러 번 나오면 처음 것만 남긴다(순서 유지).
 *
 * 커서 페이지를 이어 붙인 목록에서 쓴다. 담긴순처럼 정렬 값이 바뀌는 목록은, 페이지를 받는 사이에
 * 어떤 글의 담긴 수가 줄면 그 글이 다음 페이지에 다시 실려 올 수 있다(서버 커서로는 막을 수 없는 한계 —
 * docs/db-optimization/02-transaction.md §6). 같은 key의 카드가 두 번 렌더되지 않게 여기서 걸러낸다.
 */
export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
