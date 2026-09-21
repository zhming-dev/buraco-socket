# Socket Server Deploy Topology (PTW-34 / PTW-30 #9 / PTW-43)

Status: **Single-instance enforced** (interim). Multi-node is being built in
stages under PTW-43 — see "Path to multi-node" below.

## CTO decision (PTW-43, 2026-06-11)

**Build multi-node in stages; do NOT raise replica count yet.** Single-instance
remains the enforced production topology until the Redis adapter (Phase 1), the
room-owner lease + cross-node action forwarding (Phase 2), and a soak test at
the target concurrency tier (Phase 6) all land and pass. Rationale: at current
v1 load a single node is well within capacity, and raising replicas before the
owner-lease ships would cause split-brain room mutation (two nodes advancing the
same room's turn). The foundation is being built now so the ceiling can be
lifted safely the moment load data warrants it — not under fire.

Shipped in this stage (Phase 1 + Phase 2 primitive):

- `@socket.io/redis-adapter` wiring in `src/index.js`, **flag-gated OFF**
  (`REDIS_ADAPTER_ENABLED`, default `false`) with **fail-fast** boot: if enabled
  it refuses to start unless the Redis pub/sub clients connect within
  `REDIS_ADAPTER_CONNECT_TIMEOUT_MS`. Config rejects the flag without a real
  Redis. With the flag off, behavior is identical to the previous single-node.
- Stable per-node identity (`NODE_ID`, else `hostname:pid:rand`).
- `RoomOwnerLease` primitive (`src/managers/RoomOwnerLease.js`, unit-tested):
  `room:{id}:owner = nodeId` with TTL, atomic acquire/renew/release.
- **(PTW-57, done)** `RoomOwnerLease` is now wired into all 8 mutating actions via
  `_runOwnedSocketMutation`: the owner node mutates, non-owner nodes forward the
  action to the owner over `serverSideEmitWithAck`. Cross-node broadcast fan-out
  is proven by `test/multinode_adapter.test.js`.

Still required before `replicas > 1` (PTW-40 hard gate):

1. **Sticky sessions at the LB** — configured in
   [`MULTINODE_RUNBOOK.md`](./MULTINODE_RUNBOOK.md) §2. Load-bearing for
   correctness today (room join requires the room to be local; cross-node
   rehydration is Phase 3, not yet built).
2. **Load + soak test** at the agreed concurrency tier on staging infra (Phase 6,
   owned by PTW-58). Driver is multi-node-aware: `bot/load-soak.js --socket-urls`.

## Current constraint: ONE socket instance only

The realtime socket server keeps authoritative game state **in process**
(`GameService`, `GameRoom`, `PlayerSession`) and drives per-room timers and bot
turns locally. There is currently **no Socket.IO Redis adapter**, so:

- A second instance behind a load balancer would **split-brain**: clients in the
  same room landing on different nodes would not receive each other's broadcasts,
  and two nodes could both advance the same room's turn.
- A crash or rolling deploy **drops every live game** on that node.

Therefore the production deploy MUST run **exactly one** socket instance until the
multi-node work (Redis adapter + room-owner lease + soak test) lands.

### Enforcement

1. **Redis is mandatory in production (D2).** `validateConfig()`
   (`src/config/index.js`) refuses to boot when `NODE_ENV=production` and neither
   `REDIS_URL` nor `REDIS_HOST` is set. Redis is required for durable reconnection
   / state persistence even on a single node, and is the prerequisite for the
   future adapter.
2. **Process manager replica count = 1.** Configure the orchestrator for a single
   replica and disable horizontal autoscaling for this service:
   - Kubernetes: `replicas: 1`, no HPA on the socket Deployment.
   - PM2: `instances: 1` (do **not** use `cluster` mode / `-i max`).
   - Docker Compose / ECS: desired count `1`.
3. **Rolling deploy = brief downtime, NOT lost games.** `SIGTERM`/`SIGINT` run a
   restart drain: every room is snapshotted to Redis (exact turn time left,
   intermission deadline), clients get `server_restarting` and auto-reconnect,
   and the next boot HOLDS each restored room until a player rejoins, then resumes
   the interrupted turn. Requires a durable Redis and a supervisor that restarts
   the process. Full contract + runbook: [`RESTART_RESILIENCE.md`](RESTART_RESILIENCE.md).
   Still prefer low-traffic windows: players see a few seconds of reconnecting.

## Path to multi-node (deferred)

Tracked by **PTW-40** (post-launch hard gate) and the staged plan in
[`../../socket_scaling_plan.md`](../../socket_scaling_plan.md). Minimum to lift the
single-instance ceiling:

1. **Redis adapter** — `@socket.io/redis-adapter` wired in `src/index.js` so room
   broadcasts fan out across nodes; fail-fast if the adapter can't connect.
2. **Sticky sessions** at the load balancer (transition aid only, not relied on
   for correctness).
3. **Per-room owner lease** in Redis (`room:{id}:owner = nodeId`, TTL + renewal)
   so exactly one node mutates a room's turn/timer/bot state; non-owners forward
   mutating actions to the owner.
4. **Load + soak test** at the agreed concurrency tier before enabling >1 replica.

Only after (1)–(4) ship and pass soak testing should the replica count be raised.

## Decision owner

The topology decision is owned by the CTO and was made in **PTW-38** (D2): ship
**single-node for v1** with Redis required at boot and single-instance enforced;
defer multi-node (Redis adapter + per-room owner lease + load/soak test) to
**PTW-40** as a post-launch hard gate. This document records the runtime
implications of that decision. (Originally framed under PTW-30 #9.)
