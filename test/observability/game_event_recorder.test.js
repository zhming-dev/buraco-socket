/**
 * GameEventRecorder: per-match keying, byte budgets (per match + global),
 * O(1) appends, resume keyframes after a restart, and the async gzip
 * persistence (flush at round end, reload after the stream left memory,
 * retention pruning). Plus the pure codec it is built on.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const GameEventRecorder = require('../../src/observability/GameEventRecorder');
const ReplayEngine = require('../../src/observability/ReplayEngine');
const codec = require('../../src/observability/replayCodec');
const { GameRoom } = require('../../src/models');
const PlayerSession = require('../../src/models/PlayerSession');

let roomCounter = 0;
function dealtRoom({ roomId, seats = 2 } = {}) {
  roomCounter += 1;
  const room = new GameRoom({ roomId: roomId || `rec-room-${roomCounter}`, maxPlayers: seats });
  for (let i = 0; i < seats; i += 1) {
    room.addPlayer(new PlayerSession({ playerId: `p${i}`, playerName: `P${i}`, playerIndex: i, socketId: `s${i}` }));
  }
  room.startGame();
  room.dealCards();
  room.runFirstTurnDraw();
  return room;
}

/** Move the top stock card into the current seat's hand, like a draw. */
function draw(room) {
  const p = room.getPlayerByIndex(room.currentTurn);
  const c = room.deck.draw();
  room.playerHands.get(p.playerId).push(c);
  return c;
}

describe('replayCodec', () => {
  it('card refs round-trip, jokers and tens included', () => {
    for (const card of [
      { suit: 'hearts', rank: 'Q', cardId: 12 },
      { suit: 'spades', rank: '10', cardId: 7 },
      { suit: 'joker', rank: 'joker', isJoker: true, cardId: 105 },
    ]) {
      const ref = codec.cardRef(card);
      const back = codec.parseCardRef(ref);
      expect(back.cardId).to.equal(card.cardId);
      expect(back.rank).to.equal(card.rank);
      expect(back.suit).to.equal(card.suit);
    }
    expect(codec.cardRef({ suit: 'hearts', rank: 'Q', cardId: 12 })).to.equal('QH#12');
    expect(codec.cardRef({ suit: 'joker', rank: 'joker', cardId: 3 })).to.equal('JK#3');
  });

  it('list diffs are remove/append when that is smaller, a full set otherwise', () => {
    expect(codec.listDiff([1, 2, 3], [1, 2, 3])).to.equal(undefined);
    expect(codec.listDiff([1, 2, 3, 4], [2, 3, 4])).to.deep.equal({ r: [1] }); // draw off the top
    expect(codec.listDiff([1, 2, 3], [1, 2, 3, 9])).to.deep.equal({ a: [9] }); // card in
    expect(codec.listDiff([1, 2, 3, 4, 5], [1, 3, 5, 8])).to.deep.equal({ r: [2, 4], a: [8] });
    expect(codec.listDiff([1, 2, 3], [3, 2, 1])).to.deep.equal([3, 2, 1]); // reshuffle
    expect(codec.listDiff([1, 2, 3], [])).to.deep.equal([]);
    for (const [a, b] of [[[1, 2, 3, 4], [2, 3, 4]], [[1, 2, 3, 4, 5], [1, 3, 5, 8]], [[1, 2], [2, 1]]]) {
      expect(codec.applyListDiff(a, codec.listDiff(a, b))).to.deep.equal(b);
    }
  });

  it('meld and zone diffs apply back to the exact capture', () => {
    const before = { h0: [1, 2, 3, 4], m0: [[5, 6, 7]], g0: {}, s: [8, 9], d: [], w0: [10], w1: [11] };
    const after = { h0: [2, 4], m0: [[5, 6, 7, 1], [3, 12, 13]], g0: { 0: 'semi' }, s: [9], d: [8], w0: [], w1: [11] };
    const diff = codec.diffZones(before, after);
    expect(diff.w1).to.equal(undefined);
    expect(diff.m0).to.deep.equal({ n: 2, c: { 0: [5, 6, 7, 1], 1: [3, 12, 13] } });
    expect(codec.applyZoneDiff(before, diff)).to.deep.equal(after);
    expect(codec.tableChecksum(after, { teamA: 5 })).to.equal(codec.tableChecksum(codec.cloneZones(after), { teamA: 5 }));
    expect(codec.tableChecksum(after, { teamA: 5 })).to.not.equal(codec.tableChecksum(before, { teamA: 5 }));
  });
});

describe('GameEventRecorder', () => {
  it('keys streams by match: round 1 opens one, later rounds continue it, a new round 1 starts another', () => {
    const rec = new GameEventRecorder();
    const room = dealtRoom();
    const first = rec.record(room, 'deal', { round: 1 });
    expect(first.seq).to.equal(1);
    const matchId = first.matchId;
    expect(matchId).to.match(/^rec-room-\d+-\d+$/);

    draw(room);
    expect(rec.record(room, 'draw', { seat: room.currentTurn }).matchId).to.equal(matchId);
    rec.record(room, 'round_end', { round: 1 });
    // Round 2 of the same match.
    room.startGame();
    room.dealCards();
    const r2 = rec.record(room, 'deal', { round: 2 });
    expect(r2.matchId).to.equal(matchId);
    rec.record(room, 'match_end', { round: 2 });
    expect(rec.currentMatchId(room.roomId)).to.equal(null);

    // The same room object hosts a NEW match: a second stream, no merge.
    room.roundNumber = 0;
    room.startGame();
    room.dealCards();
    const next = rec.record(room, 'deal', { round: 1 });
    expect(next.matchId).to.not.equal(matchId);
    expect(next.seq).to.equal(1);
  });

  it('records nothing for a room with no match (lobby chatter, a void before any deal)', () => {
    const rec = new GameEventRecorder();
    const room = new GameRoom({ roomId: 'lobby-only', maxPlayers: 2 });
    expect(rec.record(room, 'leave', { seat: 1 })).to.equal(null);
    expect(rec.record(room, 'voided', { reason: 'admin_closed' })).to.equal(null);
    expect(rec.stats().liveMatches).to.equal(0);
  });

  it('opens a partial stream on a RESUME keyframe when a restored room keeps playing', async () => {
    const rec = new GameEventRecorder();
    const room = dealtRoom({ roomId: 'restored-room' });
    draw(room);
    const head = rec.record(room, 'discard', { seat: 0 });
    expect(head.seq).to.equal(2);
    const stream = await rec.load(head.matchId);
    expect(stream.header.partial).to.equal(true);
    expect(stream.header.resumed).to.equal(true);
    expect(stream.events[0].type).to.equal('resume');
    expect(stream.events[0].kf.reason).to.equal('resume');
    expect(ReplayEngine.reconstruct(stream).zones).to.deep.equal(codec.captureZones(room));
  });

  it('appends in O(1): 20x the events do not cost 20x per event more (no rescans, no shifts)', () => {
    const rec = new GameEventRecorder({ maxBytesPerMatch: 512 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 });
    const room = dealtRoom();
    rec.record(room, 'deal', { round: 1 });
    const burst = (n) => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i += 1) rec.record(room, 'timeout', { seat: 0 });
      return Number(process.hrtime.bigint() - t0) / n;
    };
    burst(2000); // warm-up
    const small = burst(2000);
    for (let i = 0; i < 18; i += 1) burst(2000);
    const large = burst(2000);
    // Per-event cost stays flat as the stream grows (generous bound for CI noise).
    expect(large).to.be.lessThan(small * 4 + 20_000);
    expect(rec.currentMatchId(room.roomId)).to.be.a('string');
  });

  it('enforces the per-match budget: past it only the round skeleton is kept, flagged truncated', async () => {
    const rec = new GameEventRecorder({ maxBytesPerMatch: 16 * 1024 });
    const room = dealtRoom();
    const { matchId } = rec.record(room, 'deal', { round: 1 }); // the keyframe alone is a few KB
    for (let i = 0; i < 500; i += 1) rec.record(room, 'timeout', { seat: 0, pad: 'x'.repeat(40) });
    const end = rec.record(room, 'match_end', { round: 1 });
    expect(end).to.not.equal(null); // essential events are never dropped
    const stream = await rec.load(matchId);
    expect(stream.header.truncated).to.equal(true);
    expect(stream.header.droppedEvents).to.be.greaterThan(0);
    expect(stream.header.bytes).to.be.lessThan(16 * 1024 + 4096);
    expect(stream.events[stream.events.length - 1].type).to.equal('match_end');
  });

  it('enforces the global budget by dropping FINISHED matches oldest-first', async () => {
    const rec = new GameEventRecorder({ maxBytesPerMatch: 16 * 1024, maxTotalBytes: 16 * 1024 });
    const finished = [];
    for (let i = 0; i < 6; i += 1) {
      const room = dealtRoom();
      const { matchId } = rec.record(room, 'deal', { round: 1 });
      for (let j = 0; j < 20; j += 1) rec.record(room, 'timeout', { seat: 0, pad: 'y'.repeat(100) });
      rec.record(room, 'match_end', {});
      finished.push(matchId);
    }
    const stats = rec.stats();
    expect(stats.bytes).to.be.at.most(16 * 1024);
    expect(await rec.load(finished[0])).to.equal(null); // oldest evicted (no disk here)
    expect(await rec.load(finished[5])).to.not.equal(null); // newest kept
  });

  describe('persistence', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replays-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('writes gzipped JSON at round end / match end and reloads it once it left memory', async () => {
      const rec = new GameEventRecorder({ persist: true, directory: dir });
      const room = dealtRoom({ roomId: 'disk room/1' });
      const { matchId } = rec.record(room, 'deal', { round: 1 });
      draw(room);
      rec.record(room, 'draw', { seat: room.currentTurn });
      // Nothing is written while the round is played.
      await new Promise((r) => setTimeout(r, 20));
      expect(fs.readdirSync(dir)).to.deep.equal([]);

      rec.record(room, 'round_end', { round: 1, teamScores: { teamA: 10, teamB: -5 } });
      await rec.flushAll();
      const file = path.join(dir, `${matchId}.json.gz`);
      expect(fs.existsSync(file)).to.equal(true);
      expect(matchId).to.match(/^[A-Za-z0-9._-]+$/); // the room id was sanitized
      const onDisk = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
      expect(onDisk.v).to.equal(1);
      expect(onDisk.events.map((e) => e.type)).to.deep.equal(['deal', 'draw', 'round_end']);
      expect(onDisk.header.status).to.equal('live');

      rec.record(room, 'match_end', { round: 1 });
      await rec.flushAll();
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `${matchId}.meta.json`), 'utf8'));
      expect(meta.status).to.equal('finished');
      expect(meta.endReason).to.equal('match_end');

      // A fresh recorder (a restart) finds it through the async disk index.
      const reborn = new GameEventRecorder({ persist: true, directory: dir });
      const listing = await reborn.list();
      expect(listing.matches.map((m) => m.matchId)).to.deep.equal([matchId]);
      expect(listing.matches[0].onDisk).to.equal(true);
      expect(listing.matches[0].roomId).to.equal('disk room/1');
      const stream = await reborn.load(matchId);
      expect(stream.events).to.have.length(4);
      expect(ReplayEngine.verify(stream).ok).to.equal(true);
      // gzip passthrough for a finished match
      const gz = await reborn.readCompressed(matchId);
      expect(zlib.gunzipSync(gz).toString('utf8')).to.include('"match_end"');
      // unsafe ids never reach the filesystem
      expect(await reborn.load('../../etc/passwd')).to.equal(null);
    });

    it('prunes replays past retention', async () => {
      const rec = new GameEventRecorder({ persist: true, directory: dir, retentionMs: 60_000 });
      const room = dealtRoom();
      const { matchId } = rec.record(room, 'deal', { round: 1 });
      rec.record(room, 'match_end', {});
      await rec.flushAll();
      const file = path.join(dir, `${matchId}.json.gz`);
      const old = new Date(Date.now() - 2 * 60_000);
      fs.utimesSync(file, old, old);
      const removed = await rec.pruneDisk();
      expect(removed).to.equal(1);
      expect(fs.readdirSync(dir)).to.deep.equal([]);
    });

    it('a room torn down mid-match still gets its stream closed and written', async () => {
      const rec = new GameEventRecorder({ persist: true, directory: dir });
      const room = dealtRoom();
      const { matchId } = rec.record(room, 'deal', { round: 1 });
      rec.closeRoom(room.roomId, 'room_deleted');
      await rec.flushAll();
      const stream = await rec.load(matchId);
      expect(stream.header.endReason).to.equal('room_deleted');
      expect(stream.events.map((e) => e.type)).to.deep.equal(['deal', 'match_closed']);
    });
  });
});
