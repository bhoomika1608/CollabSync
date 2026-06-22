/**
 * api.ts — REST endpoints for health checks and document metadata.
 *
 * WHY REST alongside Socket.io?
 * ─────────────────────────────────────────────────────────────────
 * Not all consumers need a live WebSocket. Load balancers, monitoring
 * systems, and the React app's initial page load (to fetch the list of
 * documents) benefit from a stateless REST interface. Keeping these
 * concerns separate also makes the socket layer simpler: it handles
 * real-time events only, not request/response document listing.
 */

import { Router, Request, Response } from 'express';
import * as Y from 'yjs';
import { _getRooms, getRoomClients } from '../yjs/yjsRoom';

export const apiRouter = Router();

// ── GET /api/health ────────────────────────────────────────────────
// Used by Docker Compose healthcheck and load balancers to determine
// if this instance is alive. Returns 200 when the event loop is running.
apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    pid: process.pid,
  });
});

// ── GET /api/docs ─────────────────────────────────────────────────
// Lists all documents currently in memory with their active client count.
// The React frontend uses this to populate the document list on the home page.
apiRouter.get('/docs', (_req: Request, res: Response) => {
  const rooms = _getRooms();
  const docs = Array.from(rooms.entries()).map(([docId, room]) => ({
    docId,
    activeClients: room.clients.size,
    updatesSinceSnapshot: room.updatesSinceSnapshot,
  }));
  res.json({ docs });
});

// ── GET /api/docs/:docId ───────────────────────────────────────────
// Returns metadata and the current presence list for a specific document.
// The React client uses this to show "who else is here" before the
// WebSocket connection is established.
apiRouter.get('/docs/:docId', (req: Request, res: Response) => {
  const { docId } = req.params;
  const rooms = _getRooms();

  if (!rooms.has(docId)) {
    res.status(404).json({ error: 'Document not found in memory.' });
    return;
  }

  const clients = getRoomClients(docId).map((c) => ({
    socketId: c.socketId,
    userId: c.userId,
    awareness: c.awareness,
  }));

  const room = rooms.get(docId)!;

  // Encode state vector for diagnostic purposes.
  // WHY expose state vector? Useful for debugging: you can compare
  // the server's state vector with a client's to spot divergence.
  const sv = Y.encodeStateVector(room.doc);

  res.json({
    docId,
    activeClients: clients.length,
    clients,
    stateVector: Array.from(sv),
  });
});
