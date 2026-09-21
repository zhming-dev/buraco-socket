/* eslint-env mocha */

/**
 * THE STUCK TABLE, online side — user report 2026-09-01 (verbatim):
 * "bug bot stuck, saat pile 0, bot mau ambil dari deck pile, padahal ada
 *  pozetto, pozettonya ga di transfer ke deckpile, dan sekarang game stuck
 *  gabisa diapa apain."
 *
 * The screenshot: DECK 0, one pozzetto still holding 11 cards, the other already
 * taken BY THE BOT'S OWN SIDE, a six-card discard pile, a bot to act.
 *
 * INVARIANT: a bot must never choose an action the engine will refuse.
 *
 * In that position the server DEFERS the promotion rather than spending the well
 * as a stock refill (ActionHandlers._deckOutTerminal, product decision
 * 2026-08-27 — it is what keeps the "steal the pozzetto" line alive), and
 * GameValidator.validateDrawCard then rejects the draw with "Deck is empty".
 * BotStrategy asked for that draw anyway. Online it survived only because
 * BotCoordinator answers the rejection with endRoundOnDeckOut, which promotes
 * the well behind it — quietly undoing the 2026-08-27 rule for bot seats. The
 * OFFLINE client had no such breaker and simply froze, which is the bug the user
 * hit; the client now takes the pile, and these pin that the server-side bot
 * plays the same game 1:1.
 *
 * What must NOT regress: a LONE useless card on a dead stock is still declined
 * (take one, discard one, nothing changes — every seat recycling it is the round
 * that never ends). The breaker stays the last-resort net for that case.
 */

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameValidator = require('../../src/validators/GameValidator');
const BotStrategy = require('../../src/bots/BotStrategy');
const { GameRoom, PlayerSession } = require('../../src/models');
const { Deck } = require('../../src/models/Deck');
const { GameRoomStatus } = require('../../src/constants');

let nextId = 0;
function card(rank, suit) {
  nextId += 1;
  return { cardId: `s${nextId}`, instanceId: `s${nextId}`, rank, suit, isJoker: rank === 'joker' };
}

/** The screenshot's discard pile, bottom-to-top: 4C under 9S 6C 9H 8H 8C. */
const screenshotPile = () => [
  card('4', 'clubs'),
  card('9', 'spades'),
  card('6', 'clubs'),
  card('9', 'hearts'),
  card('8', 'hearts'),
  card('8', 'clubs'),
];

/**
 * A four-card pile of pure junk relative to [uninterestedHand]: no rank we hold,
 * no suit we are near, no wilds. The bot's own valuation DECLINES it even with
 * the dead-stock discount applied — which is what makes the assertions below
 * about the new rule rather than about the bot happening to want the pile.
 */
const declinedPile = () => [
  card('3', 'hearts'),
  card('5', 'hearts'),
  card('10', 'hearts'),
  card('Q', 'hearts'),
];

/** Holds nothing in hearts and nothing that pairs the pile. */
const uninterestedHand = () => [
  card('K', 'spades'),
  card('7', 'diamonds'),
  card('4', 'clubs'),
  card('9', 'spades'),
];

const strategy = new BotStrategy();

const botState = (overrides = {}) => ({
  roomId: 'stuck-1',
  playerId: 'bot-1',
  playerIndex: 1,
  currentPlayerIndex: 1,
  cardsDealt: true,
  hasDrawnCard: false,
  meldedThisTurn: false,
  ruleset: 'professional',
  professionalWellMode: 'indirect',
  yourHand: uninterestedHand(),
  playerMelds: {},
  discardPile: [],
  deckCount: 0,
  deadPileCounts: [11, 0],
  pozzettosAvailable: true,
  teamHasTakenPozzetto: true,
  teamWellsTaken: 1,
  opponentWellsTaken: 0,
  wellsTakenThisRound: 1,
  mustMeldCard: null,
  drawnCardRestriction: [],
  ...overrides,
});

describe('#stuck-table (dead stock + untaken well: the bot takes the pile)', () => {
  it('CONTROL: the bot does not actually WANT the declined pile', () => {
    // If its own valuation said "take", the regression below would pass for the
    // wrong reason. It declines — so the take can only come from the new rule.
    const state = botState({ discardPile: declinedPile() });
    const ctx = strategy._context(state);
    const top = state.discardPile[state.discardPile.length - 1];
    expect(strategy._shouldTakeDiscardPile(state, ctx, top)).to.equal(false);
  });

  it('THE REGRESSION: takes the declined pile rather than a refused draw', () => {
    // Before the fix this returned `{ type: 'draw_card', fromDeck: true }` — the
    // move _deckOutTerminal defers and validateDrawCard then rejects (asserted
    // below). Online that was papered over by endRoundOnDeckOut promoting the
    // well; offline the identical choice froze the table.
    const intent = strategy.decide(botState({ discardPile: declinedPile() }));
    expect(intent.type).to.equal('pick_up_pile');
  });

  it('...and does so even though its own side ALREADY banked a well', () => {
    // The screenshot seat exactly: teamHasTakenPozzetto true. The client's gate
    // was `needsWell`, and this is the case it excluded.
    const intent = strategy.decide(botState({
      discardPile: declinedPile(),
      teamHasTakenPozzetto: true,
      teamWellsTaken: 1,
      wellsTakenThisRound: 1,
    }));
    expect(intent.type).to.equal('pick_up_pile');
  });

  it('the screenshot pile itself is taken too', () => {
    // Six cards with a 4C the hand can use: the valuation already wanted this
    // one (the dead-stock discount lowers its bar), so ONLINE this exact hand
    // never froze. The client's `needsWell` gate skipped its own preference
    // check entirely, which is why the same table stuck offline.
    const intent = strategy.decide(botState({ discardPile: screenshotPile() }));
    expect(intent.type).to.equal('pick_up_pile');
  });

  it('a stock draw can now promote the well without waiting for a bot rescue', () => {
    const room = new GameRoom({ roomId: 'stuck-1', maxPlayers: 2 });
    room.status = GameRoomStatus.IN_PROGRESS;
    room.ruleset = 'professional';
    room.currentTurn = 0;
    room.hasDrawnCard = false;
    room.deck = new Deck();
    room.deck.cards = [];
    room.deadPiles = [
      Array.from({ length: 11 }, (_, i) => card(String((i % 9) + 2), 'clubs')),
      [],
    ];
    room.discardPile = declinedPile();
    room.addPlayer(new PlayerSession({
      playerId: 'p1', playerName: 'P1', playerIndex: 0, socketId: 's1',
    }));
    room.playerHands.set('p1', uninterestedHand());
    room.playerMelds.set('p1', []);
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerDeadPileCount.set('p1', 1);
    room.meldDirtyFlags.set('p1', new Set());

    expect(ActionHandlers._deckOutTerminal(room, 'p1')).to.equal(null);
    expect(room.deck.count).to.equal(11);
    expect(room.deadPiles[0]).to.have.length(0);

    const validation = GameValidator.validateDrawCard(room, 'p1', true);
    expect(validation.isValid).to.equal(true);

    // Choosing the pile instead remains legal too.
    expect(ActionHandlers._pileTakeBlockedBySqueeze(room, 'p1')).to.equal(false);
  });

  it('STILL declines a lone useless card, so a dead round can end', () => {
    // The recycle protection this fix must not trade away: taking one card and
    // discarding one changes nothing, and every seat doing it circles forever.
    // Declining lets BotCoordinator's endRoundOnDeckOut promote the well (or end
    // the round) — it stays the last-resort net.
    const intent = strategy.decide(botState({ discardPile: [card('Q', 'diamonds')] }));
    expect(intent.type).to.equal('draw_card');
    expect(intent.fromDeck).to.equal(true);
  });

  it('STILL draws on an empty pile (nothing to take: promote the well)', () => {
    const intent = strategy.decide(botState({ discardPile: [] }));
    expect(intent.type).to.equal('draw_card');
    expect(intent.fromDeck).to.equal(true);
  });
});
