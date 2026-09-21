/**
 * Per-game log store: ring buffer, cursor/filter reads, >=2h retention sweep,
 * global cap eviction, and the JSONL file sink (restart recovery).
 */
/* eslint-env mocha */
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const GameLogStore = require('../../src/observability/GameLogStore');

const HOUR = 60 * 60 * 1000;

function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('GameLogStore', () => {
  describe('record / get', () => {
    it('keeps lines per room in order with a monotonic seq', () => {
      const store = new GameLogStore();
      store.record('r1', { level: 'INFO', message: 'one' });
      store.record('r2', { level: 'INFO', message: 'other room' });
      store.record('r1', { level: 'WARN', message: 'two', data: { seat: 1 } });

      const res = store.get('r1');
      expect(res.success).to.equal(true);
      expect(res.entries.map((e) => e.msg)).to.deep.equal(['one', 'two']);
      expect(res.entries[0].seq).to.be.lessThan(res.entries[1].seq);
      expect(res.entries[1].level).to.equal('WARN');
      expect(res.entries[1].data).to.equal('{"seat":1}');
      expect(res.total).to.equal(2);
      expect(res.hasMore).to.equal(false);
    });

    it('returns a not-found result for an unknown room and rejects an empty id', () => {
      const store = new GameLogStore();
      expect(store.get('nope').success).to.equal(false);
      expect(store.get('').success).to.equal(false);
      expect(store.record(null, { message: 'x' })).to.equal(null);
    });

    it('serializes Error data (message + stack) and truncates oversized payloads', () => {
      const store = new GameLogStore();
      store.record('r1', { level: 'ERROR', message: 'boom', data: new Error('kaput') });
      store.record('r1', { level: 'INFO', message: 'big', data: { blob: 'x'.repeat(10_000) } });
      store.record('r1', { level: 'INFO', message: 'm'.repeat(5000) });

      const [err, big, longMsg] = store.get('r1').entries;
      expect(JSON.parse(err.data).message).to.equal('kaput');
      expect(JSON.parse(err.data).stack).to.be.a('string');
      expect(big.data.length).to.be.lessThan(5000);
      expect(big.data).to.include('chars]');
      expect(longMsg.msg.length).to.be.lessThan(2200);
    });

    it('supports the live-tail cursor: since=<seq> returns only newer lines', () => {
      const store = new GameLogStore();
      store.record('r1', { message: 'a' });
      store.record('r1', { message: 'b' });
      const first = store.get('r1');
      store.record('r1', { message: 'c' });
      store.record('r1', { message: 'd' });

      const next = store.get('r1', { since: first.nextSince });
      expect(next.entries.map((e) => e.msg)).to.deep.equal(['c', 'd']);
      expect(store.get('r1', { since: next.nextSince }).entries).to.have.length(0);
    });

    it('filters by minimum level and by substring (message or data)', () => {
      const store = new GameLogStore();
      store.record('r1', { level: 'DEBUG', message: 'noise' });
      store.record('r1', { level: 'INFO', message: '[DISCARD] player p1 discarded' });
      store.record('r1', { level: 'WARN', message: 'slow', data: { playerId: 'p9' } });
      store.record('r1', { level: 'ERROR', message: 'bad' });

      expect(store.get('r1', { level: 'warn' }).entries.map((e) => e.msg)).to.deep.equal([
        'slow',
        'bad',
      ]);
      expect(store.get('r1', { level: 'info' }).entries).to.have.length(3);
      expect(store.get('r1', { q: 'discard' }).entries.map((e) => e.msg)).to.deep.equal([
        '[DISCARD] player p1 discarded',
      ]);
      expect(store.get('r1', { q: 'p9' }).entries.map((e) => e.msg)).to.deep.equal(['slow']);
    });

    it('narrative=true keeps game/lifecycle events and warn+ lines only', () => {
      const store = new GameLogStore();
      store.record('r1', { level: 'INFO', message: '[ROOM_LIFECYCLE] player_joined' });
      store.record('r1', { level: 'INFO', message: '[_sendInitialGameState] chatter' });
      store.record('r1', { level: 'INFO', message: '[GAME] draw', data: { game: 'draw' } });
      store.record('r1', { level: 'DEBUG', message: '[FailureManager] State persisted' });
      store.record('r1', { level: 'WARN', message: '[TURN_TIMER] offline strike' });
      store.record('r1', { level: 'ERROR', message: '[DISCARD_CARD] ✗ failed' });

      const res = store.get('r1', { narrative: true });
      expect(res.entries.map((e) => e.msg)).to.deep.equal([
        '[ROOM_LIFECYCLE] player_joined',
        '[GAME] draw',
        '[TURN_TIMER] offline strike',
        '[DISCARD_CARD] ✗ failed',
      ]);
      // composes with the level floor
      expect(store.get('r1', { narrative: true, level: 'error' }).entries).to.have.length(1);
    });

    it('pages from the head by default and from the tail with tail=true', () => {
      const store = new GameLogStore();
      for (let i = 1; i <= 10; i++) store.record('r1', { message: `l${i}` });

      const head = store.get('r1', { limit: 3 });
      expect(head.entries.map((e) => e.msg)).to.deep.equal(['l1', 'l2', 'l3']);
      expect(head.hasMore).to.equal(true);

      const tail = store.get('r1', { limit: 3, tail: true });
      expect(tail.entries.map((e) => e.msg)).to.deep.equal(['l8', 'l9', 'l10']);
    });
  });

  describe('bounds', () => {
    it('drops the oldest lines of a room past maxEntriesPerRoom and counts them', () => {
      const store = new GameLogStore({ maxEntriesPerRoom: 50 });
      for (let i = 1; i <= 60; i++)
        store.record('r1', { level: i <= 10 ? 'ERROR' : 'INFO', message: `l${i}` });

      const res = store.get('r1', { limit: 1000 });
      expect(res.entries).to.have.length(50);
      expect(res.entries[0].msg).to.equal('l11');
      expect(res.dropped).to.equal(10);
      // The evicted ERROR lines no longer count toward the listing badge.
      expect(store.list()[0].errors).to.equal(0);
    });

    it('evicts the least-recently-written rooms when the global cap is hit', () => {
      const clock = fakeClock();
      const store = new GameLogStore({
        maxEntriesPerRoom: 50,
        maxTotalEntries: 100,
        now: clock.now,
      });
      for (let i = 0; i < 50; i++) store.record('old', { message: 'x' });
      clock.advance(1000);
      for (let i = 0; i < 50; i++) store.record('mid', { message: 'x' });
      clock.advance(1000);
      for (let i = 0; i < 10; i++) store.record('new', { message: 'x' });

      expect(store.has('old')).to.equal(false);
      expect(store.has('mid')).to.equal(true);
      expect(store.has('new')).to.equal(true);
      expect(store.stats().entries).to.be.at.most(100);
    });
  });

  describe('retention', () => {
    it('keeps a finished game readable for the full retention window after its last line', () => {
      const clock = fakeClock();
      const store = new GameLogStore({ retentionMs: 2 * HOUR, now: clock.now });
      store.record('game', { message: 'game over' });

      clock.advance(2 * HOUR - 1000);
      expect(store.sweep()).to.equal(0);
      expect(store.get('game').success).to.equal(true);

      clock.advance(2000);
      expect(store.sweep()).to.equal(1);
      expect(store.get('game').success).to.equal(false);
    });

    it('measures retention from the LAST line, so a live game is never swept mid-play', () => {
      const clock = fakeClock();
      const store = new GameLogStore({ retentionMs: 2 * HOUR, now: clock.now });
      store.record('game', { message: 'start' });
      clock.advance(1.5 * HOUR);
      store.record('game', { message: 'still playing' });
      clock.advance(1.5 * HOUR);
      expect(store.sweep()).to.equal(0);
      expect(store.get('game').entries).to.have.length(2);
    });

    it('never accepts a retention below one minute and defaults to 2h', () => {
      expect(new GameLogStore({ retentionMs: 5 }).retentionMs).to.equal(60_000);
      expect(new GameLogStore().retentionMs).to.equal(2 * HOUR);
    });
  });

  describe('list', () => {
    it('lists rooms newest-activity first with error/warn counts', () => {
      const clock = fakeClock();
      const store = new GameLogStore({ now: clock.now });
      store.record('a', { level: 'ERROR', message: 'x' });
      clock.advance(10);
      store.record('b', { level: 'WARN', message: 'y' });
      store.record('b', { level: 'INFO', message: 'z' });

      const rows = store.list();
      expect(rows.map((r) => r.roomId)).to.deep.equal(['b', 'a']);
      expect(rows[0].count).to.equal(2);
      expect(rows[0].warns).to.equal(1);
      expect(rows[1].errors).to.equal(1);
      expect(rows[0].lastMessage).to.equal('z');
    });
  });

  describe('file sink', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamelog-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('appends JSONL per room on flush and reloads it in a fresh store (restart)', async () => {
      const store = new GameLogStore({ fileEnabled: true, fileDirectory: dir });
      store.record('room-9', { level: 'INFO', message: 'dealt' });
      store.record('room-9', { level: 'WARN', message: 'timeout', data: { seat: 0 } });
      store.record('other', { level: 'INFO', message: 'x' });
      await store.flush();

      const file = path.join(dir, 'room-9.jsonl');
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).to.have.length(2);
      expect(JSON.parse(lines[1]).msg).to.equal('timeout');

      // "Restart": a brand-new store over the same directory.
      const reborn = new GameLogStore({ fileEnabled: true, fileDirectory: dir });
      const listed = reborn.list();
      expect(listed.map((r) => r.roomId).sort()).to.deep.equal(['other', 'room-9']);
      expect(listed.find((r) => r.roomId === 'room-9').onDisk).to.equal(true);

      const res = reborn.get('room-9');
      expect(res.success).to.equal(true);
      expect(res.restored).to.equal(true);
      expect(res.entries.map((e) => e.msg)).to.deep.equal(['dealt', 'timeout']);
      expect(res.entries[1].data).to.equal('{"seat":0}');

      // New lines after the restart continue the same room with a higher seq.
      reborn.record('room-9', { level: 'INFO', message: 'resumed' });
      const all = reborn.get('room-9');
      expect(all.entries.map((e) => e.msg)).to.deep.equal(['dealt', 'timeout', 'resumed']);
      expect(all.entries[2].seq).to.be.greaterThan(all.entries[1].seq);
    });

    it('skips a torn trailing line instead of failing the whole file', () => {
      fs.writeFileSync(
        path.join(dir, 'torn.jsonl'),
        JSON.stringify({
          seq: 1,
          ts: new Date().toISOString(),
          level: 'INFO',
          msg: 'ok',
          data: null,
        }) + '\n{"seq":2,"ts":"2026-'
      );
      const store = new GameLogStore({ fileEnabled: true, fileDirectory: dir });
      const res = store.get('torn');
      expect(res.success).to.equal(true);
      expect(res.entries.map((e) => e.msg)).to.deep.equal(['ok']);
    });

    it('unlinks files idle past retention on sweep', async () => {
      const clock = fakeClock(Date.now());
      const store = new GameLogStore({
        fileEnabled: true,
        fileDirectory: dir,
        retentionMs: 2 * HOUR,
        now: clock.now,
      });
      store.record('stale', { message: 'x' });
      await store.flush();
      const file = path.join(dir, 'stale.jsonl');
      const past = new Date(Date.now() - 3 * HOUR);
      fs.utimesSync(file, past, past);

      clock.advance(3 * HOUR);
      store.sweep();
      expect(fs.existsSync(file)).to.equal(false);
      expect(store.has('stale')).to.equal(false);
    });

    it('sanitizes the room id into a safe file name', async () => {
      const store = new GameLogStore({ fileEnabled: true, fileDirectory: dir });
      store.record('../../etc/passwd', { message: 'nope' });
      await store.flush();
      const names = fs.readdirSync(dir);
      expect(names).to.have.length(1);
      expect(names[0]).to.not.include('/');
      expect(names[0]).to.match(/^[A-Za-z0-9._-]+\.jsonl$/);
    });

    it('renderText produces one plain line per entry', () => {
      const store = new GameLogStore();
      store.record('r', { level: 'INFO', message: 'hello', data: { a: 1 } });
      const text = store.renderText('r');
      expect(text).to.match(/^\[.+\] \[INFO\] hello \{"a":1\}\n$/);
      expect(store.renderText('missing')).to.equal(null);
    });
  });
});
