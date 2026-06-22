/**
 * presence.ts — Awareness / cursor-presence helpers.
 *
 * WHY is awareness kept separate from the Yjs document?
 * ─────────────────────────────────────────────────────────────────
 * Awareness state (who is in the room, where their cursor is) has very
 * different characteristics from document content:
 *
 *   • It is EPHEMERAL — when a user disconnects their cursor should vanish,
 *     not remain in the document history forever.
 *   • It is LAST-WRITE-WINS — there is no conflict to resolve. If a user moves
 *     their cursor twice quickly, the second update simply overwrites the first.
 *   • It is HIGH-FREQUENCY — cursor moves can fire on every keystroke or mouse
 *     move. Feeding that into the CRDT state machine would bloat the Y.Doc with
 *     tombstoned presence structs.
 *
 * The official y-protocols library defines a binary awareness protocol for
 * y-websocket that is similar to what we do here. We implement it manually
 * over Socket.io events because:
 *   a) We're not using raw WebSocket (Socket.io gives us rooms, namespaces,
 *      automatic reconnection, binary framing).
 *   b) It keeps the protocol explicit and debuggable.
 */

import { AwarenessState } from '../yjs/yjsRoom';

// ─────────────────────────────────────────────────────────────
// Colour palette for auto-assigning user colours
// ─────────────────────────────────────────────────────────────

const CURSOR_COLORS = [
  '#e74c3c', // red
  '#2ecc71', // green
  '#3498db', // blue
  '#9b59b6', // purple
  '#f39c12', // orange
  '#1abc9c', // teal
  '#e67e22', // carrot
  '#e91e63', // pink
  '#00bcd4', // cyan
  '#8bc34a', // light green
];

/**
 * Assign a deterministic colour to a userId so the same user always gets
 * the same colour across sessions without server-side state.
 *
 * WHY deterministic? If colours were random per-session, a user who refreshes
 * would appear as a different "person" to their collaborators.
 *
 * Implementation: hash the userId string to an index in CURSOR_COLORS.
 */
export function assignUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0; // | 0 keeps it int32
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

// ─────────────────────────────────────────────────────────────
// Serialisation helpers
// ─────────────────────────────────────────────────────────────

export interface PresencePayload {
  socketId: string;
  userId: string;
  awareness: AwarenessState;
}

/** Build the payload sent to ALL clients when a new user joins. */
export function buildJoinedPayload(
  socketId: string,
  userId: string,
  awareness: AwarenessState,
): PresencePayload {
  return { socketId, userId, awareness };
}

/** Build the lean payload sent when a user's awareness changes. */
export function buildAwarenessPayload(
  socketId: string,
  awareness: AwarenessState,
): Pick<PresencePayload, 'socketId' | 'awareness'> {
  return { socketId, awareness };
}

/** Build the payload sent to all when a user leaves. */
export function buildLeftPayload(socketId: string): { socketId: string } {
  return { socketId };
}
