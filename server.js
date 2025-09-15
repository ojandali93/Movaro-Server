// server.js
import express from 'express';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import http from 'http';

import NotificationRoutes from './routers/NotificationRoutes.js';
import billingRouter from './routers/BillingRoutes.js';

// ✅ attach socket
import { attachSocket } from './utils/socket.js';

dotenv.config();

const app = express();
const server = http.createServer(app);

// Render often sits behind a proxy
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
});

// Middlewares
app.use(helmet());
app.use(cors({
  origin: process.env.HTTP_ORIGIN?.split(',') || '*',
  credentials: true,
}));
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(compression());
app.use(limiter);
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Routes
app.use('/notifications', NotificationRoutes);
app.use('/billing', billingRouter);
app.get('/health', (req, res) => res.send('✅ Movaro backend is running'));

// ✅ Socket.IO
const io = attachSocket(server);

// --- SERVER START ---
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔌 Socket.IO listening on path /socket.io`);
});

export { io }; // if you need to emit from REST handlers
