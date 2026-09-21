// An untaken pozzetto survives a pile take, but an explicit stock draw must
// promote it immediately, using the same rule as timeout draws.
/* eslint-env mocha */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameRoom = require('../../src/models/GameRoom');
const PlayerSession = require('../../src/models/PlayerSession');

const c = (suit, rank, cardId) => ({ suit, rank, cardId });

/** A 1v1 room mid-round with a DEAD stock and one untaken well. */
function deadStockRoom({ pile = [c('hearts', '9', 90)], well = true } = {}) {
  const room = new GameRoom('ws1', 2);
  room.addPlayer(
    new PlayerSession({ playerId: 'p1', playerName: 'A', playerIndex: 0, socketId: 's1' })
  );
  room.addPlayer(
    new PlayerSession({ playerId: 'p2', playerName: 'B', playerIndex: 1, socketId: 's2' })
  );
  room.startGame(true);
  room.dealCards();

  // Drain the stock without touching anything else.
  room.deck.cards = [];
  room.deadPiles = well ? [[c('spades', '4', 41)], []] : [[], []];
  room.discardPile = [...pile];
  room.currentTurn = 0;
  return room;
}

const wellCards = (room) =>
  (room.deadPiles || []).reduce((n, p) => n + (Array.isArray(p) ? p.length : 0), 0);

describe('an empty stock promotes a well only when a stock draw is requested', () => {
  it('a draw request promotes the well even when the pile is takeable', () => {
    const room = deadStockRoom();
    const originalPile = [...room.discardPile];

    expect(ActionHandlers._deckOutTerminal(room, 'p1')).to.equal(null);

    expect(wellCards(room)).to.equal(0);
    expect(room.deadPiles).to.have.length(2);
    expect(room.deck.count).to.equal(1);
    expect(room.discardPile).to.deep.equal(originalPile);
    const GameValidator = require('../../src/validators/GameValidator');
    expect(GameValidator.validateDrawCard(room, 'p1', true).isValid).to.equal(true);
  });

  it('taking the discard pile instead still preserves the well', () => {
    const room = deadStockRoom();

    const result = ActionHandlers.handlePickUpPile(room, 'p1', room.discardPile);

    expect(result.success).to.equal(true);
    expect(wellCards(room)).to.equal(1);
    expect(room.deck.count).to.equal(0);
  });

  it('a repeat draw after drawing cannot consume a second well', () => {
    const room = deadStockRoom();
    room.hasDrawnCard = true;

    expect(ActionHandlers._deckOutTerminal(room, 'p1')).to.equal(null);
    expect(wellCards(room)).to.equal(1);
    expect(room.deck.count).to.equal(0);
  });

  it('an out-of-turn draw cannot consume the well', () => {
    const room = deadStockRoom();

    expect(ActionHandlers._deckOutTerminal(room, 'p2')).to.equal(null);
    expect(wellCards(room)).to.equal(1);
    expect(room.deck.count).to.equal(0);
  });

  it('emptying the hand still collects it, which is the point', () => {
    const room = deadStockRoom();
    room.playerHands.set('p1', []);

    const taken = ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', false);

    expect(taken, 'the well went to the player, not to the deck').to.not.equal(null);
    expect(room.playerHands.get('p1')).to.have.length(1);
    expect(wellCards(room)).to.equal(0);
  });

  describe('stock resolution preserves existing round-ending rules', () => {
    it('an EMPTY pile is no continuation, so the well refills the stock', () => {
      const room = deadStockRoom({ pile: [] });

      ActionHandlers._deckOutTerminal(room, 'p1');

      expect(room.deck.count, 'promoted exactly as before').to.equal(1);
      expect(wellCards(room)).to.equal(0);
    });

    it('with no well left at all the round ends, unchanged', () => {
      const room = deadStockRoom({ well: false, pile: [] });

      const out = ActionHandlers._deckOutTerminal(room, 'p1');

      expect(out).to.not.equal(null);
      expect(out.roundEnded).to.not.equal(undefined);
    });

    it('a dead stock with a takeable pile and no well still ends the round', () => {
      // The pile has never kept play alive on its own (existing product rule);
      // manual promotion does not change that.
      const room = deadStockRoom({ well: false });

      const out = ActionHandlers._deckOutTerminal(room, 'p1');

      expect(out).to.not.equal(null);
      expect(out.roundEnded).to.not.equal(undefined);
    });
  });

  it('a live stock is untouched — this only ever applies at zero', () => {
    const room = deadStockRoom();
    room.deck.cards = [c('clubs', '5', 55)];

    expect(ActionHandlers._deckOutTerminal(room, 'p1')).to.equal(null);
    expect(wellCards(room)).to.equal(1);
    expect(room.deck.count).to.equal(1);
  });

  // Found by an adversarial trace of my own change, and it WAS my regression:
  // hoisting the `deck.count > 0` guard to the top of _deckOutTerminal left
  // nothing between the promotion and the squeeze test, so the round ended on
  // the very tap that refilled the stock — abandoning the second well on the
  // table and charging BOTH sides -100 for never taking a well they were never
  // given the chance to take.
  it('a promotion refills the stock and play GOES ON — the second well is not abandoned', () => {
    const room = new GameRoom('ws-squeeze', 2);
    room.addPlayer(
      new PlayerSession({ playerId: 'p1', playerName: 'A', playerIndex: 0, socketId: 's1' })
    );
    room.addPlayer(
      new PlayerSession({ playerId: 'p2', playerName: 'B', playerIndex: 1, socketId: 's2' })
    );
    room.ruleset = 'professional'; // the squeeze rule is professional-only
    room.startGame(true);
    room.dealCards();
    room.ruleset = 'professional';

    // The exact position: stock dead, BOTH wells untaken, one card in hand and
    // one on the pile, so the squeeze blocks the pile take.
    room.deck.cards = [];
    room.deadPiles = [
      Array.from({ length: 11 }, (_, i) => c('hearts', '3', 200 + i)),
      Array.from({ length: 11 }, (_, i) => c('clubs', '4', 300 + i)),
    ];
    room.discardPile = [c('spades', '9', 91)];
    room.playerHands.set('p1', [c('diamonds', 'Q', 92)]);
    room.currentTurn = 0;

    const out = ActionHandlers._deckOutTerminal(room, 'p1');

    expect(out, 'the round must NOT end on the tap that refilled the stock').to.equal(null);
    expect(room.deck.count, 'one well was promoted into the stock').to.equal(11);
    expect(wellCards(room), 'and the OTHER well is still there to be won').to.equal(11);
  });
});
