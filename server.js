/* eslint-disable quotes */
// server.js
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
// ✅ If you have this router, mount it (since your frontend hits /users/login)
// import usersRouter from "./routers/UsersRoutes.js";

import { attachSocket } from "./utils/socket.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

// Render often sits behind a proxy (needed for rate-limit + correct IP)
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

// -------------------------
// Rate limiter
// -------------------------
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later.",
});

// -------------------------
// CORS (explicit allowlist)
// -------------------------
const normalizeOrigin = (o) => (o || "").trim().replace(/\/+$/, "");

// ✅ Explicit allowlist (no trailing slashes)
const allowedOrigins = [
  "https://movaro-server.onrender.com",
  "https://server-hmr6.onrender.com", // ✅ include the actual backend URL throwing the error
  "https://web-dev-vtpq.onrender.com",
  "http://localhost:5173",
  "http://localhost:19006",
  "http://localhost:8081",
].map(normalizeOrigin);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server / curl / Postman (no Origin header)
    if (!origin) return callback(null, true);

    const normalized = normalizeOrigin(origin);

    if (allowedOrigins.includes(normalized)) {
      return callback(null, true);
    }

    console.log("🚫 Blocked by CORS:", {
      origin,
      normalized,
      allowedOrigins,
      path: "N/A",
    });

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

// ✅ CORS FIRST (before helmet, rate limit, and routes)
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// -------------------------
// Middlewares
// -------------------------
app.use(helmet());
app.use(morgan("dev"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(compression());
app.use(limiter);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// -------------------------
// Routes
// -------------------------
app.use("/notifications", NotificationRoutes);
app.use("/billing", billingRouter);
// app.use("/users", usersRouter);

app.get("/health", (req, res) => res.send("✅ Movaro backend is running"));

// -------------------------
// Socket.IO
// -------------------------
attachSocket(server);

// -------------------------
// Start server
// -------------------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log("✅ Allowed CORS origins:", allowedOrigins);
});
