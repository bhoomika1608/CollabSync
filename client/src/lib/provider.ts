/**
 * provider.ts — Socket.io ↔ Y.Doc bridge (the CollabSync client transport layer).
 *
 * This class is the client-side counterpart to server/src/socket/handlers.ts.
 * It speaks the exact same custom protocol — doc:join, doc:update, doc:sync-request,
 * awareness:update — instead of using y-websocket's binary protocol.
 *
 * WHY a custom provider instead of y-websocket?
 * ─────────────────────────────────────────────
 * y-websocket only works with a WebSocket server that speaks the y-protocols
 * binary sync format. Our server uses Socket.io (for cross-instance pub-sub
 * via Redis) with a custom JSON+binary envelope. A custom provider gives us:
 *   1. Full control over the reconnect/delta-sync flow.
 *   2. Integrated presence/awareness using the server's own AwarenessState shape.
 *   3. A pending-update counter for the offline indicator.
 */

import * as Y from 'yjs';
import { io, Socket } from 'socket.io-client';

// ─────────────────────────────────────────────────────────────
// Types (mirroring server's AwarenessState)
// ─────────────────────────────────────────────────────────────

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface RemoteUser {
  socketId: string;
  userId: string;
  name: string;
  color: string;
  /** Selection range in the shared Y.Text. null = cursor unknown. */
  cursor: { anchor: number; head: number } | null;
}

// ─────────────────────────────────────────────────────────────
// CollabSyncProvider
// ─────────────────────────────────────────────────────────────

export class CollabSyncProvider {
  /** The CRDT document. Shared text lives at ydoc.getText('content'). */
  readonly ydoc: Y.Doc;
  /** Convenience reference to the shared text type. */
  readonly ytext: Y.Text;
  /** The Socket.io connection — exposed so callers can check socket.id. */
  readonly socket: Socket;

  readonly userId: string;
  userName: string;
  readonly userColor: string;
  private readonly docId: string;

  status: ConnectionStatus = 'connecting';
  /** Count of local edits queued while the socket was disconnected. */
  pendingUpdates = 0;
  /** Live map: socketId → RemoteUser. */
  remoteUsers: Map<string, RemoteUser> = new Map();

  // ── Callbacks ─────────────────────────────────────────────
  onStatusChange?: (status: ConnectionStatus, pending: number) => void;
  onUsersChange?: (users: RemoteUser[]) => void;

  constructor(
    serverUrl: string,
    docId: string,
    userId: string,
    userName: string,
    userColor: string,
  ) {
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText('content');
    this.docId = docId;
    this.userId = userId;
    this.userName = userName;
    this.userColor = userColor;

    // Connect to Socket.io.
    // WHY window.location.origin instead of a hardcoded URL?
    // In dev, Vite proxies /socket.io → nginx → backend, so the origin
    // matches the dev server (no CORS issue). In production, the static
    // files are served from the same origin as the API.
    this.socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });

    this._setupSocket();
    this._setupDocObserver();
  }

  // ── Socket event handlers ──────────────────────────────────

  private _setupSocket(): void {
    const { socket } = this;

    // ── connect ───────────────────────────────────────────────
    socket.on('connect', () => {
      this.status = 'connected';
      this.pendingUpdates = 0;
      // Join the shared document — server creates the Y.Doc room if needed.
      socket.emit('doc:join', {
        docId: this.docId,
        userId: this.userId,
        userInfo: { name: this.userName, color: this.userColor },
      });
      this.onStatusChange?.('connected', 0);
    });

    // ── disconnect ────────────────────────────────────────────
    socket.on('disconnect', () => {
      this.status = 'offline';
      // Clear remote cursors — they are ephemeral and tied to live connections.
      this.remoteUsers.forEach(u => { u.cursor = null; });
      this.onStatusChange?.('offline', this.pendingUpdates);
      this.onUsersChange?.([...this.remoteUsers.values()]);
    });

    // ── reconnect (fired by socket.io manager after a successful reconnect) ──
    // WHY delta sync instead of full re-join?
    // We already have most of the document in the local Y.Doc. Sending the
    // state vector lets the server reply with ONLY the ops we missed while
    // offline — potentially a few bytes instead of the full document.
    socket.io.on('reconnect', () => {
      this.status = 'reconnecting';
      this.onStatusChange?.('reconnecting', this.pendingUpdates);

      const sv = Y.encodeStateVector(this.ydoc);
      socket.emit('doc:sync-request', {
        docId: this.docId,
        stateVector: Array.from(sv),
      });
      // Re-join to restore presence entry on the server.
      socket.emit('doc:join', {
        docId: this.docId,
        userId: this.userId,
        userInfo: { name: this.userName, color: this.userColor },
      });
    });

    // ── doc:load ──────────────────────────────────────────────
    // Server sends the full (or delta) state on join / sync-request.
    socket.on('doc:load', ({ update, clients }: {
      update: ArrayBuffer | number[];
      clients: Array<{ socketId: string; userId: string; awareness: { user: { name: string; color: string }; cursor?: { anchor: number; head: number } | null } }>;
    }) => {
      // Apply into the local Y.Doc. 'server' origin prevents echo-back.
      Y.applyUpdate(this.ydoc, new Uint8Array(update), 'server');
      this.status = 'connected';
      this.pendingUpdates = 0;

      // Rebuild presence list from the server's snapshot.
      this.remoteUsers.clear();
      for (const c of clients) {
        if (c.socketId === socket.id) continue; // skip self
        this.remoteUsers.set(c.socketId, {
          socketId: c.socketId,
          userId: c.userId,
          name: c.awareness?.user?.name ?? c.userId,
          color: c.awareness?.user?.color ?? '#888888',
          cursor: c.awareness?.cursor ?? null,
        });
      }

      this.onStatusChange?.('connected', 0);
      this.onUsersChange?.([...this.remoteUsers.values()]);
    });

    // ── doc:update ────────────────────────────────────────────
    // Relayed update from another client (or from another server instance
    // via the Redis adapter). Apply it into our local Y.Doc.
    socket.on('doc:update', ({ update }: { update: ArrayBuffer | number[] }) => {
      Y.applyUpdate(this.ydoc, new Uint8Array(update), 'server');
      // The Y.Text observer in CollabEditor will pick this up automatically.
    });

    // ── awareness:update ──────────────────────────────────────
    // Another client moved their cursor. Update the remote user map.
    socket.on('awareness:update', ({ socketId, awareness }: {
      socketId: string;
      awareness: { user?: { name: string; color: string }; cursor?: { anchor: number; head: number } | null };
    }) => {
      const user = this.remoteUsers.get(socketId);
      if (!user) return;
      if (awareness?.user) {
        user.name = awareness.user.name;
        user.color = awareness.user.color;
      }
      if (awareness?.cursor != null) {
        user.cursor = awareness.cursor;
      } else {
        user.cursor = null;
      }
      this.onUsersChange?.([...this.remoteUsers.values()]);
    });

    // ── presence:joined ───────────────────────────────────────
    socket.on('presence:joined', ({ socketId, userId, awareness }: {
      socketId: string;
      userId: string;
      awareness: { user: { name: string; color: string } };
    }) => {
      this.remoteUsers.set(socketId, {
        socketId,
        userId,
        name: awareness?.user?.name ?? userId,
        color: awareness?.user?.color ?? '#888888',
        cursor: null,
      });
      this.onUsersChange?.([...this.remoteUsers.values()]);
    });

    // ── presence:left ─────────────────────────────────────────
    socket.on('presence:left', ({ socketId }: { socketId: string }) => {
      this.remoteUsers.delete(socketId);
      this.onUsersChange?.([...this.remoteUsers.values()]);
    });
  }

  // ── Y.Doc observer ────────────────────────────────────────

  private _setupDocObserver(): void {
    // WHY listen to ydoc 'update' instead of ytext.observe?
    // ytext.observe fires for every individual text operation. ydoc 'update'
    // fires with the binary-encoded update that's already suitable to send
    // over the wire — no re-encoding needed.
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      // Skip updates that arrived FROM the server (would cause echo-back loop).
      if (origin === 'server') return;

      if (this.socket.connected) {
        this.socket.emit('doc:update', {
          docId: this.docId,
          update: Array.from(update), // Array<number> survives JSON serialisation
        });
      } else {
        // Offline: count the queued updates for the indicator.
        this.pendingUpdates++;
        this.onStatusChange?.(this.status, this.pendingUpdates);
      }
    });
  }

  // ── Public helpers ─────────────────────────────────────────

  /** Updates the local user's name and broadcasts the update immediately. */
  updateName(name: string): void {
    this.userName = name;
    if (this.socket.connected) {
      this._emitCursorUpdate(this._lastPendingPosition);
    }
  }

  private _lastCursorUpdateSentAt = 0;
  private _pendingCursorTimeout: ReturnType<typeof setTimeout> | null = null;
  private _lastPendingPosition: { anchor: number; head: number } | null = null;

  /**
   * Broadcast this user's cursor position to all other clients (throttled to 100ms).
   * Called by CollabEditor on every selection change.
   * selection = null clears the cursor (user blurred the editor).
   */
  sendCursorUpdate(selection: { anchor: number; head: number } | null): void {
    if (!this.socket.connected) return;

    this._lastPendingPosition = selection;
    const now = Date.now();
    const timeSinceLast = now - this._lastCursorUpdateSentAt;

    if (timeSinceLast >= 100) {
      this._emitCursorUpdate(selection);
    } else {
      if (this._pendingCursorTimeout) {
        clearTimeout(this._pendingCursorTimeout);
      }
      this._pendingCursorTimeout = setTimeout(() => {
        this._emitCursorUpdate(this._lastPendingPosition);
        this._pendingCursorTimeout = null;
      }, 100 - timeSinceLast);
    }
  }

  private _emitCursorUpdate(selection: { anchor: number; head: number } | null): void {
    this.socket.emit('awareness:update', {
      docId: this.docId,
      state: {
        user: { name: this.userName, color: this.userColor },
        cursor: selection,
      },
    });
    this._lastCursorUpdateSentAt = Date.now();
  }

  /** Clean up resources. Call on component unmount. */
  destroy(): void {
    if (this._pendingCursorTimeout) {
      clearTimeout(this._pendingCursorTimeout);
    }
    this.socket.emit('doc:leave', { docId: this.docId });
    this.socket.disconnect();
    this.ydoc.destroy();
  }
}
