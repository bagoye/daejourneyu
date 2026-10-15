import { useQuery } from "@tanstack/react-query";
import type { WeatherResponse } from "@/lib/weather";
import { apiUrl } from "@/lib/api/authFetch";
import { queryKeys } from "@/lib/queryKeys";

function getBrowserCoords(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null), // 권한 거부/실패 시 좌표 없이 진행 — 백엔드가 대전시청으로 대체한다
      { timeout: 5000, maximumAge: 10 * 60 * 1000 }
    );
  });
}

async function fetchWeather(): Promise<WeatherResponse> {
  const coords = await getBrowserCoords();
  const search = coords ? `?lat=${coords.lat}&lng=${coords.lng}` : "";
  const res = await fetch(apiUrl(`/api/weather${search}`));
  if (!res.ok) throw new Error("날씨 정보를 불러오지 못했어요");
  return (await res.json()) as WeatherResponse;
}

/**
 * 브라우저 위치 권한이 있고 대전 안이면 그 위치 기준, 아니면(권한 거부·대전 밖) 대전시청 기준으로
 * 날씨를 가져온다 — "대전 여부 판별/시청 대체"는 백엔드(`/api/weather`)가 처리한다.
 */
export function useWeather() {
  return useQuery({
    queryKey: queryKeys.weather.current,
    queryFn: fetchWeather,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
}
