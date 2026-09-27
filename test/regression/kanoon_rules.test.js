/**
 * KANOON — the 1v1 variant that rides on pro-direct.
 *
 * Owner's spec (2026-09-27):
 *   1. No SET of one rank (3-3-3, and the 2-2-2 set too) until the side owns a
 *      buraco — clean, semi or dirty, any run.
 *   2. Taking the discard pile obliges the taker to put at least ONE of the taken
 *      cards into a meld before discarding. Forgetting is not blocked; it costs
 *      the side 100 on the round.
 *   3. Everything else is pro-direct.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameValidator = require('../../src/validators/GameValidator');
const BotStrategy = require('../../src/bots/BotStrategy');
const { GameRoom } = require('../../src/models');
const { Card } = require('../../src/models/Deck');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');

const c = (rank, suit) => new Card(suit, rank);
const run = (suit, ranks) => ranks.map((r) => c(r, suit));
const SPADE_BURACO = () => run('spades', ['4', '5', '6', '7', '8', '9', '10']);

function makeRoom({ seats = 2, kanoon = true } = {}) {
  const room = new GameRoom({ roomId: 'kanoon-room', maxPlayers: seats });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.setKanoon(kanoon);
  if (!kanoon) {
    room.ruleset = 'professional';
    room.professionalWellMode = 'direct';
  }
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.turnTimeLimit = 30;
  for (let i = 0; i < seats; i += 1) {
    room.addPlayer(
      new PlayerSession({
        playerId: `p${i + 1}`,
        playerName: `P${i + 1}`,
        playerIndex: i,
        socketId: `s${i + 1}`,
      })
    );
    room.playerHands.set(`p${i + 1}`, []);
    room.playerMelds.set(`p${i + 1}`, []);
    room.teamTurnPenalty.set(`p${i + 1}`, 0);
  }
  room.deadPiles = [];
  return room;
}

describe('#kanoon', () => {
  describe('the variant itself', () => {
    it('pins pro + direct when switched on', () => {
      const room = makeRoom();
      expect(room.ruleset).to.equal('professional');
      expect(room.professionalWellMode).to.equal('direct');
      expect(room.isKanoon()).to.equal(true);
    });

    it('is 1v1 only: a 4-seat room never plays it, whatever the flag says', () => {
      const room = makeRoom({ seats: 4 });
      expect(room.kanoon).to.equal(true);
      expect(room.isKanoon()).to.equal(false);
    });
  });

  describe('rule 1 — no set before a buraco', () => {
    const kings = () => [c('K', 'hearts'), c('K', 'diamonds'), c('K', 'clubs')];

    it('refuses a set while the side has no buraco', () => {
      const room = makeRoom();
      room.playerHands.set('p1', [...kings(), c('9', 'clubs')]);
      const res = GameValidator.validateMeld(room, 'p1', room.playerHands.get('p1').slice(0, 3));
      expect(res.isValid).to.equal(false);
      expect(res.reason).to.equal('kanoonSetLocked');
    });

    it('refuses the 2-2-2 set too', () => {
      const room = makeRoom();
      room.playerHands.set('p1', [c('2', 'hearts'), c('2', 'diamonds'), c('2', 'clubs'), c('9', 'clubs')]);
      const res = GameValidator.validateMeld(room, 'p1', room.playerHands.get('p1').slice(0, 3));
      expect(res.isValid).to.equal(false);
      expect(res.reason).to.equal('kanoonSetLocked');
    });

    it('still lets a run through', () => {
      const room = makeRoom();
      room.playerHands.set('p1', [...run('hearts', ['5', '6', '7']), c('9', 'clubs')]);
      const res = GameValidator.validateMeld(room, 'p1', room.playerHands.get('p1').slice(0, 3));
      expect(res.isValid, res.error).to.equal(true);
    });

    it('unlocks sets once the side owns a buraco', () => {
      const room = makeRoom();
      room.playerMelds.set('p1', [SPADE_BURACO()]);
      room.playerHands.set('p1', [...kings(), c('9', 'clubs')]);
      const res = GameValidator.validateMeld(room, 'p1', room.playerHands.get('p1').slice(0, 3));
      expect(res.isValid, res.error).to.equal(true);
    });

    it("the OPPONENT's buraco does not unlock mine", () => {
      const room = makeRoom();
      room.playerMelds.set('p2', [SPADE_BURACO()]);
      room.playerHands.set('p1', [...kings(), c('9', 'clubs')]);
      const res = GameValidator.validateMeld(room, 'p1', room.playerHands.get('p1').slice(0, 3));
      expect(res.reason).to.equal('kanoonSetLocked');
    });

    it('a going-down that lays a 7-card run unlocks the set travelling with it', () => {
      const room = makeRoom();
      const buraco = SPADE_BURACO();
      const set = kings();
      room.playerHands.set('p1', [...buraco, ...set, c('9', 'clubs')]);
      expect(GameValidator.validateGoingDown(room, 'p1', [buraco, set]).isValid).to.equal(true);
    });

    it('a going-down with a short run + a set is refused', () => {
      const room = makeRoom();
      const short = run('spades', ['4', '5', '6']);
      const set = kings();
      room.playerHands.set('p1', [...short, ...set, c('9', 'clubs')]);
      const res = GameValidator.validateGoingDown(room, 'p1', [short, set]);
      expect(res.isValid).to.equal(false);
      expect(res.reason).to.equal('kanoonSetLocked');
    });

    it('plain pro-direct keeps sets open', () => {
      const room = makeRoom({ kanoon: false });
      room.playerHands.set('p1', [...kings(), c('9', 'clubs')]);
      expect(GameValidator.validateMeld(room, 'p1', room.playerHands.get('p1').slice(0, 3)).isValid).to.equal(true);
    });
  });

  describe('rule 2 — a pile take must reach a meld', () => {
    /** p1 has just taken a 2-card pile [7♥, 8♥]; hand also holds 5♥ 6♥ + junk. */
    const tookPile = (opts) => {
      const room = makeRoom(opts);
      const taken = [c('7', 'hearts'), c('8', 'hearts')];
      const hand = [c('5', 'hearts'), c('6', 'hearts'), c('K', 'clubs'), c('J', 'diamonds'), ...taken];
      room.playerHands.set('p1', hand);
      room.kanoonPileTake = { playerId: 'p1', cardIds: taken.map((t) => String(t.cardId)) };
      return { room, taken, hand };
    };

    it('charges 100 when the turn ends with every taken card still in hand', () => {
      const { room, hand } = tookPile();
      const res = ActionHandlers.handleDiscard(room, 'p1', hand[2]);
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.kanoonPenalty).to.deep.equal({ value: -100, reason: 'pile_not_melded', playerIndex: 0 });
      expect(room.teamTurnPenalty.get('p1')).to.equal(100);
      // …and the HUD/round board read it from the ledger they already use.
      expect(ActionHandlers.serializeTeamRoundState(room).teamTurnPenalty.teamA).to.equal(100);
      expect(room.kanoonPileTake).to.equal(null);
    });

    it('no charge once one taken card is in a meld', () => {
      const { room, hand } = tookPile();
      const meld = [hand[0], hand[1], hand[4]]; // 5♥ 6♥ 7♥ — 7♥ came off the pile
      const laid = ActionHandlers.handlePlayMeld(room, 'p1', meld);
      expect(laid.success, laid.error).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', room.playerHands.get('p1').find((x) => x.rank === 'K'));
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.kanoonPenalty).to.equal(undefined);
      expect(room.teamTurnPenalty.get('p1')).to.equal(0);
    });

    it('throwing a taken card away does not count as melding it', () => {
      const { room, taken } = tookPile();
      const res = ActionHandlers.handleDiscard(room, 'p1', taken[1]);
      expect(res.success, res.error).to.equal(true);
      expect(room.teamTurnPenalty.get('p1')).to.equal(100);
    });

    it('the charge lands on the round total', () => {
      const { room, hand } = tookPile();
      ActionHandlers.handleDiscard(room, 'p1', hand[2]);
      const { teamScores } = ActionHandlers._computeScores(room, null, null);
      expect(teamScores.teamA.turnPenalty).to.equal(100);
    });

    it('a deck draw carries no obligation', () => {
      const room = makeRoom();
      room.playerHands.set('p1', [c('K', 'clubs'), c('J', 'diamonds')]);
      const res = ActionHandlers.handleDiscard(room, 'p1', room.playerHands.get('p1')[0]);
      expect(res.success, res.error).to.equal(true);
      expect(room.teamTurnPenalty.get('p1')).to.equal(0);
    });

    it('plain pro-direct never charges', () => {
      const { room, hand } = tookPile({ kanoon: false });
      ActionHandlers.handleDiscard(room, 'p1', hand[2]);
      expect(room.teamTurnPenalty.get('p1')).to.equal(0);
    });

    it('the obligation dies with the turn', () => {
      const { room } = tookPile();
      room.nextTurn();
      expect(room.kanoonPileTake).to.equal(null);
    });
  });

  describe('bot', () => {
    const bot = new BotStrategy();
    const baseState = (over = {}) => ({
      cardsDealt: true,
      playerIndex: 0,
      currentPlayerIndex: 0,
      ruleset: 'professional',
      professionalWellMode: 'direct',
      kanoon: true,
      playerMelds: { 0: [], 1: [] },
      meldFlags: {},
      discardPile: [],
      yourHand: [],
      ...over,
    });

    it('never opens a set while locked', () => {
      const ctx = bot._context(baseState());
      expect(ctx.kanoonSetsLocked).to.equal(true);
      expect(bot._isLegalNewMeld([c('K', 'hearts'), c('K', 'diamonds'), c('K', 'clubs')], ctx)).to.equal(false);
      expect(bot._isLegalNewMeld(run('hearts', ['5', '6', '7']), ctx)).to.equal(true);
    });

    it('declines a pile none of whose cards can reach a meld', () => {
      const state = baseState({
        hasDrawnCard: false,
        yourHand: [c('K', 'hearts'), c('4', 'clubs'), c('9', 'diamonds')],
        discardPile: [c('K', 'spades')],
      });
      const ctx = bot._context(state);
      // K♠ only pairs into a KING SET, which is locked.
      expect(bot._kanoonPileMeldable(state, ctx, state.discardPile, state.yourHand)).to.equal(false);
    });

    it('after a take, lays a taken card before anything else', () => {
      const taken = c('7', 'hearts');
      const state = baseState({
        hasDrawnCard: true,
        yourHand: [c('5', 'hearts'), c('6', 'hearts'), c('Q', 'clubs'), c('J', 'diamonds'), c('4', 'spades'), taken],
        kanoonPileCardIds: [String(taken.cardId)],
      });
      const action = bot.decide(state);
      expect(action.type).to.equal('play_meld');
      expect(action.cards.map((x) => x.cardId)).to.include(taken.cardId);
    });
  });
});
