/**
 * index.ts — HTTP server entry point.
 *
 * Responsibility: wire together Express, Socket.io, the Redis adapter,
 * MongoDB connection, and graceful shutdown. Deliberately thin — business
 * logic lives in socket/handlers.ts and yjs/yjsRoom.ts.
 *
 * WHY separate the HTTP server creation from app logic?
 * ─────────────────────────────────────────────────────────────────
 * Socket.io requires access to the raw http.Server object (not the Express app)
 * to attach the WebSocket upgrade listener. Separating the two lets us:
 *   a) Test Express routes without starting a WebSocket server.
 *   b) Attach Socket.io to the same port as REST (no extra port to expose
 *      or proxy in Docker / nginx).
 */

import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { apiRouter } from './routes/api';
import { registerSocketHandlers } from './socket/handlers';
import { attachRedisAdapter, disconnectRedis } from './redisAdapter';
import { connectMongo } from './db/mongo';
import { closeAllRooms } from './yjs/yjsRoom';

// ─────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────

const app = express();

app.use(
  cors({
    // WHY restrict origin? The Socket.io server also enforces CORS; having
    // both layers in sync prevents a misconfigured frontend from accidentally
    // connecting to a production backend.
    origin: config.clientOrigin,
    credentials: true,
  }),
);
app.use(express.json());
app.use('/api', apiRouter);

// ─────────────────────────────────────────────────────────────
// HTTP server (shared with Socket.io)
// ─────────────────────────────────────────────────────────────

const httpServer = http.createServer(app);

// ─────────────────────────────────────────────────────────────
// Socket.io server
// ─────────────────────────────────────────────────────────────

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: config.clientOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },

  // WHY allow both transports?
  // Socket.io starts with long-polling and upgrades to WebSocket once the
  // server confirms upgrade support. This makes the initial connection faster
  // (polling round-trip < WebSocket handshake in some networks) and provides
  // a fallback for corporate firewalls that block WebSocket. The upgrade
  // happens transparently; client code doesn't need to change.
  transports: ['polling', 'websocket'],

  // Binary data: Yjs updates are Uint8Array / Buffer. Socket.io's binary
  // framing (using messagepack-style binary frames) handles these natively
  // without base64 conversion, keeping update payloads as small as possible.
  // WHY not force JSON? JSON would require base64-encoding every update,
  // adding ~33% overhead to every byte of CRDT data.
});

// Attach event handlers to every new socket connection.
io.on('connection', (socket) => {
  console.log(`[connection]  socket=${socket.id}  transport=${socket.conn.transport.name}`);
  registerSocketHandlers(io, socket);
});

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  // 1. MongoDB (Task C stub — no-op until Task C is implemented)
  await connectMongo();

  // 2. Redis adapter (Task B stub — no-op until Task B is implemented)
  //    WHY attach BEFORE starting to listen?
  //    If we start listening before the Redis adapter is wired, the first
  //    few connections would use local-only broadcasting. Attaching first
  //    ensures every emit goes through Redis from the very first client.
  await attachRedisAdapter(io);

  // 3. Start listening
  httpServer.listen(config.port, () => {
    console.log(
      `[server] CollabSync backend listening on port ${config.port} ` +
        `(env=${config.nodeEnv})`,
    );
  });
}

// ─────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────

/**
 * WHY graceful shutdown?
 * ─────────────────────────────────────────────────────────────────
 * Docker Compose sends SIGTERM before a SIGKILL (10 s later). In that window
 * we can:
 *   • Stop accepting new connections.
 *   • Let in-flight socket events finish.
 *   • Flush all Y.Doc snapshots to MongoDB.
 * Without this, a rolling deploy would lose up to `snapshotIntervalMs` of edits
 * for any document that hadn't been snapshotted yet.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] Received ${signal}, starting graceful shutdown…`);

  // Stop accepting new HTTP/WS connections.
  httpServer.close(() => console.log('[server] HTTP server closed.'));

  // Disconnect all sockets immediately so clients know to reconnect elsewhere.
  io.close();

  // Flush all in-memory Y.Doc state to MongoDB.
  await closeAllRooms();

  // Close Redis connections cleanly (no dangling SUBSCRIBE sockets).
  await disconnectRedis();

  console.log('[server] All rooms flushed. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
