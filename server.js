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

// ✅ NEW: socket.io
import { Server as SocketIOServer } from 'socket.io';

import NotificationRoutes from './routers/NotificationRoutes.js';
import billingRouter from './routers/BillingRoutes.js';
dotenv.config();

const app = express();
const server = http.createServer(app);

// ✅ NEW: Socket.IO attach
const io = new SocketIOServer(server, {
  // tighten CORS in production
  cors: {
    origin: process.env.SOCKET_ORIGIN?.split(',') || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
  transports: ['websocket'], // prefer ws; Socket.IO will fall back if needed
});

const PORT = process.env.PORT || 3000;

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
});

// Middlewares
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(compression());
app.use(limiter);
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Routes
app.use('/notifications', NotificationRoutes);
app.get('/health', (req, res) => res.send('✅ Marhaba backend is running'));
app.use('/billing', billingRouter);

// ✅ NEW: Socket.IO handlers
io.on('connection', (socket) => {
  console.log('🧲 socket connected', socket.id);

  // Managers subscribe to business / route rooms
  socket.on('join:biz', (bizId) => {
    if (!bizId) return;
    socket.join(`biz:${bizId}`);
    console.log(`👂 ${socket.id} joined biz:${bizId}`);
  });

  socket.on('join:route', (routeId) => {
    if (!routeId) return;
    socket.join(`route:${routeId}`);
    console.log(`👂 ${socket.id} joined route:${routeId}`);
  });

  // Drivers push their location
  // payload: { driverId, businessId?, routeId?, lat, lon, speed?, heading?, ts }
  socket.on('driver:location', async (p) => {
    try {
      if (!p || !p.driverId || typeof p.lat !== 'number' || typeof p.lon !== 'number') return;

      // Broadcast to business room (manager screens)
      if (p.businessId) {
        io.to(`biz:${p.businessId}`).emit('driver:location', p);
      }

      // Broadcast to route room (dispatcher per-route screens)
      if (p.routeId) {
        io.to(`route:${p.routeId}`).emit('driver:location', p);
      }

      // (Optional) persist last-known location in DB here
      // await upsertLastLocation(p.driverId, p.businessId ?? null, p.lat, p.lon, p.ts ?? Date.now());
    } catch (e) {
      console.error('driver:location error', e);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('❌ socket disconnected', socket.id, reason);
  });
});

// --- SERVER START ---
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔌 Socket.IO listening on path /socket.io`);
});
