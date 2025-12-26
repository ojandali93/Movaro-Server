/* eslint-disable quotes */
import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import bodyParser from "body-parser";
import rateLimit from "express-rate-limit";
import compression from "compression";
import http from "http";

import NotificationRoutes from "./routers/NotificationRoutes.js";
import billingRouter from "./routers/BillingRoutes.js";
import usersRouter from "./routers/UsersRoutes.js"; // ✅ ensure this exists
import { attachSocket } from "./utils/socket.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later.",
});

// ---- CORS ----
const normalizeOrigin = (o) => (o || "").trim().replace(/\/+$/, "");

const allowedOrigins = new Set(
  [
    "https://movaro-server.onrender.com",
    "https://server-hmr6.onrender.com",
    "https://web-dev-vtpq.onrender.com",
    "http://localhost:5173",
    "http://localhost:19006",
    "http://localhost:8081",
  ].map(normalizeOrigin)
);

const corsOptions = {
  origin: (origin, callback) => {
    // allow server-to-server / Postman
    if (!origin) return callback(null, true);

    const normalized = normalizeOrigin(origin);

    if (allowedOrigins.has(normalized)) return callback(null, true);

    console.log("🚫 Blocked by CORS:", { origin, normalized });
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

// ✅ CORS first + preflight
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// (optional but extremely useful while debugging)
app.use((req, _res, next) => {
  if (req.method === "OPTIONS") {
    console.log("✅ Preflight:", req.path, "Origin:", req.headers.origin);
  }
  next();
});

// ---- Middlewares ----
app.use(helmet());
app.use(morgan("dev"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(compression());
app.use(limiter);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ---- Routes ----
app.use("/users", usersRouter); // ✅ REQUIRED for /users/login
app.use("/notifications", NotificationRoutes);
app.use("/billing", billingRouter);

app.get("/health", (req, res) => res.send("✅ Movaro backend is running"));

attachSocket(server);

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log("✅ Allowed CORS origins:", Array.from(allowedOrigins));
});
