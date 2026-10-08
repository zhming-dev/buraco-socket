/* eslint-env mocha */

/**
 * "Buat auto throw yang batas waktu habis biar card aware, jadi dia bakal
 * otomatis throw kartu yang gabisa dimeld" — owner, 2026-10-07.
 *
 * The turn timeout used to throw the card it had just drawn, else the cheapest
 * natural card — blind to the hand, so it happily broke a run or threw the card
 * that would have extended a meld. It now throws a card that can no longer be
 * melded (no meld it extends, no same-rank partner, no same-suit neighbour), and
 * only when every card builds something does it give up the least useful one,
 * ranked the way the bots rank their own throws. Legality and the never-a-wild
 * rule are unchanged (timeout_discard_keeps_wild).
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const BotCoordinator = require('../../src/bots/BotCoordinator');
const { Card } = require('../../src/models/Deck');

const c = (rank, suit) => new Card(suit, rank);

function fakeIo(emitted) {
  return {
    to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
    sockets: { sockets: new Map() },
  };
}

/**
 * A professional 1v1 room on p1's turn. [hand] is p1's hand; [draw] (optional)
 * is put on top of the stock so the timeout draws it; without it p1 has drawn.
 */
function setup({ hand, draw = null, ownMelds = [], opponentMelds = [], qanoon = false, roomId = 'card-aware' }) {
  const service = new GameService();
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'p1', 'P1', 's1');
  service.joinRoom(roomId, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  if (qanoon) room.setQanoon(true);
  room.ruleset = 'professional';
  room.professionalWellMode = 'direct';
  room.currentTurn = 0;
  room.meldedThisTurn = false;
  room.drawnCardThisTurnRestriction = new Set();
  room.discardPile = [];
  room.playerHands.set('p1', hand);
  room.playerMelds.set('p1', ownMelds);
  room.playerMelds.set('p2', opponentMelds);
  if (draw) {
    room.hasDrawnCard = false;
    room.deck.cards.unshift(draw);
  } else {
    room.hasDrawnCard = true;
  }
  const emitted = [];
  const handlers = new SocketHandlers(fakeIo(emitted), service);
  const thrown = () => room.discardPile[room.discardPile.length - 1];
  const done = () => {
    handlers._stopTurnTimer(room);
    service.deleteRoom(roomId);
  };
  return { service, room, handlers, emitted, thrown, done };
}

const key = (card) => `${card.rank}${card.suit[0]}`;
const handKeys = (room) => room.playerHands.get('p1').map(key);

describe('#timeout auto-throw is card-aware', () => {
  it('keeps a drawn card that extends the side\'s meld and throws hand junk instead', () => {
    const t = setup({
      hand: [c('K', 'clubs'), c('4', 'diamonds')],
      draw: c('7', 'hearts'),
      ownMelds: [[c('4', 'hearts'), c('5', 'hearts'), c('6', 'hearts')]],
    });
    t.handlers._onTurnTimerExpired(t.room);
    // Both hand cards are junk; the cheaper one goes. The 7♥ stays for the run.
    expect(key(t.thrown())).to.equal('4d');
    expect(handKeys(t.room)).to.include('7h');
    expect(t.room.currentTurn).to.equal(1);
    t.done();
  });

  it('keeps a drawn card that pairs one in the hand', () => {
    const t = setup({
      hand: [c('9', 'spades'), c('K', 'clubs'), c('4', 'diamonds')],
      draw: c('9', 'hearts'),
    });
    t.handlers._onTurnTimerExpired(t.room);
    expect(key(t.thrown())).to.equal('4d');
    expect(handKeys(t.room)).to.include.members(['9s', '9h']);
    t.done();
  });

  it('still throws back a drawn card that is junk, even over a cheaper junk card', () => {
    // Continuity with the old rule: the player never chose to keep it.
    const t = setup({
      hand: [c('4', 'diamonds'), c('9', 'spades'), c('10', 'spades')],
      draw: c('K', 'clubs'),
    });
    t.handlers._onTurnTimerExpired(t.room);
    expect(key(t.thrown())).to.equal('Kc');
    t.done();
  });

  it('never breaks up a run in the making while a junk card is there (the old pick threw the cheapest)', () => {
    const t = setup({ hand: [c('5', 'hearts'), c('6', 'hearts'), c('Q', 'clubs')] });
    t.handlers._onTurnTimerExpired(t.room);
    expect(key(t.thrown())).to.equal('Qc');
    expect(handKeys(t.room)).to.have.members(['5h', '6h']);
    t.done();
  });

  it('holds back junk an opponent could lay straight down', () => {
    // 6♠ is the cheaper junk, but it extends the opponent's 3-4-5♠.
    const t = setup({
      hand: [c('6', 'spades'), c('K', 'diamonds')],
      opponentMelds: [[c('3', 'spades'), c('4', 'spades'), c('5', 'spades')]],
    });
    t.handlers._onTurnTimerExpired(t.room);
    expect(key(t.thrown())).to.equal('Kd');
    t.done();
  });

  it('when every card builds something, gives up the least useful (a pair before a run)', () => {
    const t = setup({
      hand: [c('4', 'hearts'), c('5', 'hearts'), c('6', 'hearts'), c('K', 'clubs'), c('K', 'diamonds')],
    });
    t.handlers._onTurnTimerExpired(t.room);
    expect(t.thrown().rank).to.equal('K');
    expect(handKeys(t.room)).to.include.members(['4h', '5h', '6h']);
    t.done();
  });

  it('a wild still never goes while a natural card is legal', () => {
    const t = setup({ hand: [c('2', 'hearts'), c('5', 'hearts'), c('6', 'hearts')] });
    t.handlers._onTurnTimerExpired(t.room);
    expect(t.thrown().rank).to.not.equal('2');
    expect(handKeys(t.room)).to.include('2h');
    t.done();
  });

  it('if the judgement fails, the throw still happens: drawn card, then the cheapest', () => {
    const original = BotCoordinator.seatState;
    BotCoordinator.seatState = () => {
      throw new Error('boom');
    };
    try {
      const t = setup({ hand: [c('5', 'hearts'), c('6', 'hearts'), c('Q', 'clubs')] });
      t.handlers._onTurnTimerExpired(t.room);
      expect(key(t.thrown())).to.equal('5h');
      expect(t.room.currentTurn).to.equal(1);
      t.done();
    } finally {
      BotCoordinator.seatState = original;
    }
  });

  it('a Qanoon timeout after an unmelded pile take books the ESCALATED charge on the wire', () => {
    const taken = [c('8', 'clubs'), c('J', 'diamonds')];
    const t = setup({ hand: [c('5', 'hearts'), c('6', 'hearts'), ...taken], qanoon: true });
    t.room.qanoonChargeCounts.set('p1', 1); // one charge already this match
    t.room.qanoonPileTake = { playerId: 'p1', cardIds: taken.map((x) => String(x.cardId)) };
    t.handlers._onTurnTimerExpired(t.room);
    const discard = t.emitted.find((e) => e.event === 'card_discarded');
    expect(discard.payload.qanoonPenalty).to.include({ value: -200, count: 2, playerIndex: 0 });
    expect(t.room.teamTurnPenalty.get('p1')).to.equal(200);
    t.done();
  });
});
