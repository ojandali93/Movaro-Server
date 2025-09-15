// socket.ts
import { Server } from 'socket.io';
import type { Server as HttpServer } from 'http';

export type DriverLocation = {
  driverId: string;
  businessId?: string | null;
  routeId?: string | null;
  lat: number;
  lon: number;
  speed?: number | null;
  heading?: number | null;
  ts: number; // ms
};

export function attachSocket(http: HttpServer) {
  const allowedOrigins =
    process.env.SOCKET_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean) || ['*'];

  const io = new Server(http, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    path: '/socket.io',
    transports: ['websocket'],       // prefer ws on Render
    // Render can sleep free instances; be resilient to reconnects:
    pingInterval: 25000,
    pingTimeout: 60000,
  });

  // (Optional) auth middleware — add JWT validation here if desired
  // io.use((socket, next) => { /* verify token */ next(); });

  io.on('connection', (socket) => {
    console.log('🧲 socket connected', socket.id);

    socket.on('join:biz', (bizId: string) => {
      if (!bizId) return;
      socket.join(`biz:${bizId}`);
      console.log(`👂 ${socket.id} joined biz:${bizId}`);
    });

    socket.on('join:route', (routeId: string) => {
      if (!routeId) return;
      socket.join(`route:${routeId}`);
      console.log(`👂 ${socket.id} joined route:${routeId}`);
    });

    socket.on('driver:location', async (p: DriverLocation) => {
      try {
        if (
          !p ||
          !p.driverId ||
          typeof p.lat !== 'number' ||
          typeof p.lon !== 'number'
        ) return;

        // Broadcast to business room
        if (p.businessId) {
          io.to(`biz:${p.businessId}`).emit('driver:location', p);
        }

        // Broadcast to route room
        if (p.routeId) {
          io.to(`route:${p.routeId}`).emit('driver:location', p);
        }

        // (Optional) persist last known / trail here
        // await upsertLastLocation(p.driverId, p.businessId ?? null, p.lat, p.lon, p.ts ?? Date.now());
      } catch (e) {
        console.error('driver:location error', e);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('❌ socket disconnected', socket.id, reason);
    });
  });

  return io;
}
