import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCourses, useCreateCourse, useDeleteCourse, useUpdateCourse } from "@/hooks/useCourses";
import { createCourseApi, deleteCourseApi, fetchCourses, updateCourseApi } from "@/lib/api/courses";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCourseStore } from "@/stores/useCourseStore";
import { useToastStore } from "@/stores/useToastStore";
import type { Course } from "@/types";
import { makeCourse, makeSchedule } from "@/test/fixtures";
import { createQueryWrapper, createTestQueryClient } from "@/test/query";

vi.mock("@/lib/api/courses", () => ({
  fetchCourses: vi.fn(),
  createCourseApi: vi.fn(),
  updateCourseApi: vi.fn(),
  deleteCourseApi: vi.fn(),
}));

const KEY = ["courses"];

function renderWithClient<T>(hook: () => T) {
  const client = createTestQueryClient();
  return { client, ...renderHook(hook, { wrapper: createQueryWrapper(client) }) };
}

/** 응답 시점을 테스트가 직접 정하려고 쓰는 약속. resolve/reject를 부르기 전까지는 "요청 중"이다. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ids = (client: ReturnType<typeof createTestQueryClient>) =>
  client.getQueryData<Course[]>(KEY)?.map((course) => course.id);

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ isLoggedIn: true, hydrated: true });
  useCourseStore.setState({ schedules: [] });
  useToastStore.setState({ message: null, key: 0 });
});

describe("useCourses", () => {
  it("로그인 상태면 내 코스 목록을 받는다", async () => {
    const courses = [makeCourse({ id: "c1" })];
    vi.mocked(fetchCourses).mockResolvedValue(courses);

    const { result } = renderWithClient(() => useCourses());

    await waitFor(() => expect(result.current.data).toEqual(courses));
  });

  it("로그인 전에는 요청하지 않고 data도 undefined로 둔다", () => {
    useAuthStore.setState({ isLoggedIn: false });

    const { result } = renderWithClient(() => useCourses());

    expect(fetchCourses).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});

describe("useCreateCourse", () => {
  const input = { ...makeCourse(), id: undefined } as unknown as Omit<Course, "id">;

  it("응답 전에 임시 id로 목록에 넣고, 성공하면 서버 코스로 바꿔 끼운다", async () => {
    const request = deferred<Course>();
    vi.mocked(createCourseApi).mockReturnValue(request.promise);
    const { client, result } = renderWithClient(() => useCreateCourse());
    client.setQueryData<Course[]>(KEY, [makeCourse({ id: "c1" })]);

    let created: Course | undefined;
    act(() => {
      created = result.current.createCourse(input);
    });

    // 호출 즉시 임시 코스를 돌려줘서 화면이 응답을 기다리지 않고 넘어갈 수 있다.
    expect(created?.id).toMatch(/^optimistic-/);
    await waitFor(() => expect(ids(client)).toEqual(["c1", created?.id]));

    await act(async () => request.resolve(makeCourse({ id: "server-1" })));
    await waitFor(() => expect(ids(client)).toEqual(["c1", "server-1"]));
  });

  it("실패하면 임시 항목만 빼고 실패를 알린다", async () => {
    const request = deferred<Course>();
    vi.mocked(createCourseApi).mockReturnValue(request.promise);
    const { client, result } = renderWithClient(() => useCreateCourse());
    client.setQueryData<Course[]>(KEY, [makeCourse({ id: "c1" })]);

    act(() => {
      result.current.createCourse(input);
    });
    await waitFor(() => expect(ids(client)).toHaveLength(2));

    await act(async () => request.reject(new Error("코스 저장에 실패했어요")));

    await waitFor(() => expect(ids(client)).toEqual(["c1"]));
    expect(useToastStore.getState().message).toBe("코스 저장에 실패했어요. 잠시 후 다시 시도해주세요");
  });

  it("목록을 한 번도 안 받았으면 캐시를 새로 만들지 않는다", async () => {
    vi.mocked(createCourseApi).mockResolvedValue(makeCourse({ id: "server-1" }));
    const { client, result } = renderWithClient(() => useCreateCourse());

    act(() => {
      result.current.createCourse(input);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.getQueryData(KEY)).toBeUndefined();
  });

  it("동시에 두 개를 저장하면 마지막 응답 뒤에 한 번만 목록을 다시 받는다", async () => {
    const first = deferred<Course>();
    const second = deferred<Course>();
    vi.mocked(createCourseApi).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { client, result } = renderWithClient(() => useCreateCourse());
    client.setQueryData<Course[]>(KEY, []);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    act(() => {
      result.current.createCourse(input);
      result.current.createCourse(input);
    });
    await waitFor(() => expect(ids(client)).toHaveLength(2));

    await act(async () => first.resolve(makeCourse({ id: "server-1" })));
    // 첫 번째가 끝난 시점에 다시 받으면 두 번째의 임시 항목이 서버 목록에 덮여 사라진다.
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => second.resolve(makeCourse({ id: "server-2" })));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });
});

describe("useUpdateCourse", () => {
  it("저장 즉시 반영하고, 실패하면 그 코스만 편집 전으로 되돌린다", async () => {
    const request = deferred<Course>();
    vi.mocked(updateCourseApi).mockReturnValue(request.promise);
    const { client, result } = renderWithClient(() => useUpdateCourse());
    client.setQueryData<Course[]>(KEY, [makeCourse({ id: "c1", label: "원래 이름" }), makeCourse({ id: "c2" })]);

    act(() => {
      result.current.mutate({ courseId: "c1", patch: { label: "새 이름" } });
    });
    await waitFor(() => expect(client.getQueryData<Course[]>(KEY)?.[0].label).toBe("새 이름"));
    expect(updateCourseApi).toHaveBeenCalledWith("c1", { label: "새 이름" });

    await act(async () => request.reject(new Error("코스 수정에 실패했어요")));

    await waitFor(() => expect(client.getQueryData<Course[]>(KEY)?.[0].label).toBe("원래 이름"));
    expect(ids(client)).toEqual(["c1", "c2"]);
    expect(useToastStore.getState().message).toBe("코스 수정에 실패했어요. 잠시 후 다시 시도해주세요");
  });
});

describe("useDeleteCourse", () => {
  it("보관함과 그 코스의 일정에서 바로 빼고, 성공하면 목록을 다시 받는다", async () => {
    vi.mocked(deleteCourseApi).mockResolvedValue(undefined);
    useCourseStore.setState({
      schedules: [makeSchedule({ id: "s1", courseId: "c1" }), makeSchedule({ id: "s2", courseId: "c2" })],
    });
    const { client, result } = renderWithClient(() => useDeleteCourse());
    client.setQueryData<Course[]>(KEY, [makeCourse({ id: "c1" }), makeCourse({ id: "c2" })]);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    act(() => {
      result.current.mutate("c1");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(ids(client)).toEqual(["c2"]);
    expect(useCourseStore.getState().schedules.map((schedule) => schedule.id)).toEqual(["s2"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("실패하면 지운 코스를 원래 자리에 되살리고 일정은 서버에서 다시 받는다", async () => {
    vi.mocked(deleteCourseApi).mockRejectedValue(new Error("코스 삭제에 실패했어요"));
    const { client, result } = renderWithClient(() => useDeleteCourse());
    client.setQueryData<Course[]>(KEY, [makeCourse({ id: "c1" }), makeCourse({ id: "c2" }), makeCourse({ id: "c3" })]);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    act(() => {
      result.current.mutate("c2");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(ids(client)).toEqual(["c1", "c2", "c3"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["schedules"] });
    expect(useToastStore.getState().message).toBe("코스 삭제에 실패했어요. 잠시 후 다시 시도해주세요");
  });
});
