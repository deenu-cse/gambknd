import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, type Namespace, type Socket } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createRedisConnection } from '../config/redis.js';
import { authenticateToken, type AuthContext } from '../middleware/auth.js';
import type { Realm } from '../modules/auth/session.model.js';
import { COOKIE_NAMES } from '../modules/auth/tokens.js';
import { isStaff } from '../modules/users/user.model.js';
import { getWalletSummary } from '../modules/wallet/wallet.service.js';
import { BUS_PREFIX, type BusChannel, type BusEvents } from './bus.js';

/** Public rooms clients may join on /live. Anything else is refused. */
const ROOM_PATTERN = /^(match|market):[a-f0-9]{24}$/;
const MAX_ROOMS_PER_SOCKET = 50;

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function authMiddleware(realm: Realm, staffOnly: boolean) {
  return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
    try {
      const auth = socket.handshake.auth as { token?: unknown } | undefined;
      const token = (typeof auth?.token === 'string' ? auth.token : null) ?? cookieValue(socket.handshake.headers.cookie, COOKIE_NAMES[realm].access);
      if (!token) return next(new Error('UNAUTHENTICATED'));
      const ctx = await authenticateToken(token, realm);
      if (staffOnly && !isStaff(ctx.role)) return next(new Error('FORBIDDEN'));
      (socket.data as { auth: AuthContext }).auth = ctx;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  };
}

function wireLive(nsp: Namespace): void {
  nsp.on('connection', (socket) => {
    socket.on('subscribe', (payload: unknown, ack?: (r: { ok: boolean; rooms?: string[]; error?: string }) => void) => {
      const rooms = (Array.isArray((payload as { rooms?: unknown })?.rooms) ? (payload as { rooms: unknown[] }).rooms : []).filter(
        (r): r is string => typeof r === 'string' && ROOM_PATTERN.test(r),
      );
      if (socket.rooms.size - 1 + rooms.length > MAX_ROOMS_PER_SOCKET) return ack?.({ ok: false, error: 'too many rooms' });
      void socket.join(rooms);
      ack?.({ ok: true, rooms });
    });
    socket.on('unsubscribe', (payload: unknown) => {
      const rooms = (payload as { rooms?: unknown })?.rooms;
      if (Array.isArray(rooms)) for (const r of rooms) if (typeof r === 'string') void socket.leave(r);
    });
  });
}

let io: Server | undefined;

export function getIo(): Server | undefined {
  return io;
}

/**
 * Bus → sockets. Every API process subscribes and emits to its OWN sockets only (`.local`),
 * so N processes never deliver an event N times. Redis adapter still syncs rooms for direct emits.
 */
async function bridgeBus(server: Server): Promise<() => Promise<void>> {
  const sub = createRedisConnection('bus-subscriber');
  await sub.psubscribe(`${BUS_PREFIX}*`);
  const live = server.of('/live');
  const user = server.of('/user');
  const admin = server.of('/admin');
  sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    void (async () => {
      const name = channel.slice(BUS_PREFIX.length) as BusChannel;
      switch (name) {
        case 'wallet.changed': {
          const p = JSON.parse(message) as BusEvents['wallet.changed'];
          const room = `user:${p.userId}`;
          if (!user.adapter.rooms.has(room)) return;
          user.local.to(room).emit('wallet:update', await getWalletSummary(p.userId));
          return;
        }
        case 'match.updated': {
          const p = JSON.parse(message) as BusEvents['match.updated'];
          live.local.to(`match:${p.matchId}`).emit('score:update', p.view);
          return;
        }
        case 'match.ball': {
          const p = JSON.parse(message) as BusEvents['match.ball'];
          live.local.to(`match:${p.matchId}`).emit('ball:event', p.ball);
          live.local.to(`match:${p.matchId}`).emit('commentary:new', p.ball);
          return;
        }
        case 'match.status': {
          const p = JSON.parse(message) as BusEvents['match.status'];
          live.local.to(`match:${p.matchId}`).emit('match:status', p);
          return;
        }
        case 'match.stale': {
          const p = JSON.parse(message) as BusEvents['match.stale'];
          live.local.to(`match:${p.matchId}`).emit('match:stale', p);
          return;
        }
        case 'market.updated': {
          const p = JSON.parse(message) as BusEvents['market.updated'];
          const rooms = [`match:${p.matchId}`, `market:${p.market.id}`];
          live.local.to(rooms).emit('market:update', p.market);
          if (p.kind === 'odds') {
            live.local.to(rooms).emit('odds:update', {
              marketId: p.market.id,
              version: p.market.version,
              selections: p.market.selections.map((s) => ({ id: s.id, odds: s.odds, status: s.status })),
            });
          }
          if (p.market.status === 'SUSPENDED') live.local.to(rooms).emit('market:suspended', { marketId: p.market.id, reason: p.market.suspendReason });
          return;
        }
        case 'bet.updated': {
          const p = JSON.parse(message) as BusEvents['bet.updated'];
          user.local.to(`user:${p.userId}`).emit('bet:update', p.bet);
          return;
        }
        case 'notification.new': {
          const p = JSON.parse(message) as BusEvents['notification.new'];
          user.local.to(`user:${p.userId}`).emit('notification:new', p.notification);
          return;
        }
        case 'admin.bet': {
          const p = JSON.parse(message) as BusEvents['admin.bet'];
          admin.local.to('admin').emit('admin:bet', p);
          return;
        }
        case 'admin.liability': {
          const p = JSON.parse(message) as BusEvents['admin.liability'];
          admin.local.to('admin').emit('admin:liability', p);
          return;
        }
        default:
          return;
      }
    })().catch((err: unknown) => logger.warn({ err, channel }, 'bus → socket relay failed'));
  });
  return async () => {
    await sub.quit();
  };
}

export async function attachSocketServer(http: HttpServer): Promise<{ io: Server; close: () => Promise<void> }> {
  const server = new Server(http, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    pingInterval: 10_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 64 * 1024,
    serveClient: false,
  });
  const pub = createRedisConnection('socket-pub');
  const sub = createRedisConnection('socket-sub');
  server.adapter(createAdapter(pub, sub));

  wireLive(server.of('/live'));
  const userNsp = server.of('/user');
  userNsp.use(authMiddleware('user', false));
  userNsp.on('connection', (socket) => void socket.join(`user:${(socket.data as { auth: AuthContext }).auth.userId}`));
  const adminNsp = server.of('/admin');
  adminNsp.use(authMiddleware('admin', true));
  adminNsp.on('connection', (socket) => void socket.join(['admin', `user:${(socket.data as { auth: AuthContext }).auth.userId}`]));

  const stopBridge = await bridgeBus(server);
  io = server;
  return {
    io: server,
    close: async () => {
      await stopBridge();
      await new Promise<void>((resolve) => void server.close(() => resolve()));
      io = undefined;
    },
  };
}
