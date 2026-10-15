import { describe, expect, it } from "vitest";
import { restoreAt } from "@/lib/optimistic";

const a = { id: "a" };
const b = { id: "b" };
const c = { id: "c" };

describe("restoreAt", () => {
  it("지웠던 위치에 다시 끼운다", () => {
    expect(restoreAt([a, c], b, 1)).toEqual([a, b, c]);
  });

  it("그 사이 목록이 줄었으면 맨 뒤에 붙인다", () => {
    expect(restoreAt([a], c, 2)).toEqual([a, c]);
  });

  it("이미 들어 있으면(그 사이 재조회됨) 그대로 둔다", () => {
    const list = [a, b];
    expect(restoreAt(list, b, 0)).toBe(list);
  });

  it("캐시가 없으면 만들지 않는다", () => {
    expect(restoreAt(undefined, a, 0)).toBeUndefined();
  });

  it("원본 배열을 바꾸지 않는다", () => {
    const list = [a, c];
    restoreAt(list, b, 1);
    expect(list).toEqual([a, c]);
  });
});
