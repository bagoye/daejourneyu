import type express from "express";
import { Prisma } from "@prisma/client";

/**
 * 공통 에러 미들웨어. 라우터가 asyncHandler로 넘긴 예외를 상태 코드로 바꾼다 — 스택은 서버 로그에만 남긴다.
 *
 * Prisma 오류 중 "요청 사이의 경합"으로 생기는 것만 4xx로 내린다. 라우터가 사전에 존재·소유권을
 * 확인하더라도 확인과 실제 쓰기 사이에 다른 요청이 끼어들 수 있어서(TOCTOU), 그 경우까지 500으로
 * 뭉뚱그리면 클라이언트가 "서버 장애"와 "이미 바뀐 데이터"를 구분할 수 없다.
 */
export function errorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  // 응답을 이미 쓰기 시작했으면 Express 기본 처리기에 넘겨 연결을 정리하게 한다.
  if (res.headersSent) return next(err);

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      // 수정·삭제 대상 행이 그 사이 사라졌다
      case "P2025":
        return res.status(404).json({ error: "요청한 데이터를 찾을 수 없어요" });
      // 유니크 제약 위반 — 같은 요청이 동시에 두 번 들어온 경우가 대부분이다
      case "P2002":
        return res.status(409).json({ error: "이미 처리된 요청이에요. 새로고침 후 다시 확인해주세요" });
      // 참조 대상(FK)이 그 사이 사라졌다
      case "P2003":
        return res.status(409).json({ error: "연결된 데이터가 바뀌었어요. 새로고침 후 다시 시도해주세요" });
      // 쓰기 충돌·데드락으로 트랜잭션이 중단됐다 — 다시 시도하면 대부분 성공한다
      case "P2034":
        return res.status(409).json({ error: "다른 요청과 충돌했어요. 잠시 후 다시 시도해주세요" });
    }
  }

  // body-parser가 던지는 깨진 JSON(400)·본문 크기 초과(413) 같은 클라이언트 오류는 그 상태를 그대로 쓴다.
  const status = clientErrorStatus(err);
  if (status !== null) {
    return res.status(status).json({
      error: status === 413 ? "보낸 데이터가 너무 커요" : "요청 형식이 올바르지 않아요",
    });
  }

  console.error("[api] 처리 중 오류:", err);
  res.status(500).json({ error: "서버에서 문제가 발생했어요. 잠시 후 다시 시도해주세요" });
}

function clientErrorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  // http-errors 규약: expose가 true인 4xx만 클라이언트에 알려도 되는 오류다.
  if (typeof status === "number" && status >= 400 && status < 500 && expose === true) return status;
  return null;
}
