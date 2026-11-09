/**
 * 값 기반(keyset) 커서. 마지막으로 받은 항목의 **정렬 키 값 자체**를 불투명 문자열로 담는다.
 *
 * Prisma의 `cursor: { id }`는 다음 페이지를 만들 때 커서 행을 다시 읽어 그 **현재** 값으로 경계를 잡는다.
 * 그래서 (1) 커서 행이 지워지면 경계를 잡을 수 없고, (2) 담긴순처럼 변하는 값으로 정렬하면 커서 행의 값이
 * 바뀌는 순간 경계가 통째로 이동해 이미 본 글이 다시 나오거나 건너뛰어진다(통합 테스트로 재현).
 * 값을 커서에 박아 두면 경계가 "그때 본 위치"로 고정된다.
 *
 * 형식: `v1.` + base64url(JSON 배열). 배열 원소는 정렬 키 순서대로의 string | number.
 */
const PREFIX = "v1.";

export type CursorValue = string | number;

export function encodeCursor(values: CursorValue[]): string {
  return PREFIX + Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

export class InvalidCursorError extends Error {
  constructor() {
    super("잘못된 커서");
  }
}

/**
 * `v1.` 커서면 값 배열, 아니면 null(예전 형식 = 글 id로 취급하라는 뜻).
 * `v1.`로 시작하는데 해석이 안 되거나 모양이 기대와 다르면 InvalidCursorError.
 */
export function decodeCursor(raw: string, shape: ("string" | "number")[]): CursorValue[] | null {
  if (!raw.startsWith(PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== shape.length ||
    !parsed.every((v, i) => typeof v === shape[i] && (typeof v !== "number" || Number.isFinite(v)))
  ) {
    throw new InvalidCursorError();
  }
  return parsed as CursorValue[];
}

/** ISO 문자열 → Date. 형식이 틀리면 InvalidCursorError. */
export function cursorDate(value: CursorValue): Date {
  const date = new Date(value);
  if (typeof value !== "string" || Number.isNaN(date.getTime())) throw new InvalidCursorError();
  return date;
}
