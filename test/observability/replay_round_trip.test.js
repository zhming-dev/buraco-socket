/**
 * Replay ROUND TRIP: play real games through the real handler stack
 * (SocketHandlers + ActionHandlers, driven by the server's own BotStrategy and
 * the turn-timeout path), then rebuild the table from nothing but the recorded
 * event stream and require it to be the table the room actually ended with —
 * every hand, meld, well, the stock order and the discard pile, card for card.
 *
 * Covers the shapes the recorder has to get right without being told: melds
 * and go-downs, pile takes, auto-taken wells, minimum-meld confiscations,
 * timeout auto-draw/auto-discard (incl. returned melds), stock promotion from
 * a well, multi-round matches (a keyframe per deal), 2v2 and Qanoon.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const BotCoordinator = require('../../src/bots/BotCoordinator');
const BotStrategy = require('../../src/bots/BotStrategy');
const logger = require('../../src/utils/logger');
const ReplayEngine = require('../../src/observability/ReplayEngine');
const codec = require('../../src/observability/replayCodec');
const { getGameEventRecorder } = require('../../src/observability/GameEventRecorder');

const stubLogger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeIo() {
  return {
    to: () => ({ emit: () => {} }),
    emit: () => {},
    sockets: { sockets: new Map() },
  };
}

function setupTable({ roomId, seats = 2, ruleset = 'classic', wellMode = 'indirect', qanoon = false, targetScore = 0 }) {
  const service = new GameService();
  const handlers = new SocketHandlers(fakeIo(), service);
  service.createRoom(roomId, seats);
  for (let i = 0; i < seats; i += 1) {
    const res = service.addBotToRoom(roomId, { botId: `${roomId}-bot${i}`, botLevel: 'normal', playerIndex: i });
    expect(res.success, res.error).to.equal(true);
  }
  const room = service.getRoom(roomId);
  room.ruleset = ruleset;
  room.professionalWellMode = wellMode;
  if (qanoon) room.setQanoon(true);
  room.targetScore = targetScore;
  room.turnTimeLimit = 30;
  const coord = new BotCoordinator({
    gameService: service,
    socketHandlers: handlers,
    logger: stubLogger,
    config: { bot: {} },
  });
  coord._requestDecision = async (state) => new BotStrategy().decide(state);
  coord._scheduleRoomCheck = () => {};
  return { service, handlers, room, coord };
}

function quiesce(handlers, room) {
  handlers._stopTurnTimer(room);
  if (room.dealAnimationFallbackHandle) clearTimeout(room.dealAnimationFallbackHandle);
  room.dealAnimationFallbackHandle = null;
  room.awaitingDealAnimation = false;
}

function deal(handlers, room) {
  expect(room.startGame()).to.equal(true);
  const res = handlers._dealCardsForRoom(room, 'replay-test');
  expect(res.success, res.error).to.equal(true);
  quiesce(handlers, room);
}

/** Play the current round out. Every `timeoutEvery`-th step is a turn timeout. */
async function playRound({ handlers, room, coord }, { timeoutEvery = 9, maxSteps = 4000 } = {}) {
  let steps = 0;
  while (room.isInProgress() && steps < maxSteps) {
    steps += 1;
    const player = room.getPlayerByIndex(room.currentTurn);
    if (timeoutEvery && steps % timeoutEvery === 0) {
      handlers._onTurnTimerExpired(room);
    } else {
      await coord._playBotState(room.roomId, player.playerId, coord._stateKey(room, player));
    }
    quiesce(handlers, room);
  }
  expect(room.isInProgress(), `round did not end within ${maxSteps} steps`).to.equal(false);
}

/** The room's real table, as plain cards (independent of the recorder's capture). */
function actualTable(room) {
  const plain = (cards) => (cards || []).map((c) => ({
    cardId: c.cardId,
    rank: c.isJoker || c.rank === 'joker' ? 'joker' : String(c.rank),
    suit: c.isJoker || c.rank === 'joker' ? 'joker' : c.suit,
  }));
  return {
    players: room.getPlayers().map((p) => ({
      seat: p.playerIndex,
      hand: plain(room.playerHands.get(p.playerId)),
      melds: (room.playerMelds.get(p.playerId) || []).map(plain),
    })),
    deck: plain(room.deck?.cards),
    discard: plain(room.discardPile),
    wells: (room.deadPiles || []).map(plain),
    scores: codec.teamScoresOf(room.cumulativeTeamScores),
  };
}

function replayedTable(table) {
  const plain = (cards) => cards.map((c) => ({ cardId: c.cardId, rank: c.rank, suit: c.suit }));
  return {
    players: table.players.map((p) => ({
      seat: p.playerIndex,
      hand: plain(p.hand),
      melds: p.melds.map((m) => plain(m.cards)),
    })),
    deck: plain(table.deck),
    discard: plain(table.discardPile),
    wells: table.deadPiles.map(plain),
    scores: table.teamScores,
  };
}

async function assertRoundTrip(room, matchId) {
  const recorder = getGameEventRecorder();
  const stream = await recorder.load(matchId);
  expect(stream, 'stream').to.not.equal(null);

  // The last event rebuilds the exact final table...
  const table = ReplayEngine.tableAt(stream);
  expect(replayedTable(table)).to.deep.equal(actualTable(room));
  // ...and every round end's checksum agrees with the replay.
  const verdict = ReplayEngine.verify(stream);
  expect(verdict.rounds.length).to.be.greaterThan(0);
  expect(verdict.ok, JSON.stringify(verdict.rounds)).to.equal(true);
  // The recorder's own capture agrees too.
  expect(ReplayEngine.reconstruct(stream).zones).to.deep.equal(codec.captureZones(room));
  return stream;
}

describe('replay round trip (real handlers, bot-driven games)', function () {
  this.timeout(60000);

  let consoleWas;
  let levelWas;
  before(() => {
    consoleWas = logger.enableConsole;
    levelWas = logger.gameLogLevel;
    logger.enableConsole = false;
    logger.gameLogLevel = 1; // WARN — keep the log ring out of the way of timing
  });
  after(() => {
    logger.enableConsole = consoleWas;
    logger.gameLogLevel = levelWas;
  });

  const cases = [
    { name: '1v1 classic', roomId: 'rt-classic', seats: 2, ruleset: 'classic' },
    { name: '1v1 pro direct', roomId: 'rt-pro-direct', seats: 2, ruleset: 'professional', wellMode: 'direct' },
    { name: '2v2 pro indirect', roomId: 'rt-2v2', seats: 4, ruleset: 'professional', wellMode: 'indirect' },
    { name: '1v1 qanoon', roomId: 'rt-qanoon', seats: 2, qanoon: true },
  ];

  for (const c of cases) {
    it(`${c.name}: the replayed final table equals the room's`, async () => {
      const table = setupTable(c);
      try {
        deal(table.handlers, table.room);
        const matchId = getGameEventRecorder().currentMatchId(c.roomId);
        expect(matchId).to.be.a('string');
        await playRound(table);
        const stream = await assertRoundTrip(table.room, matchId);
        const types = new Set(stream.events.map((e) => e.type));
        expect(types.has('deal')).to.equal(true);
        expect(types.has('match_end')).to.equal(true);
        expect(stream.header.status).to.equal('finished');
      } finally {
        quiesce(table.handlers, table.room);
        table.room.disposeTimers();
        table.service.shutdown();
      }
    });
  }

  it('multi-round match: one stream, a keyframe per deal, every round verifies', async () => {
    const table = setupTable({ roomId: 'rt-multi', seats: 2, ruleset: 'classic', targetScore: 100000 });
    const { handlers, room } = table;
    try {
      deal(handlers, room);
      const matchId = getGameEventRecorder().currentMatchId('rt-multi');
      for (let round = 1; round <= 3; round += 1) {
        await playRound(table, { timeoutEvery: 7 });
        if (round < 3) {
          expect(room.awaitingNextRound).to.equal(true);
          if (room.nextRoundHandle) clearTimeout(room.nextRoundHandle);
          room.nextRoundHandle = null;
          room.awaitingNextRound = false;
          deal(handlers, room);
          expect(getGameEventRecorder().currentMatchId('rt-multi')).to.equal(matchId);
        }
      }
      // The match is still open (target not reached): close it the way a
      // teardown would, then check the whole thing.
      getGameEventRecorder().closeRoom('rt-multi', 'test_done');
      const stream = await assertRoundTrip(room, matchId);
      const rounds = ReplayEngine.roundsOf(stream);
      expect(rounds.map((r) => r.round)).to.deep.equal([1, 2, 3]);
      expect(rounds.every((r) => r.endSeq > r.seq)).to.equal(true);

      // Mid-round states rebuild too: at round 2's deal the table is exactly
      // what the keyframe recorded, hands of 11.
      const atDeal2 = ReplayEngine.tableAt(stream, rounds[1].seq);
      expect(atDeal2.roundNumber).to.equal(2);
      atDeal2.players.forEach((p) => expect(p.hand.length).to.equal(11));
      expect(atDeal2.deadPileCounts).to.deep.equal([11, 11]);
    } finally {
      quiesce(handlers, room);
      room.disposeTimers();
      table.service.shutdown();
    }
  });
});
