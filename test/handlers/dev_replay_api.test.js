/**
 * Dev console API: the /dev/api auth rule (fail closed, header only) and the
 * /dev/api/matches endpoints (listing, stream with a since-cursor, gzip
 * passthrough, table state at a seq).
 */
/* eslint-env mocha */
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { isDevAuthorized, handleDevMatches } = require('../../src/dev/devApi');
const GameEventRecorder = require('../../src/observability/GameEventRecorder');
const { GameRoom } = require('../../src/models');
const PlayerSession = require('../../src/models/PlayerSession');

function req(url, headers = {}) {
  return { url, headers, method: 'GET' };
}

function res() {
  const out = { statusCode: 0, headers: {}, body: null };
  return {
    out,
    headersSent: false,
    set statusCode(v) {
      out.statusCode = v;
    },
    get statusCode() {
      return out.statusCode;
    },
    setHeader(k, v) {
      out.headers[k.toLowerCase()] = v;
    },
    end(body) {
      out.body = body;
    },
    json() {
      const buf = Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body));
      const text = out.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      return JSON.parse(text);
    },
  };
}

function playedMatch(recorder, roomId) {
  const room = new GameRoom({ roomId, maxPlayers: 2 });
  for (let i = 0; i < 2; i += 1) {
    room.addPlayer(new PlayerSession({ playerId: `p${i}`, playerName: `P${i}`, playerIndex: i, socketId: `s${i}` }));
  }
  room.startGame();
  room.dealCards();
  const { matchId } = recorder.record(room, 'deal', { round: 1 });
  for (let i = 0; i < 3; i += 1) {
    const p = room.getPlayerByIndex(room.currentTurn);
    room.playerHands.get(p.playerId).push(room.deck.draw());
    recorder.record(room, 'draw', { seat: p.playerIndex });
  }
  recorder.record(room, 'match_end', { round: 1 });
  return { room, matchId };
}

describe('dev console API', () => {
  describe('auth (fail closed, header only)', () => {
    it('refuses everything when no secret is configured', () => {
      expect(isDevAuthorized(req('/dev/api/rooms', { 'x-webhook-secret': 'anything' }), null)).to.equal(false);
      expect(isDevAuthorized(req('/dev/api/rooms', { 'x-webhook-secret': '' }), '')).to.equal(false);
      expect(isDevAuthorized(req('/dev/api/rooms'), undefined)).to.equal(false);
    });

    it('accepts the right header and nothing else', () => {
      expect(isDevAuthorized(req('/dev/api/rooms', { 'x-webhook-secret': 's3cret' }), 's3cret')).to.equal(true);
      expect(isDevAuthorized(req('/dev/api/rooms', { 'x-webhook-secret': 's3cre' }), 's3cret')).to.equal(false);
      expect(isDevAuthorized(req('/dev/api/rooms', { 'x-webhook-secret': 's3cretX' }), 's3cret')).to.equal(false);
    });

    it('no longer accepts the secret as a query parameter', () => {
      expect(isDevAuthorized(req('/dev/api/rooms?secret=s3cret'), 's3cret')).to.equal(false);
    });
  });

  describe('/dev/api/matches', () => {
    let dir;
    let recorder;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devapi-'));
      recorder = new GameEventRecorder({ persist: true, directory: dir });
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('lists matches (filterable by room) with the room liveness', async () => {
      const a = playedMatch(recorder, 'room-a');
      playedMatch(recorder, 'room-b');
      await recorder.flushAll();
      const r = res();
      await handleDevMatches(req('/dev/api/matches?roomId=room-a'), r, {
        recorder,
        liveness: (roomId) => ({ live: false, roomStatus: roomId === 'room-a' ? null : 'finished' }),
      });
      const body = r.json();
      expect(r.out.statusCode).to.equal(200);
      expect(body.total).to.equal(1);
      expect(body.matches[0].matchId).to.equal(a.matchId);
      expect(body.matches[0].room).to.deep.equal({ live: false, roomStatus: null });
      expect(body.matches[0].events).to.equal(5);
    });

    it('serves the stream, with a since-cursor and the rounds index', async () => {
      const { matchId } = playedMatch(recorder, 'room-c');
      const r = res();
      await handleDevMatches(req(`/dev/api/matches/${matchId}`), r, { recorder });
      const body = r.json();
      expect(body.success).to.equal(true);
      expect(body.events.map((e) => e.type)).to.deep.equal(['deal', 'draw', 'draw', 'draw', 'match_end']);
      expect(body.rounds).to.deep.equal([{ round: 1, seq: 1, index: 0, reason: 'deal', endSeq: 5 }]);

      const r2 = res();
      await handleDevMatches(req(`/dev/api/matches/${matchId}?since=3`), r2, { recorder });
      expect(r2.json().events.map((e) => e.seq)).to.deep.equal([4, 5]);
    });

    it('passes a finished match straight through gzipped when the client accepts it', async () => {
      const { matchId } = playedMatch(recorder, 'room-d');
      await recorder.flushAll();
      const r = res();
      await handleDevMatches(req(`/dev/api/matches/${matchId}`, { 'accept-encoding': 'gzip, deflate' }), r, { recorder });
      expect(r.out.headers['content-encoding']).to.equal('gzip');
      expect(Buffer.isBuffer(r.out.body)).to.equal(true);
      expect(r.json().events).to.have.length(5);
    });

    it('rebuilds the table at a seq, shaped like the live room detail', async () => {
      const { room, matchId } = playedMatch(recorder, 'room-e');
      const r = res();
      await handleDevMatches(req(`/dev/api/matches/${matchId}/state?at=1`), r, { recorder });
      const atDeal = r.json();
      expect(atDeal.replay).to.equal(true);
      expect(atDeal.seq).to.equal(1);
      expect(atDeal.players.map((p) => p.hand.length)).to.deep.equal([11, 11]);
      expect(atDeal.deckCount).to.equal(room.deck.count + 3);
      expect(atDeal.deadPileCounts).to.deep.equal([11, 11]);
      expect(atDeal.discardPile).to.have.length(1);

      const r2 = res();
      await handleDevMatches(req(`/dev/api/matches/${matchId}/state`), r2, { recorder });
      const end = r2.json();
      expect(end.phase).to.equal('match_over');
      expect(end.verified).to.equal(true);
      expect(end.deckCount).to.equal(room.deck.count);
    });

    it('404s an unknown or unsafe match id', async () => {
      for (const id of ['nope-123', '..%2F..%2Fetc%2Fpasswd']) {
        const r = res();
        await handleDevMatches(req(`/dev/api/matches/${id}`), r, { recorder });
        expect(r.out.statusCode).to.equal(404);
      }
    });
  });
});
