/**
 * #11 multi-round — SERVER-driven next round.
 *
 * Before this, every round end parked the room in FINISHED, closed the backend
 * lobby row and armed a 60s delete; nothing ever dealt round N+1. The client
 * papered over it with a 10s auto `start_game` racing three server deadlines it
 * could only estimate. These tests pin the server-owned cadence and the traps it
 * had to neutralise:
 *
 *   TRAP A — the 60s room deletion must not run between rounds (it wiped the
 *            room AND the cumulative score).
 *   TRAP B — FINISHED is not IN_PROGRESS, so an intermission disconnect took the
 *            PRE-GAME branch: 30s later the seat was freed, or the whole room was
 *            killed if the dropper was the host.
 *   BACKEND — `room-closed` is PER MATCH (its body has no round dimension);
 *            `game-result` is PER ROUND. They were conflated.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoomStatus } = require('../../src/constants');
const config = require('../../src/config');

function fakeSocket(id, emitted) {
  return {
    id,
    join: () => {},
    leave: () => {},
    emit: (event, payload) => emitted.push({ scope: 'socket', id, event, payload }),
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'socket-to', id, roomId, event, payload }),
    }),
  };
}

function fakeIo(emitted, registry) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'room', roomId, event, payload }),
    }),
    sockets: { sockets: registry },
  };
}

// Player ids must be backend-user-id shaped (integers as strings), or
// _notifyBackendGameResult filters them all out and never POSTs.
const HOST = '10';
const OPP = '20';

/** A 2-seat room mid-match: dealt, IN_PROGRESS, with a live cumulative total. */
function liveRoom(service, roomId = 'nr1', { targetScore = 1000 } = {}) {
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, HOST, 'Host', 'sHost'); // index 0 → teamA
  service.joinRoom(roomId, OPP, 'Opp', 'sOpp'); //   index 1 → teamB
  room.targetScore = targetScore;
  room.startGame(true);
  room.dealCards();
  room.cumulativeTeamScores = new Map([['teamA', 320], ['teamB', 145]]);
  room.cumulativeScores = new Map([[HOST, 320], [OPP, 145]]);
  return room;
}

/**
 * Put the leading team far enough past the target that the round about to be
 * finalized is definitely the MATCH end.
 *
 * The margin is not cosmetic. These fixtures score a freshly dealt round, so
 * every seat is still holding a full hand and the round delta is a ~300-point
 * NEGATIVE swing (hand penalties, no melds). Simply setting targetScore=1 makes
 * matchEnded a coin flip on the shuffle: 320 - 300 lands either side of the line.
 */
function reachTarget(room) {
  room.cumulativeTeamScores = new Map([['teamA', room.targetScore * 5], ['teamB', 145]]);
}

/** The payload ActionHandlers._finalizeWith stamps for a NON-terminal round. */
function intermediatePayload() {
  return {
    type: 'round_ended',
    matchEnded: false,
    targetScore: 1000,
    cumulativeTeamScores: { teamA: 320, teamB: 145 },
    winnerId: HOST,
    winnerIndex: 0,
    roundWinnerId: HOST,
    roundWinnerIndex: 0,
  };
}

/**
 * End a round the way the real code does: ActionHandlers._finalizeWith flips the
 * room to FINISHED and stores the payload BEFORE the socket broadcasts it.
 * Skipping that leaves the room IN_PROGRESS and the scheduler correctly refuses
 * to deal, so the tests would pass for the wrong reason.
 */
function endRound(handlers, room, payload) {
  room.status = GameRoomStatus.FINISHED;
  room.gameEndedAt = new Date();
  room.lastRoundEndPayload = payload;
  handlers._broadcastRoundEndAndCleanup(room, payload);
  return payload;
}

describe('#11 multi-round — server-driven next round', () => {
  const services = [];
  let origFetch;
  let origUrl;
  let origSecret;
  let posts;
  let emitted;
  let registry;
  let io;

  beforeEach(() => {
    origFetch = global.fetch;
    origUrl = config.backend.url;
    origSecret = config.backend.webhookSecret;
    config.backend.url = 'http://backend.test';
    config.backend.webhookSecret = null;
    posts = [];
    global.fetch = (url, opts) => {
      posts.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      return Promise.resolve({ ok: true });
    };
    emitted = [];
    registry = new Map();
    registry.set('sHost', fakeSocket('sHost', emitted));
    registry.set('sOpp', fakeSocket('sOpp', emitted));
    io = fakeIo(emitted, registry);
  });

  afterEach(() => {
    global.fetch = origFetch;
    config.backend.url = origUrl;
    config.backend.webhookSecret = origSecret;
    while (services.length > 0) services.pop().shutdown();
  });

  function newService() {
    const service = new GameService();
    services.push(service);
    return service;
  }

  const roomClosedPosts = () => posts.filter((p) => /\/webhooks\/room-closed$/.test(p.url));
  const gameResultPosts = () => posts.filter((p) => /\/webhooks\/game-result$/.test(p.url));
  const gameStarted = () => emitted.filter((e) => e.event === 'game_started');
  const gameEnded = () => emitted.filter((e) => e.event === 'game_ended');

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------
  describe('a NON-terminal round end schedules the next deal', () => {
    it('arms the intermission instead of the 60s deletion, and keeps the backend row OPEN', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);

      endRound(handlers, room, intermediatePayload());

      expect(room.awaitingNextRound).to.equal(true);
      expect(room.nextRoundHandle).to.not.equal(null);
      expect(room.nextRoundAt).to.be.a('number');
      // TRAP A: the deletion that used to wipe the room + cumulative score.
      expect(room.finalizeCleanupHandle).to.equal(null);
      // The room is still there, and still carries the running total.
      expect(service.getRoom('nr1')).to.equal(room);
      expect(room.cumulativeTeamScores.get('teamA')).to.equal(320);
      // Per-ROUND webhook fires; the per-MATCH one does not.
      expect(gameResultPosts()).to.have.length(1);
      expect(roomClosedPosts()).to.have.length(0);
    });

    it('stamps the countdown on the round_ended payload so the client stops guessing', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      const payload = intermediatePayload();

      handlers._broadcastRoundEndAndCleanup(room, payload);

      // Ranges, not exact equality: nextRoundAt is stamped as Date.now()+delay
      // when the timer is armed, then nextRoundInMs is recomputed against a
      // SECOND Date.now() a few statements later. Crossing a millisecond boundary
      // in between legitimately yields delay-1, which flaked this assertion.
      const delay = SocketHandlers.NEXT_ROUND_DELAY_MS;
      expect(payload.nextRoundInMs).to.be.within(delay - 100, delay);
      expect(payload.nextRoundAt).to.equal(room.nextRoundAt);
      const broadcast = gameEnded().find((e) => e.scope === 'room');
      expect(broadcast.payload.nextRoundInMs).to.be.within(delay - 100, delay);
    });

    it('the intermission delay stays well under the 60s deletion and 30s waiting-leave windows', () => {
      expect(SocketHandlers.NEXT_ROUND_DELAY_MS).to.be.below(SocketHandlers.FINISHED_ROOM_GRACE_MS);
      expect(SocketHandlers.NEXT_ROUND_DELAY_MS).to.be.below(SocketHandlers.WAITING_GRACE_MS);

      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      // A nonsense per-room override can never escape the clamp.
      room.nextRoundDelayMs = 10 * 60 * 1000;
      expect(handlers._nextRoundDelayMs(room)).to.equal(SocketHandlers.WAITING_GRACE_MS);
      room.nextRoundDelayMs = 5;
      expect(handlers._nextRoundDelayMs(room)).to.equal(3000);
      room.nextRoundDelayMs = null;
      expect(handlers._nextRoundDelayMs(room)).to.equal(SocketHandlers.NEXT_ROUND_DELAY_MS);
    });
  });

  // ---------------------------------------------------------------------------
  // The host may cut the intermission short
  // ---------------------------------------------------------------------------
  describe('the HOST can start the next round early', () => {
    /** A room sitting in the between-rounds window with a deal pending. */
    function waiting(service, handlers) {
      const room = liveRoom(service);
      // endRound(), not a bare broadcast: a real round end marks the room
      // FINISHED first, and _startScheduledNextRound bails out of a room that is
      // still IN_PROGRESS ("someone already dealt"). Skipping it made these tests
      // pass while dealing nothing at all.
      endRound(handlers, room, intermediatePayload());
      expect(room.awaitingNextRound, 'the intermission is armed').to.equal(true);
      expect(room.nextRoundHandle, 'and a deal is pending').to.not.equal(null);
      return room;
    }

    it('deals immediately and cancels the pending timer', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = waiting(service, handlers);
      emitted.length = 0;

      await handlers.handleStartNextRound({ id: 'sHost' });

      expect(room.nextRoundHandle, 'the countdown was cancelled').to.equal(null);
      expect(room.awaitingNextRound, 'and the intermission is over').to.equal(false);
      // Only a real deal moves a FINISHED room back to IN_PROGRESS.
      expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);
      expect(room.cardsDealt).to.equal(true);
      expect(
        room.playerHands.get(HOST),
        'and hands were actually dealt'
      ).to.have.length(11);
    });

    it('a double tap deals ONCE', async () => {
      // The button sits under a finger on a laggy connection; two taps in the
      // same tick must not deal twice. There IS an await inside the deal path
      // before startGame(), which is exactly where a second call could slip in.
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = waiting(service, handlers);
      let deals = 0;
      const origDeal = room.dealCards.bind(room);
      room.dealCards = (...args) => {
        deals += 1;
        return origDeal(...args);
      };
      emitted.length = 0;

      await Promise.all([
        handlers.handleStartNextRound({ id: 'sHost', emit: () => {} }),
        handlers.handleStartNextRound({ id: 'sHost', emit: () => {} }),
      ]);

      expect(deals, 'the round was dealt exactly once').to.equal(1);
      expect(room.cardsDealt).to.equal(true);
    });

    it('refuses anyone who is not the host', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = waiting(service, handlers);
      emitted.length = 0;

      handlers.handleStartNextRound({ id: 'sOpp', emit: () => {} });

      expect(room.nextRoundHandle, 'the countdown still stands').to.not.equal(null);
      expect(room.awaitingNextRound, 'and the intermission still holds').to.equal(true);
    });

    it('refuses when no round is waiting', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service); // mid-round, nothing pending
      expect(room.awaitingNextRound).to.not.equal(true);
      emitted.length = 0;

      handlers.handleStartNextRound({ id: 'sHost', emit: () => {} });

      expect(room.nextRoundHandle == null, 'nothing was scheduled or started').to.equal(true);
    });

    it('the window still fits under BOTH lifecycle ceilings', () => {
      // 25s was chosen to sit under the 30s waiting-leave window; going past it
      // means a waiting player can be dropped mid-intermission, and past 60s the
      // room itself is deleted.
      expect(SocketHandlers.NEXT_ROUND_DELAY_MS).to.be.below(SocketHandlers.WAITING_GRACE_MS);
      expect(SocketHandlers.NEXT_ROUND_DELAY_MS).to.be.below(SocketHandlers.FINISHED_ROOM_GRACE_MS);
    });
  });

  describe('a TERMINAL round end does NOT schedule anything', () => {
    it('matchEnded:true closes the backend row and arms the 60s deletion, as before', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);

      endRound(handlers, room, { ...intermediatePayload(), matchEnded: true });

      expect(room.awaitingNextRound).to.equal(false);
      expect(room.nextRoundHandle).to.equal(null);
      expect(room.finalizeCleanupHandle).to.not.equal(null);
      expect(roomClosedPosts()).to.have.length(1);
      expect(roomClosedPosts()[0].body.reason).to.equal('game_ended');
    });

    it('an ABSENT matchEnded (single-round / pre-#11 payload) stays terminal — backward compatible', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service, 'nr1', { targetScore: 0 });

      endRound(handlers, room, { type: 'round_ended', winnerId: HOST, winnerIndex: 0 });

      expect(room.awaitingNextRound).to.equal(false);
      expect(room.finalizeCleanupHandle).to.not.equal(null);
      expect(roomClosedPosts()).to.have.length(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Performing the deal
  // ---------------------------------------------------------------------------
  describe('the scheduler performs the next deal', () => {
    it('deals round N+1 in place and PRESERVES the cumulative scores', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;

      await handlers._startScheduledNextRound('nr1');

      expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);
      expect(room.cardsDealt).to.equal(true);
      expect(room.awaitingNextRound).to.equal(false);
      expect(room.nextRoundHandle).to.equal(null);
      // The whole point of the match: the running total survives the re-deal.
      expect(room.cumulativeTeamScores.get('teamA')).to.equal(320);
      expect(room.cumulativeTeamScores.get('teamB')).to.equal(145);
      // Per-round one-shots reset so round N+1 can end normally.
      expect(room._roundEndBroadcast).to.equal(false);
      expect(room.resultReported).to.equal(false);
      // Both seats get GAME_STARTED with cardsDealt:false — the client's cue to
      // re-arm its deal latch, exactly like round 1.
      const starts = gameStarted();
      expect(starts.map((e) => e.id).sort()).to.deep.equal(['sHost', 'sOpp']);
      starts.forEach((e) => expect(e.payload.cardsDealt).to.equal(false));
      // ...and every seat actually holds cards afterwards.
      room.getPlayers().forEach((p) => {
        expect(room.playerHands.get(p.playerId)).to.have.length(11);
      });
    });

    it('the real timer fires on its own (no client start_game involved)', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      // Re-arm short so the test does not wait 10s; same code path.
      handlers._scheduleNextRound(room, 20);

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);
      expect(room.cardsDealt).to.equal(true);
      expect(room.nextRoundHandle).to.equal(null);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------
  describe('it is impossible to deal twice', () => {
    it('a host start_game during the intermission is a no-op (does not pre-empt the scheduler)', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;

      handlers.handleStartGame(registry.get('sHost'), { roomId: 'nr1' });

      expect(room.status).to.equal(GameRoomStatus.FINISHED);
      expect(room.awaitingNextRound).to.equal(true);
      expect(gameStarted()).to.have.length(0);
      // No error shown to the host either — it is a silent no-op.
      expect(emitted.filter((e) => e.event === 'error')).to.have.length(0);
    });

    it('the webhook start-game trigger reports the pending round instead of dealing', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;

      const result = handlers.triggerStartGame('nr1');

      expect(result).to.deep.include({ success: true, nextRoundPending: true });
      expect(room.status).to.equal(GameRoomStatus.FINISHED);
      expect(gameStarted()).to.have.length(0);
    });

    it('a manual start that DID win the race disarms the scheduler, which then no-ops', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      // Simulate any path that re-deals directly (startGame is the per-round
      // reset every start path funnels through).
      room.startGame(true);
      expect(room.awaitingNextRound).to.equal(false);
      expect(room.nextRoundHandle).to.equal(null);
      handlers._autoDealAfterStart(room, 'race winner');
      const deckAfterFirstDeal = room.deck.count;

      await handlers._startScheduledNextRound('nr1');

      // No second deal: the deck was not reshuffled under the players.
      expect(room.deck.count).to.equal(deckAfterFirstDeal);
      expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);
    });

    it('running the scheduler twice deals exactly once', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      await handlers._startScheduledNextRound('nr1');
      const deckAfterDeal = room.deck.count;
      await handlers._startScheduledNextRound('nr1');

      expect(room.deck.count).to.equal(deckAfterDeal);
      expect(gameStarted().filter((e) => e.id === 'sHost')).to.have.length(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Fallbacks — the timer fires but the room cannot start
  // ---------------------------------------------------------------------------
  describe('fallbacks when the next round cannot be dealt', () => {
    it('a seat that vanished ends the MATCH terminally instead of dealing a broken table', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;
      posts.length = 0;
      room.removePlayer(OPP); // below 2 players / no longer full

      await handlers._startScheduledNextRound('nr1');

      expect(room.status).to.equal(GameRoomStatus.FINISHED);
      expect(room.awaitingNextRound).to.equal(false);
      expect(room.nextRoundHandle).to.equal(null);
      const ended = gameEnded().find((e) => e.scope === 'room');
      expect(ended.payload.matchEnded).to.equal(true);
      expect(ended.payload.reason).to.equal('seat_missing');
      // No client is left waiting on a countdown that will never resolve.
      expect(ended.payload).to.not.have.property('nextRoundInMs');
      // ...and the match settles: backend row closed + normal teardown armed.
      expect(roomClosedPosts()).to.have.length(1);
      expect(room.finalizeCleanupHandle).to.not.equal(null);
    });

    it('a full table with no connected human settles rather than dealing into the void', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      room.getPlayers().forEach((p) => p.disconnect());
      emitted.length = 0;

      await handlers._startScheduledNextRound('nr1');

      const ended = gameEnded().find((e) => e.scope === 'room');
      expect(ended.payload.reason).to.equal('no_humans');
      expect(ended.payload.matchEnded).to.equal(true);
    });

    it('a room deleted during the intermission is never resurrected', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      service.deleteRoom('nr1');
      emitted.length = 0;

      await handlers._startScheduledNextRound('nr1');

      expect(service.getRoom('nr1')).to.equal(undefined);
      expect(gameStarted()).to.have.length(0);
      expect(gameEnded()).to.have.length(0);
    });

    it('a throw inside the deal never escapes the timer (it would kill the whole process)', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      // Blow up deep inside the deal, AFTER startGame flipped the room to
      // IN_PROGRESS — the half-started case.
      handlers._autoDealAfterStart = () => {
        throw new Error('boom');
      };
      handlers._scheduleNextRound(room, 10);

      await new Promise((resolve) => setTimeout(resolve, 80));

      // Process survived, and the match settled rather than sitting IN_PROGRESS
      // with no cards and no turn.
      expect(room.awaitingNextRound).to.equal(false);
      expect(room.status).to.equal(GameRoomStatus.FINISHED);
      const ended = gameEnded().find((e) => e.payload?.reason === 'deal_failed');
      expect(ended).to.be.an('object');
      expect(ended.payload.matchEnded).to.equal(true);
      expect(room.finalizeCleanupHandle).to.not.equal(null);
    });

    it('a throw AFTER a successful deal does NOT tear the live round down', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      // PartnerWebhookRelay.dispatch signs its body synchronously (JSON.stringify
      // + HMAC), so it CAN throw. That call used to sit inside the deal_failed
      // net, one statement past the point of no return: a relay throw flipped a
      // correctly dealt round N+1 back to FINISHED and emitted a BLANK terminal
      // card (round N's payload was already cleared by startGame, and the
      // _preDealRoundEndPayload snapshot dropped on the line above), losing the
      // match to a reporting failure.
      handlers.partnerWebhookRelay = {
        dispatch: (name) => {
          if (name === 'game.started') throw new TypeError('Converting circular structure to JSON');
        },
      };
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;

      await handlers._startScheduledNextRound('nr1');

      expect(room.isInProgress()).to.equal(true);
      expect(room.cardsDealt).to.equal(true);
      expect(gameEnded()).to.have.length(0);
      expect(room.finalizeCleanupHandle).to.equal(null);
    });

    it('a throw OUTSIDE the deal is caught by the outer net and still settles', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      // Throw between startGame() and the deal: the room is already IN_PROGRESS
      // with cardsDealt=false, which is the stranded state _failNextRound must
      // recognise even though awaitingNextRound has already been cleared.
      handlers._stopHostHeartbeat = () => {
        throw new Error('boom');
      };
      handlers._scheduleNextRound(room, 10);

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(room.status).to.equal(GameRoomStatus.FINISHED);
      const ended = gameEnded().find((e) => e.payload?.reason === 'scheduler_error');
      expect(ended).to.be.an('object');
      expect(ended.payload.matchEnded).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Timer hygiene
  // ---------------------------------------------------------------------------
  describe('the handle cannot leak', () => {
    it('disposeTimers() cancels the pending deal and clears the intermission', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      room.disposeTimers();

      expect(room.nextRoundHandle).to.equal(null);
      expect(room.awaitingNextRound).to.equal(false);
      expect(room.nextRoundAt).to.equal(null);
    });

    it('deleting the room cancels the pending deal (deleteRoom → disposeTimers)', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      service.deleteRoom('nr1');

      expect(room.nextRoundHandle).to.equal(null);
    });

    it('a terminal forfeit during the intermission cancels the pending deal', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      handlers._handlePlayerForfeit(null, room, OPP, room.getPlayer(OPP), {
        reason: 'opponent_left',
      });

      expect(room.awaitingNextRound).to.equal(false);
      expect(room.nextRoundHandle).to.equal(null);
      expect(room.lastRoundEndPayload.matchEnded).to.equal(true);
    });

    it('the 1-hour FINISHED sweep skips a room that is only between rounds', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      // getRoomAge() is MATCH age, so a long match trips the sweep mid-round.
      room.createdAt = new Date(Date.now() - 2 * 3600000);

      service._cleanupInactiveRooms();

      expect(service.getRoom('nr1')).to.equal(room);
    });

    it('a throw while broadcasting the round end still leaves a LIVE timer', () => {
      // The flag and the timer must be armed atomically. Every emit/webhook in
      // _broadcastRoundEndAndCleanup is one uncaught synchronous throw away
      // (JSON.stringify / HMAC inside the partner relay, socket.io
      // serialization), and awaitingNextRound=true with NO timer is now
      // UNRECOVERABLE: the 1-hour sweep above deliberately skips such rooms, so
      // the room and its player mappings would live for the life of the process.
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      handlers._notifyBackendGameResult = () => {
        throw new Error('boom');
      };

      room.status = GameRoomStatus.FINISHED;
      room.lastRoundEndPayload = intermediatePayload();
      expect(() =>
        handlers._broadcastRoundEndAndCleanup(room, room.lastRoundEndPayload)
      ).to.throw('boom');

      expect(room.awaitingNextRound).to.equal(true);
      expect(room.nextRoundHandle).to.not.equal(null);
    });
  });

  // ---------------------------------------------------------------------------
  // TRAP B — the intermission is IN-MATCH, not pre-game
  // ---------------------------------------------------------------------------
  describe('TRAP B: a disconnect during the intermission', () => {
    it('does NOT arm the pre-game waiting-leave that frees the seat', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      await handlers.handleDisconnect(registry.get('sOpp'));

      expect(handlers._waitingGraceTimers.size).to.equal(0);
      expect(room.getPlayer(OPP)).to.be.an('object');
      expect(room.players.size).to.equal(2);
    });

    it('does NOT kill the room when the dropper is the HOST', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      await handlers.handleDisconnect(registry.get('sHost'));

      expect(service.getRoom('nr1')).to.equal(room);
      expect(room.awaitingNextRound).to.equal(true);
      expect(emitted.filter((e) => e.event === 'room_closed')).to.have.length(0);
    });

    it('a stale waiting-leave timer armed before the round ended is a no-op', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      // Arm it while the room still looks pre-game, then open the intermission.
      room.status = GameRoomStatus.WAITING;
      handlers._scheduleWaitingLeave('nr1', OPP);
      room.status = GameRoomStatus.IN_PROGRESS;
      room.getPlayer(OPP).disconnect();
      endRound(handlers, room, intermediatePayload());

      // Run the timer body directly (its 30s deadline is not worth waiting for).
      const key = `nr1:${OPP}`;
      const handle = handlers._waitingGraceTimers.get(key);
      expect(handle).to.not.equal(undefined);
      clearTimeout(handle);
      handlers._waitingGraceTimers.delete(key);
      handlers._scheduleWaitingLeave('nr1', OPP);
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(room.players.size).to.equal(2);
      expect(service.getRoom('nr1')).to.equal(room);
    });
  });

  describe('TRAP B: seats are frozen during the intermission', () => {
    let service;
    let handlers;
    let room;

    beforeEach(() => {
      service = newService();
      handlers = new SocketHandlers(io, service);
      room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;
    });

    it('rejects switch_team (it would rewrite the team ids cumulativeTeamScores is keyed on)', () => {
      handlers.handleSwitchTeam(registry.get('sOpp'), {});
      expect(emitted.filter((e) => e.event === 'error')).to.have.length(1);
      expect(room.getPlayer(OPP).playerIndex).to.equal(1);
    });

    const swapFails = () => emitted.filter((e) => e.event === 'swap_failed');

    it('rejects claim_seat with "Game already started"', () => {
      handlers.handleClaimSeat(registry.get('sOpp'), { seat: 0 });
      expect(swapFails()).to.have.length(1);
      expect(swapFails()[0].payload.message).to.equal('Game already started');
      expect(room.getPlayer(OPP).playerIndex).to.equal(1);
      expect(room.getPlayer(HOST).playerIndex).to.equal(0);
    });

    it('rejects a host kick (the seat must survive to play round N+1)', () => {
      handlers.handleHostKick(registry.get('sHost'), { targetId: OPP });
      expect(swapFails()).to.have.length(1);
      expect(room.players.size).to.equal(2);
      expect(room.getPlayer(OPP)).to.be.an('object');
    });

    it('rejects leave_seat', () => {
      handlers.handleLeaveSeat(registry.get('sOpp'));
      expect(swapFails()).to.have.length(1);
      expect(room.getPlayer(OPP).playerIndex).to.equal(1);
    });

    it('rejects a host seat swap', () => {
      handlers.handleHostSwapSeats(registry.get('sHost'), { seatA: 0, seatB: 1 });
      expect(swapFails()).to.have.length(1);
      expect(room.getPlayer(HOST).playerIndex).to.equal(0);
      expect(room.getPlayer(OPP).playerIndex).to.equal(1);
    });

    it('rejects a swap request', () => {
      handlers.handleRequestSwap(registry.get('sOpp'), { targetPlayerId: HOST, targetSeat: 0 });
      expect(swapFails()).to.have.length(1);
    });

    it('rejects a seat invite', () => {
      handlers.handleInviteToSeat(registry.get('sHost'), { seat: 1 });
      expect(swapFails()).to.have.length(1);
    });
  });

  describe('TRAP B: a deliberate leave during the intermission', () => {
    it('forfeits the MATCH (terminal) instead of being swallowed as a ghost seat', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;

      handlers.handleLeaveRoom(registry.get('sOpp'));

      expect(room.awaitingNextRound).to.equal(false);
      expect(room.nextRoundHandle).to.equal(null);
      expect(room.lastRoundEndPayload.matchEnded).to.equal(true);
      expect(room.lastRoundEndPayload.reason).to.equal('opponent_left');
    });
  });

  describe('a player who reconnects mid-intermission is not stranded', () => {
    it('rebinds the socket so round N+1 reaches them, and replays a RE-BASED countdown', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      await handlers.handleDisconnect(registry.get('sOpp'));
      registry.delete('sOpp');

      const revived = fakeSocket('sOpp2', emitted);
      registry.set('sOpp2', revived);
      emitted.length = 0;
      await handlers.handleJoinRoom(revived, { roomId: 'nr1', playerId: OPP, playerName: 'Opp' });

      // The seat now points at the LIVE socket — the old code returned before
      // this rebinding, so the next round's `yourHand` went to a dead handle.
      expect(room.getPlayer(OPP).socketId).to.equal('sOpp2');
      expect(service.getPlayerIdBySocket('sOpp2')).to.equal(OPP);
      // They are told how much of the intermission is LEFT, not the original 10s.
      const card = emitted.find((e) => e.event === 'game_ended' && e.id === 'sOpp2');
      expect(card).to.be.an('object');
      expect(card.payload.matchEnded).to.equal(false);
      expect(card.payload.nextRoundInMs).to.be.at.most(SocketHandlers.NEXT_ROUND_DELAY_MS);

      emitted.length = 0;
      await handlers._startScheduledNextRound('nr1');
      expect(gameStarted().map((e) => e.id).sort()).to.deep.equal(['sHost', 'sOpp2']);
    });
  });

  // ---------------------------------------------------------------------------
  // Restart resilience
  // ---------------------------------------------------------------------------
  // Deploy-restart contract (test/regression/restart_hold_resume.test.js has
  // the full matrix): on boot the room is HELD — the deal is NOT re-armed until
  // a human rejoins (_releaseRestartHold), because _startScheduledNextRound
  // settles the match with `no_humans` when nobody is connected, and after a
  // restart nobody is. The re-arm itself still runs off the persisted deadline.
  describe('a restart during the intermission', () => {
    it('holds the room on boot, then re-arms the deal from the persisted absolute deadline', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      // Simulate the restart: state survives, the timer handle does not.
      clearTimeout(room.nextRoundHandle);
      room.nextRoundHandle = null;
      expect(room.awaitingNextRound).to.equal(true);
      expect(room.nextRoundAt).to.be.a('number');

      const resumed = await handlers.resumePersistedRooms();

      expect(resumed).to.equal(1);
      expect(room.restartHold, 'held until a player rejoins').to.exist;
      expect(room.nextRoundHandle, 'no deal armed while held').to.equal(null);
      expect(room.awaitingNextRound).to.equal(true);

      handlers._releaseRestartHold(room, 'player_rejoined');

      expect(room.restartHold).to.equal(null);
      expect(room.nextRoundHandle).to.not.equal(null);
      // Floored so the deal does not land before the clients reconnect.
      expect(room.nextRoundAt - Date.now()).to.be.below(
        SocketHandlers.NEXT_ROUND_DELAY_MS + 1000
      );
    });

    it('re-BASES the deadline, so the replayed countdown matches the re-armed timer', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      // The process was down THROUGH the original deadline — the normal case,
      // since a restart takes longer than the intermission itself.
      clearTimeout(room.nextRoundHandle);
      room.nextRoundHandle = null;
      room.nextRoundAt = Date.now() - 30000;

      await handlers.resumePersistedRooms();
      handlers._releaseRestartHold(room, 'player_rejoined');

      // Keeping the past deadline would make every reconnect replay advertise
      // "0ms" for a deal that is still NEXT_ROUND_RESUME_FLOOR_MS away — exactly
      // the stale countdown _roundEndReplayPayload exists to prevent, and what
      // the client's deal watchdog fires on.
      expect(room.nextRoundAt).to.be.above(Date.now());
      const replay = handlers._roundEndReplayPayload(room);
      expect(replay.nextRoundInMs).to.be.above(0);
      expect(replay.nextRoundInMs).to.be.at.most(
        SocketHandlers.NEXT_ROUND_RESUME_FLOOR_MS
      );
    });
  });

  // ---------------------------------------------------------------------------
  // The game_ended `reason` is CLIENT-FACING COPY.
  //
  // Live report: the round-over intermission showed "{Host} left the game" with
  // nobody gone. The board only ever prints that line off the `reason` field, so
  // these lock both halves of the contract — a clean round end must carry NO
  // reason at all (the client gates its whole forfeit narrative, including a -200
  // penalty, on the key being present), and the genuine forfeits must keep the
  // exact codes the client switches on.
  // ---------------------------------------------------------------------------
  describe('a CLEAN round end carries no forfeit reason', () => {
    // Not intermediatePayload(): that is a hand-written fixture, so asserting on
    // it would only prove the fixture is clean. These drive the REAL producer.
    it('a batida (go-out) round end stamps no reason, hostLeft or forfeitedBy', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);

      const ended = ActionHandlers._finalizeRound(room, HOST);
      handlers._broadcastRoundEndAndCleanup(room, ended);

      expect(ended.matchEnded).to.equal(false);
      expect(ended).to.not.have.property('reason');
      expect(ended).to.not.have.property('hostLeft');
      expect(ended).to.not.have.property('forfeitedBy');
      const broadcast = gameEnded().find((e) => e.scope === 'room');
      expect(broadcast.payload).to.not.have.property('reason');
      expect(broadcast.payload).to.not.have.property('hostLeft');
    });

    it('a stock-exhausted (no-batida) round end stamps no reason either', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);

      const ended = ActionHandlers._finalizeRoundNoBatida(room);
      handlers._broadcastRoundEndAndCleanup(room, ended);

      expect(ended.batidaType).to.equal(null);
      expect(ended).to.not.have.property('reason');
      expect(gameEnded().find((e) => e.scope === 'room').payload).to.not.have.property('reason');
    });

    it('a clean TERMINAL match end (target reached) stamps no reason', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      reachTarget(room);

      const ended = ActionHandlers._finalizeRound(room, HOST);
      handlers._broadcastRoundEndAndCleanup(room, ended);

      expect(ended.matchEnded).to.equal(true);
      expect(ended).to.not.have.property('reason');
      expect(gameEnded().find((e) => e.scope === 'room').payload).to.not.have.property('reason');
    });
  });

  describe('the GENUINE forfeit paths keep their reason', () => {
    it('the host leaving an IN-PROGRESS game is host_left, and the opponent wins', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      liveRoom(service);
      emitted.length = 0;

      handlers.handleLeaveRoom(registry.get('sHost'));

      const ended = gameEnded().find((e) => e.scope === 'room');
      expect(ended.payload.reason).to.equal('host_left');
      expect(ended.payload.hostLeft).to.equal(true);
      expect(ended.payload.matchEnded).to.equal(true);
      expect(ended.payload.winnerId).to.equal(OPP);
    });

    it('a non-host leaving an IN-PROGRESS game is opponent_left', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      emitted.length = 0;

      handlers.handleLeaveRoom(registry.get('sOpp'));

      const ended = gameEnded().find((e) => e.scope === 'room');
      expect(ended.payload.reason).to.equal('opponent_left');
      expect(ended.payload.hostLeft).to.equal(false);
      expect(ended.payload.winnerId).to.equal(HOST);
      expect(room.status).to.equal(GameRoomStatus.FINISHED);
    });

    it('the HOST leaving during the intermission still forfeits as host_left', () => {
      // The mirror of the existing opponent_left intermission test. This is the
      // path the live "{Host} left the game" report actually came down, so it must
      // stay a real forfeit — the false positive was a client emitting the leave,
      // not the server mislabelling one.
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;

      handlers.handleLeaveRoom(registry.get('sHost'));

      const ended = gameEnded().find((e) => e.scope === 'room');
      expect(ended.payload.reason).to.equal('host_left');
      expect(ended.payload.matchEnded).to.equal(true);
      expect(room.awaitingNextRound).to.equal(false);
      expect(room.nextRoundHandle).to.equal(null);
    });

    it('running out the OFFLINE strike budget is offline_forfeit', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      const max = SocketHandlers.MAX_OFFLINE_STRIKES;
      const absent = room.getPlayer(OPP);
      absent.disconnect();
      room.offlineStrikes = new Map([[OPP, max - 1]]);
      emitted.length = 0;

      const forfeited = handlers._handleInactiveTurnExpiry(room, absent);

      expect(forfeited).to.equal(true);
      const ended = gameEnded().find((e) => e.scope === 'room');
      expect(ended.payload.reason).to.equal('offline_forfeit');
      expect(ended.payload.offlineStrikes).to.equal(max);
      expect(ended.payload.matchEnded).to.equal(true);
    });

    it('only the two LEAVE codes contain the word "left"', () => {
      // The client captions the board by matching on this string. Any new code
      // containing "left" would render as "<player> left the game" for a player
      // who did nothing of the sort — the exact false line reported from a live
      // match. Codes are enumerated on _abortNextRound.
      const leaveCodes = ['host_left', 'opponent_left'];
      const otherCodes = [
        'inactivity_forfeit',
        'offline_forfeit',
        'scheduler_error',
        'seat_missing',
        'no_humans',
        'start_failed',
        'deal_failed',
      ];
      leaveCodes.forEach((code) => expect(code).to.contain('left'));
      otherCodes.forEach((code) => expect(code).to.not.contain('left'));
    });
  });

  // ---------------------------------------------------------------------------
  // The intermission deadline on the wire (client countdown).
  // ---------------------------------------------------------------------------
  describe('the intermission deadline is on the wire and sane', () => {
    it('a non-terminal end carries BOTH the relative and the absolute deadline', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      const before = Date.now();

      const ended = ActionHandlers._finalizeRound(room, HOST);
      handlers._broadcastRoundEndAndCleanup(room, ended);

      const payload = gameEnded().find((e) => e.scope === 'room').payload;
      expect(payload.nextRoundInMs).to.be.a('number').above(0);
      expect(payload.nextRoundInMs).to.be.at.most(SocketHandlers.NEXT_ROUND_DELAY_MS);
      expect(payload.nextRoundAt).to.be.a('number').above(before);
      expect(payload.nextRoundAt).to.be.at.most(before + SocketHandlers.NEXT_ROUND_DELAY_MS + 500);
      // The pair implicitly encodes SERVER-now, which is what lets the client
      // count down on its own (skewed) clock while still using nextRoundAt as a
      // skew-free identity key for the intermission. No separate serverNow field.
      const serverNow = payload.nextRoundAt - payload.nextRoundInMs;
      expect(Math.abs(serverNow - before)).to.be.below(500);
    });

    it('the deadline follows the per-room override, not a hardcoded 10s', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      room.nextRoundDelayMs = 4000;

      const payload = endRound(handlers, room, intermediatePayload());

      // A range, not 4000 exactly: nextRoundAt is stamped as Date.now()+delay when
      // the timer is armed and nextRoundInMs is recomputed against a SECOND
      // Date.now() a few statements later, so crossing a millisecond boundary
      // legitimately yields 3999.
      expect(payload.nextRoundInMs).to.be.within(3900, 4000);
      expect(payload.nextRoundAt - Date.now()).to.be.at.most(4000);
    });

    it('a TERMINAL end carries NEITHER field', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      reachTarget(room);

      const ended = ActionHandlers._finalizeRound(room, HOST);
      handlers._broadcastRoundEndAndCleanup(room, ended);

      const payload = gameEnded().find((e) => e.scope === 'room').payload;
      expect(payload.matchEnded).to.equal(true);
      expect(payload).to.not.have.property('nextRoundInMs');
      expect(payload).to.not.have.property('nextRoundAt');
    });

    it('a replay AFTER the intermission is over strips the stale countdown', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      // The intermission ended some other way (forfeit / host-gone kill cancels
      // it). Nothing rewrites the STORED payload, which still holds the countdown
      // stamped when the round ended.
      handlers._cancelNextRound(room, 'test');
      expect(room.lastRoundEndPayload.nextRoundInMs).to.be.a('number');

      const replay = handlers._roundEndReplayPayload(room);

      expect(replay).to.not.have.property('nextRoundInMs');
      expect(replay).to.not.have.property('nextRoundAt');
    });

    it('a player rejoining a settled room is not handed that stale countdown', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      handlers._cancelNextRound(room, 'test');
      const revived = fakeSocket('sOpp2', emitted);
      registry.set('sOpp2', revived);
      emitted.length = 0;

      return handlers
        .handleJoinRoom(revived, { roomId: 'nr1', playerId: OPP, playerName: 'Opp' })
        .then(() => {
          const card = emitted.find((e) => e.event === 'game_ended' && e.id === 'sOpp2');
          expect(card).to.be.an('object');
          expect(card.payload).to.not.have.property('nextRoundInMs');
          expect(card.payload).to.not.have.property('nextRoundAt');
        });
    });
  });

  // ---------------------------------------------------------------------------
  // The ABORT signal: every way the scheduler can give up must reach the client.
  // ---------------------------------------------------------------------------
  describe('every abort path broadcasts the terminal signal', () => {
    /** Assert the shape every abort must produce, whatever led to it. */
    function expectAbort(reason) {
      const rounds = gameEnded().filter((e) => e.scope === 'room');
      expect(rounds, `one room-wide game_ended for ${reason}`).to.have.length(1);
      const payload = rounds[0].payload;
      expect(payload.reason).to.equal(reason);
      expect(payload.matchEnded).to.equal(true);
      // Nobody may be left counting down to a deal that is not coming.
      expect(payload).to.not.have.property('nextRoundInMs');
      expect(payload).to.not.have.property('nextRoundAt');
      return payload;
    }

    async function abortVia(mutate) {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;
      posts.length = 0;
      mutate(room, handlers);
      await handlers._startScheduledNextRound('nr1');
      return { room, handlers };
    }

    it('seat_missing', async () => {
      const { room } = await abortVia((r) => r.removePlayer(OPP));
      expectAbort('seat_missing');
      expect(room.awaitingNextRound).to.equal(false);
      expect(room.nextRoundHandle).to.equal(null);
      expect(roomClosedPosts()).to.have.length(1);
    });

    it('no_humans', async () => {
      const { room } = await abortVia((r) => r.getPlayers().forEach((p) => p.disconnect()));
      expectAbort('no_humans');
      expect(room.awaitingNextRound).to.equal(false);
      expect(roomClosedPosts()).to.have.length(1);
    });

    it('start_failed', async () => {
      // startGame() only refuses a table below 2 seats, and seat_missing catches
      // that first — so the only way to reach start_failed is a refusal from
      // inside startGame itself. Stub it to prove the branch still settles.
      const { room } = await abortVia((r) => {
        r.startGame = () => false;
      });
      expectAbort('start_failed');
      expect(room.awaitingNextRound).to.equal(false);
      expect(roomClosedPosts()).to.have.length(1);
    });

    it('deal_failed, and it still reports the round that WAS scored', async () => {
      const { room } = await abortVia((r, h) => {
        h._autoDealAfterStart = () => ({ success: false });
      });
      const payload = expectAbort('deal_failed');
      // startGame() nulls lastRoundEndPayload as part of the per-round reset, so
      // without the pre-deal snapshot this settles with a blank scoreboard and a
      // null winner — for the players AND for the settlement webhook.
      expect(payload.winnerId).to.equal(HOST);
      expect(payload.cumulativeTeamScores).to.deep.equal({ teamA: 320, teamB: 145 });
      expect(room.status).to.equal(GameRoomStatus.FINISHED);
    });

    it('scheduler_error (a throw the timer must swallow), result preserved too', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      // Throws between startGame() and the deal: the room is IN_PROGRESS with no
      // cards, and lastRoundEndPayload has already been wiped by startGame.
      handlers._stopHostHeartbeat = () => {
        throw new Error('boom');
      };
      emitted.length = 0;
      handlers._scheduleNextRound(room, 10);

      await new Promise((resolve) => setTimeout(resolve, 80));

      const payload = expectAbort('scheduler_error');
      expect(payload.winnerId).to.equal(HOST);
      expect(payload.cumulativeTeamScores).to.deep.equal({ teamA: 320, teamB: 145 });
      expect(room.status).to.equal(GameRoomStatus.FINISHED);
    });

    it('the inactivity sweep cannot delete the room out from under the scheduler', () => {
      // _startScheduledNextRound returns SILENTLY when the room is gone, so it can
      // never reach _abortNextRound — a reaped intermission would leave every
      // client counting down forever. allPlayersInactive() is true for an EMPTY
      // roster, so this is reachable the moment the last seat is removed.
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      room.removePlayer(HOST);
      room.removePlayer(OPP);
      expect(room.allPlayersInactive(service.inactivityTimeout)).to.equal(true);

      service._cleanupInactiveRooms();

      expect(service.getRoom('nr1')).to.equal(room);
      expect(room.awaitingNextRound).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // MONEY — a match that ends DURING the intermission must still settle.
  //
  // Round N's report latches room.resultReported, and startGame() is the only
  // thing that clears it — i.e. not until round N+1 is actually DEALT. For the
  // whole ~10s intermission the latch is therefore still up, and it used to be a
  // single room-wide boolean, so _notifyBackendGameResult returned early for
  // EVERY terminal end raised in that window. The 10s right after a round card is
  // exactly when a losing player quits, so real payouts and win/loss rows were
  // being dropped in production.
  //
  // Clearing the latch alone is not enough either: `result_id` is
  // roomId:gameStartedAt and gameStartedAt only advances on a DEAL, so the
  // terminal report would carry round N's id verbatim and be deduped away
  // downstream. These pin BOTH halves — the POST leaves, and it is distinguishable
  // from round N's — plus the one thing that must NOT change: `match_id` is the
  // escrow settlement key, so a second POST under a NEW match_id would re-run
  // settleMatch and pay the pot twice.
  // ---------------------------------------------------------------------------
  describe('a TERMINAL end during the intermission still reports the result', () => {
    /** The round-N report + the terminal report, in order. */
    const results = () => gameResultPosts().map((p) => p.body);

    function expectSettled(room, { reason, players = [10, 20] }) {
      const bodies = results();
      // Exactly two: round N (matchEnded:false) and the terminal one.
      expect(bodies).to.have.length(2);
      const [roundN, terminal] = bodies;
      expect(roundN.matchEnded).to.equal(false);
      expect(terminal.matchEnded).to.equal(true);
      if (reason) expect(terminal.data.reason).to.equal(reason);
      // Distinct dedupe ids, or the backend swallows the settlement exactly as
      // the socket used to.
      expect(terminal.result_id).to.not.equal(roundN.result_id);
      expect(terminal.result_id).to.equal(`${roundN.result_id}:final`);
      // ...and consistent inside the body: a reader that dedupes on data.result_id
      // must see the same id as one that dedupes on the top-level field.
      expect(terminal.data.result_id).to.equal(terminal.result_id);
      // DOUBLE-PAY GUARD: match_id keys ProcessedGameResult + the escrow
      // settlement ledger entry. It must be byte-identical across both reports.
      expect(terminal.match_id).to.equal(roundN.match_id);
      expect(terminal.player_user_ids).to.deep.equal(players);
      return terminal;
    }

    it('leave_room mid-intermission settles the match (the money case)', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      handlers.handleLeaveRoom(registry.get('sOpp'));

      const terminal = expectSettled(room, { reason: 'opponent_left' });
      // The leaver loses, so the remaining seat is reported as the winner.
      expect(terminal.winner_user_id).to.equal(10);
    });

    it('an inactivity forfeit mid-intermission settles too', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      handlers._handlePlayerForfeit(null, room, OPP, room.getPlayer(OPP), {
        reason: 'inactivity_forfeit',
        inactiveTurns: 3,
      });

      expectSettled(room, { reason: 'inactivity_forfeit' });
    });

    it('_abortNextRound(seat_missing) settles instead of silently abandoning the pot', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      room.removePlayer(OPP); // the seat genuinely vanished

      await handlers._startScheduledNextRound('nr1');

      // The vacated seat is no longer reportable, but the match still settles for
      // whoever is left — previously NOTHING was reported at all.
      expectSettled(room, { reason: 'seat_missing', players: [10] });
    });

    it('_abortNextRound(no_humans) settles', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      room.getPlayers().forEach((p) => p.disconnect());

      await handlers._startScheduledNextRound('nr1');

      expectSettled(room, { reason: 'no_humans' });
    });

    it('_abortNextRound(start_failed) settles', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      room.startGame = () => false;

      await handlers._startScheduledNextRound('nr1');

      expectSettled(room, { reason: 'start_failed' });
    });

    it('_abortNextRound(deal_failed) settles under the FRESH round id', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      // Round N started a minute ago. Without this the re-deal lands in the SAME
      // millisecond and both rounds mint the same roomId:gameStartedAt id — a
      // test-only artefact of dealing two rounds back to back.
      room.gameStartedAt = new Date(Date.now() - 60000);
      endRound(handlers, room, intermediatePayload());
      handlers._autoDealAfterStart = () => ({ success: false, error: 'no cards' });

      await handlers._startScheduledNextRound('nr1');

      // deal_failed is raised AFTER startGame(), which minted a new gameStartedAt
      // and cleared the round latch — so this one is already distinct on its own
      // and must NOT be suffixed.
      const bodies = results();
      expect(bodies).to.have.length(2);
      expect(bodies[1].matchEnded).to.equal(true);
      expect(bodies[1].data.reason).to.equal('deal_failed');
      expect(bodies[1].result_id).to.not.equal(bodies[0].result_id);
      expect(bodies[1].result_id).to.not.match(/:final$/);
      expect(bodies[1].match_id).to.equal(bodies[0].match_id);
    });

    it('_abortNextRound(scheduler_error) settles', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      handlers._stopHostHeartbeat = () => {
        throw new Error('boom');
      };
      handlers._scheduleNextRound(room, 10);

      await new Promise((resolve) => setTimeout(resolve, 80));

      const bodies = results();
      expect(bodies).to.have.length(2);
      expect(bodies[1].matchEnded).to.equal(true);
      expect(bodies[1].data.reason).to.equal('scheduler_error');
      expect(bodies[1].match_id).to.equal(bodies[0].match_id);
    });

    it('a throwing report still de-lists and tears the aborted room down', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());
      posts.length = 0;
      handlers._notifyBackendGameResult = () => {
        throw new TypeError('Converting circular structure to JSON');
      };

      handlers._abortNextRound(room, 'no_humans');

      // The settle report is best-effort; the teardown below it is not. Losing
      // both would strand the room listed-and-undeletable forever.
      expect(roomClosedPosts()).to.have.length(1);
      expect(room.finalizeCleanupHandle).to.not.equal(null);
    });

    it('reports EXACTLY once — a forfeit racing an abort cannot double-settle', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      handlers.handleLeaveRoom(registry.get('sOpp'));
      // Every other terminal path re-entering the same room afterwards.
      handlers._abortNextRound(room, 'no_humans');
      handlers._handlePlayerForfeit(null, room, HOST, room.getPlayer(HOST), {
        reason: 'host_left',
      });
      handlers._notifyBackendGameResult(room, HOST);

      expect(results().filter((b) => b.matchEnded === true)).to.have.length(1);
    });

    it('does NOT re-send round N (the non-terminal report stays one-shot)', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      // A retry / racing re-broadcast of the SAME round.
      handlers._notifyBackendGameResult(room, HOST);

      expect(results()).to.have.length(1);
      expect(results()[0].matchEnded).to.equal(false);
    });

    it('room-closed still fires exactly once at the terminal moment, never mid-round', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);

      endRound(handlers, room, intermediatePayload());
      // PER MATCH: an intermediate round must not de-list a live room.
      expect(roomClosedPosts()).to.have.length(0);

      handlers.handleLeaveRoom(registry.get('sOpp'));

      expect(roomClosedPosts()).to.have.length(1);
      expect(roomClosedPosts()[0].body.reason).to.equal('opponent_left');
    });

    it('a clean single-report match end keeps its EXACT id (no `:final` churn)', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);

      // Terminal on the very first report — the normal win path.
      endRound(handlers, room, { ...intermediatePayload(), matchEnded: true });

      const bodies = results();
      expect(bodies).to.have.length(1);
      expect(bodies[0].matchEnded).to.equal(true);
      expect(bodies[0].result_id).to.equal(`nr1:${room.gameStartedAt.getTime()}`);
      expect(bodies[0].data.result_id).to.equal(bodies[0].result_id);
    });
  });

  // ---------------------------------------------------------------------------
  // BLOCKER 3 — 'seat_missing' must not be reachable by a backend re-sync.
  //
  // syncRoomFromBackend rewrote room.maxPlayers with no in-match guard (through
  // BOTH GameService.createRoom and its own assignment). Any sync carrying a
  // different max_players — a heartbeat, a host settings edit, a re-sync after a
  // backend restart — could grow it past the seated count, and the next scheduled
  // round then read players.size !== maxPlayers as "a seat vanished" and killed a
  // match nobody left.
  // ---------------------------------------------------------------------------
  describe('a backend re-sync cannot resize a live table', () => {
    it('leaves maxPlayers alone mid-round and mid-intermission, and round N+1 still deals', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);

      // Mid-round.
      handlers.syncRoomFromBackend({ roomId: 'nr1', maxPlayers: 4 });
      expect(room.maxPlayers).to.equal(2);

      endRound(handlers, room, intermediatePayload());
      // Mid-intermission (FINISHED but NOT over) — same freeze.
      handlers.syncRoomFromBackend({ roomId: 'nr1', maxPlayers: 4 });
      expect(room.maxPlayers).to.equal(2);

      await handlers._startScheduledNextRound('nr1');

      // The match survived: it dealt round N+1 rather than aborting.
      expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);
      expect(room.cardsDealt).to.equal(true);
      expect(gameEnded().some((e) => e.payload?.reason === 'seat_missing')).to.equal(false);
    });

    it('still applies the rest of the sync while the seat count is frozen', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom(service);
      endRound(handlers, room, intermediatePayload());

      handlers.syncRoomFromBackend({ roomId: 'nr1', maxPlayers: 4, ruleset: 'professional' });

      expect(room.maxPlayers).to.equal(2);
      expect(room.ruleset).to.equal('professional');
    });

    it('a WAITING room is still resizable (the guard is in-match only)', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = service.createRoom('nrw', 2);
      service.joinRoom('nrw', HOST, 'Host', 'sHost');

      handlers.syncRoomFromBackend({ roomId: 'nrw', maxPlayers: 4 });

      expect(room.maxPlayers).to.equal(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Seat-freeze coverage gaps that let today's regressions ship green.
  // ---------------------------------------------------------------------------
  describe('seat-freeze gaps', () => {
    /**
     * A 4-seat 2v2 table mid-match. Every existing fixture is 2-seat, so the
     * `players.size !== room.maxPlayers` half of the scheduler's seat check —
     * a SHORT but still >= 2 table — had no coverage at all.
     */
    function liveRoom4(service, roomId = 'nr4') {
      const room = service.createRoom(roomId, 4);
      ['10', '20', '30', '40'].forEach((id, i) => {
        registry.set(`s${id}`, fakeSocket(`s${id}`, emitted));
        service.joinRoom(roomId, id, `P${i}`, `s${id}`);
      });
      room.targetScore = 1000;
      room.startGame(true);
      room.dealCards();
      room.cumulativeTeamScores = new Map([['teamA', 320], ['teamB', 145]]);
      return room;
    }

    it('a 2v2 that loses ONE seat aborts on the size!==maxPlayers half of the check', async () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom4(service);
      expect(room.maxPlayers).to.equal(4);
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;

      room.removePlayer('40');
      // Still THREE seated, so the `players.size < 2` half cannot fire — only
      // the full-table half can. Dealing a 3-hander here would silently rewrite
      // the even/odd teaming that cumulativeTeamScores is keyed on.
      expect(room.players.size).to.equal(3);

      await handlers._startScheduledNextRound('nr4');

      const ended = gameEnded().find((e) => e.scope === 'room');
      expect(ended.payload.reason).to.equal('seat_missing');
      expect(ended.payload.matchEnded).to.equal(true);
      // It never dealt: the room stayed FINISHED rather than flipping to
      // IN_PROGRESS with a silently re-teamed 3-hander.
      expect(room.status).to.equal(GameRoomStatus.FINISHED);
      expect(room.awaitingNextRound).to.equal(false);
      expect(gameStarted()).to.have.length(0);
    });

    it('remove_bot is refused mid-intermission (it would strand the next deal)', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = liveRoom4(service, 'nrb');
      const bot = room.getPlayer('40');
      bot.isBot = true;
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;

      handlers.handleRemoveBot(registry.get('s10'), { roomId: 'nrb', botId: '40' });

      expect(emitted.filter((e) => e.event === 'error')).to.have.length(1);
      expect(room.players.size).to.equal(4);
      expect(room.getPlayer('40')).to.be.an('object');
      expect(emitted.filter((e) => e.event === 'bot_removed')).to.have.length(0);
    });

    it('respond_swap ACCEPT is refused mid-intermission (the leg that moves seats)', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = service.createRoom('nrs', 4);
      ['10', '20', '30', '40'].forEach((id, i) => {
        registry.set(`s${id}`, fakeSocket(`s${id}`, emitted));
        service.joinRoom('nrs', id, `P${i}`, `s${id}`);
      });
      room.targetScore = 1000;
      // Requested while the room is still WAITING (neither side is the host, or
      // handleRequestSwap refuses), then answered after the match is under way —
      // the 15s answer window straddles the start, which is exactly why the
      // ACCEPT leg carries its own re-validation.
      handlers.handleRequestSwap(registry.get('s20'), { targetPlayerId: '30', targetSeat: 2 });
      expect(room._pendingSwaps.get('30')).to.be.an('object');
      room.startGame(true);
      room.dealCards();
      endRound(handlers, room, intermediatePayload());
      emitted.length = 0;

      handlers.handleRespondSwap(registry.get('s30'), { requesterId: '20', accept: true });

      // Seats untouched — the swap would have rewritten playerIndex mid-match.
      expect(room.getPlayer('20').playerIndex).to.equal(1);
      expect(room.getPlayer('30').playerIndex).to.equal(2);
      const responded = emitted.filter((e) => e.event === 'swap_responded');
      expect(responded).to.have.length(1);
      expect(responded[0].payload.accept).to.equal(false);
      expect(responded[0].payload.reason).to.equal('seat_taken');
      expect(emitted.filter((e) => e.event === 'seat_changed')).to.have.length(0);
    });

    it('respond_seat_invite ACCEPT is refused mid-intermission', () => {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const room = service.createRoom('nri', 4);
      ['10', '20', '30'].forEach((id, i) => {
        registry.set(`s${id}`, fakeSocket(`s${id}`, emitted));
        service.joinRoom('nri', id, `P${i}`, `s${id}`);
      });
      room.targetScore = 1000;
      const specSocket = fakeSocket('sSpec', emitted);
      registry.set('sSpec', specSocket);
      handlers._addSpectator(specSocket, 'nri', '99', 'Watcher');
      // Invite while WAITING, then fill the last seat before starting a valid
      // 2v2 match. The pending answer is delivered during the intermission.
      handlers.handleInviteToSeat(registry.get('s10'), { spectatorId: '99', seat: 3 });
      expect(room._pendingInvites.get('99')).to.be.an('object');
      registry.set('s40', fakeSocket('s40', emitted));
      service.joinRoom('nri', '40', 'P3', 's40');
      expect(room.startGame(true)).to.equal(true);
      room.dealCards();
      endRound(handlers, room, intermediatePayload());
      // Simulate a missing seat in a restored intermission. Keep it empty so
      // the match-phase guard alone must reject the old invitation.
      room.removePlayer('40');
      emitted.length = 0;

      handlers.handleRespondSeatInvite(specSocket, { accept: true });

      const responded = emitted.filter((e) => e.event === 'seat_invite_responded');
      expect(responded).to.have.length(1);
      expect(responded[0].payload.accept).to.equal(false);
      expect(responded[0].payload.reason).to.equal('seat_taken');
      expect(emitted.filter((e) => e.event === 'seat_invite_cancelled')).to.have.length(1);
      expect(room.players.size).to.equal(3);
    });
  });
});
