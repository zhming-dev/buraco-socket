/**
 * Game event recorder — one compact, replay-complete event stream per MATCH.
 *
 * Why a second store next to GameLogStore: the per-room log ring is shared
 * with every debug line the room produces, so in a long match the earliest
 * `[GAME]` lines (the deal!) were the first thing evicted. This stream holds
 * ONLY game events, is keyed by match (a room reused for a second match gets a
 * second stream), and every event carries enough to rebuild the table:
 *
 *   { seq, t, type, ...payload, z?, tn?, dict?, kf?, check? }
 *
 *     seq    1-based position in the match
 *     t      ms since the match stream opened
 *     z      zone diff since the previous event (see replayCodec) — whatever
 *            the action did to hands / melds / stock / pile / wells
 *     tn     currentTurn, when it changed
 *     dict   {id: code} for card ids the stream had not seen (dev hand surgery)
 *     kf     keyframe (every deal, and a mid-round resume after a restart)
 *     check  table checksum on round_end / match_end (replay verification)
 *
 * Events are stored as their JSON text: appending is O(1), the byte budget is
 * exact, and the flush to disk is a string join. Nothing touches the disk
 * while a round is played; at every round end (and match end / void /
 * forfeit / room teardown) the match is written ASYNCHRONOUSLY as gzipped JSON
 * to `<dir>/<matchId>.json.gz` (+ a tiny `.meta.json` for listings), and read
 * back on demand once it has left memory.
 *
 * Memory is bounded per match (`maxBytesPerMatch`: past it only the round
 * skeleton — deals, round ends, match end — is kept and the stream is flagged
 * `truncated`) and globally (`maxTotalBytes`: finished streams are dropped
 * oldest-first; they are already on disk).
 *
 * Never throws into the game: every public entry point swallows its own errors.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const codec = require('./replayCodec');

const FORMAT_VERSION = 1;
/** Events kept even past the per-match budget: the round skeleton. */
const ESSENTIAL = new Set(['deal', 'round_end', 'match_end', 'voided', 'forfeit', 'match_closed']);
/** Events that end the MATCH (the stream is closed and flushed). */
const TERMINAL = new Set(['match_end', 'voided', 'forfeit']);
/** Events that end a ROUND (the stream is flushed, stays open). */
const FLUSH_ON = new Set(['round_end']);
/** Payload flags that are noise when false/0 (the story reads absence as "no"). */
const QUIET_DEFAULTS = new Set([
  'pozzettoTaken',
  'minimumMeldFailed',
  'kanoonPenalty',
  'meldsReturned',
  'auto',
  'isBuraco',
]);
const DISK_INDEX_TTL_MS = 30_000;
const LOADED_CACHE_SIZE = 6;

function safeId(text) {
  return String(text ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 96);
}

/** An instant given as epoch ms (number or digit string) or an ISO date; null otherwise. */
function parseInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^\d{10,16}$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

class GameEventRecorder {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled=true]
   * @param {boolean} [options.persist=false]      write finished rounds to disk
   * @param {string}  [options.directory]           where `<matchId>.json.gz` live
   * @param {number}  [options.retentionMs]         disk retention (default 7 days)
   * @param {number}  [options.maxBytesPerMatch]    in-memory budget per match
   * @param {number}  [options.maxTotalBytes]       in-memory budget, all matches
   * @param {number}  [options.maxDiskBytes]        disk budget (oldest pruned first)
   * @param {() => number} [options.now]            clock (tests)
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.persist = options.persist === true;
    this.directory = options.directory || path.join('./logs', 'replays');
    this.retentionMs = Math.max(60_000, Number(options.retentionMs) || 7 * 24 * 60 * 60 * 1000);
    this.maxBytesPerMatch = Math.max(16 * 1024, Number(options.maxBytesPerMatch) || 4 * 1024 * 1024);
    this.maxTotalBytes = Math.max(
      this.maxBytesPerMatch,
      Number(options.maxTotalBytes) || 64 * 1024 * 1024
    );
    this.maxDiskBytes = Math.max(1024 * 1024, Number(options.maxDiskBytes) || 2 * 1024 * 1024 * 1024);
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();

    /** roomId -> the match stream currently recording in that room */
    this._openByRoom = new Map();
    /** matchId -> stream (live) */
    this._live = new Map();
    /** matchId -> stream (finished, still in memory). Insertion order = finish order (LRU). */
    this._finished = new Map();
    this._totalBytes = 0;
    this._droppedEvents = 0;

    /** matchId -> {matchId, file, size, mtimeMs, meta} */
    this._diskIndex = new Map();
    this._diskIndexAt = 0;
    this._diskIndexRefresh = null;
    /** matchId -> parsed stream loaded from disk (tiny LRU) */
    this._loaded = new Map();

    this._pruneTimer = null;
    this._dirReady = null;
  }

  // ---------------------------------------------------------------------------
  // Write path
  // ---------------------------------------------------------------------------

  /**
   * Record one game event for `room`. Returns the stored event head
   * (`{matchId, seq}`) or null when nothing was recorded (recorder off, no
   * match in this room, budget exhausted).
   * @param {import('../models/GameRoom')} room
   * @param {string} type
   * @param {object} [payload]
   */
  record(room, type, payload = {}) {
    if (!this.enabled || !room || !type) return null;
    try {
      return this._record(room, type, payload || {});
    } catch (error) {
      console.error('[GameEventRecorder] record failed:', error && error.message);
      return null;
    }
  }

  _record(room, type, payload) {
    const roomId = String(room.roomId);
    let stream = this._openByRoom.get(roomId) || null;
    let keyframe = null;

    if (type === 'deal') {
      const round = Number(payload.round) || room.roundNumber || 1;
      if (!stream || round <= 1) {
        if (stream) this._finish(stream, 'superseded');
        stream = this._open(room, { partial: round > 1 });
      }
      keyframe = this._keyframe(stream, room, 'deal');
    } else if (!stream) {
      // A room that is mid-round with no stream: the process restarted and the
      // room was restored. Open a partial stream on a RESUME keyframe so what
      // follows is still replayable. Anything else (lobby chatter, a void of
      // a room that never dealt) has no match to belong to.
      const midMatch =
        room.cardsDealt === true &&
        ((typeof room.isInProgress === 'function' && room.isInProgress()) ||
          room.awaitingNextRound === true);
      if (!midMatch || TERMINAL.has(type)) return null;
      stream = this._open(room, { partial: true, resumed: true });
      this._append(stream, { type: 'resume', kf: this._keyframe(stream, room, 'resume') }, true);
    }

    const event = { type, ...this._compact(stream, payload) };
    if (keyframe) {
      event.kf = keyframe;
    } else {
      this._attachDiff(stream, room, event);
    }
    if (type === 'round_end' || type === 'match_end') {
      // The running match score rides the event (the replay reads it from
      // here), and the checksum covers exactly that object.
      if (!event.cumulative) event.cumulative = codec.teamScoresOf(room.cumulativeTeamScores);
      event.check = codec.tableChecksum(stream.zones, event.cumulative);
    }

    const stored = this._append(stream, event, ESSENTIAL.has(type));
    if (!stored) return null;

    if (TERMINAL.has(type)) this._finish(stream, type);
    else if (FLUSH_ON.has(type)) this._scheduleFlush(stream);
    return { matchId: stream.matchId, seq: stored.seq };
  }

  /**
   * Payload as stored: nulls and the all-quiet defaults dropped, and the
   * playerId dropped when the seat already names that player (the keyframe's
   * seat list maps it back). The `[GAME]` log line keeps the full payload.
   */
  _compact(stream, payload) {
    const out = {};
    for (const key of Object.keys(payload)) {
      const value = payload[key];
      if (value === null || value === undefined) continue;
      if (QUIET_DEFAULTS.has(key) && !value) continue;
      out[key] = value;
    }
    if (out.playerId != null && out.seat != null && stream.seatIds[out.seat] === String(out.playerId)) {
      delete out.playerId;
    }
    return out;
  }

  _keyframe(stream, room, reason) {
    const kf = codec.buildKeyframe(room, { reason });
    stream.zones = codec.cloneZones(kf.z);
    stream.known = new Set(Object.keys(kf.cards));
    stream.turn = kf.turn;
    stream.rounds.push({ round: kf.round, seq: stream.seq + 1 });
    stream.seatIds = {};
    for (const seat of kf.seats) stream.seatIds[seat.seat] = String(seat.id);
    return kf;
  }

  /** Capture the table, diff it against the last capture, stamp z/tn/cards. */
  _attachDiff(stream, room, event) {
    if (!stream.zones) return;
    let fresh = null;
    const known = stream.known;
    const zones = codec.captureZones(room, (id, card) => {
      const key = String(id);
      if (!known.has(key)) {
        known.add(key);
        (fresh || (fresh = {}))[key] = codec.cardCode(card);
      }
    });
    const diff = codec.diffZones(stream.zones, zones);
    if (diff) {
      event.z = diff;
      stream.zones = zones;
    }
    if (fresh) event.dict = fresh;
    const turn = room.currentTurn ?? null;
    if (turn !== stream.turn) {
      event.tn = turn;
      stream.turn = turn;
    }
  }

  _open(room, { partial = false, resumed = false } = {}) {
    const roomId = String(room.roomId);
    const createdMs =
      (room.createdAt && room.createdAt.getTime && room.createdAt.getTime()) || this._now();
    let matchId = `${safeId(roomId)}-${createdMs}`;
    if (partial) matchId += `-${resumed ? 'k' : 'r'}${room.roundNumber || 0}-${this._now().toString(36)}`;
    let n = 2;
    const base = matchId;
    while (this._live.has(matchId) || this._finished.has(matchId) || this._diskIndex.has(matchId)) {
      matchId = `${base}-${n}`;
      n += 1;
    }
    const now = this._now();
    const players = typeof room.getPlayers === 'function' ? room.getPlayers() : [];
    const stream = {
      matchId,
      roomId,
      header: {
        v: FORMAT_VERSION,
        matchId,
        roomId,
        // What the backend settles this match under (SocketHandlers._matchResultIds).
        backendMatchId: `${roomId}:${createdMs}`,
        roomName: room.name || null,
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        endReason: null,
        partial,
        resumed,
        maxPlayers: room.maxPlayers,
        ruleset: room.ruleset || 'classic',
        wellMode: room.professionalWellMode || null,
        kanoon: typeof room.isKanoon === 'function' ? room.isKanoon() : false,
        targetScore: Number(room.targetScore) || 0,
        bet: Number(room.bet) || 0,
        seats: players.map((p) => ({
          seat: p.playerIndex,
          id: p.playerId,
          name: p.playerName ?? null,
          bot: p.isBot === true,
        })),
        truncated: false,
      },
      startedAt: now,
      lastAt: now,
      status: 'live',
      lines: [],
      bytes: 0,
      seq: 0,
      rounds: [],
      seatIds: {},
      zones: null,
      known: new Set(),
      turn: null,
      droppedEvents: 0,
      lastScores: null,
      // persistence
      writeChain: Promise.resolve(),
      flushQueued: null,
      persistedSeq: 0,
    };
    this._openByRoom.set(roomId, stream);
    this._live.set(matchId, stream);
    return stream;
  }

  /**
   * Append an event (O(1)): stamp seq/t, serialize once, account bytes.
   * @returns {{seq:number}|null}
   */
  _append(stream, event, essential) {
    const now = this._now();
    const seq = stream.seq + 1;
    const text = JSON.stringify({ seq, t: now - stream.startedAt, ...event });
    if (!essential && stream.bytes + text.length > this.maxBytesPerMatch) {
      stream.header.truncated = true;
      stream.droppedEvents += 1;
      this._droppedEvents += 1;
      return null;
    }
    if (!essential && this._totalBytes + text.length > this.maxTotalBytes) {
      this._evictFinished(text.length);
      if (this._totalBytes + text.length > this.maxTotalBytes) {
        stream.header.truncated = true;
        stream.droppedEvents += 1;
        this._droppedEvents += 1;
        return null;
      }
    }
    stream.seq = seq;
    stream.lines.push(text);
    stream.bytes += text.length;
    stream.lastAt = now;
    this._totalBytes += text.length;
    if (event.type === 'round_end' || event.type === 'match_end') {
      stream.lastScores = event.cumulative || event.teamScores || null;
    }
    if (this._totalBytes > this.maxTotalBytes) this._evictFinished(0);
    return { seq };
  }

  /** Drop finished streams oldest-first until `extra` more bytes fit. */
  _evictFinished(extra) {
    for (const [matchId, stream] of this._finished) {
      if (this._totalBytes + extra <= this.maxTotalBytes) break;
      this._finished.delete(matchId);
      this._totalBytes -= stream.bytes;
      stream.evicted = true;
    }
  }

  _finish(stream, reason) {
    if (!stream || stream.status !== 'live') return;
    stream.status = 'finished';
    stream.header.endedAt = new Date(this._now()).toISOString();
    stream.header.endReason = reason;
    if (this._openByRoom.get(stream.roomId) === stream) this._openByRoom.delete(stream.roomId);
    this._live.delete(stream.matchId);
    this._finished.set(stream.matchId, stream);
    stream.zones = null; // the shadow capture is only needed while recording
    stream.known = null;
    this._scheduleFlush(stream);
    if (this._totalBytes > this.maxTotalBytes) this._evictFinished(0);
  }

  /**
   * The room is being torn down. Closes its open stream (if the game never
   * reached a terminal event — abandoned, reaped, deleted mid-intermission).
   * @param {string} roomId
   * @param {string} [reason]
   */
  closeRoom(roomId, reason = 'room_deleted') {
    try {
      const stream = this._openByRoom.get(String(roomId));
      if (!stream) return;
      this._append(stream, { type: 'match_closed', reason }, true);
      this._finish(stream, reason);
    } catch (error) {
      console.error('[GameEventRecorder] closeRoom failed:', error && error.message);
    }
  }

  /** The match currently recording in a room, if any. */
  currentMatchId(roomId) {
    return this._openByRoom.get(String(roomId))?.matchId || null;
  }

  // ---------------------------------------------------------------------------
  // Persistence (async, never on the action path)
  // ---------------------------------------------------------------------------

  _serialize(stream) {
    const header = {
      ...stream.header,
      events: stream.seq,
      rounds: stream.rounds.length,
      bytes: stream.bytes,
      droppedEvents: stream.droppedEvents,
      lastScores: stream.lastScores,
      lastAt: new Date(stream.lastAt).toISOString(),
      status: stream.status,
    };
    const json = `{"v":${FORMAT_VERSION},"header":${JSON.stringify(header)},"events":[${stream.lines.join(',')}]}`;
    return { header, json };
  }

  _metaFor(header, extra = {}) {
    return {
      matchId: header.matchId,
      roomId: header.roomId,
      backendMatchId: header.backendMatchId,
      roomName: header.roomName,
      startedAt: header.startedAt,
      endedAt: header.endedAt,
      lastAt: header.lastAt,
      endReason: header.endReason,
      status: header.status,
      partial: header.partial,
      truncated: header.truncated,
      ruleset: header.ruleset,
      kanoon: header.kanoon,
      maxPlayers: header.maxPlayers,
      targetScore: header.targetScore,
      seats: header.seats,
      events: header.events,
      rounds: header.rounds,
      lastScores: header.lastScores,
      ...extra,
    };
  }

  _ensureDir() {
    if (!this._dirReady) {
      this._dirReady = fs.promises.mkdir(this.directory, { recursive: true }).catch((error) => {
        this._dirReady = null;
        throw error;
      });
    }
    return this._dirReady;
  }

  _filePath(matchId) {
    return path.join(this.directory, `${safeId(matchId)}.json.gz`);
  }

  /**
   * Queue an async write of the whole stream. Coalesces: while a write is
   * queued but not started, further requests ride on it (it snapshots the
   * stream when it STARTS, so it always writes the newest content).
   * @returns {Promise<void>}
   */
  _scheduleFlush(stream) {
    if (!this.persist || !stream) return Promise.resolve();
    if (stream.flushQueued) return stream.flushQueued;
    const job = stream.writeChain.then(() => {
      stream.flushQueued = null;
      return this._writeStream(stream);
    });
    stream.flushQueued = job;
    stream.writeChain = job.catch(() => {});
    return job.catch((error) => {
      console.error(`[GameEventRecorder] flush failed for ${stream.matchId}:`, error && error.message);
    });
  }

  async _writeStream(stream) {
    if (stream.persistedSeq === stream.seq && stream.persistedStatus === stream.status) return;
    const seqAtSnapshot = stream.seq;
    const statusAtSnapshot = stream.status;
    const { header, json } = this._serialize(stream);
    await this._ensureDir();
    const gz = await new Promise((resolve, reject) => {
      zlib.gzip(json, { level: 6 }, (err, buf) => (err ? reject(err) : resolve(buf)));
    });
    const file = this._filePath(stream.matchId);
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, gz);
    await fs.promises.rename(tmp, file);
    const meta = this._metaFor(header, { size: gz.length, rawBytes: json.length });
    await fs.promises.writeFile(`${file.slice(0, -'.json.gz'.length)}.meta.json`, JSON.stringify(meta));
    stream.persistedSeq = seqAtSnapshot;
    stream.persistedStatus = statusAtSnapshot;
    this._diskIndex.set(stream.matchId, {
      matchId: stream.matchId,
      file,
      size: gz.length,
      mtimeMs: this._now(),
      meta,
    });
    this._loaded.delete(stream.matchId);
  }

  /** Flush every in-memory stream (shutdown / tests). */
  async flushAll() {
    if (!this.persist) return;
    const jobs = [];
    for (const stream of this._live.values()) jobs.push(this._scheduleFlush(stream));
    for (const stream of this._finished.values()) jobs.push(this._scheduleFlush(stream));
    await Promise.all(jobs);
  }

  /** Arm the disk pruner. Idempotent. */
  start() {
    if (this.persist && !this._pruneTimer) {
      const first = setTimeout(() => this.pruneDisk().catch(() => {}), 5_000);
      first.unref?.();
      this._pruneTimer = setInterval(() => this.pruneDisk().catch(() => {}), 60 * 60 * 1000);
      this._pruneTimer.unref?.();
    }
    return this;
  }

  async stop() {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    this._pruneTimer = null;
    await this.flushAll();
  }

  /**
   * Refresh the cached listing of matches on disk (async readdir + stat, meta
   * sidecars read once per file).
   */
  refreshDiskIndex({ force = false } = {}) {
    if (!this.persist) return Promise.resolve(this._diskIndex);
    if (!force && this._now() - this._diskIndexAt < DISK_INDEX_TTL_MS) {
      return Promise.resolve(this._diskIndex);
    }
    if (this._diskIndexRefresh) return this._diskIndexRefresh;
    this._diskIndexRefresh = (async () => {
      let names = [];
      try {
        names = await fs.promises.readdir(this.directory);
      } catch {
        names = [];
      }
      const seen = new Set();
      await Promise.all(
        names
          .filter((name) => name.endsWith('.json.gz'))
          .map(async (name) => {
            const matchId = name.slice(0, -'.json.gz'.length);
            seen.add(matchId);
            const file = path.join(this.directory, name);
            let stat;
            try {
              stat = await fs.promises.stat(file);
            } catch {
              return;
            }
            const cached = this._diskIndex.get(matchId);
            let meta = cached && cached.meta && cached.statMtimeMs === stat.mtimeMs ? cached.meta : null;
            if (!meta) {
              try {
                meta = JSON.parse(
                  await fs.promises.readFile(path.join(this.directory, `${matchId}.meta.json`), 'utf8')
                );
              } catch {
                meta = cached ? cached.meta : null;
              }
            }
            this._diskIndex.set(matchId, {
              matchId,
              file,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              statMtimeMs: stat.mtimeMs,
              meta,
            });
          })
      );
      for (const matchId of Array.from(this._diskIndex.keys())) {
        if (!seen.has(matchId)) this._diskIndex.delete(matchId);
      }
      this._diskIndexAt = this._now();
      this._diskIndexRefresh = null;
      return this._diskIndex;
    })();
    return this._diskIndexRefresh;
  }

  /** Delete replays past retention, then the oldest past the disk budget. */
  async pruneDisk() {
    if (!this.persist) return 0;
    const index = await this.refreshDiskIndex({ force: true });
    const cutoff = this._now() - this.retentionMs;
    const rows = Array.from(index.values()).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = rows.reduce((sum, r) => sum + (r.size || 0), 0);
    let removed = 0;
    for (const row of rows) {
      const tooOld = row.mtimeMs < cutoff;
      if (!tooOld && total <= this.maxDiskBytes) continue;
      if (this._live.has(row.matchId)) continue; // still being written
      await fs.promises.unlink(row.file).catch(() => {});
      await fs.promises
        .unlink(path.join(this.directory, `${row.matchId}.meta.json`))
        .catch(() => {});
      this._diskIndex.delete(row.matchId);
      this._loaded.delete(row.matchId);
      total -= row.size || 0;
      removed += 1;
    }
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Read path
  // ---------------------------------------------------------------------------

  _memoryStream(matchId) {
    return this._live.get(matchId) || this._finished.get(matchId) || null;
  }

  _rowFor(stream) {
    const { header } = this._serializeHeaderOnly(stream);
    return this._metaFor(header, {
      live: stream.status === 'live',
      inMemory: true,
      onDisk: this._diskIndex.has(stream.matchId),
      bytes: stream.bytes,
    });
  }

  _serializeHeaderOnly(stream) {
    return {
      header: {
        ...stream.header,
        events: stream.seq,
        rounds: stream.rounds.length,
        lastScores: stream.lastScores,
        lastAt: new Date(stream.lastAt).toISOString(),
        status: stream.status,
      },
    };
  }

  /**
   * Recent matches, newest activity first: live and finished in memory plus
   * whatever is on disk.
   *
   * Lookup filters (the admin Review page finds the replay of a backend game):
   * - `backendMatchId` — the backend's `match_id` (`<roomId>:<createdAt ms>`,
   *   header.backendMatchId). A restart mid-match leaves several streams (the
   *   original + a resumed one) under the same id; all of them match.
   * - `playerIds` — every id (array or comma list) must hold a seat.
   * - `at` (ISO or epoch ms) — the match was being played around then: its
   *   [startedAt, endedAt|lastAt] window widened by `windowMs` (default 15 min,
   *   a settlement can land a little after the last event) contains `at`.
   *   Results are then ordered by how close the match END is to `at`.
   * @param {{roomId?: string, limit?: number, offset?: number, status?: 'live'|'finished',
   *   backendMatchId?: string, playerIds?: string|string[], at?: string|number, windowMs?: number}} [opts]
   */
  async list(opts = {}) {
    await this.refreshDiskIndex().catch(() => {});
    const rows = [];
    const seen = new Set();
    for (const stream of [...this._live.values(), ...this._finished.values()]) {
      seen.add(stream.matchId);
      rows.push(this._rowFor(stream));
    }
    for (const entry of this._diskIndex.values()) {
      if (seen.has(entry.matchId)) continue;
      const meta = entry.meta || { matchId: entry.matchId };
      rows.push({
        ...meta,
        // Written while still live and never finished: the process stopped
        // (restart / crash) mid-match. A resumed room continues in a new stream.
        endReason: meta.endReason || (meta.status === 'live' ? 'interrupted' : null),
        matchId: entry.matchId,
        lastAt: meta.lastAt || new Date(entry.mtimeMs).toISOString(),
        live: false,
        inMemory: false,
        onDisk: true,
        size: entry.size,
      });
    }
    let filtered = rows;
    if (opts.roomId != null && opts.roomId !== '') {
      const roomId = String(opts.roomId);
      filtered = filtered.filter((r) => String(r.roomId) === roomId);
    }
    if (opts.status === 'live') filtered = filtered.filter((r) => r.live);
    else if (opts.status === 'finished') filtered = filtered.filter((r) => !r.live);
    if (opts.backendMatchId != null && opts.backendMatchId !== '') {
      const wanted = String(opts.backendMatchId);
      filtered = filtered.filter((r) => r.backendMatchId != null && String(r.backendMatchId) === wanted);
    }
    const playerIds = (Array.isArray(opts.playerIds) ? opts.playerIds : String(opts.playerIds ?? '').split(','))
      .map((id) => String(id ?? '').trim())
      .filter(Boolean);
    if (playerIds.length) {
      filtered = filtered.filter((r) => {
        const seated = new Set((r.seats || []).map((s) => String(s && s.id)));
        return playerIds.every((id) => seated.has(id));
      });
    }
    const at = parseInstant(opts.at);
    if (at !== null) {
      const windowRaw = opts.windowMs == null || opts.windowMs === '' ? NaN : Number(opts.windowMs);
      const windowMs = Math.min(
        24 * 60 * 60 * 1000,
        Math.max(0, Number.isFinite(windowRaw) ? windowRaw : 15 * 60 * 1000)
      );
      const endOf = (r) => Date.parse(r.endedAt || r.lastAt || r.startedAt);
      filtered = filtered.filter((r) => {
        const start = Date.parse(r.startedAt);
        const end = endOf(r);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        return start - windowMs <= at && at <= end + windowMs;
      });
      filtered.sort((a, b) => Math.abs(endOf(a) - at) - Math.abs(endOf(b) - at));
    } else {
      filtered.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    }
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const offset = Math.max(0, Number(opts.offset) || 0);
    return {
      total: filtered.length,
      offset,
      limit,
      matches: filtered.slice(offset, offset + limit),
    };
  }

  /**
   * One match's full stream `{v, header, events}`, from memory or disk.
   * @param {string} matchId
   * @returns {Promise<object|null>}
   */
  async load(matchId) {
    const id = String(matchId || '');
    if (!id || safeId(id) !== id) return null;
    const stream = this._memoryStream(id);
    if (stream) {
      const { header, json } = this._serialize(stream);
      return { ...JSON.parse(json), header, live: stream.status === 'live' };
    }
    if (this._loaded.has(id)) {
      const hit = this._loaded.get(id);
      this._loaded.delete(id);
      this._loaded.set(id, hit);
      return hit;
    }
    const gz = await this.readCompressed(id);
    if (!gz) return null;
    const json = await new Promise((resolve, reject) => {
      zlib.gunzip(gz, (err, buf) => (err ? reject(err) : resolve(buf.toString('utf8'))));
    });
    const parsed = { ...JSON.parse(json), live: false };
    this._loaded.set(id, parsed);
    while (this._loaded.size > LOADED_CACHE_SIZE) this._loaded.delete(this._loaded.keys().next().value);
    return parsed;
  }

  /**
   * The on-disk gzip bytes of a match that is no longer changing (for gzip
   * passthrough), or null when it is live / not persisted / stale on disk.
   */
  async readCompressed(matchId) {
    const id = String(matchId || '');
    if (!this.persist || !id || safeId(id) !== id) return null;
    const stream = this._memoryStream(id);
    if (stream && (stream.status === 'live' || stream.persistedSeq !== stream.seq)) return null;
    try {
      return await fs.promises.readFile(this._filePath(id));
    } catch {
      return null;
    }
  }

  stats() {
    return {
      enabled: this.enabled,
      persist: this.persist,
      directory: this.persist ? this.directory : null,
      liveMatches: this._live.size,
      finishedInMemory: this._finished.size,
      bytes: this._totalBytes,
      maxTotalBytes: this.maxTotalBytes,
      maxBytesPerMatch: this.maxBytesPerMatch,
      droppedEvents: this._droppedEvents,
      onDisk: this._diskIndex.size,
      retentionMs: this.retentionMs,
    };
  }

  /** Forget everything in memory (tests). Disk is left alone. */
  clear() {
    this._openByRoom.clear();
    this._live.clear();
    this._finished.clear();
    this._loaded.clear();
    this._diskIndex.clear();
    this._diskIndexAt = 0;
    this._totalBytes = 0;
    this._droppedEvents = 0;
  }
}

// -----------------------------------------------------------------------------
// Shared instance (the socket handlers and ActionHandlers record into one)
// -----------------------------------------------------------------------------

let shared = null;

/** The process-wide recorder, built from config on first use. */
function getGameEventRecorder() {
  if (!shared) {
    const config = require('../config');
    const opts = config.gameReplay || {};
    shared = new GameEventRecorder({
      enabled: opts.enabled,
      persist: opts.persist,
      directory: opts.directory,
      retentionMs: opts.retentionMs,
      maxBytesPerMatch: opts.maxBytesPerMatch,
      maxTotalBytes: opts.maxTotalBytes,
      maxDiskBytes: opts.maxDiskBytes,
    });
  }
  return shared;
}

module.exports = GameEventRecorder;
module.exports.GameEventRecorder = GameEventRecorder;
module.exports.getGameEventRecorder = getGameEventRecorder;
module.exports.safeId = safeId;
module.exports.FORMAT_VERSION = FORMAT_VERSION;
