/**
 * "Diawal, automatic take and throw ga work di turn yang pertama" — reported
 * 2026-09-27: when the FIRST turn of a hand runs out, the seat's own board never
 * shows the automatic take-and-throw; later turns look fine.
 *
 * What the first turn has that later turns usually do not: the player has not
 * touched the table yet, so the timeout has to DRAW for them before it throws.
 * Two things went wrong on exactly that path.
 *
 *   1. The auto-draw announced the card to the whole room as `card: null` —
 *      including to the seat that drew it. A manual draw tells its owner which
 *      card arrived (`toPlayer`); the timeout's draw did not, so the owner's
 *      client flew a card back into a hand that never received it, and when
 *      the timeout then threw that very card away (it prefers the card the
 *      player never chose to keep) the client had nothing in the hand to throw.
 *      On that screen neither the take nor the throw happened.
 *   2. The first turn's clock is supposed to wait for the opening deal (every
 *      seated human's `deal_animation_complete`, or the bounded fallback). A
 *      REJECTED discard sent during the deal armed the clock anyway, through the
 *      "no timer is live" repair in handleDiscardCard — which also dropped the
 *      deal gate, so the first player's real time started behind the deal.
 *
 * The clock itself is covered too, in every shape the report could have come
 * from: round 1 and a later round, a seat that never reports its deal, bot
 * seats, 1v1 and 2v2 — the first turn always expires into a draw AND a discard,
 * exactly once.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents, GameRoomStatus } = require('../../src/constants');

const TURN_SECONDS = 30;

/** Deterministic clock: timers run only when the test advances time. */
function installClock() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realNow = Date.now;
  let now = realNow();
  const timers = new Set();
  Date.now = () => now;
  global.setTimeout = (run, delay = 0) => {
    const handle = { run, deadline: now + Math.max(0, delay), unref() {}, ref() {} };
    timers.add(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (!timers.delete(handle)) realClearTimeout(handle);
  };
  return {
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const t of timers) {
          if (t.deadline <= target && (!due || t.deadline < due.deadline)) due = t;
        }
        if (!due) break;
        timers.delete(due);
        now = due.deadline;
        await due.run();
        // let any promise chains the callback started settle
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      }
      now = target;
    },
    restore() {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      Date.now = realNow;
    },
  };
}

function fakeSocket(id, frames) {
  return {
    id,
    data: {},
    handshake: { headers: {}, auth: {}, query: {} },
    join() {},
    leave() {},
    emit: (event, payload) => frames.push({ to: id, event, payload }),
    // socket.to(room) reaches everyone in the room EXCEPT this socket.
    to: (roomId) => ({
      emit: (event, payload) => frames.push({ to: `room-but:${id}`, roomId, event, payload }),
    }),
  };
}

describe('first turn: the timeout auto-draws AND auto-discards, visibly, exactly once', () => {
  let clock;
  let originalFetch;
  const live = [];

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    clock = installClock();
  });

  afterEach(() => {
    while (live.length > 0) {
      const { handler, service, room } = live.pop();
      handler._stopTurnTimer(room);
      service.shutdown();
    }
    clock.restore();
    global.fetch = originalFetch;
  });

  /**
   * A dealt table. `seats` lists 'human' / 'bot' per seat index.
   * @returns {{handler, service, room, frames, sockets: Map<string, object>}}
   */
  function dealtTable(seats, roomId = `ftt-${live.length}-${seats.join('')}`) {
    const frames = [];
    const registry = new Map();
    const io = {
      sockets: { sockets: registry },
      to: (rid) => ({ emit: (event, payload) => frames.push({ to: `room:${rid}`, event, payload }) }),
    };
    const service = new GameService();
    const handler = new SocketHandlers(io, service);
    const room = service.createRoom(roomId, seats.length);
    const sockets = new Map();
    seats.forEach((kind, index) => {
      if (kind === 'bot') {
        const res = handler.inviteBotToRoom({ roomId, botId: `bot${index}`, botName: `Bot ${index}` });
        expect(res.success, `bot seat ${index}`).to.equal(true);
        return;
      }
      const socket = fakeSocket(`s${index}`, frames);
      registry.set(socket.id, socket);
      sockets.set(`p${index}`, socket);
      service.joinRoom(roomId, `p${index}`, `P${index}`, socket.id);
    });
    room.getPlayers().forEach((p, i) => expect(p.playerIndex).to.equal(i));
    const host = sockets.get('p0');
    handler.handleStartGame(host, { turnTimeLimitSeconds: TURN_SECONDS });
    expect(room.cardsDealt).to.equal(true);
    expect(room.awaitingDealAnimation).to.equal(true);
    live.push({ handler, service, room });
    return { handler, service, room, frames, sockets };
  }

  /** Hand the first turn to `seat` (the high-card draw is random). */
  function firstTurnTo(room, seat) {
    room.currentTurn = seat;
    room.turnOrder = room.getPlayers().map((_, offset) => (seat + offset) % room.maxPlayers);
  }

  function ackAll(handler, sockets) {
    for (const socket of sockets.values()) handler.handleDealAnimationComplete(socket, {});
  }

  function framesAfter(frames, mark) {
    return frames.slice(mark);
  }

  /**
   * Run the first turn out and check the take-and-throw: the drawing seat is
   * told which card it drew, everyone else is not, the same card is thrown, the
   * turn moves on, and nothing is drawn or thrown twice.
   */
  async function expectVisibleTimeoutPlay({ handler, room, frames, sockets }, seat) {
    const player = room.getPlayerByIndex(seat);
    const handBefore = room.playerHands.get(player.playerId).length;
    const pileBefore = room.discardPile.length;
    const mark = frames.length;

    await clock.advance(TURN_SECONDS * 1000 + 5);

    const after = framesAfter(frames, mark);
    const drawn = after.filter((f) => f.event === SocketEvents.CARD_DRAWN);
    const discarded = after.filter((f) => f.event === SocketEvents.CARD_DISCARDED);
    expect(after.some((f) => f.event === SocketEvents.TURN_TIMER_EXPIRED)).to.equal(true);
    expect(discarded, 'exactly one auto-discard').to.have.length(1);
    expect(discarded[0].payload.playerIndex).to.equal(seat);
    expect(room.currentTurn, 'the turn moved on').to.not.equal(seat);
    expect(room.playerHands.get(player.playerId)).to.have.length(handBefore);
    expect(room.discardPile).to.have.length(pileBefore + 1);

    if (player.isBot) {
      // No socket to tell: the room hears the hidden shape once.
      expect(drawn).to.have.length(1);
      expect(drawn[0].payload.card).to.equal(null);
      return;
    }

    const own = sockets.get(player.playerId);
    const toOwner = drawn.filter((f) => f.to === own.id);
    const toOthers = drawn.filter((f) => f.to !== own.id);
    expect(toOwner, 'the drawer is told once').to.have.length(1);
    expect(toOwner[0].payload.autoAdvance).to.equal(true);
    expect(toOwner[0].payload.card, 'the drawer is told WHICH card').to.not.equal(null);
    expect(toOthers, 'the rest of the room is told once').to.have.length(1);
    expect(toOthers[0].payload.card, 'nobody else sees it').to.equal(null);
    // The card thrown is the one the timeout drew for them — which is why the
    // owner has to know it: otherwise there is nothing in its hand to throw.
    // (A drawn WILD is the one exception: a timeout never throws a 2/joker
    // while a natural card is legal, so a hand card goes instead.)
    const told = toOwner[0].payload.card;
    const thrown = discarded[0].payload.card;
    const key = (c) => `${c.suit}-${c.rank}-${c.cardId}`;
    if (told.rank === '2' || told.rank === 'joker') {
      expect(key(thrown)).to.not.equal(key(told));
      expect(room.playerHands.get(player.playerId).map(key)).to.include(key(told));
    } else {
      expect(key(thrown)).to.equal(key(told));
    }
  }

  describe('round 1', () => {
    it('1v1: the seat to act gets the take and the throw once every seat reported its deal', async () => {
      const t = dealtTable(['human', 'human']);
      firstTurnTo(t.room, 1);
      ackAll(t.handler, t.sockets);
      expect(t.room.awaitingDealAnimation).to.equal(false);
      await expectVisibleTimeoutPlay(t, 1);
    });

    it('2v2: same, and the three other seats only see the hidden draw', async () => {
      const t = dealtTable(['human', 'human', 'human', 'human']);
      firstTurnTo(t.room, 2);
      ackAll(t.handler, t.sockets);
      await expectVisibleTimeoutPlay(t, 2);
    });

    it('a seat that never reports its deal: the bounded fallback starts the clock, not the report', async () => {
      const t = dealtTable(['human', 'human']);
      firstTurnTo(t.room, 0);
      t.handler.handleDealAnimationComplete(t.sockets.get('p0'), {});
      // p1 never reports (backgrounded, old build, board still loading).
      const started = () =>
        t.frames.filter((f) => f.event === SocketEvents.TURN_TIMER_STARTED).length;
      expect(started()).to.equal(0);
      await clock.advance(SocketHandlers.DEAL_ANIMATION_FALLBACK_MS - 1);
      expect(t.room.awaitingDealAnimation, 'still waiting on the slow seat').to.equal(true);
      expect(started()).to.equal(0);
      await clock.advance(1);
      expect(t.room.awaitingDealAnimation).to.equal(false);
      expect(started()).to.equal(1);
      await expectVisibleTimeoutPlay(t, 0);
    });

    it('1v1 against a bot: the human seat is played for, visibly', async () => {
      const t = dealtTable(['human', 'bot']);
      firstTurnTo(t.room, 0);
      ackAll(t.handler, t.sockets); // the bot never reports and never holds the deal
      expect(t.room.awaitingDealAnimation).to.equal(false);
      await expectVisibleTimeoutPlay(t, 0);
    });

    it('a bot seat whose first turn lapses is still drawn and thrown for', async () => {
      const t = dealtTable(['human', 'bot']);
      firstTurnTo(t.room, 1);
      ackAll(t.handler, t.sockets);
      await expectVisibleTimeoutPlay(t, 1);
    });

    it('2v2 with bots: the human partner of two bots gets the visible take and throw', async () => {
      const t = dealtTable(['human', 'bot', 'human', 'bot']);
      firstTurnTo(t.room, 2);
      ackAll(t.handler, t.sockets);
      await expectVisibleTimeoutPlay(t, 2);
    });
  });

  describe('a later round of a match', () => {
    it("round 2's first turn gets the same take-and-throw", async () => {
      const t = dealtTable(['human', 'human']);
      ackAll(t.handler, t.sockets);
      // End round 1 and let the server deal round 2 on its own schedule.
      t.handler._stopTurnTimer(t.room);
      t.room.targetScore = 2000;
      t.room.status = GameRoomStatus.FINISHED;
      t.room.gameEndedAt = new Date();
      t.room.awaitingNextRound = true;
      t.room.lastRoundEndPayload = { type: 'round_ended', matchEnded: false };
      await t.handler._startScheduledNextRound(t.room.roomId);
      expect(t.room.roundNumber).to.equal(2);
      expect(t.room.cardsDealt).to.equal(true);
      expect(t.room.awaitingDealAnimation).to.equal(true);
      const seat = t.room.currentTurn;
      ackAll(t.handler, t.sockets);
      await expectVisibleTimeoutPlay(t, seat);
    });
  });

  describe('no double fire, no stolen time', () => {
    it("a discard that arrives after the timeout already played the turn is refused, not played again", async () => {
      const t = dealtTable(['human', 'human']);
      firstTurnTo(t.room, 0);
      ackAll(t.handler, t.sockets);
      await expectVisibleTimeoutPlay(t, 0);
      const pile = t.room.discardPile.length;
      const late = t.room.playerHands.get('p0')[0];
      const mark = t.frames.length;
      t.handler.handleDiscardCard(t.sockets.get('p0'), { card: late.toJSON() });
      expect(t.room.discardPile).to.have.length(pile);
      expect(t.room.currentTurn).to.equal(1);
      expect(framesAfter(t.frames, mark).some((f) => f.event === SocketEvents.CARD_DISCARDED)).to.equal(false);
    });

    it('a manual draw during the deal is honoured: the timeout then only throws', async () => {
      const t = dealtTable(['human', 'human']);
      firstTurnTo(t.room, 0);
      // The quick seat finished its deal and drew while the other is still dealing.
      t.handler.handleDealAnimationComplete(t.sockets.get('p0'), {});
      t.handler.handleDrawCard(t.sockets.get('p0'), { fromDeck: true });
      expect(t.room.hasDrawnCard).to.equal(true);
      expect(t.room.turnTimerTickHandle, 'the draw does not start the clock').to.equal(null);
      t.handler.handleDealAnimationComplete(t.sockets.get('p1'), {});
      const hand = t.room.playerHands.get('p0').length;
      const mark = t.frames.length;
      await clock.advance(TURN_SECONDS * 1000 + 5);
      const after = framesAfter(t.frames, mark);
      expect(after.filter((f) => f.event === SocketEvents.CARD_DRAWN)).to.have.length(0);
      expect(after.filter((f) => f.event === SocketEvents.CARD_DISCARDED)).to.have.length(1);
      expect(t.room.playerHands.get('p0')).to.have.length(hand - 1);
      expect(t.room.currentTurn).to.equal(1);
    });

    it('a REJECTED discard during the deal does not start the first-turn clock early', async () => {
      const t = dealtTable(['human', 'human']);
      firstTurnTo(t.room, 0);
      // Before anybody has finished dealing, the seat to act fires a discard the
      // server refuses (it has not drawn). The deal gate must survive it.
      const card = t.room.playerHands.get('p0')[0];
      t.handler.handleDiscardCard(t.sockets.get('p0'), { card: card.toJSON() });
      expect(t.room.awaitingDealAnimation, 'the deal gate is still up').to.equal(true);
      expect(t.room.turnTimerTickHandle, 'no clock behind the deal').to.equal(null);
      expect(
        t.frames.filter((f) => f.event === SocketEvents.TURN_TIMER_STARTED),
        'nobody was told a clock started'
      ).to.have.length(0);
      expect(t.room.dealAnimationFallbackHandle, 'the bounded fallback is still armed').to.not.equal(null);

      // The clock starts when the deal is done — and the whole turn is still there.
      ackAll(t.handler, t.sockets);
      const started = t.frames.filter((f) => f.event === SocketEvents.TURN_TIMER_STARTED);
      expect(started).to.have.length(1);
      expect(started[0].payload.seconds).to.equal(TURN_SECONDS);
      await expectVisibleTimeoutPlay(t, 0);
    });
  });
});
