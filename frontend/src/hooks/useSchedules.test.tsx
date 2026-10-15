import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateSchedule, useDeleteSchedule, useSchedules } from "@/hooks/useSchedules";
import { createScheduleApi, deleteScheduleApi, fetchSchedulesApi } from "@/lib/api/schedule";
import { useAuthStore } from "@/stores/useAuthStore";
import type { CourseSchedule } from "@/types";
import { makeSchedule } from "@/test/fixtures";
import { createQueryWrapper, createTestQueryClient } from "@/test/query";

vi.mock("@/lib/api/schedule", () => ({
  fetchSchedulesApi: vi.fn(),
  createScheduleApi: vi.fn(),
  deleteScheduleApi: vi.fn(),
}));

const KEY = ["schedules"];

function renderWithClient<T>(hook: () => T) {
  const client = createTestQueryClient();
  return { client, ...renderHook(hook, { wrapper: createQueryWrapper(client) }) };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cached = (client: ReturnType<typeof createTestQueryClient>) => client.getQueryData<CourseSchedule[]>(KEY);

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ isLoggedIn: true, hydrated: true });
});

describe("useSchedules", () => {
  it("로그인 상태면 일정 목록을 받는다", async () => {
    const schedules = [makeSchedule({ id: "s1" })];
    vi.mocked(fetchSchedulesApi).mockResolvedValue(schedules);

    const { result } = renderWithClient(() => useSchedules());

    await waitFor(() => expect(result.current.data).toEqual(schedules));
  });

  it("로그인 전에는 요청하지 않는다", () => {
    useAuthStore.setState({ isLoggedIn: false });

    renderWithClient(() => useSchedules());

    expect(fetchSchedulesApi).not.toHaveBeenCalled();
  });
});

describe("useCreateSchedule", () => {
  it("응답 전에 캘린더에 먼저 찍고, 성공하면 서버 일정으로 바꿔 끼운다", async () => {
    const request = deferred<CourseSchedule>();
    vi.mocked(createScheduleApi).mockReturnValue(request.promise);
    const { client, result } = renderWithClient(() => useCreateSchedule());
    client.setQueryData<CourseSchedule[]>(KEY, []);

    let saving: Promise<CourseSchedule> | undefined;
    act(() => {
      saving = result.current.mutateAsync({ courseId: "c1", date: "2026-10-20" });
    });

    await waitFor(() => expect(cached(client)).toHaveLength(1));
    expect(cached(client)?.[0]).toMatchObject({ courseId: "c1", date: "2026-10-20" });
    expect(cached(client)?.[0].id).toMatch(/^optimistic-schedule-/);

    await act(async () => {
      request.resolve(makeSchedule({ id: "server-1", courseId: "c1", date: "2026-10-20" }));
      await saving;
    });
    expect(cached(client)?.map((item) => item.id)).toEqual(["server-1"]);
  });

  it("실패하면 먼저 찍은 일정을 빼고, 에러는 호출부로 넘긴다", async () => {
    vi.mocked(createScheduleApi).mockRejectedValue(new Error("일정 등록에 실패했어요"));
    const { client, result } = renderWithClient(() => useCreateSchedule());
    client.setQueryData<CourseSchedule[]>(KEY, [makeSchedule({ id: "s1" })]);

    // 호출부(일정 추가 화면·캘린더)가 await 후 catch에서 실패 토스트를 띄우므로 에러가 새어 나와야 한다.
    await act(async () => {
      await expect(result.current.mutateAsync({ courseId: "c1", date: "2026-10-20" })).rejects.toThrow(
        "일정 등록에 실패했어요"
      );
    });

    expect(cached(client)?.map((item) => item.id)).toEqual(["s1"]);
  });
});

describe("useDeleteSchedule", () => {
  it("목록에서 바로 빼고, 성공하면 목록을 다시 받는다", async () => {
    vi.mocked(deleteScheduleApi).mockResolvedValue(undefined);
    const { client, result } = renderWithClient(() => useDeleteSchedule());
    client.setQueryData<CourseSchedule[]>(KEY, [makeSchedule({ id: "s1" }), makeSchedule({ id: "s2" })]);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await result.current.mutateAsync("s1");
    });

    expect(cached(client)?.map((item) => item.id)).toEqual(["s2"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("실패하면 원래 자리에 되살리고 에러를 넘긴다", async () => {
    const request = deferred<void>();
    vi.mocked(deleteScheduleApi).mockReturnValue(request.promise);
    const { client, result } = renderWithClient(() => useDeleteSchedule());
    client.setQueryData<CourseSchedule[]>(KEY, [
      makeSchedule({ id: "s1" }),
      makeSchedule({ id: "s2" }),
      makeSchedule({ id: "s3" }),
    ]);

    let removing: Promise<void> | undefined;
    act(() => {
      removing = result.current.mutateAsync("s2");
    });
    await waitFor(() => expect(cached(client)?.map((item) => item.id)).toEqual(["s1", "s3"]));

    await act(async () => {
      request.reject(new Error("일정 취소에 실패했어요"));
      await expect(removing).rejects.toThrow("일정 취소에 실패했어요");
    });

    expect(cached(client)?.map((item) => item.id)).toEqual(["s1", "s2", "s3"]);
  });
});
