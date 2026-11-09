import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import placesRouter from "./routes/places";
import weatherRouter from "./routes/weather";
import petTourSpotsRouter from "./routes/petTourSpots";
import daejeonRouter from "./routes/daejeon";
import parksRouter from "./routes/parks";
import geocodeRouter from "./routes/geocode";
import kakaoPlacesRouter from "./routes/kakaoPlaces";
import petFacilitiesRouter from "./routes/petFacilities";
import verifiedPetRestaurantsRouter from "./routes/verifiedPetRestaurants";
import daejeonPlacesRouter from "./routes/daejeonPlaces";
import campgroundsRouter from "./routes/campgrounds";
import coursesRouter from "./routes/courses";
import aiRouter from "./routes/ai";
import authRouter from "./routes/auth";
import petsRouter from "./routes/pets";
import authKakaoRouter from "./routes/authKakao";
import postsRouter from "./routes/posts";
import reviewsRouter from "./routes/reviews";
import festivalsRouter from "./routes/festivals";
import { errorHandler } from "./lib/errorHandler";
import { createShutdown, drainingMiddleware, isDraining } from "./lib/shutdown";
import { prisma } from "./lib/prisma";

const app = express();
const PORT = process.env.PORT || 4000;

// credentials: 인증 쿠키를 주고받기 위해 필요(프론트가 rewrites로 프록시하지 않고 직접 호출하는 경우 대비)
// FRONTEND_ORIGIN 미설정 시(로컬 개발) localhost:3000을 허용한다.
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000", credentials: true }));
app.use(drainingMiddleware);
app.use(express.json());
app.use(cookieParser());

// 헬스체크
// 종료 정리 중에는 503 — 로드밸런서·모니터가 이 인스턴스를 트래픽에서 빼게(lib/shutdown.ts)
app.get("/api/health", (_req, res) =>
  isDraining() ? res.status(503).json({ ok: false, draining: true }) : res.json({ ok: true })
);

// 라우트
app.use("/api/places", placesRouter);
app.use("/api/weather", weatherRouter);
app.use("/api/pet-tour-spots", petTourSpotsRouter);
app.use("/api/daejeon", daejeonRouter);
app.use("/api/parks", parksRouter);
app.use("/api/geocode", geocodeRouter);
app.use("/api/kakao-places", kakaoPlacesRouter);
app.use("/api/pet-facilities", petFacilitiesRouter);
app.use("/api/verified-pet-restaurants", verifiedPetRestaurantsRouter);
app.use("/api/daejeon-places", daejeonPlacesRouter);
app.use("/api/campgrounds", campgroundsRouter);
app.use("/api/courses", coursesRouter);
app.use("/api/ai", aiRouter);
app.use("/api/auth", authRouter);
app.use("/api/auth/kakao", authKakaoRouter);
app.use("/api/pets", petsRouter);
app.use("/api/posts", postsRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/festivals", festivalsRouter);

// 라우터에서 넘어온 예외를 상태 코드로 변환한다(Prisma 경합 오류는 4xx, 나머지는 500).
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`🐾 대저니유 API listening on http://localhost:${PORT}`);
});

// 재배포(SIGTERM)·Ctrl+C(SIGINT) 때 진행 중 요청을 마치고 DB 연결을 닫는다 — lib/shutdown.ts
const shutdown = createShutdown(server, prisma);
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
