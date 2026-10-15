import { QueryClient } from "@tanstack/react-query";

/**
 * 앱 전역 QueryClient 기본값. 훅마다 같은 값을 반복해서 덮어쓰던 걸 여기로 올렸다.
 *
 * - staleTime 30초: 기본값(0)이면 탭을 오갈 때마다 같은 목록을 다시 받는다. 이 앱의 데이터(코스·후기·
 *   게시물)는 초 단위로 바뀌지 않고, 내가 바꾼 건 mutation이 캐시를 직접 고치거나 무효화해서 바로
 *   반영되므로 시간 기반 재조회는 느슨해도 된다. 더 오래 둬도 되는 데이터(장소·날씨)는 훅에서 늘린다.
 * - retry 1: 기본값(3회, 지수 백오프)이면 로컬 DB가 꺼져 있을 때 에러 화면까지 7초 넘게 걸린다.
 *   한 번의 일시적 실패만 흡수한다.
 * - mutation은 재시도하지 않는다(기본값). 코스 저장 같은 POST가 두 번 나가면 중복 생성된다.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
      },
    },
  });
}
