# Brazilia Socket Server SDK

Professional real-time Brazilia game server built with Socket.IO.  
This project is the **realtime engine** for room state, turn actions, and game lifecycle, and it is designed to be integrated with an external backend (Laravel or any server) through webhooks.

## What this project is

- Realtime multiplayer server for Brazilia (`src/index.js`)
- Socket event handlers for players/spectators (`src/handlers/SocketHandlers.js`)
- Core game state + rules (`src/models`, `src/services`, `src/validators`, `src/handlers/ActionHandlers.js`)
- Reliability layer for reconnect/disconnect recovery (`src/managers/FailureManager.js`)
- Optional outbound webhook relay to your backend (`src/integrations/PartnerWebhookRelay.js`)
- Optional bot tools for simulation and operational testing (`bot/`)

---

## Quick integration (server-side)

### 1) Install and run

```bash
cd socket
npm install
cp .env.example .env
npm run dev
```

Default server:
- Host: `0.0.0.0`
- Port: `8080`

### 2) Configure environment

Main variables in `.env`:

- `PORT`, `HOST`, `NODE_ENV`
- `WEBHOOK_SECRET` (protect inbound webhook endpoints)
- `PARTNER_WEBHOOK_URL` (where this server sends outbound gameplay events)
- `PARTNER_WEBHOOK_SECRET` (HMAC signing secret for outbound events)
- `PARTNER_WEBHOOK_EVENTS` (comma-separated allowlist)

### 3) Backend-to-socket synchronization flow (recommended)

When your backend creates/updates room metadata:

1. Call `POST /webhooks/sync-room`
2. Players connect with `join_room` using same `roomId`
3. When backend decides room is ready, call `POST /webhooks/start-game`

This avoids race conditions and keeps room ownership in backend domain logic.

---

## Inbound webhooks your backend must send

All endpoints are served by `src/index.js`.  
If `WEBHOOK_SECRET` is configured, include header:

`x-webhook-secret: <WEBHOOK_SECRET>`

### A) Sync room into realtime memory

`POST /webhooks/sync-room`

Purpose: create/update runtime room state before players join.

Request body:

```json
{
  "roomId": "12345",
  "maxPlayers": 4,
  "ruleset": "professional",
  "professionalWellMode": "direct",
  "hostPlayerId": "user-1",
  "skins": {
    "table_skin": "green",
    "card_skin": "classic"
  },
  "status": "open"
}
```

Response:

```json
{
  "success": true,
  "roomId": "12345",
  "maxPlayers": 4,
  "playerCount": 0
}
```

### B) Trigger game start from backend

`POST /webhooks/start-game`

Purpose: start game without requiring host client action.

Request body:

```json
{
  "roomId": "12345",
  "turnTimeLimitSeconds": 45,
  "skins": {
    "table_skin": "green",
    "card_skin": "classic"
  }
}
```

Response (`success` / `alreadyStarted` possible):

```json
{
  "success": true
}
```

`turnTimeLimitSeconds` is a start-time option. Send it with `start-game` when
the room owner chooses a custom timer for that match. If omitted, the socket
uses the built-in fallback `30`.

The socket clamps custom values to `5..600` seconds to avoid accidental invalid
or multi-hour timers. `turnTimeLimit` is accepted as an alias for
`turnTimeLimitSeconds`.

### C) Query realtime room runtime snapshot

`POST /webhooks/room-runtime`

Purpose: backend reconciliation/checks for room presence and connected players.

Request body:

```json
{
  "roomId": "12345"
}
```

Response when room exists:

```json
{
  "success": true,
  "roomId": "12345",
  "exists": true,
  "status": "inProgress",
  "maxPlayers": 4,
  "turnTimeLimitSeconds": 45,
  "hostPlayerId": "user-1",
  "playerCount": 2,
  "playerIds": ["user-1", "user-2"],
  "players": [
    { "playerId": "user-1", "playerIndex": 0, "isConnected": true },
    { "playerId": "user-2", "playerIndex": 1, "isConnected": false }
  ]
}
```

Response when room does not exist:

```json
{
  "success": true,
  "roomId": "12345",
  "exists": false,
  "playerCount": 0,
  "playerIds": []
}
```

---

## Outbound webhooks your backend should consume

If `PARTNER_WEBHOOK_URL` is set, this server sends gameplay events to your backend (`POST` JSON).

### Headers

- `Content-Type: application/json`
- `X-SDK-Event`: event name
- `X-SDK-Event-Id`: unique id
- `X-SDK-Timestamp`: ISO timestamp
- `X-SDK-Signature`: `sha256=<hmac>` (present when `PARTNER_WEBHOOK_SECRET` configured)

### Base envelope

Each webhook body includes:

```json
{
  "event": "turn.completed",
  "eventId": "<hex>",
  "timestamp": "2026-03-05T10:00:00.000Z",
  "...eventSpecificFields": true
}
```

### Event payloads currently emitted

#### `game.started`

```json
{
  "event": "game.started",
  "roomId": "12345",
  "players": [
    { "playerId": "user-1", "playerName": "Alice", "playerIndex": 0 },
    { "playerId": "user-2", "playerName": "Bob", "playerIndex": 1 }
  ],
  "currentPlayerIndex": 0,
  "source": "webhook"
}
```

`source` is optional and may appear when start is triggered by backend webhook.

#### `player.status`

```json
{
  "event": "player.status",
  "roomId": "12345",
  "playerId": "user-2",
  "playerName": "Bob",
  "status": "disconnected"
}
```

Statuses observed: `reconnected`, `disconnected`.

#### `card.drawn`

```json
{
  "event": "card.drawn",
  "roomId": "12345",
  "playerId": "user-1",
  "playerIndex": 0,
  "fromDeck": true
}
```

#### `meld.played`

```json
{
  "event": "meld.played",
  "roomId": "12345",
  "playerId": "user-1",
  "playerIndex": 0,
  "meld": {
    "type": "meld_played",
    "playerIndex": 0,
    "cards": [
      { "suit": "hearts", "rank": "A" }
    ],
    "meldIndex": 0,
    "timestamp": "2026-03-05T10:00:00.000Z"
  }
}
```

#### `turn.completed`

```json
{
  "event": "turn.completed",
  "roomId": "12345",
  "playerId": "user-1",
  "playerIndex": 0,
  "data": {
    "type": "turn_completed",
    "discardedCard": { "suit": "clubs", "rank": "7" },
    "playerIndex": 0,
    "newTurnIndex": 1,
    "previousTurnIndex": 0,
    "discardPile": [
      { "suit": "clubs", "rank": "7" }
    ],
    "hasDrawnCard": false,
    "timestamp": "2026-03-05T10:00:00.000Z"
  }
}
```

#### `game.completed`

```json
{
  "event": "game.completed",
  "roomId": "12345",
  "winnerId": "user-1",
  "result": {
    "winnerId": "user-1",
    "winnerIndex": 0,
    "scores": {
      "user-1": 250,
      "user-2": 120
    }
  }
}
```

The exact shape of `result` depends on round finalization output from `ActionHandlers`.

---

## Socket client events (high level)

Incoming (client -> server):
- `join_room`, `leave_room`, `start_game`, `deal_cards`
- `draw_card`, `play_meld`, `discard_card`, `go_down`, `add_to_meld`, `pick_up_pile`, `take_pozzetto`
- `matchmaking:join`, `matchmaking:leave`, `matchmaking:status`

Outgoing (server -> client):
- `player_joined`, `player_left`, `player_disconnected`, `player_reconnected`, `host_changed`, `room_closed`
- `game_started`, `game_state_update`, `turn_completed`, `round_ended`, `game_ended`
- `card_drawn`, `meld_played`, `card_discarded`, `went_down`, `added_to_meld`, `pile_picked_up`, `pozzetto_taken`
- `server_restarting` — a deploy restart is about to close the socket; keep the session,
  let socket.io reconnect, then re-emit `join_room` (see `docs/RESTART_RESILIENCE.md`).
  Distinct from `development { restart_server: true }`, which means "leave the table".

See `src/constants/events.js` and `src/constants/matchmaking.js` for canonical names.

---

## Operational notes

- Room IDs are normalized to strings in runtime maps.
- Realtime server refuses implicit room creation when `join_room` provides unknown `roomId`; call `sync-room` first.
- In-memory Redis adapter (`src/utils/InMemoryRedis.js`) is used for failure-management state
  when no Redis is configured; with a real Redis, live games survive a process restart
  (`SIGTERM` / `pm2 restart` / `POST /webhooks/dev-restart { keep_sessions: true }`) and resume
  when players rejoin. See `docs/RESTART_RESILIENCE.md`.
- In production, validate and rotate webhook secrets regularly.
- Never commit real tokens/passwords in `bot/.env`.
- Per-game logs: every log line the server can attribute to a room is kept per room for at least 2h
  (finished games included) and readable from the dev console (`GET /dev` → Logs tab) or
  `GET /dev/api/rooms/<roomId>/logs`. See `docs/GAME_LOGS.md`.

---

## Directory documentation

Each folder in this project has a dedicated `README.md` explaining its responsibility, files, and integration role.
