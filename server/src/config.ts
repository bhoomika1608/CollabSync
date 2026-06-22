/**
 * config.ts — Centralised, validated environment configuration.
 *
 * WHY centralise config here instead of reading process.env inline?
 * ─────────────────────────────────────────────────────────────────
 * 1. Single source of truth: every module imports `config`, so a
 *    typo in an env-var name shows up in ONE place, not scattered
 *    across the codebase.
 * 2. Fail-fast validation: missing required vars crash at startup
 *    with a clear message, not silently mid-request.
 * 3. Typed defaults: TypeScript narrows the types (string | undefined
 *    becomes string) after validation, so callers never need to
 *    handle undefined.
 */

import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[config] Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and fill in the values.`,
    );
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const config = {
  // HTTP port this instance listens on.
  // In Docker Compose, server:1 gets 3001 and server:2 gets 3002
  // via the PORT env-var, both sitting behind nginx on 80.
  port: parseInt(optionalEnv('PORT', '3001'), 10),

  // Redis connection URL.
  // WHY ioredis instead of the built-in redis client?
  // ioredis has automatic reconnect with exponential back-off,
  // which is critical when containers start in parallel and Redis
  // may not be ready yet.
  redisUrl: optionalEnv('REDIS_URL', 'redis://localhost:6379'),

  // MongoDB connection string for snapshot persistence (Task C).
  mongoUri: optionalEnv(
    'MONGO_URI',
    'mongodb://localhost:27017/collabsync',
  ),

  // How often (ms) to flush in-memory Y.Doc state to MongoDB.
  // 30 s is a pragmatic balance: short enough that a crash loses at
  // most 30 s of work, long enough that MongoDB isn't hammered.
  snapshotIntervalMs: parseInt(
    optionalEnv('SNAPSHOT_INTERVAL_MS', '30000'),
    10,
  ),

  // CORS origin for the Vite dev server / production frontend.
  clientOrigin: optionalEnv('CLIENT_ORIGIN', 'http://localhost:5173'),

  nodeEnv: optionalEnv('NODE_ENV', 'development'),

  // WHY SKIP_REDIS?
  // Allows running the server locally without Docker / Redis installed.
  // Set SKIP_REDIS=true in .env for single-instance development.
  // In Docker Compose, this is always false (Redis is a declared dependency).
  skipRedis: process.env.SKIP_REDIS === 'true',

  // Human-readable label for log lines — helps distinguish server:1 from
  // server:2 in aggregated Docker logs. Defaults to the OS hostname
  // (which Docker sets to the container ID).
  instanceId: optionalEnv('INSTANCE_ID', require('os').hostname()),

  get isProduction() {
    return this.nodeEnv === 'production';
  },
} as const;
