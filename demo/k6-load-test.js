/**
 * k6-load-test.js — CollabSync k6 WebSocket load test.
 *
 * ═══════════════════════════════════════════════════════════════
 * PROTOCOL OVERVIEW
 * ═══════════════════════════════════════════════════════════════
 *
 * CollabSync uses Socket.io v4, which sits on top of Engine.io v4.
 * k6's ws module sends raw WebSocket frames, so we implement the
 * Engine.io framing layer manually:
 *
 *   EIO packet types (prefix character in the text frame):
 *     '0' — OPEN       (server → client, handshake JSON)
 *     '2' — PING       (server → client, keep-alive)
 *     '3' — PONG       (client → server, keep-alive response)
 *     '4' — MESSAGE    (both directions, carries Socket.io payload)
 *     '5' — UPGRADE    (client → server, signals WS upgrade complete)
 *
 *   Socket.io packet types (second character after '4'):
 *     '0' — CONNECT    (server → client, namespace handshake)
 *     '2' — EVENT      (both directions, carries [eventName, data])
 *
 *   So a Socket.io EVENT looks like: '42["event", payload]'
 *
 * WHY direct WebSocket (no prior HTTP polling)?
 *   Engine.io v4 supports "direct WebSocket" connections where the
 *   client connects via WS without a prior polling handshake. The server
 *   sends the OPEN packet as the first WS frame. This halves the number
 *   of HTTP round-trips per VU, which is critical at 200 concurrent VUs.
 *
 * ═══════════════════════════════════════════════════════════════
 * LATENCY MEASUREMENT STRATEGY
 * ═══════════════════════════════════════════════════════════════
 *
 * We measure SERVER ROUND-TRIP TIME using the awareness:update event:
 *   1. Client sends awareness:update with cursor.anchor = Date.now()
 *   2. Server broadcasts to ALL room members INCLUDING the sender
 *   3. Client receives its own echo and computes RTT = now - cursor.anchor
 *
 * WHY awareness:update instead of doc:update?
 *   doc:update carries a Yjs binary that the server applies to the Y.Doc.
 *   If the binary is invalid or already seen (duplicate clientId+clock),
 *   the server silently drops it without broadcasting — breaking the RTT
 *   measurement. awareness:update is always re-broadcast unconditionally,
 *   making it a reliable RTT probe even under load.
 *
 * ═══════════════════════════════════════════════════════════════
 * TEST PHASES
 * ═══════════════════════════════════════════════════════════════
 *
 *   Phase 1 — Warm-up:   0 → 50 VUs  over 30s, hold 30s
 *   Phase 2 — Medium:  50 → 100 VUs  over 20s, hold 40s
 *   Phase 3 — Peak:   100 → 200 VUs  over 30s, hold 60s
 *   Phase 4 — Cool-down: 200 → 0    over 20s
 *   Total: ~230s (~4 min)
 *
 * USAGE:
 *   # Two-instance test (nginx load balancer):
 *   k6 run --env TARGET=http://localhost k6-load-test.js --out json=results-2inst.json
 *
 *   # Single-instance test (direct to server1):
 *   k6 run --env TARGET=http://localhost:3001 k6-load-test.js --out json=results-1inst.json
 */

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate, Gauge } from 'k6/metrics';

// ─────────────────────────────────────────────────────────────
// Custom metrics
// ─────────────────────────────────────────────────────────────

/** Round-trip time: time from sending awareness:update to receiving the echo. */
const wsRttMs = new Trend('ws_rtt_ms', true);

/** Time from WebSocket connect() call to receiving Socket.io CONNECT (40). */
const wsConnectMs = new Trend('ws_connect_ms', true);

/** Total Socket.io event messages received across all VUs. */
const wsMsgsReceived = new Counter('ws_msgs_received');

/** Total Socket.io event messages sent across all VUs. */
const wsMsgsSent = new Counter('ws_msgs_sent');

/** Fraction of VUs that failed to connect or received a socket error. */
const wsErrorRate = new Rate('ws_error_rate');

/** Number of awareness:update echoes successfully matched (RTT samples). */
const wsRttSamples = new Counter('ws_rtt_samples');

// ─────────────────────────────────────────────────────────────
// Test configuration
// ─────────────────────────────────────────────────────────────

const TARGET     = __ENV.TARGET      || 'http://localhost';
const DOC_ID     = __ENV.DOC_ID      || 'k6-load-test';
const VU_RUNTIME = parseInt(__ENV.VU_RUNTIME_MS || '120000', 10); // 2 min per VU
const EDIT_INTERVAL_MS = 500; // each VU sends one awareness:update every 500ms

// Derived WebSocket URL: http://localhost → ws://localhost
const WS_URL = TARGET.replace(/^http/, 'ws') +
  `/socket.io/?EIO=4&transport=websocket`;

// ─────────────────────────────────────────────────────────────
// k6 scenario configuration
// ─────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    warmup: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },  // ramp to 50
        { duration: '30s', target: 50 },  // hold at 50
      ],
      gracefulRampDown: '10s',
      tags: { phase: 'warmup_50' },
    },
    medium_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 100 }, // ramp from 0 to 100
        { duration: '40s', target: 100 }, // hold at 100
      ],
      startTime: '70s',  // begins after warmup ends
      gracefulRampDown: '10s',
      tags: { phase: 'medium_100' },
    },
    peak_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 200 }, // ramp to 200
        { duration: '60s', target: 200 }, // hold at 200 — this is the 2-min stress period
        { duration: '20s', target: 0 },   // cool-down
      ],
      startTime: '140s', // begins after medium_load ends
      gracefulRampDown: '15s',
      tags: { phase: 'peak_200' },
    },
  },

  thresholds: {
    // p95 round-trip must be under 300ms for real-time feel
    ws_rtt_ms:     ['p(95)<300', 'p(99)<1000'],
    // Connection setup must be under 2 s even at peak
    ws_connect_ms: ['p(95)<2000'],
    // Fewer than 5% of VUs should encounter errors
    ws_error_rate: ['rate<0.05'],
  },
};

// ─────────────────────────────────────────────────────────────
// Engine.io / Socket.io helpers
// ─────────────────────────────────────────────────────────────

/**
 * Encode a Socket.io EVENT packet.
 * Format: '42' + JSON.stringify([eventName, payload])
 *
 * WHY manual encoding?
 * k6 doesn't include socket.io-client. We implement only the subset of the
 * Socket.io v4 protocol that CollabSync uses (EVENT type on namespace '/').
 */
function encodeEvent(eventName, payload) {
  return '42' + JSON.stringify([eventName, payload]);
}

/**
 * Decode a Socket.io EVENT packet. Returns null if the frame is not an event.
 */
function decodeEvent(frame) {
  if (typeof frame !== 'string') return null;
  if (frame.startsWith('42')) {
    try {
      const parsed = JSON.parse(frame.slice(2));
      return { event: parsed[0], data: parsed[1] };
    } catch {
      return null;
    }
  }
  if (frame.startsWith('45')) {
    const index = frame.indexOf('[');
    if (index === -1) return null;
    try {
      const parsed = JSON.parse(frame.slice(index));
      return { event: parsed[0], data: parsed[1] };
    } catch {
      return null;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// VU main function
// ─────────────────────────────────────────────────────────────

export default function () {
  const vuId    = `k6-vu-${__VU}`;
  const myColor = `hsl(${(__VU * 137) % 360}, 70%, 55%)`; // unique color per VU

  // Track state for RTT measurement
  let pendingSyncStart = null;

  let connected = false;
  let mySocketId = null;
  const connectStart = Date.now();
  let hadError = false;

  const response = ws.connect(WS_URL, {
    // WHY these headers?
    // Engine.io checks the Origin header against allowed CORS origins.
    // Our server allows 'http://localhost:5173' (Vite dev) and 'http://localhost'.
    // Using 'http://localhost' matches the CLIENT_ORIGIN env-var in docker-compose.
    headers: { 'Origin': TARGET },
  }, function (socket) {

    // ── Engine.io / Socket.io handshake ───────────────────────

    socket.on('open', function () {
      // k6 connected the WebSocket; wait for Engine.io OPEN packet.
    });

    socket.on('message', function (frame) {
      // ── Engine.io PING keep-alive ──────────────────────────
      // Server sends '2' every pingInterval ms; we must reply '3' within
      // pingTimeout ms or the server closes the connection.
      if (frame === '2') {
        socket.send('3');
        return;
      }

      // ── Engine.io OPEN handshake ───────────────────────────
      // First frame after connection: '0{"sid":"...","pingInterval":...}'
      if (frame.startsWith('0')) {
        // Send Socket.io CONNECT packet to request namespace connection.
        socket.send('40');
        return;
      }

      // ── Socket.io CONNECT (namespace '/') ──────────────────
      // Frame: '40' or '40{"sid":"..."}'
      if (frame.startsWith('40')) {
        const connectMs = Date.now() - connectStart;
        wsConnectMs.add(connectMs);
        connected = true;

        // Extract the Socket.io socket ID from the connect packet if present.
        try {
          const payload = JSON.parse(frame.slice(2));
          mySocketId = payload.sid;
        } catch {
          // Some versions send '40' without a JSON body — that's fine.
        }

        // Join the collaborative document room.
        socket.send(encodeEvent('doc:join', {
          docId: DOC_ID,
          userId: vuId,
          userInfo: { name: vuId, color: myColor },
        }));
        wsMsgsSent.add(1);
        return;
      }

      // ── Socket.io EVENT messages ───────────────────────────
      const decoded = decodeEvent(frame);
      if (!decoded) return;

      wsMsgsReceived.add(1);
      const { event, data } = decoded;

      // doc:load — server confirms we've joined and sends current doc state or sync delta.
      if (event === 'doc:load') {
        if (pendingSyncStart !== null) {
          const rtt = Date.now() - pendingSyncStart;
          wsRttMs.add(rtt);
          wsRttSamples.add(1);
          pendingSyncStart = null;
        }
        return;
      }
    });

    socket.on('error', function (e) {
      hadError = true;
      wsErrorRate.add(1);
    });

    // ── Periodic edits & latency measurement ──────────────────
    socket.setInterval(function () {
      if (!connected) return;

      // 1. Send awareness:update to simulate a small cursor edit
      socket.send(encodeEvent('awareness:update', {
        docId: DOC_ID,
        state: {
          user: { name: vuId, color: myColor },
          cursor: { anchor: Date.now(), head: Date.now() },
        },
      }));
      wsMsgsSent.add(1);

      // 2. Send doc:sync-request to measure message round-trip latency
      if (pendingSyncStart === null) {
        pendingSyncStart = Date.now();
        socket.send(encodeEvent('doc:sync-request', {
          docId: DOC_ID,
          stateVector: [0],
        }));
        wsMsgsSent.add(1);
      }
    }, EDIT_INTERVAL_MS);

    // ── VU lifetime ────────────────────────────────────────────
    // Each VU runs for VU_RUNTIME ms (default 2 min = 120,000 ms).
    socket.setTimeout(function () {
      socket.close();
    }, VU_RUNTIME);
  });

  // Record connection success/failure.
  const connectedOk = check(response, {
    'WebSocket handshake succeeded (101)': (r) => r && r.status === 101,
  });

  if (!connectedOk || hadError) {
    wsErrorRate.add(1);
  } else {
    wsErrorRate.add(0);
  }
}
