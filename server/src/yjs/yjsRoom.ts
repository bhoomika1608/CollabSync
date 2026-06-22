/**
 * yjsRoom.ts — Per-document Yjs state management (the CRDT heart of CollabSync).
 *
 * ═══════════════════════════════════════════════════════════════
 * HOW Yjs CRDT CONFLICT RESOLUTION WORKS — read this first
 * ═══════════════════════════════════════════════════════════════
 *
 * Yjs uses a variant of the YATA (Yet Another Transformation Approach) CRDT
 * algorithm. Every character (or "item") inserted into a Y.Text is wrapped in
 * a struct with four fields:
 *
 *   { id: {client: number, clock: number}, content, left, right }
 *
 *  • id.client  — a random 53-bit integer assigned once to each Y.Doc instance.
 *                 Identifies WHO made the change.
 *  • id.clock   — a per-client monotonically increasing counter.
 *                 Identifies WHEN (relative to that client's own history).
 *  • left/right — references to the structs that were immediately left/right of
 *                 this insertion at the moment it was made. These are the
 *                 "intention" anchors.
 *
 * CONFLICT SCENARIO: Two clients A and B both insert at position 5 of a
 * shared text without seeing each other's update first (concurrent inserts).
 *
 *   Client A inserts "X" after struct(leftId=L)
 *   Client B inserts "Y" after struct(leftId=L)   ← same left anchor
 *
 * When A's update arrives at B (or vice versa), Yjs must decide: does X go
 * before Y or after? It applies the YATA rule:
 *
 *   Walk right from L until you find a position where the NEXT struct's
 *   client ID is LESS THAN the incoming struct's client ID (numerically).
 *   Insert there.
 *
 * WHY client ID as tiebreaker?
 *   It is deterministic (same input → same output on every replica),
 *   it requires no coordination (no round-trip to a sequencer server),
 *   and it is stable (once two ops have resolved their relative order,
 *   that order never changes — the document grows monotonically).
 *
 * RESULT: Both "X" and "Y" are present in the final document (no data loss),
 * and ALL replicas arrive at the SAME order without any server serialisation.
 *
 * DELETION: Deletes are represented as a "tombstone" flag on the target struct,
 * not as a removal. This prevents the "delete a char that another user moved"
 * problem — the tombstoned struct keeps its position identity even if it is
 * later re-inserted relative to.
 *
 * IDEMPOTENCY: Y.applyUpdate checks the (client, clock) pair against the
 * document's internal state vector. If the struct is already known, it is
 * silently skipped. This means an update can be applied any number of times
 * (e.g., if it is re-broadcast by Redis) with no effect after the first.
 *
 * STATE VECTOR: A compact {clientId → maxClock} map that summarises everything
 * a Y.Doc has seen. Used for delta-sync: given a remote state vector SV,
 * Y.encodeStateAsUpdate(doc, SV) returns ONLY the structs newer than SV.
 * This turns the initial "send full state" approach into an efficient diff
 * for reconnecting clients.
 * ═══════════════════════════════════════════════════════════════
 */

import * as Y from 'yjs';
import { loadSnapshot, saveSnapshot } from './persistence';
import { config } from '../config';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface AwarenessState {
  user: {
    name: string;
    /** CSS colour string, e.g. "#e74c3c" */
    color: string;
  };
  /** Text cursor positions inside the shared Y.Text */
  cursor?: {
    anchor: number; // selection start
    head: number;   // selection end (== anchor when no selection)
  };
}

export interface ClientInfo {
  socketId: string;
  userId: string;
  awareness: AwarenessState;
}

export interface RoomState {
  /** The single authoritative Y.Doc for this document ID.
   *
   *  WHY one doc per server process (not one doc per client)?
   *  The server holds the "publisher" copy. When client A sends an
   *  update, the server applies it here (so the server stays current)
   *  and then re-broadcasts the raw bytes to all other clients.
   *  The server doc also lets us compute delta updates for late-joining
   *  or reconnecting clients without iterating over all connected sockets.
   */
  doc: Y.Doc;
  clients: Map<string, ClientInfo>;
  /** Timer handle for periodic snapshot saves to MongoDB (Task C). */
  snapshotTimer: ReturnType<typeof setInterval> | null;
  /** Count updates since last snapshot — used as a secondary flush trigger. */
  updatesSinceSnapshot: number;
}

// ─────────────────────────────────────────────────────────────
// In-memory room registry
// ─────────────────────────────────────────────────────────────

/**
 * WHY a module-level Map instead of a class / singleton pattern?
 *
 * A plain Map is the simplest data structure for a docId → RoomState lookup.
 * Node.js is single-threaded, so there are no race conditions on reads/writes.
 * We export helper functions rather than the Map itself so tests can mock or
 * reset state without importing the raw Map reference.
 */
const rooms = new Map<string, RoomState>();

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Returns the existing room for `docId` or creates a fresh one.
 * If MongoDB has a snapshot for this docId, the Y.Doc is seeded with it
 * (Task C fills in loadSnapshot; until then it's a no-op stub).
 */
export async function getOrCreateRoom(docId: string): Promise<RoomState> {
  if (rooms.has(docId)) {
    return rooms.get(docId)!;
  }

  // Create a brand-new Y.Doc.
  // WHY gcEnabled = true (default)?  Garbage collection trims tombstoned
  // structs that no client references, keeping memory bounded over time.
  const doc = new Y.Doc({ gc: true });

  // ── Seed from persistent snapshot ──────────────────────────
  // WHY load from MongoDB here instead of lazily on first client join?
  // Loading at room-creation time means the first connecting client
  // always gets a fully seeded document. If we deferred, the first
  // client would see an empty doc momentarily, causing a flash.
  try {
    const snapshot = await loadSnapshot(docId);
    if (snapshot) {
      Y.applyUpdate(doc, snapshot);
      console.log(`[yjsRoom] Seeded doc "${docId}" from MongoDB snapshot.`);
    }
  } catch (err) {
    // WHY swallow? A persistence failure should not block collaboration.
    // The room starts empty and clients can still collaborate; the next
    // save cycle will attempt to persist again.
    console.error(`[yjsRoom] Failed to load snapshot for "${docId}":`, err);
  }

  // ── Periodic snapshot timer ─────────────────────────────────
  // WHY setInterval here (at room creation) rather than at server startup?
  // Each room manages its own flush cadence independently. If there are
  // 10 active documents, they flush on separate timers, spreading the
  // MongoDB write load.
  const snapshotTimer = setInterval(async () => {
    await flushSnapshot(docId);
  }, config.snapshotIntervalMs);

  // Prevent the timer from keeping the Node process alive on shutdown.
  if (snapshotTimer.unref) snapshotTimer.unref();

  const room: RoomState = {
    doc,
    clients: new Map(),
    snapshotTimer,
    updatesSinceSnapshot: 0,
  };

  rooms.set(docId, room);
  return room;
}

/**
 * Apply a binary Yjs update from a client to the server-side doc.
 *
 * WHY is this safe to call concurrently?
 * Node.js processes one event-loop tick at a time. Even if two socket
 * events fire in the same tick, they are processed sequentially. So there
 * is no risk of two Y.applyUpdate calls running simultaneously on the
 * same Y.Doc — no mutex needed.
 *
 * WHY don't we validate the update bytes before applying?
 * Y.applyUpdate ignores unknown or already-seen structs rather than throwing.
 * Malformed input would throw, but that is caught by the caller's try/catch
 * in handlers.ts. Validating a CRDT update would require deserialising it
 * fully, which is exactly what applyUpdate does — there's no cheaper check.
 */
export function applyClientUpdate(docId: string, update: Uint8Array): void {
  const room = rooms.get(docId);
  if (!room) return;

  /**
   * ── The Core CRDT Merge ──────────────────────────────────────
   *
   * Y.applyUpdate integrates the incoming binary `update` into `room.doc`.
   * Internally, Yjs:
   *   1. Deserialises the update into a list of structs.
   *   2. For each struct, checks if (client, clock) is already in the doc's
   *      state vector. If yes → skip (idempotency).
   *   3. If the struct is new, finds its left/right neighbours using the
   *      YATA insertion algorithm and links it into the doubly-linked list
   *      of the target shared type (Y.Text, Y.Map, etc.).
   *   4. Updates the state vector with the new max clock for that client.
   *
   * The YATA conflict rule (when two structs share the same left anchor):
   *   Scan right from the shared left until you find a struct whose clientId
   *   is numerically less than the incoming struct's clientId. Insert before it.
   *   This produces a stable, deterministic total order across replicas.
   */
  Y.applyUpdate(room.doc, update);

  // Bump update counter. Every 100 updates we flush early — useful for
  // high-traffic documents where 30 s would lose too many ops.
  room.updatesSinceSnapshot += 1;
  if (room.updatesSinceSnapshot >= 100) {
    flushSnapshot(docId).catch(console.error);
    room.updatesSinceSnapshot = 0;
  }
}

/**
 * Encode the full current state of a doc as a binary Yjs update.
 * If `stateVector` is provided, encode ONLY the structs newer than that vector
 * (delta sync — critical for efficient reconnection).
 *
 * WHY return Uint8Array instead of Buffer?
 * Uint8Array is the standard across the Yjs ecosystem. Socket.io's binary
 * transport accepts both; callers can wrap in Buffer.from() if needed.
 */
export function getStateUpdate(
  docId: string,
  stateVector?: Uint8Array,
): Uint8Array {
  const room = rooms.get(docId);
  if (!room) return new Uint8Array(0);
  return Y.encodeStateAsUpdate(room.doc, stateVector);
}

/**
 * Returns the doc's current state vector — a compact {clientId → clock} map.
 * Clients send this on reconnect so the server can compute the minimal delta.
 */
export function getStateVector(docId: string): Uint8Array {
  const room = rooms.get(docId);
  if (!room) return new Uint8Array(0);
  return Y.encodeStateVector(room.doc);
}

/**
 * Register a newly connected client in the room's presence list.
 * Called AFTER the Socket.io socket has joined the room channel.
 */
export function addClient(docId: string, info: ClientInfo): void {
  // getOrCreateRoom is async (due to snapshot load), but addClient is called
  // after the room already exists (handlers.ts awaits getOrCreateRoom first).
  const room = rooms.get(docId);
  if (!room) {
    console.warn(`[yjsRoom] addClient called before room "${docId}" exists.`);
    return;
  }
  room.clients.set(info.socketId, info);
}

/**
 * Remove a disconnected client from the room's presence list.
 *
 * WHY keep the room alive even when the last client leaves?
 * Destroying the Y.Doc immediately would lose all in-memory state for
 * documents that haven't been snapshotted yet. Keeping rooms alive also
 * means a client that refreshes their tab reconnects to a warm doc instantly.
 * Task C adds a TTL-based cleanup for rooms that have been empty for N minutes.
 */
export function removeClient(docId: string, socketId: string): void {
  const room = rooms.get(docId);
  if (!room) return;
  room.clients.delete(socketId);

  // When the last client leaves, do an eager snapshot flush so we don't
  // lose the recent edits if the server is restarted before the next timer tick.
  if (room.clients.size === 0) {
    flushSnapshot(docId).catch(console.error);
  }
}

/**
 * Upsert the awareness (cursor/presence) state for one client.
 * Awareness is NOT stored in the Y.Doc — it's ephemeral, last-write-wins.
 */
export function updateAwarenessState(
  docId: string,
  socketId: string,
  state: AwarenessState,
): void {
  const room = rooms.get(docId);
  if (!room) return;
  const client = room.clients.get(socketId);
  if (client) {
    client.awareness = state;
  }
}

/** Return all currently-connected clients with their awareness state. */
export function getRoomClients(docId: string): ClientInfo[] {
  const room = rooms.get(docId);
  if (!room) return [];
  return Array.from(room.clients.values());
}

/** Return a snapshot of all awareness states keyed by socketId. */
export function getAllAwarenessStates(
  docId: string,
): Map<string, AwarenessState> {
  const room = rooms.get(docId);
  if (!room) return new Map();
  const out = new Map<string, AwarenessState>();
  for (const [sid, info] of room.clients) {
    out.set(sid, info.awareness);
  }
  return out;
}

/**
 * Gracefully shut down a room: cancel the snapshot timer and flush state.
 * Called during server shutdown (SIGTERM handler in index.ts).
 */
export async function closeRoom(docId: string): Promise<void> {
  const room = rooms.get(docId);
  if (!room) return;
  if (room.snapshotTimer) clearInterval(room.snapshotTimer);
  await flushSnapshot(docId);
  rooms.delete(docId);
}

/** Flush all open rooms — called during graceful shutdown. */
export async function closeAllRooms(): Promise<void> {
  const ids = Array.from(rooms.keys());
  await Promise.allSettled(ids.map(closeRoom));
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

async function flushSnapshot(docId: string): Promise<void> {
  const room = rooms.get(docId);
  if (!room) return;
  try {
    // Encode the FULL current state (no state-vector filter).
    // WHY full state? We want the snapshot to be self-contained so that
    // on server restart we can restore with a single Y.applyUpdate call
    // rather than replaying a log.
    const fullUpdate = Y.encodeStateAsUpdate(room.doc);
    await saveSnapshot(docId, fullUpdate);
  } catch (err) {
    // WHY not throw? A failed snapshot is bad but not fatal. Clients can
    // keep collaborating; we log and retry on the next interval.
    console.error(`[yjsRoom] Snapshot flush failed for "${docId}":`, err);
  }
}

// ─────────────────────────────────────────────────────────────
// Test / internal escape hatches (not part of the public API)
// ─────────────────────────────────────────────────────────────

/** @internal — used by tests to inspect raw room state */
export function _getRooms(): Map<string, RoomState> {
  return rooms;
}

/** @internal — clears all rooms; used in beforeEach of test suites */
export function _clearRooms(): void {
  for (const room of rooms.values()) {
    if (room.snapshotTimer) clearInterval(room.snapshotTimer);
    room.doc.destroy();
  }
  rooms.clear();
}
