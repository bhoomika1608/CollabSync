/**
 * crdt.test.ts — Concurrent-edit correctness tests for the CollabSync CRDT layer.
 *
 * ═══════════════════════════════════════════════════════════════
 * TEST PHILOSOPHY
 * ═══════════════════════════════════════════════════════════════
 *
 * We test TWO layers:
 *
 *  Layer 1 — Pure Yjs CRDT semantics (Tests T1–T6)
 *  ─────────────────────────────────────────────────
 *  These tests create Y.Doc instances directly and exercise the merge
 *  algorithm in isolation, without any Socket.io or server code.
 *  Goal: verify that Yjs's CRDT guarantees hold as expected.
 *
 *  Three key properties under test:
 *    • CONVERGENCE   — after all updates are exchanged, all replicas
 *                      have identical content.
 *    • NO DATA LOSS  — both (all) concurrent edits survive the merge.
 *    • IDEMPOTENCY   — applying the same update twice produces no change.
 *
 *  Layer 2 — Server yjsRoom integration (Tests T7–T8)
 *  ────────────────────────────────────────────────────
 *  These tests exercise the server-side functions (getOrCreateRoom,
 *  applyClientUpdate, getStateUpdate, etc.) to confirm the server
 *  behaves correctly as a relay + authoritative state holder.
 *
 * HOW concurrent edits are simulated
 * ────────────────────────────────────
 *  "Concurrent" in a CRDT context means: two clients each started from
 *  the SAME base state and made edits BEFORE seeing each other's update.
 *
 *    baseDoc → (clone) → clientA: edit A  →  update_A
 *    baseDoc → (clone) → clientB: edit B  →  update_B
 *
 *  update_A and update_B are "concurrent" because neither contains
 *  knowledge of the other. Applying both to a third doc (the server doc
 *  or a third client) tests the CRDT merge.
 */

import * as Y from 'yjs';
import {
  getOrCreateRoom,
  applyClientUpdate,
  getStateUpdate,
  getStateVector,
  addClient,
  removeClient,
  getRoomClients,
  _clearRooms,
  _getRooms,
} from '../src/yjs/yjsRoom';

jest.mock('../src/yjs/persistence', () => ({
  loadSnapshot: jest.fn().mockResolvedValue(null),
  saveSnapshot: jest.fn().mockResolvedValue(undefined),
}));


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Clone the full state of `source` into a brand-new Y.Doc.
 * Simulates a client that joins and receives the current doc state.
 */
function cloneDoc(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  return clone;
}

/**
 * Compute the binary update that `modified` has over `base`.
 * This is the update a client would send to the server after making edits.
 * Uses the base's state vector so only the *new* structs are encoded.
 */
function deltaFrom(modified: Y.Doc, base: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(modified, Y.encodeStateVector(base));
}

// The shared Y.Text key used across all tests.
const TEXT_KEY = 'content';

// ─────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────

describe('CollabSync — Yjs CRDT concurrent-edit correctness', () => {
  // Clean up all server-side rooms between tests so they don't bleed state.
  beforeEach(() => _clearRooms());
  afterAll(() => _clearRooms());

  // ═══════════════════════════════════════════════════════════
  // T1 — Inserts at DIFFERENT positions merge without data loss
  // ═══════════════════════════════════════════════════════════
  /**
   * Scenario:
   *   Server state: "Hello"
   *   Client A (concurrently) appends " World" → "Hello World"
   *   Client B (concurrently) prepends "Hi! "  → "Hi! Hello"
   *
   * Expected after merge: both inserts present; all replicas identical.
   *
   * Why this matters:
   *   This is the simplest case — no positional conflict. Tests that
   *   independent concurrent inserts are both preserved (no overwrite).
   */
  test('T1: Concurrent inserts at different positions — both survive, all replicas converge', () => {
    const serverDoc = new Y.Doc();
    serverDoc.getText(TEXT_KEY).insert(0, 'Hello');

    // Two clients clone the server's current state.
    const clientA = cloneDoc(serverDoc);
    const clientB = cloneDoc(serverDoc);

    // Concurrent edits (neither has seen the other).
    clientA.getText(TEXT_KEY).insert(5, ' World');  // "Hello World"
    clientB.getText(TEXT_KEY).insert(0, 'Hi! ');    // "Hi! Hello"

    const updateA = deltaFrom(clientA, serverDoc);
    const updateB = deltaFrom(clientB, serverDoc);

    // Server applies both updates.
    Y.applyUpdate(serverDoc, updateA);
    Y.applyUpdate(serverDoc, updateB);

    // Clients exchange each other's updates.
    Y.applyUpdate(clientA, updateB);
    Y.applyUpdate(clientB, updateA);

    const finalServer = serverDoc.getText(TEXT_KEY).toString();
    const finalA = clientA.getText(TEXT_KEY).toString();
    const finalB = clientB.getText(TEXT_KEY).toString();

    // ── Convergence ────────────────────────────────────────
    expect(finalA).toBe(finalServer);
    expect(finalB).toBe(finalServer);

    // ── No data loss ───────────────────────────────────────
    expect(finalServer).toContain('Hello');
    expect(finalServer).toContain('World');
    expect(finalServer).toContain('Hi!');
  });

  // ═══════════════════════════════════════════════════════════
  // T2 — Inserts at the SAME position (YATA tiebreaker)
  // ═══════════════════════════════════════════════════════════
  /**
   * Scenario:
   *   Server state: "AB"
   *   Client A inserts "1" between A and B → "A1B"
   *   Client B inserts "2" between A and B → "A2B" (same anchor!)
   *
   * Both are anchored to the struct for "A" as their left neighbour.
   * Yjs's YATA rule uses the clientId as a tiebreaker to produce a
   * deterministic order: "A12B" or "A21B" depending on which clientId
   * is numerically larger.
   *
   * Why this matters:
   *   The "same position" case is where OT needs a central coordinator.
   *   CRDTs resolve it locally and deterministically — the result may
   *   not be "intuitive" but it is ALWAYS the same on every replica.
   */
  test('T2: Concurrent inserts at the same position — both chars present, order is deterministic and identical on all replicas', () => {
    const serverDoc = new Y.Doc();
    serverDoc.getText(TEXT_KEY).insert(0, 'AB');

    const clientA = cloneDoc(serverDoc);
    const clientB = cloneDoc(serverDoc);

    // Both insert at index 1 (between 'A' and 'B').
    clientA.getText(TEXT_KEY).insert(1, '1');
    clientB.getText(TEXT_KEY).insert(1, '2');

    const updateA = deltaFrom(clientA, serverDoc);
    const updateB = deltaFrom(clientB, serverDoc);

    Y.applyUpdate(serverDoc, updateA);
    Y.applyUpdate(serverDoc, updateB);
    Y.applyUpdate(clientA, updateB);
    Y.applyUpdate(clientB, updateA);

    const finalServer = serverDoc.getText(TEXT_KEY).toString();
    const finalA = clientA.getText(TEXT_KEY).toString();
    const finalB = clientB.getText(TEXT_KEY).toString();

    // ── Convergence: all replicas agree ────────────────────
    expect(finalA).toBe(finalServer);
    expect(finalB).toBe(finalServer);

    // ── No data loss: both '1' and '2' are present ─────────
    expect(finalServer).toContain('1');
    expect(finalServer).toContain('2');

    // ── Structural integrity: original chars preserved ──────
    expect(finalServer).toContain('A');
    expect(finalServer).toContain('B');
    expect(finalServer).toHaveLength(4); // A + one of {1,2} + the other + B

    // ── The first and last chars must still be A and B ──────
    // This ensures the relative order of non-conflicting content is respected.
    expect(finalServer[0]).toBe('A');
    expect(finalServer[finalServer.length - 1]).toBe('B');
  });

  // ═══════════════════════════════════════════════════════════
  // T3 — Concurrent DELETE and INSERT at the same region
  // ═══════════════════════════════════════════════════════════
  /**
   * Scenario:
   *   Server state: "Hello World"
   *   Client A deletes " World" (6 chars from pos 5) → "Hello"
   *   Client B inserts " Earth" at pos 11 (after "World") → "Hello World Earth"
   *
   * After merge: client B's insert references a position that client A deleted.
   * Yjs handles this via tombstones: deleted structs stay in the linked list
   * but are flagged invisible. Client B's insert is still linked relative to
   * the (now-tombstoned) "World" structs and remains visible.
   *
   * Expected: " Earth" survives (attached to the tombstone's position);
   *           " World" is deleted. Final: "Hello Earth".
   *
   * Why this matters:
   *   This is the hardest class of conflict. OT "lost-update" bugs happen
   *   here. CRDTs avoid them with tombstones.
   */
  test('T3: Concurrent delete + insert at overlapping region — insert survives, delete is honoured, all replicas converge', () => {
    const serverDoc = new Y.Doc();
    serverDoc.getText(TEXT_KEY).insert(0, 'Hello World');

    const clientA = cloneDoc(serverDoc);
    const clientB = cloneDoc(serverDoc);

    // Client A deletes " World" (positions 5..10, length 6)
    clientA.getText(TEXT_KEY).delete(5, 6);

    // Client B inserts " Earth" at the very end (after "World")
    clientB.getText(TEXT_KEY).insert(11, ' Earth');

    const updateA = deltaFrom(clientA, serverDoc);
    const updateB = deltaFrom(clientB, serverDoc);

    Y.applyUpdate(serverDoc, updateA);
    Y.applyUpdate(serverDoc, updateB);
    Y.applyUpdate(clientA, updateB);
    Y.applyUpdate(clientB, updateA);

    const finalServer = serverDoc.getText(TEXT_KEY).toString();
    const finalA = clientA.getText(TEXT_KEY).toString();
    const finalB = clientB.getText(TEXT_KEY).toString();

    // ── Convergence ────────────────────────────────────────
    expect(finalA).toBe(finalServer);
    expect(finalB).toBe(finalServer);

    // ── Delete is respected ────────────────────────────────
    expect(finalServer).not.toContain('World');

    // ── Insert survives (tombstone anchor) ─────────────────
    expect(finalServer).toContain('Earth');
    expect(finalServer).toContain('Hello');
  });

  // ═══════════════════════════════════════════════════════════
  // T4 — OFFLINE EDIT RECONCILIATION (reconnect scenario)
  // ═══════════════════════════════════════════════════════════
  /**
   * Scenario:
   *   Server & Client A start from "Hello".
   *   Client B "goes offline" with state "Hello".
   *   Server (via Client A): appends " World" → server is now "Hello World".
   *   Client B (offline):    appends "!"      → client B is now "Hello!".
   *   Client B reconnects:
   *     • Sends its state vector to server.
   *     • Receives delta (" World" update).
   *     • Applies it → now "Hello World!" or "Hello! World".
   *     • Sends its own " !" update to server.
   *     • Server applies → same result.
   *
   * Why this matters:
   *   This is requirement 3 from the spec: offline editing must reconcile
   *   automatically on reconnect with no manual conflict resolution.
   */
  test('T4: Offline edit reconciliation — client B reconnects and merges without data loss', () => {
    const serverDoc = new Y.Doc();
    serverDoc.getText(TEXT_KEY).insert(0, 'Hello');

    // Client B "disconnects" with the current server state.
    const clientB = cloneDoc(serverDoc);
    const clientBStateVectorBeforeOffline = Y.encodeStateVector(clientB);

    // While B is offline, the server gets an update from client A.
    const clientA = cloneDoc(serverDoc);
    clientA.getText(TEXT_KEY).insert(5, ' World');
    const updateA = deltaFrom(clientA, serverDoc);
    Y.applyUpdate(serverDoc, updateA);
    // Server is now "Hello World"

    // Meanwhile, client B edits offline.
    clientB.getText(TEXT_KEY).insert(5, '!');
    const updateB = deltaFrom(clientB, serverDoc); // uses server's old SV

    // ── Reconnect: server sends B the delta it missed ──────
    //    (simulates doc:sync-request handler)
    const serverDelta = Y.encodeStateAsUpdate(
      serverDoc,
      clientBStateVectorBeforeOffline,
    );
    Y.applyUpdate(clientB, serverDelta);
    // Client B now has both " World" and "!" merged.

    // ── Client B sends its offline edit to the server ──────
    Y.applyUpdate(serverDoc, updateB);
    // Server now has both edits too.

    const finalServer = serverDoc.getText(TEXT_KEY).toString();
    const finalB = clientB.getText(TEXT_KEY).toString();

    // ── Convergence ────────────────────────────────────────
    expect(finalB).toBe(finalServer);

    // ── Both edits survive ─────────────────────────────────
    expect(finalServer).toContain('Hello');
    expect(finalServer).toContain('World');
    expect(finalServer).toContain('!');
  });

  // ═══════════════════════════════════════════════════════════
  // T5 — THREE-WAY concurrent edits
  // ═══════════════════════════════════════════════════════════
  /**
   * Scenario:
   *   Server state: "" (empty doc)
   *   Client A inserts "Alice"
   *   Client B inserts "Bob"    (concurrent with A)
   *   Client C inserts "Carol"  (concurrent with A and B)
   *
   * After all three updates are applied to all three docs:
   *   Every doc must contain "Alice", "Bob", and "Carol" in the SAME order.
   *
   * Why this matters:
   *   Three-way merge is the minimal case for real group collaboration.
   *   If any pair of updates fails to commute, replicas diverge.
   */
  test('T5: Three-way concurrent edits — all three edits preserved, all replicas identical', () => {
    const serverDoc = new Y.Doc();
    // Empty starting state.

    const clientA = cloneDoc(serverDoc);
    const clientB = cloneDoc(serverDoc);
    const clientC = cloneDoc(serverDoc);

    // All three clients edit from the SAME empty base (truly concurrent).
    clientA.getText(TEXT_KEY).insert(0, 'Alice');
    clientB.getText(TEXT_KEY).insert(0, 'Bob');
    clientC.getText(TEXT_KEY).insert(0, 'Carol');

    const updateA = deltaFrom(clientA, serverDoc);
    const updateB = deltaFrom(clientB, serverDoc);
    const updateC = deltaFrom(clientC, serverDoc);

    // Server applies all three.
    Y.applyUpdate(serverDoc, updateA);
    Y.applyUpdate(serverDoc, updateB);
    Y.applyUpdate(serverDoc, updateC);

    // Each client applies the other two.
    Y.applyUpdate(clientA, updateB);
    Y.applyUpdate(clientA, updateC);
    Y.applyUpdate(clientB, updateA);
    Y.applyUpdate(clientB, updateC);
    Y.applyUpdate(clientC, updateA);
    Y.applyUpdate(clientC, updateB);

    const finalServer = serverDoc.getText(TEXT_KEY).toString();
    const finalA = clientA.getText(TEXT_KEY).toString();
    const finalB = clientB.getText(TEXT_KEY).toString();
    const finalC = clientC.getText(TEXT_KEY).toString();

    // ── Convergence: all four replicas identical ───────────
    expect(finalA).toBe(finalServer);
    expect(finalB).toBe(finalServer);
    expect(finalC).toBe(finalServer);

    // ── No data loss: all three names present ──────────────
    expect(finalServer).toContain('Alice');
    expect(finalServer).toContain('Bob');
    expect(finalServer).toContain('Carol');
  });

  // ═══════════════════════════════════════════════════════════
  // T6 — IDEMPOTENCY: applying the same update twice
  // ═══════════════════════════════════════════════════════════
  /**
   * Scenario:
   *   Client A inserts "Hello".
   *   The same binary update is applied to the server doc TWICE
   *   (simulating a network re-delivery or Redis re-broadcast).
   *
   * Expected: the server doc has "Hello" exactly ONCE.
   *
   * Why this matters:
   *   Requirement 4 (horizontal scaling via Redis pub-sub) means an update
   *   could theoretically be delivered more than once (if the Redis adapter
   *   re-broadcasts on reconnect). The CRDT must handle this gracefully.
   *
   * How it works:
   *   Y.applyUpdate checks (clientId, clock) before inserting any struct.
   *   If the clock is already in the server doc's state vector, the struct
   *   is silently skipped — no duplicate content, no error.
   */
  test('T6: Idempotency — applying the same update twice does not duplicate content', () => {
    const serverDoc = new Y.Doc();
    const clientA = new Y.Doc();

    clientA.getText(TEXT_KEY).insert(0, 'Hello');
    const update = Y.encodeStateAsUpdate(clientA);

    // Apply the same binary update twice.
    Y.applyUpdate(serverDoc, update);
    Y.applyUpdate(serverDoc, update); // second application must be a no-op

    expect(serverDoc.getText(TEXT_KEY).toString()).toBe('Hello');
    expect(serverDoc.getText(TEXT_KEY).length).toBe(5);
  });

  // ═══════════════════════════════════════════════════════════
  // T7 — STATE VECTOR delta sync (efficient reconnect)
  // ═══════════════════════════════════════════════════════════
  /**
   * Scenario:
   *   Server has "Hello World" (two sequential updates: "Hello" then " World").
   *   Client knows about "Hello" but not " World".
   *   Client sends its state vector to the server.
   *   Server returns ONLY the " World" delta.
   *   Client applies delta → now has "Hello World".
   *
   * Why this matters:
   *   For a document with thousands of edits, sending the full state on
   *   every reconnect would be expensive. Delta sync (state-vector exchange)
   *   keeps reconnection payloads proportional to missed edits, not total
   *   document history.
   */
  test('T7: State-vector delta sync — server sends only missing updates to a reconnecting client', () => {
    const serverDoc = new Y.Doc();
    const clientDoc = new Y.Doc();

    // First update: client receives and applies "Hello".
    serverDoc.getText(TEXT_KEY).insert(0, 'Hello');
    const update1 = Y.encodeStateAsUpdate(serverDoc);
    Y.applyUpdate(clientDoc, update1);

    // Client's state vector now records "Hello".
    const clientSV = Y.encodeStateVector(clientDoc);

    // Second update on server: " World" added while client was "offline".
    serverDoc.getText(TEXT_KEY).insert(5, ' World');

    // ── Simulate doc:sync-request: server computes delta ───
    const delta = Y.encodeStateAsUpdate(serverDoc, clientSV);

    // The delta should be SMALLER than the full state (only " World").
    const fullState = Y.encodeStateAsUpdate(serverDoc);
    expect(delta.length).toBeLessThan(fullState.length);

    // Apply delta to client.
    Y.applyUpdate(clientDoc, delta);

    expect(clientDoc.getText(TEXT_KEY).toString()).toBe('Hello World');
    expect(serverDoc.getText(TEXT_KEY).toString()).toBe('Hello World');
  });

  // ═══════════════════════════════════════════════════════════
  // T8 — SERVER yjsRoom: room lifecycle and client tracking
  // ═══════════════════════════════════════════════════════════
  /**
   * Tests the server-side room management functions (not pure Yjs).
   *
   * Verifies:
   *   • getOrCreateRoom creates a room on first call, reuses on second.
   *   • addClient / removeClient correctly track presence.
   *   • applyClientUpdate + getStateUpdate round-trip faithfully.
   *   • Concurrent edits via the server functions converge correctly.
   */
  test('T8: Server yjsRoom — room lifecycle, client tracking, and update relay convergence', async () => {
    const DOC_ID = 'test-doc-t8';

    // ── Room creation ──────────────────────────────────────
    const room1 = await getOrCreateRoom(DOC_ID);
    const room2 = await getOrCreateRoom(DOC_ID); // must return same room
    expect(room1).toBe(room2);
    expect(_getRooms().has(DOC_ID)).toBe(true);

    // ── Client join ────────────────────────────────────────
    addClient(DOC_ID, {
      socketId: 'socket-alice',
      userId: 'alice',
      awareness: { user: { name: 'Alice', color: '#e74c3c' } },
    });
    addClient(DOC_ID, {
      socketId: 'socket-bob',
      userId: 'bob',
      awareness: { user: { name: 'Bob', color: '#3498db' } },
    });

    expect(getRoomClients(DOC_ID)).toHaveLength(2);

    // ── Client disconnect ──────────────────────────────────
    removeClient(DOC_ID, 'socket-bob');
    expect(getRoomClients(DOC_ID)).toHaveLength(1);
    expect(getRoomClients(DOC_ID)[0].userId).toBe('alice');

    // ── Update relay: two clients edit and server merges ───
    // Simulate Alice's Y.Doc
    const aliceDoc = new Y.Doc();
    aliceDoc.getText(TEXT_KEY).insert(0, 'Alice was here');
    const aliceUpdate = Y.encodeStateAsUpdate(aliceDoc);

    // Simulate Bob's Y.Doc (concurrent from empty)
    const bobDoc = new Y.Doc();
    bobDoc.getText(TEXT_KEY).insert(0, 'Bob too');
    const bobUpdate = Y.encodeStateAsUpdate(bobDoc);

    // Server applies both via applyClientUpdate
    applyClientUpdate(DOC_ID, aliceUpdate);
    applyClientUpdate(DOC_ID, bobUpdate);

    // Server's merged state
    const serverState = getStateUpdate(DOC_ID);
    expect(serverState.length).toBeGreaterThan(0);

    // A third client (Carol) joins late and gets the full state
    const carolDoc = new Y.Doc();
    Y.applyUpdate(carolDoc, serverState);

    // Carol's doc must contain both Alice's and Bob's text
    const carolText = carolDoc.getText(TEXT_KEY).toString();
    expect(carolText).toContain('Alice was here');
    expect(carolText).toContain('Bob too');
  });
});
