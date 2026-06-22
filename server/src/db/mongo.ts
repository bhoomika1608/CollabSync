/**
 * mongo.ts — Mongoose connection manager for CollabSync.
 *
 * WHY Mongoose instead of the native MongoDB driver?
 * ─────────────────────────────────────────────────────────────────
 * Mongoose adds:
 *   • Schema validation — catches malformed snapshots at write time, not read time.
 *   • Built-in connection pooling and automatic reconnect (critical in Docker where
 *     the MongoDB container might start slightly after the server).
 *   • Lean query API — `.lean()` returns plain JS objects, making it trivial to
 *     convert the stored Buffer back to Uint8Array without Mongoose Document overhead.
 *
 * WHY a module-level connection instead of per-request connection?
 * ─────────────────────────────────────────────────────────────────
 * MongoDB is a stateful TCP connection. Opening a new connection per operation
 * would add ~10-50 ms of TCP + auth handshake latency to every snapshot read/write.
 * A single persistent connection (managed by Mongoose's internal pool) amortises
 * that cost across all operations for the lifetime of the server process.
 */

import mongoose from 'mongoose';
import { config } from '../config';

/**
 * Establish a Mongoose connection to MongoDB.
 * Called once during server bootstrap (index.ts). Resolves when the connection
 * is ready; rejects if MongoDB is unreachable after the driver's retry window.
 *
 * WHY not await mongoose.connect() and let it handle retries?
 * Mongoose's default behaviour on connection failure is to emit 'error' and then
 * silently retry. By listening to lifecycle events we get log visibility into
 * connect/disconnect cycles — critical for diagnosing Docker startup ordering issues.
 */
export async function connectMongo(): Promise<void> {
  // Mongoose emits these events on the default connection object.
  // Register them BEFORE calling connect() so we don't miss events that fire
  // synchronously during the connection attempt.
  mongoose.connection.on('connected', () => {
    console.log(`[mongo] ✓ Connected to MongoDB at ${config.mongoUri}`);
  });

  mongoose.connection.on('disconnected', () => {
    // WHY log but not crash?
    // In Docker, a brief MongoDB restart (e.g. rolling update) will trigger
    // a disconnect. Mongoose automatically reconnects. Crashing the server
    // here would lose all in-memory Y.Doc state for active documents.
    console.warn('[mongo] Disconnected from MongoDB — Mongoose will auto-reconnect.');
  });

  mongoose.connection.on('error', (err: Error) => {
    console.error(`[mongo] Connection error: ${err.message}`);
  });

  await mongoose.connect(config.mongoUri, {
    // WHY serverSelectionTimeoutMS = 30000?
    // In Docker Compose, `depends_on: mongo: condition: service_healthy` ensures
    // the Mongo healthcheck passes before the server starts. But the healthcheck
    // uses mongosh which is a separate process — there can still be a few hundred
    // milliseconds before the TCP port accepts connections. 30 s is a generous
    // buffer that accommodates even slow CI environments.
    serverSelectionTimeoutMS: 30_000,

    // WHY socketTimeoutMS = 45000?
    // Snapshot writes are infrequent (every 30 s) but the document binary can be
    // large for heavily-edited files. 45 s ensures a slow write doesn't time out
    // mid-operation and produce a corrupted snapshot.
    socketTimeoutMS: 45_000,
  });
}

