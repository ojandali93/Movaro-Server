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

// ✅ attach socket
import { attachSocket } from "./utils/socket.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

// Render often sits behind a proxy
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many requests, please try again later.",
});

const normalizeOrigin = (o) => (o || "").trim().replace(/\/+$/, "");

const allowedOrigins = (process.env.HTTP_ORIGIN || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // allow non-browser requests (like curl/postman) that have no Origin
      if (!origin) return callback(null, true);

      const normalized = normalizeOrigin(origin);

      if (allowedOrigins.includes(normalized)) {
        return callback(null, true);
      }

      // helpful for debugging
      console.log("🚫 Blocked by CORS:", {
        origin,
        normalized,
        allowedOrigins,
      });
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Make sure preflight requests are handled
app.options("*", cors());

// Middlewares
app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(compression());
app.use(limiter);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Routes
app.use("/notifications", NotificationRoutes);
app.use("/billing", billingRouter);
app.get("/health", (req, res) => res.send("✅ Movaro backend is running"));

// ✅ Socket.IO
const io = attachSocket(server);

// --- SERVER START ---
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

export { io }; // if you need to emit from REST handlers
