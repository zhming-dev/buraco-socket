# Game logs and match replays

Two stores, two jobs:

| | Per-room log ring (`GameLogStore`) | Per-match event stream (`GameEventRecorder`) |
|---|---|---|
| What | every log line the server can attribute to a room | one compact event per game fact, replay-complete |
| Keyed by | room id | match id (a reused room gets a new match) |
| Forgets | yes: ring per room, global byte cap, 2h retention | no, within a byte budget; written to disk |
| Disk | optional JSONL per room (`GAME_LOG_FILE=true`) | gzipped JSON per match at every round end |
| Read by | dev console **Raw log** | dev console **Table → Replay** and **Story** |

The ring is shared with the room's debug chatter, so in a long match its first
`[GAME]` lines (the deal) were the first to be evicted. The recorder exists so
that can never happen to the game itself.

## Game events

Every game fact goes through one emitter, `src/observability/gameEvents.js`
(`SocketHandlers._gameEvent` and `ActionHandlers` both call it). It writes the
event into the match stream **and** logs one `[GAME] <type>` line (which still
lands in the ring, so the raw log keeps the game's spine in context; that line
also carries `match` and `seq`).

Cards travel as compact refs: `"QH#123"` = rank + suit letter (`H D C S`) +
`#` + cardId; a joker is `"JK#105"`.

Stored event shape:

```
{ seq, t, type, ...payload, z?, tn?, dict?, kf?, check? }
```

| field | meaning |
|---|---|
| `seq` | 1-based position in the match |
| `t` | ms since the stream opened (`header.startedAt`) |
| `z` | zone diff since the previous event (below) |
| `tn` | `currentTurn`, when it changed |
| `dict` | `{cardId: code}` for ids the stream had not seen yet (dev hand surgery) |
| `kf` | keyframe (every deal, and `resume`) |
| `check` | table checksum on `round_end` / `match_end` |

In the stored stream `playerId` is dropped when `seat` already names the player
(the keyframe's seat list maps it back), and so are nulls and all-quiet flags
(`pozzettoTaken: 0`, `auto: false`, ...). The log line keeps the full payload.

| type | payload (besides seat / playerId) |
|---|---|
| `deal` | `round, reason, firstTurn, deck, wells[], seats[{seat,playerId,name,isBot,cards}], firstTurnDraw` + `kf` |
| `draw` | `card, hand, deck, auto?` (auto = turn timeout) |
| `take_pile` | `cards[], hand` |
| `meld` | `cards[], meldIndex, isBuraco, grade, hand, pozzettoTaken?` |
| `go_down` | `melds[][], hand, pozzettoTaken?` |
| `add_to_meld` | `cards[], targetSeat, targetMeldIndex, hand, pozzettoTaken?` |
| `discard` | `card, hand, nextSeat, pozzettoTaken?, minimumMeldFailed?, qanoonPenalty?, auto?, meldsReturned?, returnedCards?` |
| `take_pozzetto` | `cards[] (the well), hand` |
| `stock_promoted` | `well` (index), `deck` — an empty stock took a well in as the new stock |
| `timeout` | `connected, isBot` |
| `turn_forced` | `fromSeat, toSeat` |
| `undo_meld` | `ignored: true, reason` (undo is disabled server-side; logged, nothing moves) |
| `round_end` / `match_end` | `round, winnerSeat, winnerId, batida, winningTeam, teamScores, cumulative, targetScore` + `check` |
| `disconnect` / `reconnect` | `reason, inProgress` / — |
| `leave` | `seat, remaining` |
| `forfeit` | `reason, winnerSeat, hostLeft` |
| `voided` | `reason, message, wasInProgress, players` |
| `dev_change_cards` / `dev_swap_cards` | the cards an operator moved from the dev console |
| `resume` | (recorder only) the first event of a stream opened mid-round, carries a `kf` |
| `match_closed` | (recorder only) the room was torn down before a terminal event |

## Zones, diffs, keyframes

The table is captured as **zones** of card ids (`src/observability/replayCodec.js`):

| zone | contents |
|---|---|
| `h<seat>` | hand, in server order |
| `m<seat>` | melds of that seat, each an id list in canonical order |
| `g<seat>` | meld grade latches `{meldIndex: 'semi'|'dirty'}` |
| `s` | stock, next draw first |
| `d` | discard pile, top last |
| `w<i>` | well i (a taken well stays in place as `[]`) |

After every event the recorder re-captures the table and stores only what
changed. A flat zone diff is either `{r:[removed ids], a:[appended ids]}` or,
when that is not smaller (a reshuffle), the whole list; a meld zone diff is
`{n: meldCount, c: {index: [ids]}}`. Because the diff is taken from the table
itself, every event is replay-complete **without the call site describing its
side effects**: an auto-taken well, the minimum-meld confiscation inside a
discard, the melds a timeout hands back, a stock promotion, dev hand surgery.

A **keyframe** (`kf`) is recorded at every deal (after the first-turn ceremony,
so its stock order is the one play starts from) and when a stream is opened
mid-round after a restart (`resume`):

```
{ reason, round, ruleset, wellMode, qanoon, maxPlayers, targetScore, turn, turnOrder,
  seats: [{seat, id, name, bot}],
  firstTurn: { winner, rounds: [[[seat, "QH#12"], ...], ...] } | null,
  cum: {teamA, teamB},          // cumulative scores entering the round
  cards: {cardId: "QH", ...},   // dictionary for every card on the table
  z: { ...zones } }
```

The shuffle stays unseeded (`Math.random`); keyframes make the seed unnecessary.

`check` on a round end is FNV-1a over the zones plus the event's `cumulative`
scores. `ReplayEngine.verify(stream)` rebuilds the table at every round end and
compares.

## Match ids, memory, disk

- A deal of round 1 opens a new stream: `matchId = <roomId sanitized>-<room.createdAt ms>`
  (`-2`, `-3`... if taken). `header.backendMatchId` is `<roomId>:<createdAt ms>`,
  the `match_id` the backend settles under.
- Later rounds continue the room's open stream. `match_end`, `voided`, `forfeit`
  or the room's deletion close it.
- A restored room that keeps playing with no stream (process restart) gets a
  partial stream, `…-k<round>-<time>`, starting with a `resume` keyframe.
- Events are kept as their JSON text: O(1) append, exact byte accounting.
  Past `GAME_REPLAY_MAX_BYTES_PER_MATCH` only the round skeleton (deal, round
  end, match end, void, forfeit) is kept and the header says `truncated`.
  Past `GAME_REPLAY_MAX_TOTAL_BYTES` finished streams are dropped from memory,
  oldest first (they are on disk).
- Nothing touches the disk during play. At every `round_end` (and match end /
  void / forfeit / teardown / shutdown) the whole stream is written
  asynchronously: `<dir>/<matchId>.json.gz` (`{v, header, events}`) plus
  `<matchId>.meta.json` (the listing row). Writes to one match are serialized
  and coalesced; a file is written to `.tmp` and renamed.
- Retention: an hourly async prune deletes files older than
  `GAME_REPLAY_RETENTION_MS`, then the oldest while the directory exceeds
  `GAME_REPLAY_MAX_DISK_BYTES`.

Measured (bot games through the real handlers): ~140 bytes per event in
memory, ~30 bytes per event gzipped; a 2-seat round is ~250 events, ~35 KB raw,
~7 KB on disk. Recording costs ~3-4 µs per event (capture + diff + serialize of a
4-seat table).

## Dev API

All `/dev/api/*` endpoints need the webhook secret in the **`x-webhook-secret`
header**. They **fail closed**: with no `WEBHOOK_SECRET` configured every call
is refused (they expose every player's cards). The old `?secret=` query form is
no longer accepted; the dev console downloads through `fetch()` with the header.

| endpoint | returns |
|---|---|
| `GET /dev/api/matches` | recent matches, live and finished, memory + disk, newest first. `?roomId=` `?status=live|finished` `?limit=` (max 200) `?offset=`. Lookup of a backend game: `?backendMatchId=<roomId>:<createdAt ms>` (the settled `match_id`; a match resumed after a restart has several streams under it), or `?playerIds=<id>,<id>&at=<ISO or ms>` (every id seated, the match window ± `windowMs`, default 15 min, contains `at`; ordered by how close the match end is). `stats.retentionMs` tells a lookup miss "gone" from "never here" |
| `GET /dev/api/matches/<matchId>` | `{success, live, header, rounds, events}`. `?since=<seq>` only newer events (live follow). A finished match on disk is passed through gzipped (`Content-Encoding: gzip`, the stored `{v, header, events}` document) when the client accepts gzip. `?download=1` sets a file name. |
| `GET /dev/api/matches/<matchId>/state?at=<seq>` | the table rebuilt at that event, shaped like `GET /dev/api/rooms/<roomId>` (`players[].hand/melds`, `deck`, `deadPiles`, `discardPile`, `currentTurn`, `teamScores`...) plus `event`, `phase`, `verified` |
| `GET /dev/api/logs` | rooms that have a log ring (memory + disk index) |
| `GET /dev/api/rooms/<roomId>/logs[.txt]` | one room's ring. `?since` `?level` `?q` `?limit` `?tail=1` `?narrative=1` `?excludeGame=1` |

The replay engine (`src/observability/ReplayEngine.js`) is pure: `reconstruct`,
`tableAt`, `verify`, `roundsOf` work on a stream object anywhere.

## Dev console

- **Replays** (sidebar; the *Replays* section lists more and filters by room id, player id or
  backend match id): recent matches. Click one to replay it on the table. `#/replays/<matchId>`
  opens one directly.
- **Review** (Buraco admin): every game of a leaderboard collusion flag gets a *Replay* link when
  this socket still has the recording (looked up by the pair's player ids + the settle time, since
  the backend rows carry no match id yet), or says it is gone (past retention) / not on this socket.
- **Table → Replay** (also the *Replay* button next to a room): round selector,
  ⏮ ◀ ▶/⏸ ▶▏ ⏭, a slider over every event, speed, the event as a sentence,
  `✓ table verified` on round ends. Keyboard: ← → and space. A live match can
  be replayed while it is played; at the end the player follows new events.
  *Exit replay* returns to the live table.
- **Story**: game events come from the match recorder (never evicted), merged by
  time with the ring's lifecycle and warn/error lines. **Raw log** is the ring.

## Log ring (GameLogStore)

- Real ring buffer per room (no `Array#shift`); the room map is kept in
  last-write order, so eviction and the sweep never sort.
- Global caps: `GAME_LOG_MAX_TOTAL_BYTES` (message + data text) and
  `GAME_LOG_MAX_TOTAL_ENTRIES`; the least recently written rooms go first.
- `data` over 4 KB is shrunk structurally (long strings cut, long arrays keep
  their head, deep objects summarized) and marked `_truncated: {bytes}`; it is
  always valid JSON.
- JSONL file sink: appends batched every second through a per-room chain; the
  retention sweep's unlink rides the same chain and skips rooms with pending
  lines. The directory listing is async and cached; a room whose file predates
  the process is merged in by `ensureLoaded()` (lines are stamped with the boot
  that wrote them, so nothing is counted twice).
- Logger file sink (`LOG_FILE=true`): one buffered `WriteStream` per day, one
  line per entry with `data` as compact JSON (no more `appendFileSync` + pretty
  JSON).

## Environment

| variable | default | |
|---|---|---|
| `GAME_REPLAY_ENABLED` | `true` | recorder on/off |
| `GAME_REPLAY_PERSIST` | `true` (`false` under `NODE_ENV=test`) | write replays to disk |
| `GAME_REPLAY_DIR` | `$LOG_DIR/replays` (`./logs/replays`) | replay directory |
| `GAME_REPLAY_RETENTION_MS` | 7 days | disk retention |
| `GAME_REPLAY_MAX_BYTES_PER_MATCH` | 4 MB | in-memory budget per match |
| `GAME_REPLAY_MAX_TOTAL_BYTES` | 64 MB | in-memory budget, all matches |
| `GAME_REPLAY_MAX_DISK_BYTES` | 2 GB | disk budget |
| `GAME_LOG_LEVEL` | `info` in production, `debug` otherwise | ring capture level |
| `GAME_LOG_MAX_TOTAL_BYTES` | 128 MB | ring byte budget |
| `GAME_LOG_MAX_TOTAL_ENTRIES` | 400000 | ring line budget |
| `GAME_LOG_MAX_ENTRIES_PER_ROOM` | 4000 | ring size per room |
| `GAME_LOG_RETENTION_MS` | 2 h | ring retention after the last line |
| `GAME_LOG_FILE` / `GAME_LOG_DIR` | follows `LOG_FILE` / `$LOG_DIR/games` | ring file sink |
| `WEBHOOK_SECRET` | — | **required** for the dev console now |
