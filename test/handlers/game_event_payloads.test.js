/**
 * [GAME] event payloads, one per event type, produced by the REAL socket
 * handlers and read back from the match recorder: what each event says about
 * the action (cards as "QH#123" refs, seats, flags) and that its zone diff
 * moved exactly the cards the action moved.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const logger = require('../../src/utils/logger');
const { Card } = require('../../src/models/Deck');
const ReplayEngine = require('../../src/observability/ReplayEngine');
const codec = require('../../src/observability/replayCodec');
const { getGameEventRecorder } = require('../../src/observability/GameEventRecorder');

const recorder = getGameEventRecorder();
const REF = /^(10|[2-9AJQK])[HDCS]#\d+$|^JK#\d+$/;
const SUIT = { H: 'hearts', D: 'diamonds', C: 'clubs', S: 'spades' };

/** '7H' -> a fresh Card instance */
function card(spec) {
  if (spec === 'JK') return new Card('joker', 'joker');
  return new Card(SUIT[spec.slice(-1)], spec.slice(0, -1));
}
const cards = (specs) => specs.map(card);
const ref = (c) => codec.cardRef(c);

function socketMock(id) {
  const emitted = [];
  return {
    id,
    handshake: { headers: {} },
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
    emit: (event, payload) => emitted.push({ event, payload }),
    emitted,
  };
}

let counter = 0;
function dealtTable({ ruleset = 'classic', wellMode = 'indirect', kanoon = false, targetScore = 0 } = {}) {
  counter += 1;
  const roomId = `payload-${counter}-${Date.now()}`;
  const service = new GameService();
  const s1 = socketMock('s1');
  const s2 = socketMock('s2');
  const io = {
    sockets: { sockets: new Map([['s1', s1], ['s2', s2]]) },
    to: () => ({ emit: () => {} }),
    emit: () => {},
  };
  const handler = new SocketHandlers(io, service);
  service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'p1', 'P1', 's1');
  service.joinRoom(roomId, 'p2', 'P2', 's2');
  const room = service.getRoom(roomId);
  room.ruleset = ruleset;
  room.professionalWellMode = wellMode;
  if (kanoon) room.setKanoon(true);
  room.targetScore = targetScore;
  handler.handleStartGame(s1, {});
  handler._stopTurnTimer(room);
  if (room.dealAnimationFallbackHandle) clearTimeout(room.dealAnimationFallbackHandle);
  room.awaitingDealAnimation = false;
  const sockets = { p1: s1, p2: s2 };
  const current = () => {
    const p = room.getPlayerByIndex(room.currentTurn);
    return { playerId: p.playerId, seat: p.playerIndex, socket: sockets[p.playerId] };
  };
  const done = () => {
    handler._stopTurnTimer(room);
    room.disposeTimers();
    service.shutdown();
  };
  return { roomId, service, handler, room, current, done };
}

async function events(roomId) {
  const matchId = recorder.currentMatchId(roomId) || (await recorder.list({ roomId, limit: 1 })).matches[0]?.matchId;
  const stream = await recorder.load(matchId);
  return stream.events;
}
const last = (list, type) => list.filter((e) => e.type === type).pop();

describe('[GAME] event payloads (recorder)', () => {
  let consoleWas;
  beforeEach(() => {
    consoleWas = logger.enableConsole;
    logger.enableConsole = false;
  });
  afterEach(() => {
    logger.enableConsole = consoleWas;
  });

  it('deal: a keyframe with every hand, the stock order, both wells, the upcard and the seats', async () => {
    const t = dealtTable();
    try {
      const deal = last(await events(t.roomId), 'deal');
      expect(deal.round).to.equal(1);
      expect(deal.seats.map((s) => s.cards)).to.deep.equal([11, 11]);
      const kf = deal.kf;
      expect(kf.reason).to.equal('deal');
      expect(kf.seats.map((s) => [s.seat, s.id, s.name])).to.deep.equal([[0, 'p1', 'P1'], [1, 'p2', 'P2']]);
      expect(kf.z.h0).to.deep.equal(t.room.playerHands.get('p1').map((c) => c.cardId));
      expect(kf.z.s).to.deep.equal(t.room.deck.cards.map((c) => c.cardId));
      expect(kf.z.w0).to.have.length(11);
      expect(kf.z.w1).to.have.length(11);
      expect(kf.z.d).to.deep.equal([t.room.discardPile[0].cardId]);
      expect(kf.turn).to.equal(t.room.currentTurn);
      expect(kf.ruleset).to.equal('classic');
      // Round 1: the high-card ceremony is on the keyframe.
      expect(kf.firstTurn.winner).to.equal(t.room.currentTurn);
      expect(kf.firstTurn.rounds[0].every(([seat, r]) => Number.isInteger(seat) && REF.test(r))).to.equal(true);
      // The dictionary knows every card on the table (108 with jokers).
      expect(Object.keys(kf.cards)).to.have.length(108);
    } finally {
      t.done();
    }
  });

  it('draw + discard: refs, the stock/hand/pile diff and the next seat', async () => {
    const t = dealtTable();
    try {
      const me = t.current();
      const top = t.room.deck.cards[0];
      t.handler.handleDrawCard(me.socket, { fromDeck: true });
      const hand = t.room.playerHands.get(me.playerId);
      const thrown = hand[0];
      t.handler.handleDiscardCard(me.socket, { card: thrown.toJSON() });

      const list = await events(t.roomId);
      const draw = last(list, 'draw');
      expect(draw.card).to.equal(ref(top));
      expect(draw.seat).to.equal(me.seat);
      expect(draw.playerId).to.equal(undefined); // the seat names the player
      expect(draw.z[`h${me.seat}`]).to.deep.equal({ a: [top.cardId] });
      expect(draw.z.s).to.deep.equal({ r: [top.cardId] });

      const discard = last(list, 'discard');
      expect(discard.card).to.equal(ref(thrown));
      expect(discard.nextSeat).to.equal(t.room.currentTurn);
      expect(discard.tn).to.equal(t.room.currentTurn);
      expect(discard.z[`h${me.seat}`]).to.deep.equal({ r: [thrown.cardId] });
      expect(discard.auto).to.equal(undefined);
    } finally {
      t.done();
    }
  });

  it('take_pile: every taken card, pile emptied into the hand', async () => {
    const t = dealtTable();
    try {
      const me = t.current();
      const pile = t.room.discardPile.slice();
      t.handler.handlePickUpPile(me.socket, {});
      const take = last(await events(t.roomId), 'take_pile');
      expect(take.cards).to.deep.equal(pile.map(ref));
      expect(take.z.d).to.deep.equal([]);
      expect(take.z[`h${me.seat}`].a).to.deep.equal(pile.map((c) => c.cardId));
    } finally {
      t.done();
    }
  });

  it('meld, add_to_meld and go_down: the cards laid and the meld they built', async () => {
    const t = dealtTable();
    try {
      const me = t.current();
      const run = cards(['5H', '6H', '7H']);
      const extra = card('8H');
      const goDown = [cards(['9S', '10S', 'JS']), cards(['KD', 'KC', 'KS'])];
      t.room.playerHands.set(me.playerId, [...run, extra, ...goDown.flat(), ...cards(['3C', '4D', '9D'])]);
      t.room.hasDrawnCard = true;

      t.handler.handlePlayMeld(me.socket, { cards: run.map((c) => c.toJSON()) });
      t.handler.handleAddToMeld(me.socket, {
        cards: [extra.toJSON()],
        targetPlayerIndex: me.seat,
        targetMeldIndex: 0,
      });
      t.handler.handleGoDown(me.socket, { melds: goDown.map((m) => m.map((c) => c.toJSON())) });

      const list = await events(t.roomId);
      const meld = last(list, 'meld');
      expect(meld.cards).to.deep.equal(run.map(ref));
      expect(meld.grade).to.equal('clean');
      expect(meld.z[`m${me.seat}`]).to.deep.equal({ n: 1, c: { 0: run.map((c) => c.cardId) } });

      const add = last(list, 'add_to_meld');
      expect(add.cards).to.deep.equal([ref(extra)]);
      expect(add.targetSeat).to.equal(me.seat);
      expect(add.targetMeldIndex).to.equal(0);
      expect(add.z[`m${me.seat}`].c[0]).to.include(extra.cardId);

      const down = last(list, 'go_down');
      expect(down.melds).to.deep.equal(goDown.map((m) => m.map(ref)));
      expect(down.z[`m${me.seat}`].n).to.equal(3);
      expect(down.hand).to.equal(3);
    } finally {
      t.done();
    }
  });

  it('take_pozzetto: the eleven well cards by ref, the well slot emptied in place', async () => {
    const t = dealtTable();
    try {
      const me = t.current();
      t.room.playerHands.set(me.playerId, []);
      t.room.hasDrawnCard = true;
      const well = t.room.deadPiles[0].slice();
      t.handler.handleTakePozzetto(me.socket, {});
      const take = last(await events(t.roomId), 'take_pozzetto');
      expect(take.cards).to.deep.equal(well.map(ref));
      expect(take.hand).to.equal(11);
      expect(take.z.w0).to.deep.equal([]);
      expect(take.z.w1).to.equal(undefined);
    } finally {
      t.done();
    }
  });

  it('timeout: auto-draw + auto-discard carry `auto`, and returned melds name their cards', async () => {
    const t = dealtTable();
    try {
      const me = t.current();
      // A dead end (the shape timeout_returns_turn_melds.test.js pins): melded
      // down to one card THIS turn, no buraco, no well left — the lone card
      // cannot be thrown, so the timeout takes the turn's meld back first.
      const laid = cards(['3H', '4H', '5H', '6H', '7H', '8H']);
      const lone = card('KS');
      t.room.deadPiles = [[], []];
      t.room.playerMelds.set(me.playerId, [laid]);
      t.room.playerMeldOrders.set(me.playerId, [0]);
      t.room.turnMeldedCards.set(me.playerId, laid.slice());
      t.room.playerHands.set(me.playerId, [lone]);
      t.room.hasDrawnCard = true;
      t.handler._onTurnTimerExpired(t.room);

      const list = await events(t.roomId);
      const timeout = last(list, 'timeout');
      expect(timeout.seat).to.equal(me.seat);
      // Direct test surgery above had no event of its own, so it lands in the
      // NEXT event's diff — the replay still follows it.
      expect(timeout.dict).to.include.keys(...laid.map((c) => String(c.cardId)));
      const auto = last(list, 'discard');
      expect(auto.auto).to.equal(true);
      expect(auto.meldsReturned).to.equal(6);
      expect(auto.returnedCards).to.have.members(laid.map(ref));
      // The confiscation is in the same event's diff: the meld is gone.
      expect(auto.z[`m${me.seat}`]).to.deep.equal({ n: 0, c: {} });

      // Next seat, nothing drawn yet: the timeout draws for them too.
      const next = t.current();
      t.handler._onTurnTimerExpired(t.room);
      const list2 = await events(t.roomId);
      const autoDraw = last(list2, 'draw');
      expect(autoDraw.auto).to.equal(true);
      expect(autoDraw.seat).to.equal(next.seat);
    } finally {
      t.done();
    }
  });

  it('kanoonPenalty rides the manual discard and the timeout auto-discard', async () => {
    const t = dealtTable({ kanoon: true });
    try {
      const me = t.current();
      t.handler.handlePickUpPile(me.socket, {});
      const hand = t.room.playerHands.get(me.playerId);
      const throwAway = hand.find((c) => !t.room.kanoonPileTake.cardIds.includes(String(c.cardId)) && c.rank !== '2' && c.rank !== 'joker');
      t.handler.handleDiscardCard(me.socket, { card: throwAway.toJSON() });
      const manual = last(await events(t.roomId), 'discard');
      expect(manual.kanoonPenalty).to.equal(-ActionHandlers.KANOON_PILE_CHARGE);

      const next = t.current();
      t.handler.handlePickUpPile(next.socket, {});
      t.handler._onTurnTimerExpired(t.room);
      const auto = last(await events(t.roomId), 'discard');
      expect(auto.auto).to.equal(true);
      expect(auto.kanoonPenalty).to.equal(-ActionHandlers.KANOON_PILE_CHARGE);
    } finally {
      t.done();
    }
  });

  it('stock_promoted: an empty stock takes a well in as the new stock, as its own event', async () => {
    const t = dealtTable();
    try {
      const me = t.current();
      t.room.deck.cards = [];
      const well = t.room.deadPiles[0].map((c) => c.cardId);
      t.handler.handleDrawCard(me.socket, { fromDeck: true });
      const list = await events(t.roomId);
      const promo = last(list, 'stock_promoted');
      expect(promo.well).to.equal(0);
      expect(promo.deck).to.equal(11);
      expect(promo.z.w0).to.deep.equal([]);
      expect(promo.z.s.slice().sort()).to.deep.equal(well.slice().sort());
      expect(list.indexOf(promo)).to.be.lessThan(list.indexOf(last(list, 'draw')));
    } finally {
      t.done();
    }
  });

  it('round_end (target match) and match_end (single round) carry scores and a checksum that replays', async () => {
    for (const [targetScore, type] of [[100000, 'round_end'], [0, 'match_end']]) {
      const t = dealtTable({ targetScore });
      try {
        const me = t.current();
        t.room.deck.cards = [];
        t.room.deadPiles = [[], []];
        t.handler.handleDrawCard(me.socket, { fromDeck: true }); // deck-out: round over, no batida
        const list = await events(t.roomId);
        const end = last(list, type);
        expect(end, type).to.not.equal(undefined);
        expect(end.teamScores).to.have.keys('teamA', 'teamB');
        expect(end.cumulative).to.have.keys('teamA', 'teamB');
        expect(end.check).to.match(/^[0-9a-f]{8}$/);
        const stream = { header: {}, events: list };
        expect(ReplayEngine.reconstruct(stream, end.seq).verified).to.equal(true);
      } finally {
        t.done();
      }
    }
  });

  it('undo_meld: logged as ignored (undo is disabled) with an empty diff', async () => {
    const t = dealtTable();
    try {
      const me = t.current();
      t.handler.handleUndoMeld(me.socket, {});
      const undo = last(await events(t.roomId), 'undo_meld');
      expect(undo.seat).to.equal(me.seat);
      expect(undo.ignored).to.equal(true);
      expect(undo.z).to.equal(undefined);
    } finally {
      t.done();
    }
  });

  it('leave: carries the seat of the player who left', async () => {
    const service = new GameService();
    const s1 = socketMock('ls1');
    const s2 = socketMock('ls2');
    const io = { sockets: { sockets: new Map([['ls1', s1], ['ls2', s2]]) }, to: () => ({ emit: () => {} }), emit: () => {} };
    const handler = new SocketHandlers(io, service);
    const roomId = `leave-${Date.now()}`;
    const lines = [];
    const original = logger.info;
    logger.info = function (message, data) {
      if (String(message).startsWith('[GAME] leave')) lines.push(data);
      return original.call(this, message, data);
    };
    try {
      service.createRoom(roomId, 2);
      service.joinRoom(roomId, 'p1', 'P1', 'ls1');
      service.joinRoom(roomId, 'p2', 'P2', 'ls2');
      handler.handleLeaveRoom(s2, {});
      expect(lines).to.have.length(1);
      expect(lines[0].seat).to.equal(1);
      expect(lines[0].playerId).to.equal('p2');
    } finally {
      logger.info = original;
      service.shutdown();
    }
  });

  it('dev hand surgery is an event, so the replay follows it', async () => {
    const t = dealtTable();
    try {
      const target = t.room.getPlayer('p2');
      const want = t.room.deck.cards.slice(0, 3).map((c) => ({ cardId: c.cardId }));
      const out = t.handler.changePlayerCards({ roomId: t.roomId, target_user: 'p2', change_cards: want });
      expect(out.success, out.error).to.equal(true);
      const list = await events(t.roomId);
      const ev = last(list, 'dev_change_cards');
      expect(ev.seat).to.equal(target.playerIndex);
      expect(ev.cards).to.have.length(3);
      const table = ReplayEngine.tableAt({ header: {}, events: list });
      expect(table.players[1].hand.map((c) => c.cardId)).to.deep.equal(want.map((c) => c.cardId));
    } finally {
      t.done();
    }
  });
});
