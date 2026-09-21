/**
 * Per-game log store (dev tooling).
 *
 * Keeps every log line the logger can attribute to a room in a bounded
 * per-room ring buffer so ONE game's full timeline can be pulled after the
 * fact from the dev console (`GET /dev/api/rooms/<roomId>/logs`). Entries
 * OUTLIVE the room: a finished/deleted game stays readable for `retentionMs`
 * after its last line (default 2h), then the sweeper drops it. Memory is
 * bounded three ways — the per-room ring (`maxEntriesPerRoom`), a global cap
 * (`maxTotalEntries`, evicts the least-recently-written rooms first) and the
 * time-based sweep.
 *
 * Optional JSONL file sink (`GAME_LOG_FILE=true`): one `<roomId>.jsonl` per
 * room under `fileDirectory`, appended in batches, so a game's log survives a
 * process restart. The first touch of a room after a restart (a read OR a new
 * line) reloads its file into memory, and the sweeper unlinks files idle past
 * retention.
 *
 * Deliberately has NO dependency on the logger (the logger feeds it), so it
 * reports its own failures via console.error.
 */

const fs = require('fs');
const path = require('path');

const LEVEL_RANK = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

/** Bytes kept per serialized `data` payload; anything longer is truncated. */
const MAX_DATA_BYTES = 4096;
/** Characters kept per message; log lines that embed whole JSON payloads get cut. */
const MAX_MESSAGE_CHARS = 2048;
/** How often pending file appends are flushed. */
const FILE_FLUSH_MS = 1000;
/**
 * Message prefixes that make up a game's human-readable spine (see
 * SocketHandlers._gameEvent). `narrative` reads keep these plus every
 * WARN/ERROR line and drop the protocol chatter.
 */
const NARRATIVE_PREFIXES = ['[GAME]', '[ROOM_LIFECYCLE]', '[DEV_CHANGE_CARDS]', '[FORFEIT]'];

class GameLogStore {
  /**
   * @param {object} [options]
   * @param {number} [options.retentionMs]        keep a room's log this long after its last line
   * @param {number} [options.maxEntriesPerRoom]  ring size per room
   * @param {number} [options.maxTotalEntries]    global cap across rooms
   * @param {boolean} [options.fileEnabled]       JSONL sink on/off
   * @param {string} [options.fileDirectory]      where the per-room files live
   * @param {() => number} [options.now]          clock (tests)
   */
  constructor(options = {}) {
    this.retentionMs = Math.max(60_000, Number(options.retentionMs) || 2 * 60 * 60 * 1000);
    this.maxEntriesPerRoom = Math.max(50, Number(options.maxEntriesPerRoom) || 4000);
    this.maxTotalEntries = Math.max(
      this.maxEntriesPerRoom,
      Number(options.maxTotalEntries) || 400000
    );
    this.fileEnabled = options.fileEnabled === true;
    this.fileDirectory = options.fileDirectory || path.join('./logs', 'games');
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();

    /** @type {Map<string, {entries: object[], firstAt: number, lastAt: number, counts: object, dropped: number}>} */
    this._rooms = new Map();
    this._totalEntries = 0;
    this._seq = 0;

    // File sink state: per-room pending lines + a per-room append chain so
    // writes to one file never interleave out of order.
    this._pendingLines = new Map();
    this._appendChains = new Map();
    this._flushTimer = null;
    this._sweepTimer = null;

    if (this.fileEnabled) this._ensureDirectory();
  }

  // ---------------------------------------------------------------------------
  // Write path
  // ---------------------------------------------------------------------------

  /**
   * Append one line to a room's log.
   * @param {string} roomId
   * @param {{level: string, message: string, data?: any, timestamp?: string}} entry
   * @returns {object|null} the stored entry
   */
  record(roomId, entry) {
    const key = roomId == null ? null : String(roomId);
    if (!key || !entry) return null;

    const now = this._now();
    const stored = {
      seq: ++this._seq,
      ts: entry.timestamp || new Date(now).toISOString(),
      level: String(entry.level || 'INFO').toUpperCase(),
      msg: truncate(String(entry.message ?? ''), MAX_MESSAGE_CHARS),
      data: serializeData(entry.data),
    };

    const bucket = this._bucketFor(key, { create: true, now });

    bucket.entries.push(stored);
    bucket.lastAt = now;
    bucket.counts[stored.level] = (bucket.counts[stored.level] || 0) + 1;
    this._totalEntries += 1;

    if (bucket.entries.length > this.maxEntriesPerRoom) {
      const evicted = bucket.entries.shift();
      bucket.counts[evicted.level] -= 1;
      bucket.dropped += 1;
      this._totalEntries -= 1;
    }

    if (this._totalEntries > this.maxTotalEntries) this._evictColdestRooms();

    if (this.fileEnabled) this._queueFileLine(key, stored);
    return stored;
  }

  /** Whether any line has been attributed to this room (memory only). */
  has(roomId) {
    return roomId != null && this._rooms.has(String(roomId));
  }

  // ---------------------------------------------------------------------------
  // Read path
  // ---------------------------------------------------------------------------

  /**
   * Read a room's log.
   * @param {string} roomId
   * @param {object} [opts]
   * @param {number} [opts.since]   only entries with seq > since (live tail cursor)
   * @param {string} [opts.level]   minimum level (error|warn|info|debug)
   * @param {string} [opts.q]       case-insensitive substring over msg + data
   * @param {number} [opts.limit]   page size (default 500, max 5000)
   * @param {boolean} [opts.tail]   with no `since`: return the LAST `limit` entries
   * @param {boolean} [opts.narrative] only game events, lifecycle events and warn/error lines
   * @returns {{success: boolean, roomId: string, entries: object[], total: number, hasMore: boolean, nextSince: number, source: string, error?: string}}
   */
  get(roomId, opts = {}) {
    const key = roomId == null ? '' : String(roomId);
    if (!key) return { success: false, error: 'roomId required' };

    const bucket = this._bucketFor(key, { create: false });
    if (!bucket) return { success: false, roomId: key, error: 'No logs for room' };
    const entries = bucket.entries;

    const since = Number.isFinite(Number(opts.since)) ? Number(opts.since) : 0;
    const maxRank = levelRank(opts.level, LEVEL_RANK.DEBUG);
    const needle = opts.q ? String(opts.q).toLowerCase() : null;
    const limit = Math.min(5000, Math.max(1, Number(opts.limit) || 500));

    const narrative = opts.narrative === true;
    const filtered = entries.filter((e) => {
      if (e.seq <= since) return false;
      if (LEVEL_RANK[e.level] > maxRank) return false;
      if (narrative && LEVEL_RANK[e.level] > LEVEL_RANK.WARN && !isNarrative(e.msg)) return false;
      if (needle) {
        const hay = `${e.msg}\n${e.data || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    let page;
    if (opts.tail && !since) page = filtered.slice(-limit);
    else page = filtered.slice(0, limit);

    return {
      success: true,
      roomId: key,
      entries: page,
      total: filtered.length,
      hasMore: filtered.length > page.length,
      nextSince: page.length ? page[page.length - 1].seq : since,
      firstAt: new Date(bucket.firstAt).toISOString(),
      lastAt: new Date(bucket.lastAt).toISOString(),
      dropped: bucket.dropped,
      restored: bucket.restored === true,
      retentionMs: this.retentionMs,
    };
  }

  /**
   * Rooms that currently have a log, newest activity first. Rooms whose file
   * is on disk but not yet reloaded (after a restart) are listed with
   * `onDisk: true` and no counts — reading them loads them.
   * @returns {Array<{roomId: string, count: number|null, firstAt: string|null, lastAt: string, errors: number, warns: number}>}
   */
  list() {
    const rows = [];
    for (const [roomId, bucket] of this._rooms) {
      rows.push({
        roomId,
        count: bucket.entries.length,
        dropped: bucket.dropped,
        firstAt: new Date(bucket.firstAt).toISOString(),
        lastAt: new Date(bucket.lastAt).toISOString(),
        errors: bucket.counts.ERROR || 0,
        warns: bucket.counts.WARN || 0,
        restored: bucket.restored === true,
        onDisk: false,
        lastMessage: bucket.entries.length ? bucket.entries[bucket.entries.length - 1].msg : null,
      });
    }
    if (this.fileEnabled) {
      for (const file of this._listFiles()) {
        if (this._rooms.has(file.roomId)) continue;
        rows.push({
          roomId: file.roomId,
          count: null,
          dropped: 0,
          firstAt: null,
          lastAt: new Date(file.mtimeMs).toISOString(),
          errors: 0,
          warns: 0,
          restored: false,
          onDisk: true,
          lastMessage: null,
        });
      }
    }
    rows.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    return rows;
  }

  /** Render a room's log as plain text (download / grep). */
  renderText(roomId, opts = {}) {
    const result = this.get(roomId, { ...opts, limit: 5000 });
    if (!result.success) return null;
    return result.entries.map(formatLine).join('\n') + '\n';
  }

  /** Counters for /health-style snapshots. */
  stats() {
    return {
      rooms: this._rooms.size,
      entries: this._totalEntries,
      retentionMs: this.retentionMs,
      fileEnabled: this.fileEnabled,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Arm the retention sweeper (and the file flusher). Idempotent. */
  start() {
    if (!this._sweepTimer) {
      const every = Math.min(60_000, Math.max(5_000, Math.floor(this.retentionMs / 4)));
      this._sweepTimer = setInterval(() => this.sweep(), every);
      this._sweepTimer.unref?.();
    }
    if (this.fileEnabled && !this._flushTimer) {
      this._flushTimer = setInterval(() => this.flush(), FILE_FLUSH_MS);
      this._flushTimer.unref?.();
    }
    return this;
  }

  /** Stop timers and flush whatever is pending to disk. */
  async stop() {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._sweepTimer = null;
    this._flushTimer = null;
    await this.flush();
  }

  /**
   * Drop rooms idle past retention (memory + files). Returns how many rooms
   * were dropped from memory.
   * @param {number} [now]
   */
  sweep(now = this._now()) {
    const cutoff = now - this.retentionMs;
    let dropped = 0;
    for (const [roomId, bucket] of this._rooms) {
      if (bucket.lastAt < cutoff) {
        this._totalEntries -= bucket.entries.length;
        this._rooms.delete(roomId);
        dropped += 1;
      }
    }
    if (this.fileEnabled) this._sweepFiles(cutoff);
    return dropped;
  }

  /** Forget everything (tests). */
  clear() {
    this._rooms.clear();
    this._pendingLines.clear();
    this._totalEntries = 0;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The in-memory bucket for a room. Falls back to reloading the room's file
   * (restart recovery) before creating a fresh one.
   * @private
   */
  _bucketFor(key, { create, now = this._now() }) {
    let bucket = this._rooms.get(key);
    if (!bucket && this.fileEnabled) bucket = this._loadFromFile(key);
    if (!bucket && create) {
      bucket = newBucket(now);
      this._rooms.set(key, bucket);
    }
    return bucket;
  }

  /** Global-cap pressure: drop whole rooms, least recently written first. */
  _evictColdestRooms() {
    const byAge = Array.from(this._rooms.entries()).sort((a, b) => a[1].lastAt - b[1].lastAt);
    for (const [roomId, bucket] of byAge) {
      if (this._totalEntries <= this.maxTotalEntries) break;
      this._totalEntries -= bucket.entries.length;
      this._rooms.delete(roomId);
    }
  }

  _ensureDirectory() {
    try {
      fs.mkdirSync(this.fileDirectory, { recursive: true });
    } catch (error) {
      console.error(
        '[GameLogStore] cannot create log directory, file sink disabled:',
        error.message
      );
      this.fileEnabled = false;
    }
  }

  _filePath(roomId) {
    const safe = String(roomId)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120);
    return path.join(this.fileDirectory, `${safe}.jsonl`);
  }

  _queueFileLine(roomId, stored) {
    let lines = this._pendingLines.get(roomId);
    if (!lines) {
      lines = [];
      this._pendingLines.set(roomId, lines);
    }
    lines.push(JSON.stringify(stored));
  }

  /** Append every pending line to its room file. Resolves when all appends land. */
  flush() {
    if (!this.fileEnabled || this._pendingLines.size === 0) return Promise.resolve();
    const jobs = [];
    for (const [roomId, lines] of this._pendingLines) {
      const chunk = lines.join('\n') + '\n';
      const file = this._filePath(roomId);
      const prev = this._appendChains.get(roomId) || Promise.resolve();
      const next = prev
        .then(() => fs.promises.appendFile(file, chunk))
        .catch((error) => {
          console.error(`[GameLogStore] append failed for ${roomId}:`, error.message);
        })
        .then(() => {
          if (this._appendChains.get(roomId) === next) this._appendChains.delete(roomId);
        });
      this._appendChains.set(roomId, next);
      jobs.push(next);
    }
    this._pendingLines.clear();
    return Promise.all(jobs).then(() => undefined);
  }

  /**
   * Reload a room's file into a memory bucket (restart recovery). Entries are
   * renumbered with THIS process's seq counter so `since` cursors stay
   * monotonic across the restart boundary. Bounded to the ring size.
   * @private
   */
  _loadFromFile(roomId) {
    const file = this._filePath(roomId);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-this.maxEntriesPerRoom);
    const bucket = newBucket(this._now());
    bucket.restored = true;
    for (const line of tail) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // torn line (crash mid-write)
      }
      if (!parsed || typeof parsed.msg !== 'string') continue;
      const level = LEVEL_RANK[parsed.level] === undefined ? 'INFO' : parsed.level;
      bucket.entries.push({
        seq: ++this._seq,
        ts: parsed.ts || new Date(0).toISOString(),
        level,
        msg: parsed.msg,
        data: parsed.data ?? null,
      });
      bucket.counts[level] += 1;
    }
    if (!bucket.entries.length) return null;
    bucket.dropped = Math.max(0, lines.length - bucket.entries.length);
    bucket.firstAt = Date.parse(bucket.entries[0].ts) || bucket.firstAt;
    bucket.lastAt = Date.parse(bucket.entries[bucket.entries.length - 1].ts) || bucket.lastAt;
    this._rooms.set(roomId, bucket);
    this._totalEntries += bucket.entries.length;
    if (this._totalEntries > this.maxTotalEntries) this._evictColdestRooms();
    return this._rooms.get(roomId) || null;
  }

  /** Room files on disk: `{ roomId, file, mtimeMs }` (roomId is the sanitized file stem). */
  _listFiles() {
    let names;
    try {
      names = fs.readdirSync(this.fileDirectory);
    } catch {
      return [];
    }
    const files = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(this.fileDirectory, name);
      try {
        files.push({
          roomId: name.slice(0, -'.jsonl'.length),
          file,
          mtimeMs: fs.statSync(file).mtimeMs,
        });
      } catch {
        // raced with a sweep — skip
      }
    }
    return files;
  }

  _sweepFiles(cutoffMs) {
    for (const { file, mtimeMs } of this._listFiles()) {
      if (mtimeMs >= cutoffMs) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone — nothing to do
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function newBucket(now) {
  return {
    entries: [],
    firstAt: now,
    lastAt: now,
    counts: { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 },
    dropped: 0,
    restored: false,
  };
}

function isNarrative(msg) {
  for (const prefix of NARRATIVE_PREFIXES) {
    if (msg.startsWith(prefix)) return true;
  }
  return false;
}

function levelRank(level, fallback) {
  if (!level) return fallback;
  const rank = LEVEL_RANK[String(level).toUpperCase()];
  return rank === undefined ? fallback : rank;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
}

/** Compact, size-capped JSON for the `data` payload (Errors keep message + stack). */
function serializeData(data) {
  if (data === null || data === undefined) return null;
  let value = data;
  if (data instanceof Error) {
    value = { name: data.name, message: data.message, stack: data.stack };
  }
  let json;
  try {
    json = typeof value === 'string' ? value : JSON.stringify(value, jsonReplacer);
  } catch {
    json = String(value);
  }
  if (json === undefined) return null;
  return truncate(json, MAX_DATA_BYTES);
}

function jsonReplacer(_key, val) {
  if (val instanceof Map) return Object.fromEntries(val);
  if (val instanceof Set) return Array.from(val);
  if (typeof val === 'bigint') return val.toString();
  return val;
}

function formatLine(entry) {
  const base = `[${entry.ts}] [${entry.level}] ${entry.msg}`;
  return entry.data ? `${base} ${entry.data}` : base;
}

module.exports = GameLogStore;
module.exports.LEVEL_RANK = LEVEL_RANK;
module.exports.formatLine = formatLine;
