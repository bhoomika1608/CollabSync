/**
 * redisAdapter.ts — @socket.io/redis-adapter wiring for horizontal scaling.
 *
 * ═══════════════════════════════════════════════════════════════
 * HOW CROSS-INSTANCE BROADCAST WORKS
 * ═══════════════════════════════════════════════════════════════
 *
 * Without Redis, Socket.io's io.to(room).emit() only reaches clients
 * connected to THIS server process. With the Redis adapter:
 *
 *   server:1 (Client A)                server:2 (Client B)
 *   ─────────────────                  ─────────────────
 *   io.to(docId).emit('doc:update', …)
 *         │
 *         ├─ LOCAL: deliver to clients on server:1
 *         │
 *         └─ REDIS PUBLISH → channel "socket.io#/#<room>#"
 *                                       │
 *                                       └─ server:2 SUBSCRIBED to that channel
 *                                             │
 *                                             └─ re-emit to local clients → Client B ✓
 *
 * WHY publish the socket.io room name as the Redis channel key?
 *   The adapter namespaces channels by Socket.io room, so only instances
 *   that have at least one client in that room receive the message.
 *   A server with no clients in "doc-abc" never pays the deserialisation cost
 *   for updates to "doc-abc".
 *
 * ═══════════════════════════════════════════════════════════════
 * PUB/SUB vs REDIS STREAMS — why we chose Pub/Sub
 * ═══════════════════════════════════════════════════════════════
 *
 * Redis Streams offer durable, consumer-group–based delivery with
 * acknowledgements and replay. Pub/Sub is fire-and-forget. We chose
 * Pub/Sub deliberately:
 *
 *   1. Durability is NOT needed at this layer.
 *      Yjs is the source of truth. A client that missed a broadcast
 *      during a Redis outage will request a state-vector delta on
 *      reconnect (doc:sync-request) and recover without losing data.
 *      Adding Stream durability would mean two durable stores (Redis +
 *      MongoDB) for the same logical data — over-engineering.
 *
 *   2. Latency.
 *      Pub/Sub is single-hop (PUBLISH → all SUBSCRIBERs immediately).
 *      Streams require consumers to XREAD/XREADGROUP on a polling or
 *      blocking basis — adding at least one extra round-trip.
 *
 *   3. Operational simplicity.
 *      Pub/Sub has no consumer groups, no offsets, no trimming policy.
 *      The @socket.io/redis-adapter handles the subscription lifecycle.
 *
 * ═══════════════════════════════════════════════════════════════
 * WHAT HAPPENS WHEN REDIS IS TEMPORARILY UNAVAILABLE
 * ═══════════════════════════════════════════════════════════════
 *
 * The system degrades gracefully to single-instance mode:
 *
 *   Phase 1 — Outage detected (ioredis fires 'error' event)
 *     • ioredis logs the error and begins retry with exponential back-off.
 *     • The pubClient has enableOfflineQueue: false → PUBLISH commands
 *       fail immediately (not queued) so memory doesn't grow unbounded.
 *     • io.to(room).emit() still delivers to LOCAL clients; cross-instance
 *       delivery is silently dropped for the duration of the outage.
 *     • Clients on the same server instance continue to collaborate normally.
 *     • Clients on DIFFERENT instances diverge — their Y.Docs accumulate
 *       local updates that haven't been seen by the other instance.
 *
 *   Phase 2 — Redis reconnects (ioredis 'ready' event)
 *     • subClient automatically re-issues SUBSCRIBE commands (ioredis
 *       internal: re-subscription happens in the 'ready' callback).
 *     • The @socket.io/redis-adapter receives a 'reconnect' signal and
 *       reinitialises the subscription map.
 *     • NEW updates (post-reconnect) flow cross-instance again.
 *
 *   Phase 3 — Client reconciliation (the Yjs safety net)
 *     • Diverged Y.Docs still hold all their local edits in memory.
 *     • When any client sends its next Yjs update, the server applies
 *       it and re-broadcasts — other clients apply and converge.
 *     • Alternatively: if a client reconnects its WebSocket, it sends a
 *       doc:sync-request with its state vector, and the server responds
 *       with the full delta. This catches ALL missed updates regardless
 *       of how the outage manifested.
 *
 * NET RESULT: a Redis outage causes temporary cross-instance isolation,
 * not data loss. Yjs CRDTs guarantee that when updates do flow again,
 * all replicas converge to the correct merged state automatically.
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { type Redis as RedisClient } from 'ioredis';
import { Server } from 'socket.io';
import { config } from './config';

// Exported so index.ts can call disconnect() during graceful shutdown.
let pubClient: RedisClient | null = null;
let subClient: RedisClient | null = null;

export async function attachRedisAdapter(io: Server): Promise<void> {
  // ── Single-instance mode (no Redis) ───────────────────────
  if (config.skipRedis) {
    console.log(
      `[${config.instanceId}][redis-adapter] SKIP_REDIS=true — ` +
        'running single-instance mode (cross-instance broadcast disabled).',
    );
    return;
  }

  console.log(
    `[${config.instanceId}][redis-adapter] Connecting to ${config.redisUrl}…`,
  );

  pubClient = createRedisClient('pub');
  subClient = createRedisClient('sub');

  // ── Error listeners MUST be registered before connect ─────
  //
  // WHY before connect?
  // ioredis emits 'error' synchronously during the initial connection
  // attempt if the TCP dial fails. If no listener is attached yet,
  // Node.js treats it as an uncaught exception and crashes the process.
  attachErrorHandlers(pubClient, 'pub');
  attachErrorHandlers(subClient, 'sub');

  // ── Wait for initial connection ────────────────────────────
  //
  // WHY await both here (not inside createAdapter)?
  // createAdapter() starts emitting to Redis immediately when any
  // io.to().emit() fires. If we don't wait for 'ready', the first
  // few emits silently fail (pub's offline queue is disabled).
  // Awaiting here means the adapter is fully operational by the time
  // index.ts calls httpServer.listen() and starts accepting clients.
  await Promise.all([
    waitForReady(pubClient, 'pub'),
    waitForReady(subClient, 'sub'),
  ]);

  // ── Attach the adapter ─────────────────────────────────────
  //
  // After this line, every io.to(room).emit(event, data) call on this
  // instance publishes a serialised message to the Redis channel for
  // that room. All other instances subscribed to that channel receive
  // the message and re-emit it to their local sockets in that room.
  //
  // WHY does this work without sticky sessions?
  // The adapter makes EVERY instance a full relay: any instance can
  // receive any client's event and re-broadcast it everywhere. No single
  // instance is "authoritative" for a room from the network's perspective.
  io.adapter(createAdapter(pubClient, subClient));

  console.log(
    `[${config.instanceId}][redis-adapter] ✓ Attached — ` +
      'cross-instance broadcast enabled.',
  );
}

/**
 * Gracefully disconnect Redis clients during server shutdown.
 * Called from index.ts SIGTERM handler AFTER io.close() so no
 * further emits are attempted on the disconnecting clients.
 */
export async function disconnectRedis(): Promise<void> {
  if (pubClient) {
    await pubClient.quit().catch(() => pubClient?.disconnect());
    pubClient = null;
  }
  if (subClient) {
    await subClient.quit().catch(() => subClient?.disconnect());
    subClient = null;
  }
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

function createRedisClient(role: 'pub' | 'sub'): RedisClient {
  return new Redis(config.redisUrl, {
    // ── Retry strategy ──────────────────────────────────────
    //
    // WHY exponential back-off capped at 10 s?
    // During Docker startup, Redis might not be ready when the first
    // server instance boots. A short initial delay (200 ms) means we
    // detect Redis quickly in the happy path. The cap (10 s) prevents
    // runaway retry loops from hammering a failed Redis with tight loops.
    // Returning null from retryStrategy would stop retrying — we never
    // do that here because Redis is a required service in production.
    retryStrategy(times: number): number {
      const delay = Math.min(times * 200, 10_000);
      console.warn(
        `[${config.instanceId}][redis-${role}] ` +
          `Attempt ${times} — retrying in ${delay}ms…`,
      );
      return delay;
    },

    // ── Offline queue — different for pub vs sub ─────────────
    //
    // pubClient (enableOfflineQueue: false):
    //   PUBLISH commands fail immediately while Redis is disconnected.
    //   The adapter's internal try-catch absorbs the error, so the
    //   io.emit() call completes (delivering to local clients) and the
    //   cross-instance broadcast is silently dropped. This prevents the
    //   queue from growing unbounded during a prolonged Redis outage.
    //
    // subClient (enableOfflineQueue: true — the ioredis default):
    //   SUBSCRIBE / PSUBSCRIBE commands are queued while disconnected
    //   and replayed immediately on reconnect. This ensures the
    //   subscription map is always restored after a Redis restart,
    //   re-enabling cross-instance receives automatically.
    enableOfflineQueue: role === 'sub',

    // ── maxRetriesPerRequest ─────────────────────────────────
    //
    // pub: 0 — if a PUBLISH fails (Redis down), fail fast. The adapter
    //          will catch the error and the emit degrades to local-only.
    //          Retrying a stale PUBLISH after Redis comes back would
    //          replay old events to clients that may have already reconciled.
    //
    // sub: null — ioredis uses this for blocking commands internally.
    //             Setting it to any finite number would cause subscriptions
    //             to stop retrying after a connection failure.
    maxRetriesPerRequest: role === 'pub' ? 0 : null,

    // Give ioredis 15 s to establish the initial TCP connection before
    // deciding the host is unreachable. In Docker, this covers slow
    // container startup times.
    connectTimeout: 15_000,
  });
}

function attachErrorHandlers(client: RedisClient, role: string): void {
  client.on('error', (err: Error) => {
    // Log but do not throw — ioredis will retry automatically.
    // Throwing here would crash the process, which we explicitly want
    // to avoid. Degraded single-instance mode is far better than a crash.
    console.error(
      `[${config.instanceId}][redis-${role}] Error: ${err.message}`,
    );
  });

  client.on('reconnecting', () => {
    console.warn(
      `[${config.instanceId}][redis-${role}] Reconnecting to Redis…`,
    );
  });

  client.on('ready', () => {
    console.log(
      `[${config.instanceId}][redis-${role}] ✓ Connection ready.`,
    );
  });
}

/**
 * Wait for the 'ready' event, which fires after ioredis successfully
 * connects AND authenticates. 'connect' fires earlier (TCP established)
 * but before AUTH completes — using 'ready' avoids sending commands
 * before the server is prepared to accept them.
 */
function waitForReady(client: RedisClient, role: string): Promise<void> {
  // Already connected (e.g., called twice accidentally).
  if (client.status === 'ready') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    // Timeout: if Redis is genuinely unreachable (wrong URL, firewall),
    // we fail the bootstrap rather than hanging forever. 30 s covers
    // the typical Docker service startup window; a container that hasn't
    // started Redis in 30 s has a deeper problem.
    const timer = setTimeout(() => {
      reject(
        new Error(
          `[redis-${role}] Did not become ready within 30 s. ` +
            'Check REDIS_URL and that the Redis service is healthy.',
        ),
      );
    }, 30_000);

    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });

    // If a fatal error fires before 'ready' (e.g., WRONGPASS auth error),
    // reject immediately — no point retrying an auth failure.
    client.once('error', (err: Error) => {
      if (err.message.includes('WRONGPASS') || err.message.includes('NOAUTH')) {
        clearTimeout(timer);
        reject(err);
      }
      // For other errors (TCP refused), retryStrategy handles the retry.
      // Do NOT reject here — 'ready' will still fire after a successful retry.
    });
  });
}
