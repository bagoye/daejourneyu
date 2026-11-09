import { describe, expect, it } from "vitest";
import { cursorDate, decodeCursor, encodeCursor, InvalidCursorError } from "./cursor";

describe("값 기반 커서", () => {
  it("인코딩한 값을 그대로 되돌린다(URL에 그대로 실을 수 있는 문자만 쓴다)", () => {
    const cursor = encodeCursor([7, "2026-08-12T09:00:00.000Z", "cm123"]);
    expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, ["number", "string", "string"])).toEqual([7, "2026-08-12T09:00:00.000Z", "cm123"]);
  });

  it("v1. 접두사가 없으면 예전 형식(id)이라는 뜻으로 null", () => {
    expect(decodeCursor("cm123", ["string", "string"])).toBeNull();
  });

  it("깨졌거나 모양이 다르면 InvalidCursorError", () => {
    expect(() => decodeCursor("v1.%%%", ["string"])).toThrow(InvalidCursorError);
    expect(() => decodeCursor(encodeCursor(["a"]), ["string", "string"])).toThrow(InvalidCursorError);
    expect(() => decodeCursor(encodeCursor(["7", "a"]), ["number", "string"])).toThrow(InvalidCursorError);
  });

  it("날짜 값이 날짜가 아니면 InvalidCursorError", () => {
    expect(cursorDate("2026-08-12T09:00:00.000Z").toISOString()).toBe("2026-08-12T09:00:00.000Z");
    expect(() => cursorDate("not-a-date")).toThrow(InvalidCursorError);
    expect(() => cursorDate(123)).toThrow(InvalidCursorError);
  });
});
