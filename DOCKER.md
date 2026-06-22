# CollabSync — Docker Setup & Operations Guide

## Quick Start

```bash
# 1. Build images and start all services
docker compose up --build -d

# 2. Watch logs (both server instances + nginx)
docker compose logs -f server1 server2

# 3. Verify all services are healthy
docker compose ps
```

Wait until every service shows `healthy` (≈ 30 s for MongoDB on first run).

---

## Running the Cross-Instance Demo

The demo script proves that a Yjs edit sent to **server:1** reaches a client connected to **server:2** through Redis — not through a direct server-to-server connection.

```bash
cd demo
npm install
node cross-instance-test.js
```

Expected output:

```
╔══════════════════════════════════════════════════════╗
║   CollabSync — Cross-Instance Redis Pub/Sub Test     ║
╚══════════════════════════════════════════════════════╝

  Document ID : cross-instance-1718569001234
  Server A    : http://localhost:3001 (server:1)
  Server B    : http://localhost:3002 (server:2)

[SETUP] Connecting clients to separate instances…
  ✓ Client A connected → server:1 (http://localhost:3001)
  ✓ Client B connected → server:2 (http://localhost:3002)
  ✓ Both clients joined document "cross-instance-…"

[Test 1] Cross-instance delivery: Client A → Client B
  ✓ Received at Client B via server:2 in 8ms
  ✓ Content verified: "Hello from Instance A!"

[Test 2] Bidirectional: Client B → Client A
  ✓ Received at Client A via server:1 in 7ms
  ✓ Content verified: "Reply from Instance B!"

[Test 3] Rapid-fire: 20 updates A→B, no drops
  ✓ All 20/20 updates received
  ✓ Average delivery: 6ms

[Test 4] Latency stats over 50 samples
  ✓ 50 samples collected
       min:  3ms   p50:  7ms   p95:  18ms   max:  24ms

═══════════════════════════════════════════════════════
  RESULTS
═══════════════════════════════════════════════════════
  ✓ T1 A→B basic delivery       (8ms)
  ✓ T2 B→A bidirectional        (7ms)
  ✓ T3 20 rapid updates         (6ms)
  ✓ T4 latency p95 ≤ 500ms     (18ms)

  ✓ ALL TESTS PASSED — Redis pub/sub is working correctly.
```

---

## Service Architecture

```
                    ┌──────────────┐
  Browser / curl    │    nginx     │  :80 (round-robin, WebSocket proxy)
  ───────────────▶  │   :80        │
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        ┌──────────┐             ┌──────────┐
        │ server:1 │             │ server:2 │
        │  :3001   │             │  :3001   │
        └──────┬───┘             └──────┬───┘
               │                       │
               └──────────┬────────────┘
                           │  Redis Pub/Sub
                    ┌──────▼──────┐
                    │   redis:7   │
                    │   :6379     │
                    └──────┬──────┘
                           │  (snapshots, Task C)
                    ┌──────▼──────┐
                    │  mongo:7    │
                    │  :27017     │
                    └─────────────┘
```

---

## Redis Pub/Sub — How It Works

When a client connected to **server:1** makes a Yjs edit:

1. `server:1` applies the update to its in-memory `Y.Doc` (CRDT merge).
2. `server:1` calls `io.to(docId).emit('doc:update', update)`.
3. The `@socket.io/redis-adapter` **publishes** the update to Redis channel  
   `socket.io#/#<docId>#`.
4. **server:2** is subscribed to that channel.  
5. The adapter on `server:2` receives the message and **re-emits** it locally.
6. The client connected to `server:2` receives `doc:update` and applies it.

No direct TCP connection between server:1 and server:2. Redis is the only bridge.

---

## What Happens When Redis Goes Down

### Phase 1 — Outage (seconds 0–N)

| What breaks | What keeps working |
|---|---|
| Cross-instance update delivery | Local clients on the SAME server |
| Cross-instance cursor/presence | Local cursor sync on same server |
| Cross-instance presence join/leave | REST API (`/api/health`, `/api/docs`) |

**Why doesn't the server crash?**  
The `pubClient` has `enableOfflineQueue: false`. PUBLISH commands fail
immediately and the adapter's internal try-catch absorbs the error. The
`io.emit()` call still delivers to local sockets and returns normally.

**What do clients on different instances see?**  
Their Y.Docs temporarily diverge — each instance accumulates local edits
that the other hasn't seen. The editor remains fully usable for anyone on
the same instance.

### Phase 2 — Recovery (Redis reconnects)

1. `ioredis` detects the connection is back (via TCP reconnect).
2. The `subClient` automatically re-issues `SUBSCRIBE` commands (ioredis
   internal reconnect logic).
3. New updates start flowing cross-instance again.

**How do diverged Y.Docs reconcile?**

The next time any client makes an edit (which will be re-broadcast) or
reconnects its WebSocket, the Yjs CRDT merges the diverged states
automatically. Specifically:

- Client reconnects → sends `doc:sync-request` with its state vector.
- Server replies with the delta (everything it has that the client doesn't).
- Client applies the delta → both client and server converge.

No manual conflict resolution. No data loss. The CRDT's commutativity
guarantees that all replicas reach the same final state regardless of the
order in which they receive updates.

### Simulating a Redis Outage (for testing)

```bash
# 1. Pause Redis (simulates network partition)
docker compose pause redis

# 2. Make edits in two browser tabs on different instances
#    (open localhost:3001 and localhost:3002 directly)
#    → edits stay local, don't cross instances

# 3. Restore Redis
docker compose unpause redis

# 4. Make any new edit or refresh a tab
#    → both instances reconcile via state-vector delta sync
```

---

## Useful Commands

```bash
# View logs for a specific service
docker compose logs -f server1

# Restart one instance without downtime on the other
docker compose restart server2

# Connect to Redis CLI
docker compose exec redis redis-cli

# Check pub/sub activity in Redis
docker compose exec redis redis-cli MONITOR

# Connect to MongoDB shell
docker compose exec mongo mongosh collabsync

# Scale to 0 and back (stops/starts an instance)
docker compose stop server1
docker compose start server1

# Tear down everything (preserves mongo_data volume)
docker compose down

# Tear down and wipe all data
docker compose down -v
```

---

## Port Reference

| Port | Service | Notes |
|---|---|---|
| **:80** | nginx | Main entry point — round-robin to server:1 and server:2 |
| **:3001** | server:1 | Direct access (bypasses nginx) — used by demo script |
| **:3002** | server:2 | Direct access (bypasses nginx) — used by demo script |
| **:6379** | Redis | Exposed for `redis-cli` debugging on the host |
| **:27017** | MongoDB | Exposed for `mongosh` debugging on the host |

---

## Why Round-Robin Without Sticky Sessions Works

Socket.io's HTTP long-polling requires sticky sessions — each poll request
must reach the same server instance (because the session ID is stored in
memory there). Round-robin without `ip_hash` would break long-polling.

We resolve this by configuring clients to use **WebSocket-only transport**
(`transports: ['websocket']`). WebSocket establishes one persistent TCP
connection that stays with one server for its lifetime — no polling, no
session fragmentation.

The Redis adapter then handles the broadcast layer: any server can receive
an edit from its local client and relay it to every other server's clients.
No server is "authoritative" for any room from the network's perspective.

If you need long-polling support (corporate proxies, strict firewalls),
add the following to `nginx/nginx.conf` inside the `upstream` block:

```nginx
hash $remote_addr consistent;
```

This activates IP-hash sticky routing and restores long-polling compatibility
at the cost of less even load distribution.
