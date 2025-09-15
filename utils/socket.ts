// socket.ts
import { Server } from 'socket.io';
import type { Server as HttpServer } from 'http';

type DriverLocation = {
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
  const io = new Server(http, {
    cors: { origin: '*' }, // tighten in prod
    path: '/socket.io',
    transports: ['websocket'],
  });

  io.on('connection', (socket) => {
    // Managers subscribe to rooms:
    socket.on('join:biz', (bizId: string) => {
      socket.join(`biz:${bizId}`);
    });

    socket.on('join:route', (routeId: string) => {
      socket.join(`route:${routeId}`);
    });

    // Drivers push their location:
    socket.on('driver:location', async (p: DriverLocation) => {
      // (Optional) validate p.driverId auth here

      // Broadcast to business room if provided
      if (p.businessId) {
        io.to(`biz:${p.businessId}`).emit('driver:location', p);
      }

      // Broadcast to route room if provided
      if (p.routeId) {
        io.to(`route:${p.routeId}`).emit('driver:location', p);
      }

      // (Optional) persist last-known
      // await upsertLastLocation(p.driverId, p.businessId, p.lat, p.lon, p.ts)

      // (Optional) sample trail every N seconds
    });

    socket.on('disconnect', () => {});
  });

  return io;
}
