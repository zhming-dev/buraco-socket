/**
 * Per-game log store (dev tooling).
 *
 * Keeps every log line the logger can attribute to a room in a bounded
 * per-room ring buffer so ONE game's full timeline can be pulled after the
 * fact from the dev console (`GET /dev/api/rooms/<roomId>/logs`). Entries
 * OUTLIVE the room: a finished/deleted game stays readable for `retentionMs`
 * after its last line (default 2h), then the sweeper drops it. Memory is
 * bounded three ways — the per-room ring (`maxEntriesPerRoom`), a global cap
 * (`maxTotalBytes`, plus the legacy `maxTotalEntries`; evicts the least
 * recently written rooms first) and the time-based sweep.
 *
 * The game's replay-grade event stream lives in GameEventRecorder, NOT here:
 * this ring is shared with the room's debug chatter and is allowed to forget.
 *
 * Cost per line is O(1): the ring overwrites in place (no Array#shift), the
 * room map is kept in least-recently-written order (so eviction and the sweep
 * read it from the front, no sort), and the byte accounting is the stored
 * string lengths.
 *
 * Optional JSONL file sink (`GAME_LOG_FILE=true`): one `<roomId>.jsonl` per
 * room under `fileDirectory`, appended in batches, so a game's log survives a
 * process restart. NOTHING on the write path touches the disk synchronously:
 * the directory listing is an async, cached index, and a room whose file
 * predates this process is merged back in by `ensureLoaded()` (the dev API
 * awaits it before reading; `record()` kicks it off in the background).
 *
 * Deliberately has NO dependency on the logger (the logger feeds it), so it
 * reports its own failures via console.error.
 */

const fs = require('fs');
const path = require('path');

const LEVEL_RANK = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

/** Bytes kept per serialized `data` payload; bigger payloads are shrunk (still valid JSON). */
const MAX_DATA_BYTES = 4096;
/** Characters kept per message; log lines that embed whole JSON payloads get cut. */
const MAX_MESSAGE_CHARS = 2048;
/** Fixed per-entry overhead for the byte budget (seq, ts, level, object). */
const ENTRY_OVERHEAD = 64;
/** How often pending file appends are flushed. */
const FILE_FLUSH_MS = 1000;
/** How long the cached directory listing is trusted. */
const FILE_INDEX_TTL_MS = 30_000;
/**
 * Message prefixes that make up a game's human-readable spine (see
 * observability/gameEvents). `narrative` reads keep these plus every
 * WARN/ERROR line and drop the protocol chatter.
 */
const NARRATIVE_PREFIXES = ['[GAME]', '[ROOM_LIFECYCLE]', '[DEV_CHANGE_CARDS]', '[FORFEIT]'];

/** Fixed-capacity ring: push overwrites the oldest in place. */
class Ring {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = new Array(capacity);
    this.start = 0;
    this.length = 0;
  }

  /** @returns {*} the evicted item, or undefined */
  push(item) {
    if (this.length < this.capacity) {
      this.items[(this.start + this.length) % this.capacity] = item;
      this.length += 1;
      return undefined;
    }
    const evicted = this.items[this.start];
    this.items[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
    return evicted;
  }

  at(i) {
    return this.items[(this.start + i) % this.capacity];
  }

  first() {
    return this.length ? this.at(0) : undefined;
  }

  last() {
    return this.length ? this.at(this.length - 1) : undefined;
  }

  toArray() {
    const out = new Array(this.length);
    for (let i = 0; i < this.length; i += 1) out[i] = this.at(i);
    return out;
  }
}

class GameLogStore {
  /**
   * @param {object} [options]
   * @param {number} [options.retentionMs]        keep a room's log this long after its last line
   * @param {number} [options.maxEntriesPerRoom]  ring size per room
   * @param {number} [options.maxTotalEntries]    global line cap across rooms
   * @param {number} [options.maxTotalBytes]      global byte cap across rooms
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
    this.maxTotalBytes = Math.max(1024 * 1024, Number(options.maxTotalBytes) || 128 * 1024 * 1024);
    this.fileEnabled = options.fileEnabled === true;
    this.fileDirectory = options.fileDirectory || path.join('./logs', 'games');
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();

    /**
     * roomId -> bucket, in least-recently-WRITTEN order (a write moves its room
     * to the end), which is what eviction and the sweep walk from the front.
     */
    this._rooms = new Map();
    this._lastKey = null;
    this._totalEntries = 0;
    this._totalBytes = 0;
    this._seq = 0;

    // File sink state: per-room pending lines + a per-room append chain so
    // writes (and the sweep's unlink) to one file never interleave out of order.
    this._pendingLines = new Map();
    this._appendChains = new Map();
    this._flushTimer = null;
    this._sweepTimer = null;
    /** roomId -> {file, mtimeMs} for files on disk (async, cached). */
    this._fileIndex = new Map();
    this._fileIndexAt = 0;
    this._fileIndexRefresh = null;
    this._loading = new Map();
    this._dirReady = null;
    // Stamped on every file line: ensureLoaded merges only lines an EARLIER
    // boot wrote (this boot's are already in memory).
    this._bootId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    if (this.fileEnabled) {
      this._ensureDirectory();
      this.refreshFileIndex().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Write path
  // ---------------------------------------------------------------------------

  /**
   * Append one line to a room's log. O(1), no disk I/O.
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
    if (LEVEL_RANK[stored.level] === undefined) stored.level = 'INFO';

    const bucket = this._touch(key, now);
    this._push(bucket, stored);
    bucket.lastAt = now;

    if (this._totalEntries > this.maxTotalEntries || this._totalBytes > this.maxTotalBytes) {
      this._evictColdestRooms(key);
    }

    if (this.fileEnabled) this._queueFileLine(key, stored);
    return stored;
  }

  /** Whether any line has been attributed to this room (memory only). */
  has(roomId) {
    return roomId != null && this._rooms.has(String(roomId));
  }

  /**
   * The room's bucket, created if missing, moved to the most-recent end of
   * the map. A room that has a file from before this process is flagged for
   * a background merge (see ensureLoaded) — never read inline.
   * @private
   */
  _touch(key, now) {
    let bucket = this._rooms.get(key);
    if (!bucket) {
      bucket = newBucket(now, this.maxEntriesPerRoom);
      this._rooms.set(key, bucket);
      if (this.fileEnabled && (this._fileIndex.has(key) || this._fileIndexAt === 0)) {
        bucket.pendingRestore = true;
        this.ensureLoaded(key).catch(() => {});
      }
    } else if (this._lastKey !== key) {
      this._rooms.delete(key);
      this._rooms.set(key, bucket);
    }
    this._lastKey = key;
    return bucket;
  }

  /** @private */
  _push(bucket, stored) {
    const bytes = entryBytes(stored);
    const evicted = bucket.ring.push(stored);
    bucket.counts[stored.level] += 1;
    bucket.bytes += bytes;
    this._totalEntries += 1;
    this._totalBytes += bytes;
    if (evicted) {
      const gone = entryBytes(evicted);
      bucket.counts[evicted.level] -= 1;
      bucket.bytes -= gone;
      bucket.dropped += 1;
      this._totalEntries -= 1;
      this._totalBytes -= gone;
    }
  }

  // ---------------------------------------------------------------------------
  // Read path
  // ---------------------------------------------------------------------------

  /**
   * Read a room's log (memory only — call ensureLoaded() first for a room
   * whose log may still be on disk only).
   * @param {string} roomId
   * @param {object} [opts]
   * @param {number} [opts.since]   only entries with seq > since (live tail cursor)
   * @param {string} [opts.level]   minimum level (error|warn|info|debug)
   * @param {string} [opts.q]       case-insensitive substring over msg + data
   * @param {number} [opts.limit]   page size (default 500, max 5000)
   * @param {boolean} [opts.tail]   with no `since`: return the LAST `limit` entries
   * @param {boolean} [opts.narrative] only game events, lifecycle events and warn/error lines
   * @param {boolean} [opts.excludeGame] drop `[GAME]` lines (the Story reads them from the recorder)
   * @returns {{success: boolean, roomId: string, entries: object[], total: number, hasMore: boolean, nextSince: number, source: string, error?: string}}
   */
  get(roomId, opts = {}) {
    const key = roomId == null ? '' : String(roomId);
    if (!key) return { success: false, error: 'roomId required' };

    const bucket = this._rooms.get(key);
    if (!bucket) return { success: false, roomId: key, error: 'No logs for room' };

    const since = Number.isFinite(Number(opts.since)) ? Number(opts.since) : 0;
    const maxRank = levelRank(opts.level, LEVEL_RANK.DEBUG);
    const needle = opts.q ? String(opts.q).toLowerCase() : null;
    const limit = Math.min(5000, Math.max(1, Number(opts.limit) || 500));
    const narrative = opts.narrative === true;
    const excludeGame = opts.excludeGame === true;

    const filtered = [];
    const ring = bucket.ring;
    for (let i = 0; i < ring.length; i += 1) {
      const e = ring.at(i);
      if (e.seq <= since) continue;
      if (LEVEL_RANK[e.level] > maxRank) continue;
      if (narrative && LEVEL_RANK[e.level] > LEVEL_RANK.WARN && !isNarrative(e.msg)) continue;
      if (excludeGame && e.msg.startsWith('[GAME]')) continue;
      if (needle) {
        const hay = `${e.msg}\n${e.data || ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      filtered.push(e);
    }

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
      restoring: bucket.pendingRestore === true,
      retentionMs: this.retentionMs,
    };
  }

  /**
   * Rooms that currently have a log, newest activity first. Rooms whose file
   * is on disk but not loaded (after a restart) are listed from the cached
   * index with `onDisk: true` and no counts — reading them loads them.
   * Never touches the disk itself (a stale index is refreshed in the
   * background; await refreshFileIndex() for a fresh one).
   * @returns {Array<{roomId: string, count: number|null, firstAt: string|null, lastAt: string, errors: number, warns: number}>}
   */
  list() {
    const rows = [];
    for (const [roomId, bucket] of this._rooms) {
      const last = bucket.ring.last();
      rows.push({
        roomId,
        count: bucket.ring.length,
        dropped: bucket.dropped,
        firstAt: new Date(bucket.firstAt).toISOString(),
        lastAt: new Date(bucket.lastAt).toISOString(),
        errors: bucket.counts.ERROR || 0,
        warns: bucket.counts.WARN || 0,
        restored: bucket.restored === true,
        onDisk: false,
        lastMessage: last ? last.msg : null,
      });
    }
    if (this.fileEnabled) {
      if (this._now() - this._fileIndexAt > FILE_INDEX_TTL_MS) this.refreshFileIndex().catch(() => {});
      for (const [roomId, file] of this._fileIndex) {
        if (this._rooms.has(roomId)) continue;
        rows.push({
          roomId,
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
      bytes: this._totalBytes,
      maxTotalBytes: this.maxTotalBytes,
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
   * Drop rooms idle past retention from memory, and schedule the matching
   * file cleanup. Returns how many rooms were dropped from memory.
   * @param {number} [now]
   */
  sweep(now = this._now()) {
    const cutoff = now - this.retentionMs;
    let dropped = 0;
    for (const [roomId, bucket] of Array.from(this._rooms)) {
      if (bucket.lastAt >= cutoff) continue;
      this._dropRoom(roomId, bucket);
      dropped += 1;
    }
    if (this.fileEnabled) this.sweepFiles(cutoff).catch(() => {});
    return dropped;
  }

  /**
   * Unlink room files idle past retention. Each unlink rides that room's
   * append chain, so a queued append can never land after it (recreating a
   * half file) or be deleted before it is written; a room that still has
   * pending lines is skipped this round.
   * @param {number} [cutoffMs]
   * @returns {Promise<number>} files removed
   */
  async sweepFiles(cutoffMs = this._now() - this.retentionMs) {
    if (!this.fileEnabled) return 0;
    const index = await this.refreshFileIndex({ force: true });
    const jobs = [];
    for (const [roomId, entry] of index) {
      if (entry.mtimeMs >= cutoffMs) continue;
      if (this._pendingLines.has(roomId)) continue;
      const bucket = this._rooms.get(roomId);
      if (bucket && bucket.lastAt >= cutoffMs) continue;
      const job = this._chain(roomId, () =>
        fs.promises.unlink(entry.file).then(
          () => {
            this._fileIndex.delete(roomId);
            return 1;
          },
          () => 0
        )
      );
      jobs.push(job);
    }
    const results = await Promise.all(jobs);
    return results.reduce((a, b) => a + (b || 0), 0);
  }

  /** Forget everything (tests). */
  clear() {
    this._rooms.clear();
    this._pendingLines.clear();
    this._appendChains.clear();
    this._loading.clear();
    this._lastKey = null;
    this._totalEntries = 0;
    this._totalBytes = 0;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _dropRoom(roomId, bucket) {
    this._totalEntries -= bucket.ring.length;
    this._totalBytes -= bucket.bytes;
    this._rooms.delete(roomId);
    if (this._lastKey === roomId) this._lastKey = null;
  }

  /** Global-cap pressure: drop whole rooms, least recently written first. */
  _evictColdestRooms(keepKey) {
    for (const [roomId, bucket] of this._rooms) {
      if (this._totalEntries <= this.maxTotalEntries && this._totalBytes <= this.maxTotalBytes) break;
      if (roomId === keepKey) continue;
      this._dropRoom(roomId, bucket);
    }
  }

  _ensureDirectory() {
    if (!this._dirReady) {
      this._dirReady = fs.promises.mkdir(this.fileDirectory, { recursive: true }).catch((error) => {
        console.error(
          '[GameLogStore] cannot create log directory, file sink disabled:',
          error.message
        );
        this.fileEnabled = false;
      });
    }
    return this._dirReady;
  }

  _filePath(roomId) {
    return path.join(this.fileDirectory, `${safeName(roomId)}.jsonl`);
  }

  _queueFileLine(roomId, stored) {
    let lines = this._pendingLines.get(roomId);
    if (!lines) {
      lines = [];
      this._pendingLines.set(roomId, lines);
    }
    lines.push(JSON.stringify({ ...stored, boot: this._bootId }));
  }

  /** Run `task` after everything already queued for this room's file. */
  _chain(roomId, task) {
    const prev = this._appendChains.get(roomId) || Promise.resolve();
    const next = prev.then(task).catch((error) => {
      console.error(`[GameLogStore] file op failed for ${roomId}:`, error && error.message);
    });
    const tracked = next.then((value) => {
      if (this._appendChains.get(roomId) === tracked) this._appendChains.delete(roomId);
      return value;
    });
    this._appendChains.set(roomId, tracked);
    return tracked;
  }

  /** Append every pending line to its room file. Resolves when all appends land. */
  flush() {
    if (!this.fileEnabled || this._pendingLines.size === 0) return Promise.resolve();
    const jobs = [];
    for (const roomId of Array.from(this._pendingLines.keys())) jobs.push(this._flushRoom(roomId));
    return Promise.all(jobs).then(() => undefined);
  }

  /** Append one room's pending lines (and wait for anything queued before). */
  _flushRoom(roomId) {
    const lines = this._pendingLines.get(roomId);
    if (!lines || !lines.length) return this._appendChains.get(roomId) || Promise.resolve();
    this._pendingLines.delete(roomId);
    const chunk = lines.join('\n') + '\n';
    const file = this._filePath(roomId);
    return this._chain(roomId, async () => {
      await this._ensureDirectory();
      await fs.promises.appendFile(file, chunk);
      this._fileIndex.set(roomId, { file, mtimeMs: this._now() });
    });
  }

  /**
   * Refresh the cached listing of room files (async readdir + stat).
   * @returns {Promise<Map<string, {file: string, mtimeMs: number}>>}
   */
  refreshFileIndex({ force = false } = {}) {
    if (!this.fileEnabled) return Promise.resolve(this._fileIndex);
    if (!force && this._fileIndexAt && this._now() - this._fileIndexAt < FILE_INDEX_TTL_MS) {
      return Promise.resolve(this._fileIndex);
    }
    if (this._fileIndexRefresh) return this._fileIndexRefresh;
    this._fileIndexRefresh = (async () => {
      let names = [];
      try {
        names = await fs.promises.readdir(this.fileDirectory);
      } catch {
        names = [];
      }
      const next = new Map();
      await Promise.all(
        names
          .filter((name) => name.endsWith('.jsonl'))
          .map(async (name) => {
            const file = path.join(this.fileDirectory, name);
            try {
              const stat = await fs.promises.stat(file);
              next.set(name.slice(0, -'.jsonl'.length), { file, mtimeMs: stat.mtimeMs });
            } catch {
              // raced with a sweep — skip
            }
          })
      );
      this._fileIndex = next;
      this._fileIndexAt = this._now();
      this._fileIndexRefresh = null;
      return next;
    })();
    return this._fileIndexRefresh;
  }

  /**
   * Make sure a room's log includes what is on disk (restart recovery). Loads
   * the file asynchronously and merges it UNDER whatever this process has
   * recorded for the room: every file line is stamped with the boot that
   * wrote it, so lines of an earlier boot are prepended and this boot's own
   * lines (already in memory, flushed or not) are never counted twice. All
   * entries are renumbered with THIS process's seq counter so `since` cursors
   * stay monotonic (a live tail open across the merge may see a few lines
   * twice).
   * @param {string} roomId
   * @returns {Promise<boolean>} whether the room has a log now
   */
  ensureLoaded(roomId) {
    const key = roomId == null ? '' : String(roomId);
    if (!key) return Promise.resolve(false);
    const existing = this._rooms.get(key);
    if (existing && !existing.pendingRestore) return Promise.resolve(true);
    if (!this.fileEnabled) return Promise.resolve(Boolean(existing));
    if (this._loading.has(key)) return this._loading.get(key);

    const job = (async () => {
      let raw = null;
      try {
        raw = await fs.promises.readFile(this._filePath(key), 'utf8');
      } catch {
        raw = null;
      }
      // Synchronous from here on: nothing can record in between.
      const current = this._rooms.get(key);
      const older = [];
      if (raw !== null) {
        for (const line of raw.split('\n')) {
          if (!line) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // torn line (crash mid-write)
          }
          if (!parsed || typeof parsed.msg !== 'string' || parsed.boot === this._bootId) continue;
          older.push({
            ts: parsed.ts || new Date(0).toISOString(),
            level: LEVEL_RANK[parsed.level] === undefined ? 'INFO' : parsed.level,
            msg: parsed.msg,
            data: parsed.data ?? null,
          });
        }
      }
      if (!older.length) {
        if (current) current.pendingRestore = false;
        return Boolean(current);
      }
      const merged = older.concat(current ? current.ring.toArray() : []);
      const tail = merged.slice(-this.maxEntriesPerRoom);
      const bucket = newBucket(this._now(), this.maxEntriesPerRoom);
      bucket.restored = true;
      for (const e of tail) {
        this._push(bucket, { seq: ++this._seq, ts: e.ts, level: e.level, msg: e.msg, data: e.data });
      }
      bucket.dropped = Math.max(0, merged.length - tail.length) + (current ? current.dropped : 0);
      bucket.firstAt = Date.parse(bucket.ring.first().ts) || bucket.firstAt;
      bucket.lastAt = current ? current.lastAt : Date.parse(bucket.ring.last().ts) || bucket.lastAt;
      if (current) this._dropRoom(key, current);
      this._rooms.set(key, bucket);
      if (this._totalEntries > this.maxTotalEntries || this._totalBytes > this.maxTotalBytes) {
        this._evictColdestRooms(key);
      }
      return this._rooms.has(key);
    })().finally(() => {
      this._loading.delete(key);
    });
    this._loading.set(key, job);
    return job;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function newBucket(now, capacity) {
  return {
    ring: new Ring(capacity),
    firstAt: now,
    lastAt: now,
    counts: { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 },
    bytes: 0,
    dropped: 0,
    restored: false,
    pendingRestore: false,
  };
}

function entryBytes(entry) {
  return ENTRY_OVERHEAD + entry.msg.length + (entry.data ? entry.data.length : 0);
}

function safeName(roomId) {
  return String(roomId)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120);
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

function jsonReplacer(_key, val) {
  if (val instanceof Map) return Object.fromEntries(val);
  if (val instanceof Set) return Array.from(val);
  if (typeof val === 'bigint') return val.toString();
  return val;
}

function stringify(value) {
  try {
    return JSON.stringify(value, jsonReplacer);
  } catch {
    return undefined; // circular etc. — the caller falls back
  }
}

/**
 * Shrink a value structurally: long strings cut with a marker, long arrays
 * keep their head plus a marker, deep/wide objects summarized. The result is
 * always a JSON-able value.
 */
function shrinkValue(value, depth, lim) {
  if (typeof value === 'string') {
    return value.length > lim.str ? `${value.slice(0, lim.str)}…[+${value.length - lim.str} chars]` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) value = Object.fromEntries(value);
  else if (value instanceof Set) value = Array.from(value);
  if (depth >= lim.depth) return Array.isArray(value) ? `[${value.length} items]` : '[object]';
  if (Array.isArray(value)) {
    const head = value.slice(0, lim.arr).map((v) => shrinkValue(v, depth + 1, lim));
    if (value.length > lim.arr) head.push(`…[+${value.length - lim.arr} items]`);
    return head;
  }
  const out = {};
  const keys = Object.keys(value);
  for (const k of keys.slice(0, lim.keys)) out[k] = shrinkValue(value[k], depth + 1, lim);
  if (keys.length > lim.keys) out['…'] = `+${keys.length - lim.keys} keys`;
  return out;
}

const SHRINK_STEPS = [
  { str: 512, arr: 40, keys: 60, depth: 6 },
  { str: 128, arr: 12, keys: 30, depth: 4 },
  { str: 48, arr: 4, keys: 16, depth: 2 },
];

/**
 * Compact, size-capped JSON for the `data` payload (Errors keep message +
 * stack). Anything over MAX_DATA_BYTES is shrunk STRUCTURALLY so the stored
 * text is still valid JSON, and carries `_truncated: {bytes}` with the
 * original size. Plain-string data stays a (cut) string.
 */
function serializeData(data) {
  if (data === null || data === undefined) return null;
  let value = data;
  if (data instanceof Error) {
    value = { name: data.name, message: data.message, stack: data.stack };
  }
  if (typeof value === 'string') return truncate(value, MAX_DATA_BYTES);
  const json = stringify(value);
  if (json === undefined) return truncate(String(value), MAX_DATA_BYTES);
  if (json.length <= MAX_DATA_BYTES) return json;

  for (const lim of SHRINK_STEPS) {
    const shrunk = shrinkValue(value, 0, lim);
    const wrapped =
      shrunk && typeof shrunk === 'object' && !Array.isArray(shrunk)
        ? { ...shrunk, _truncated: { bytes: json.length } }
        : { value: shrunk, _truncated: { bytes: json.length } };
    const text = stringify(wrapped);
    if (text !== undefined && text.length <= MAX_DATA_BYTES) return text;
  }
  return JSON.stringify({
    _truncated: { bytes: json.length },
    keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 40) : undefined,
    preview: json.slice(0, 1024),
  });
}

function formatLine(entry) {
  const base = `[${entry.ts}] [${entry.level}] ${entry.msg}`;
  return entry.data ? `${base} ${entry.data}` : base;
}

module.exports = GameLogStore;
module.exports.LEVEL_RANK = LEVEL_RANK;
module.exports.formatLine = formatLine;
module.exports.serializeData = serializeData;
module.exports.Ring = Ring;
