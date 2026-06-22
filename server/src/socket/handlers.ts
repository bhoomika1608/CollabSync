/**
 * handlers.ts — Socket.io event handlers for document collaboration.
 *
 * ══════════════════════════════════════════════════════════════════
 * WIRE PROTOCOL  (client ↔ server)
 * ══════════════════════════════════════════════════════════════════
 *
 * Client → Server events
 * ─────────────────────
 *  doc:join          { docId, userId, userInfo: {name, color?} }
 *    Client requests to join a collaborative document.
 *
 *  doc:update        { docId, update: Buffer }
 *    Client sends a binary Yjs update produced by a local edit.
 *
 *  doc:sync-request  { docId, stateVector: Buffer }
 *    Client (typically after reconnect) sends its current state vector.
 *    Server replies with only the ops the client hasn't seen.
 *
 *  awareness:update  { docId, state: AwarenessState }
 *    Client sends its latest cursor / presence data.
 *
 *  doc:leave         { docId }
 *    Client explicitly leaves (tab close, navigation away).
 *
 * Server → Client events
 * ─────────────────────
 *  doc:load          { docId, update: Buffer, clients: PresencePayload[] }
 *    Full (or delta) doc state sent to a joining / reconnecting client.
 *
 *  doc:update        { docId, update: Buffer }
 *    Relayed update from another client. Apply to local Y.Doc.
 *
 *  awareness:update  { socketId, state: AwarenessState }
 *    Another client's cursor / presence changed.
 *
 *  presence:joined   { socketId, userId, awareness }
 *    A new user joined the document.
 *
 *  presence:left     { socketId }
 *    A user disconnected or left.
 *
 * ══════════════════════════════════════════════════════════════════
 */

import { Server, Socket } from 'socket.io';
import {
  getOrCreateRoom,
  addClient,
  removeClient,
  applyClientUpdate,
  getStateUpdate,
  updateAwarenessState,
  getRoomClients,
  AwarenessState,
} from '../yjs/yjsRoom';
import {
  assignUserColor,
  buildJoinedPayload,
  buildAwarenessPayload,
  buildLeftPayload,
} from './presence';

// ─────────────────────────────────────────────────────────────
// Per-socket bookkeeping
// ─────────────────────────────────────────────────────────────

/**
 * WHY track socket → docs instead of querying Socket.io rooms?
 * Socket.io stores room membership but doesn't distinguish "document rooms"
 * from other rooms (e.g., a private channel). Maintaining our own Map
 * gives us O(1) lookup on disconnect without filtering Socket.io's
 * internal room set.
 */
const socketDocMap = new Map<string, Set<string>>();

// ─────────────────────────────────────────────────────────────
// Handler registration
// ─────────────────────────────────────────────────────────────

export function registerSocketHandlers(io: Server, socket: Socket): void {
  // ── doc:join ───────────────────────────────────────────────
  socket.on(
    'doc:join',
    async (payload: {
      docId: string;
      userId: string;
      userInfo: { name: string; color?: string };
    }) => {
      try {
        const { docId, userId, userInfo } = payload;

        // Deterministic colour: if the client doesn't specify one, derive it
        // from the userId so it stays stable across sessions.
        const color = userInfo.color ?? assignUserColor(userId);

        // Ensure the room exists (creates Y.Doc, loads snapshot if available).
        await getOrCreateRoom(docId);

        // Join Socket.io room — this lets us call io.to(docId).emit(...)
        // to reach all clients on this document, including via Redis adapter
        // on other server instances (Task B).
        socket.join(docId);

        // Track this socket's doc memberships for disconnect cleanup.
        if (!socketDocMap.has(socket.id)) {
          socketDocMap.set(socket.id, new Set());
        }
        socketDocMap.get(socket.id)!.add(docId);

        const awareness: AwarenessState = {
          user: { name: userInfo.name, color },
          cursor: undefined,
        };

        addClient(docId, { socketId: socket.id, userId, awareness });

        // ── Sync step: send full current doc state to the new client ──────
        //
        // WHY send the full state and not just a diff?
        // We don't know the client's state vector yet (it's a fresh join,
        // not a reconnect). The full state is always safe; it may be larger
        // than a delta but is always correct.
        //
        // WHY not send the state vector first and wait for the client to reply
        // with its own vector? That would add a round-trip (2 × latency)
        // before the client can render the document. For fresh joins, the
        // full-state approach halves the time-to-first-render.
        const fullState = getStateUpdate(docId);

        socket.emit('doc:load', {
          docId,
          update: Buffer.from(fullState),
          clients: getRoomClients(docId).map((c) => ({
            socketId: c.socketId,
            userId: c.userId,
            awareness: c.awareness,
          })),
        });

        // Notify everyone else that a new user joined.
        socket.to(docId).emit(
          'presence:joined',
          buildJoinedPayload(socket.id, userId, awareness),
        );

        console.log(
          `[join]  socket=${socket.id}  user=${userId}  doc=${docId}`,
        );
      } catch (err) {
        console.error('[doc:join] Error:', err);
        socket.emit('error', { message: 'Failed to join document.' });
      }
    },
  );

  // ── doc:update ─────────────────────────────────────────────
  socket.on(
    'doc:update',
    (payload: { docId: string; update: Buffer | number[] }) => {
      try {
        const { docId } = payload;

        // Normalise to Uint8Array regardless of transport representation.
        // Socket.io binary transport delivers a Buffer; JSON fallback delivers
        // a number[]. Both are handled here.
        const updateBytes =
          payload.update instanceof Buffer
            ? new Uint8Array(payload.update)
            : new Uint8Array(payload.update);

        // Apply to the server-side authoritative Y.Doc (CRDT merge).
        applyClientUpdate(docId, updateBytes);

        /**
         * WHY re-broadcast the ORIGINAL bytes from the client and NOT a
         * re-encoded snapshot from the server doc?
         *
         * Each Yjs struct carries a (clientId, clock) pair that uniquely
         * identifies it. If we encoded the server's doc and sent that, every
         * update would appear to come from the server's clientId. Other clients
         * applying that would then have their state vector record the server's
         * clock, not the originating client's clock — breaking delta-sync
         * correctness and making idempotency checks fail for the original ops.
         *
         * By relaying the raw bytes, we preserve the originating client's
         * identity through the entire network path. Redis (Task B) also relays
         * raw bytes for the same reason.
         */
        socket.to(docId).emit('doc:update', {
          docId,
          update: Buffer.from(updateBytes),
        });

        // WHY NOT echo back to the sender?
        // The sender's Y.Doc already has this update applied locally (that's
        // how it generated the bytes). Echoing would cause applyUpdate to run
        // again, hit the idempotency check, and do nothing — but it wastes
        // bandwidth and a client-side event-loop tick.
      } catch (err) {
        console.error('[doc:update] Error:', err);
      }
    },
  );

  // ── doc:sync-request ───────────────────────────────────────
  //
  // WHY have a separate sync-request event (not just re-join)?
  // A reconnecting client already HAS the document up to its last-seen state.
  // Re-sending the full state wastes bandwidth. The client sends its state
  // vector; the server computes and sends only the delta. This is the same
  // mechanism Yjs's y-websocket uses for its "sync step 2".
  socket.on(
    'doc:sync-request',
    (payload: { docId: string; stateVector: Buffer | number[] }) => {
      try {
        const { docId } = payload;
        const svBytes =
          payload.stateVector instanceof Buffer
            ? new Uint8Array(payload.stateVector)
            : new Uint8Array(payload.stateVector);

        // Compute only the updates the client hasn't seen.
        const delta = getStateUpdate(docId, svBytes);

        socket.emit('doc:load', {
          docId,
          update: Buffer.from(delta),
          // Re-send current presence list so the client refreshes avatars.
          clients: getRoomClients(docId).map((c) => ({
            socketId: c.socketId,
            userId: c.userId,
            awareness: c.awareness,
          })),
        });
      } catch (err) {
        console.error('[doc:sync-request] Error:', err);
      }
    },
  );

  // ── awareness:update ───────────────────────────────────────
  socket.on(
    'awareness:update',
    (payload: { docId: string; state: AwarenessState }) => {
      try {
        const { docId, state } = payload;
        updateAwarenessState(docId, socket.id, state);
        // Relay to all OTHER clients in the room.
        socket.to(docId).emit(
          'awareness:update',
          buildAwarenessPayload(socket.id, state),
        );
      } catch (err) {
        console.error('[awareness:update] Error:', err);
      }
    },
  );

  // ── doc:leave ──────────────────────────────────────────────
  socket.on('doc:leave', (payload: { docId: string }) => {
    handleLeave(io, socket, payload.docId);
  });

  // ── disconnect ─────────────────────────────────────────────
  //
  // WHY handle disconnect separately from doc:leave?
  // doc:leave is a graceful, intentional departure. disconnect fires when
  // the TCP connection drops (network loss, browser close, server-killed
  // idle connection). We must handle both to avoid ghost cursors.
  socket.on('disconnect', (reason) => {
    console.log(`[disconnect]  socket=${socket.id}  reason=${reason}`);
    const docs = socketDocMap.get(socket.id);
    if (docs) {
      for (const docId of docs) {
        handleLeave(io, socket, docId);
      }
      socketDocMap.delete(socket.id);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Shared leave logic
// ─────────────────────────────────────────────────────────────

function handleLeave(io: Server, socket: Socket, docId: string): void {
  removeClient(docId, socket.id);
  socket.leave(docId);

  // WHY use io.to(docId) and not socket.to(docId)?
  // socket.to() excludes the sending socket, which is fine here. But io.to()
  // is explicit: it broadcasts to the room regardless of whether the socket
  // is still in it (it just left). The difference matters if this is called
  // from the disconnect handler where socket.rooms may already be empty.
  io.to(docId).emit('presence:left', buildLeftPayload(socket.id));

  // Clean up the bookkeeping entry.
  socketDocMap.get(socket.id)?.delete(docId);

  console.log(`[leave]  socket=${socket.id}  doc=${docId}`);
}
