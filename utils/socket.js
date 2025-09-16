// src/utils/socket.js
import { Server as SocketIOServer } from 'socket.io';

/**
 * Attach a Socket.IO server to an existing HTTP server.
 * @param {import('http').Server} http
 */
export function attachSocket(http) {
  const allowed =
    (process.env.SOCKET_ORIGIN ? process.env.SOCKET_ORIGIN.split(',') : ['*'])
      .map(s => s.trim())
      .filter(Boolean);

  const io = new SocketIOServer(http, {
    cors: {
      origin: allowed,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    path: '/socket.io',
    transports: ['websocket'],
    pingInterval: 25000,
    pingTimeout: 60000,
  });

  io.on('connection', (socket) => {
    console.log('🧲 socket connected', socket.id);

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

    // payload: { driverId, businessId?, routeId?, lat, lon, speed?, heading?, ts }
    socket.on('driver:location', async (p) => {
      try {
        if (!p || !p.driverId || typeof p.lat !== 'number' || typeof p.lon !== 'number') {
          return;
        }

        if (p.businessId) {
          io.to(`biz:${p.businessId}`).emit('driver:location', p);
        }
        if (p.routeId) {
          io.to(`route:${p.routeId}`).emit('driver:location', p);
        }

        // Optionally persist last-known here
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
