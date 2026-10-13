/**
 * QANOON — the 1v1 variant that rides on pro-direct.
 *
 * Owner's spec (2026-09-27):
 *   1. No SET of one rank (3-3-3, and the 2-2-2 set too) until the side owns a
 *      buraco — clean, semi or dirty, any run.
 *   2. Taking the discard pile obliges the taker to put at least ONE of the taken
 *      cards into a meld before discarding. Forgetting is not blocked; it costs
 *      the side 100 on the round.
 *      2026-10-10 relaxed it to "any meld of the turn"; 2026-10-13 withdrew
 *      that: the meld must hold a taken card again — or its TWIN, the same
 *      rank and suit already in hand (the shoe is two decks, the copies look
 *      the same).
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
const FailureManager = require('../../src/managers/FailureManager');
const SocketHandlers = require('../../src/handlers/SocketHandlers');

const c = (rank, suit) => new Card(suit, rank);
const run = (suit, ranks) => ranks.map((r) => c(r, suit));
const SPADE_BURACO = () => run('spades', ['4', '5', '6', '7', '8', '9', '10']);

function makeRoom({ seats = 2, qanoon = true } = {}) {
  const room = new GameRoom({ roomId: 'qanoon-room', maxPlayers: seats });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.setQanoon(qanoon);
  if (!qanoon) {
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

describe('#qanoon', () => {
  describe('the variant itself', () => {
    it('pins pro + direct when switched on', () => {
      const room = makeRoom();
      expect(room.ruleset).to.equal('professional');
      expect(room.professionalWellMode).to.equal('direct');
      expect(room.isQanoon()).to.equal(true);
    });

    it('is 1v1 only: a 4-seat room never plays it, whatever the flag says', () => {
      const room = makeRoom({ seats: 4 });
      expect(room.qanoon).to.equal(true);
      expect(room.isQanoon()).to.equal(false);
    });
  });

  describe('rule 1 — no set before a buraco', () => {
    const kings = () => [c('K', 'hearts'), c('K', 'diamonds'), c('K', 'clubs')];

    it('refuses a set while the side has no buraco', () => {
      const room = makeRoom();
      room.playerHands.set('p1', [...kings(), c('9', 'clubs')]);
      const res = GameValidator.validateMeld(room, 'p1', room.playerHands.get('p1').slice(0, 3));
      expect(res.isValid).to.equal(false);
      expect(res.reason).to.equal('qanoonSetLocked');
    });

    it('refuses the 2-2-2 set too', () => {
      const room = makeRoom();
      room.playerHands.set('p1', [c('2', 'hearts'), c('2', 'diamonds'), c('2', 'clubs'), c('9', 'clubs')]);
      const res = GameValidator.validateMeld(room, 'p1', room.playerHands.get('p1').slice(0, 3));
      expect(res.isValid).to.equal(false);
      expect(res.reason).to.equal('qanoonSetLocked');
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
      expect(res.reason).to.equal('qanoonSetLocked');
    });

    it('a going-down that lays a 7-card run unlocks the set travelling with it', () => {
      const room = makeRoom();
      const buraco = SPADE_BURACO();
      const set = kings();
      room.playerHands.set('p1', [...buraco, ...set, c('9', 'clubs')]);
      expect(GameValidator.validateGoingDown(room, 'p1', [buraco, set]).isValid).to.equal(true);
    });

    it('a set that is itself a buraco (7 cards, a 2 inside) is allowed while locked', () => {
      const room = makeRoom();
      const set = [
        c('K', 'diamonds'), c('K', 'spades'), c('K', 'clubs'), c('K', 'hearts'),
        c('K', 'diamonds'), c('2', 'diamonds'), c('K', 'clubs'),
      ];
      room.playerHands.set('p1', [...set, c('9', 'clubs'), c('A', 'hearts')]);
      const res = GameValidator.validateMeld(room, 'p1', set);
      expect(res.isValid, res.error).to.equal(true);
      expect(GameValidator.validateGoingDown(room, 'p1', [set]).isValid).to.equal(true);
    });

    it('a 6-card set is still locked', () => {
      const room = makeRoom();
      const set = [
        c('K', 'diamonds'), c('K', 'spades'), c('K', 'clubs'),
        c('K', 'hearts'), c('K', 'diamonds'), c('K', 'clubs'),
      ];
      room.playerHands.set('p1', [...set, c('9', 'clubs'), c('A', 'hearts')]);
      expect(GameValidator.validateMeld(room, 'p1', set).reason).to.equal('qanoonSetLocked');
    });

    it('a going-down with a short run + a set is refused', () => {
      const room = makeRoom();
      const short = run('spades', ['4', '5', '6']);
      const set = kings();
      room.playerHands.set('p1', [...short, ...set, c('9', 'clubs')]);
      const res = GameValidator.validateGoingDown(room, 'p1', [short, set]);
      expect(res.isValid).to.equal(false);
      expect(res.reason).to.equal('qanoonSetLocked');
    });

    it('plain pro-direct keeps sets open', () => {
      const room = makeRoom({ qanoon: false });
      room.playerHands.set('p1', [...kings(), c('9', 'clubs')]);
      expect(GameValidator.validateMeld(room, 'p1', room.playerHands.get('p1').slice(0, 3)).isValid).to.equal(true);
    });
  });

  describe('rule 2 — a pile take must reach a meld (a taken card, or its twin)', () => {
    /**
     * p1 has just taken a 2-card pile [7♥, 8♥]; hand also holds 5♥ 6♥ + junk
     * and a club run 9♣ 10♣ J♣ none of the taken cards belongs to.
     */
    const tookPile = (opts) => {
      const room = makeRoom(opts);
      const taken = [c('7', 'hearts'), c('8', 'hearts')];
      const hand = [
        c('5', 'hearts'), c('6', 'hearts'), c('K', 'clubs'), c('J', 'diamonds'), ...taken,
        c('9', 'clubs'), c('10', 'clubs'), c('J', 'clubs'),
      ];
      room.playerHands.set('p1', hand);
      room.qanoonPileTake = { playerId: 'p1', cardIds: taken.map((t) => String(t.cardId)) };
      return { room, taken, hand };
    };

    it('charges 100 when the turn ends with every taken card still in hand', () => {
      const { room, hand } = tookPile();
      const res = ActionHandlers.handleDiscard(room, 'p1', hand[2]);
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.deep.equal({
        value: -100,
        reason: 'pile_not_melded',
        playerIndex: 0,
        count: 1,
      });
      expect(room.teamTurnPenalty.get('p1')).to.equal(100);
      // …and the HUD/round board read it from the ledger they already use.
      expect(ActionHandlers.serializeTeamRoundState(room).teamTurnPenalty.teamA).to.equal(100);
      expect(room.qanoonPileTake).to.equal(null);
    });

    it('no charge once one taken card is in a meld', () => {
      const { room, hand } = tookPile();
      const meld = [hand[0], hand[1], hand[4]]; // 5♥ 6♥ 7♥ — 7♥ came off the pile
      const laid = ActionHandlers.handlePlayMeld(room, 'p1', meld);
      expect(laid.success, laid.error).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', room.playerHands.get('p1').find((x) => x.rank === 'K'));
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.equal(undefined);
      expect(room.teamTurnPenalty.get('p1')).to.equal(0);
    });

    // Owner, 2026-10-13: the 2026-10-10 relaxation ("ngemeld apapun ... ga
    // bakal kena minus") is withdrawn — a meld that holds neither a taken card
    // nor a twin of one is charged again.
    const clubsRun = (room) => room.playerHands.get('p1').filter((x) => x.suit === 'clubs' && x.rank !== 'K');
    const junkK = (room) => room.playerHands.get('p1').find((x) => x.rank === 'K');

    it('charges when the turn lays a new meld of cards that did NOT come off the pile', () => {
      const { room } = tookPile();
      const laid = ActionHandlers.handlePlayMeld(room, 'p1', clubsRun(room));
      expect(laid.success, laid.error).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', junkK(room));
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.include({ value: -100, count: 1 });
      expect(room.teamTurnPenalty.get('p1')).to.equal(100);
    });

    it('charges when the turn only ADDS a non-pile card — same rank, other suit is no twin', () => {
      const { room } = tookPile();
      room.playerMelds.set('p1', [run('diamonds', ['4', '5', '6'])]);
      const seven = c('7', 'diamonds'); // a 7 like the taken 7♥, but a diamond
      room.playerHands.get('p1').push(seven);
      const added = ActionHandlers.handleAddToMeld(room, 'p1', [seven], 0, 0);
      expect(added.success, added.error).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', junkK(room));
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.include({ value: -100, count: 1 });
    });

    /**
     * The owner's case (2026-10-13): the pile was A♥ J♥ K♥ and the hand already
     * held 10♥ J♥ Q♥ — two J♥ in hand now, one from each deck.
     */
    const tookTwinPile = () => {
      const room = makeRoom();
      const taken = [c('A', 'hearts'), c('J', 'hearts'), c('K', 'hearts')];
      const own = [c('10', 'hearts'), c('J', 'hearts'), c('Q', 'hearts')];
      const junk = [c('4', 'clubs'), c('9', 'diamonds')];
      room.playerHands.set('p1', [...own, ...junk, ...taken]);
      room.qanoonPileTake = { playerId: 'p1', cardIds: taken.map((t) => String(t.cardId)) };
      return { room, taken, own, junk };
    };

    it('no charge when the meld holds the TWIN of a taken card instead of the taken copy', () => {
      const { room, taken, own, junk } = tookTwinPile();
      const laid = ActionHandlers.handlePlayMeld(room, 'p1', own); // 10♥ J♥ Q♥, the J♥ from the hand
      expect(laid.success, laid.error).to.equal(true);
      // Every taken card, the pile's J♥ included, is still in hand.
      const handIds = room.playerHands.get('p1').map((x) => String(x.cardId));
      expect(taken.every((t) => handIds.includes(String(t.cardId)))).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', junk[0]);
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.equal(undefined);
      expect(room.teamTurnPenalty.get('p1')).to.equal(0);
      expect(room.qanoonChargeCounts.get('p1') || 0).to.equal(0);
    });

    it('no charge when the twin is ADDED to a meld already on the table', () => {
      const { room, own, junk } = tookTwinPile();
      room.playerMelds.set('p1', [run('hearts', ['8', '9', '10'])]);
      const added = ActionHandlers.handleAddToMeld(room, 'p1', [own[1]], 0, 0); // the hand's J♥
      expect(added.success, added.error).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', junk[0]);
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.equal(undefined);
    });

    it('melding the twin and throwing the taken copy is the same play as the other way round', () => {
      const { room, taken, own } = tookTwinPile();
      expect(ActionHandlers.handlePlayMeld(room, 'p1', own).success).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', taken[1]); // the pile's J♥ goes back
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.equal(undefined);
    });

    it('the same rank in another suit is not a twin', () => {
      const { room, junk } = tookTwinPile();
      const spades = [c('10', 'spades'), c('J', 'spades'), c('Q', 'spades')];
      room.playerHands.get('p1').push(...spades);
      expect(ActionHandlers.handlePlayMeld(room, 'p1', spades).success).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', junk[0]);
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.include({ value: -100, count: 1 });
    });

    it("a 2's twin counts like any other card's", () => {
      const room = makeRoom();
      const taken = [c('2', 'clubs'), c('K', 'spades')];
      const hearts = [c('5', 'hearts'), c('6', 'hearts'), c('2', 'clubs')]; // the hand's 2♣ stands in for the 7♥
      const junk = c('9', 'diamonds');
      room.playerHands.set('p1', [...hearts, junk, ...taken]);
      room.qanoonPileTake = { playerId: 'p1', cardIds: taken.map((t) => String(t.cardId)) };
      const laid = ActionHandlers.handlePlayMeld(room, 'p1', hearts);
      expect(laid.success, laid.error).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', junk);
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.equal(undefined);
    });

    it('a twin meld laid and then UNDONE does not count', () => {
      const { room, own, junk } = tookTwinPile();
      expect(ActionHandlers.handlePlayMeld(room, 'p1', own).success).to.equal(true);
      const undo = ActionHandlers.handleUndoMeld(room, 'p1');
      expect(undo.success, undo.error).to.equal(true);
      const res = ActionHandlers.handleDiscard(room, 'p1', junk[0]);
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.include({ value: -100, count: 1 });
      expect(room.teamTurnPenalty.get('p1')).to.equal(100);
    });

    it("a twin laid on the seat's PREVIOUS turn does not cover this turn's take", () => {
      const { room } = tookPile();
      // Turn 1: no take, the club run 9♣ 10♣ J♣ goes down, a discard.
      room.qanoonPileTake = null;
      expect(ActionHandlers.handlePlayMeld(room, 'p1', clubsRun(room)).success).to.equal(true);
      expect(ActionHandlers.handleDiscard(room, 'p1', room.playerHands.get('p1').find((x) => x.rank === 'J')).success)
        .to.equal(true);
      // p2 passes the turn back.
      room.playerHands.set('p2', [c('3', 'spades'), c('4', 'clubs')]);
      room.hasDrawnCard = true;
      expect(ActionHandlers.handleDiscard(room, 'p2', room.playerHands.get('p2')[0]).success).to.equal(true);
      // Turn 2: p1 takes a pile holding the twin of last turn's 10♣ and lays nothing.
      const taken = [c('10', 'clubs'), c('Q', 'hearts')];
      room.playerHands.get('p1').push(...taken);
      room.qanoonPileTake = { playerId: 'p1', cardIds: taken.map((t) => String(t.cardId)) };
      room.hasDrawnCard = true;
      const res = ActionHandlers.handleDiscard(room, 'p1', junkK(room));
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.include({ value: -100, count: 1 });
    });

    it('a server restart mid-turn keeps the twin meld counted', async () => {
      const { room, own, junk } = tookTwinPile();
      expect(ActionHandlers.handlePlayMeld(room, 'p1', own).success).to.equal(true);
      let persisted = null;
      const noop = () => {};
      const manager = new FailureManager(
        null,
        { setex: (key, ttl, json) => { persisted = json; } },
        null,
        { debug: noop, info: noop, warn: noop, error: noop }
      );
      await manager.persistGameState(room);
      const rebuilt = manager._reconstructGameRoom(JSON.parse(persisted));
      // The take and the variant came back, so the judge really runs below.
      expect(rebuilt.isQanoon()).to.equal(true);
      expect(rebuilt.qanoonPileTake.cardIds).to.have.length(3);
      const thrown = rebuilt.playerHands.get('p1').find((x) => String(x.cardId) === String(junk[0].cardId));
      const res = ActionHandlers.handleDiscard(rebuilt, 'p1', thrown);
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.equal(undefined);
    });

    it('a room restored with an empty turn ledger still sees the taken card that left the hand', () => {
      const { room, hand } = tookPile();
      expect(ActionHandlers.handlePlayMeld(room, 'p1', [hand[0], hand[1], hand[4]]).success).to.equal(true);
      room.turnMeldedCards = new Map(); // a snapshot from before the ledger was persisted
      const res = ActionHandlers.handleDiscard(room, 'p1', junkK(room));
      expect(res.success, res.error).to.equal(true);
      expect(res.broadcast.qanoonPenalty).to.equal(undefined);
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
      const { room, hand } = tookPile({ qanoon: false });
      ActionHandlers.handleDiscard(room, 'p1', hand[2]);
      expect(room.teamTurnPenalty.get('p1')).to.equal(0);
    });

    it('the obligation dies with the turn', () => {
      const { room } = tookPile();
      room.nextTurn();
      expect(room.qanoonPileTake).to.equal(null);
    });
  });

  describe('rule 2 — the charge escalates (owner, 2026-10-07)', () => {
    /**
     * One offence by [seat]: it took a 2-card pile it cannot use and throws a
     * junk card. Returns the broadcast's qanoonPenalty.
     */
    const offend = (room, seat = 'p1') => {
      const taken = [c('7', 'hearts'), c('8', 'hearts')];
      const junk = c('K', 'clubs');
      room.playerHands.set(seat, [junk, c('J', 'diamonds'), ...taken]);
      room.qanoonPileTake = { playerId: seat, cardIds: taken.map((t) => String(t.cardId)) };
      room.currentTurn = room.getPlayer(seat).playerIndex;
      room.hasDrawnCard = true;
      const res = ActionHandlers.handleDiscard(room, seat, junk);
      expect(res.success, res.error).to.equal(true);
      return res.broadcast.qanoonPenalty;
    };

    it('the 1st charge is 100, the 2nd 200, the 3rd 300 — and the round total adds them up', () => {
      const room = makeRoom();
      expect(offend(room)).to.include({ value: -100, count: 1 });
      expect(offend(room)).to.include({ value: -200, count: 2 });
      expect(offend(room)).to.include({ value: -300, count: 3 });
      expect(room.teamTurnPenalty.get('p1')).to.equal(600);
      expect(ActionHandlers._computeScores(room, null, null).teamScores.teamA.turnPenalty).to.equal(600);
    });

    it('qanoonPileChargeFor is count × 100, never below one step', () => {
      expect(ActionHandlers.qanoonPileChargeFor(1)).to.equal(100);
      expect(ActionHandlers.qanoonPileChargeFor(4)).to.equal(400);
      expect(ActionHandlers.qanoonPileChargeFor(0)).to.equal(100);
      expect(ActionHandlers.qanoonPileChargeFor(undefined)).to.equal(100);
    });

    it('each seat has its own count', () => {
      const room = makeRoom();
      offend(room, 'p1');
      offend(room, 'p1');
      expect(offend(room, 'p2')).to.include({ value: -100, count: 1, playerIndex: 1 });
      expect(room.teamTurnPenalty.get('p2')).to.equal(100);
    });

    it('a clean turn in between does not reset it', () => {
      const room = makeRoom();
      offend(room);
      room.currentTurn = 0;
      room.hasDrawnCard = true;
      room.playerHands.set('p1', [c('K', 'clubs'), c('J', 'diamonds')]);
      expect(ActionHandlers.handleDiscard(room, 'p1', room.playerHands.get('p1')[0]).success).to.equal(true);
      expect(offend(room)).to.include({ value: -200, count: 2 });
    });

    it('is match-long: a new round keeps counting while its round total starts at 0', () => {
      const room = makeRoom();
      offend(room);
      offend(room);
      room.startGame(); // the per-round reset
      expect(room.teamTurnPenalty.get('p1')).to.equal(0);
      expect(offend(room)).to.include({ value: -300, count: 3 });
      expect(room.teamTurnPenalty.get('p1')).to.equal(300);
    });

    it('survives a restart: the persisted room keeps the count', async () => {
      const room = makeRoom();
      offend(room);
      offend(room);
      let persisted = null;
      const noop = () => {};
      const manager = new FailureManager(
        null,
        { setex: (key, ttl, json) => { persisted = json; } },
        null,
        { debug: noop, info: noop, warn: noop, error: noop }
      );
      await manager.persistGameState(room);
      const rebuilt = manager._reconstructGameRoom(JSON.parse(persisted));
      expect(rebuilt.qanoonChargeCounts.get('p1')).to.equal(2);
      // …and a snapshot from before the counter existed starts it at nothing.
      const legacy = manager._reconstructGameRoom({ roomId: 'legacy', maxPlayers: 2 });
      expect(legacy.qanoonChargeCounts.size).to.equal(0);
    });

    it('a room restored without the map still charges (and starts it)', () => {
      const room = makeRoom();
      delete room.qanoonChargeCounts;
      expect(offend(room)).to.include({ value: -100, count: 1 });
      expect(room.qanoonChargeCounts.get('p1')).to.equal(1);
    });

    it('every state frame carries the counts by seat, so the next charge is known after a reconnect', () => {
      const room = makeRoom();
      offend(room, 'p1');
      offend(room, 'p1');
      offend(room, 'p2');
      expect(ActionHandlers.serializeQanoonCharges(room)).to.deep.equal({ 0: 2, 1: 1 });

      const handlers = Object.create(SocketHandlers.prototype);
      handlers._nextRoundDelayMs = () => 0;
      expect(handlers._serializeRoomGameSettings(room).qanoonCharges).to.deep.equal({ 0: 2, 1: 1 });

      const plain = makeRoom({ qanoon: false });
      expect(handlers._serializeRoomGameSettings(plain).qanoonCharges).to.equal(null);
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
      qanoon: true,
      playerMelds: { 0: [], 1: [] },
      meldFlags: {},
      discardPile: [],
      yourHand: [],
      ...over,
    });

    it('never opens a set while locked', () => {
      const ctx = bot._context(baseState());
      expect(ctx.qanoonSetsLocked).to.equal(true);
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
      expect(bot._qanoonPileMeldable(state, ctx, state.discardPile, state.yourHand)).to.equal(false);
    });

    it('dead stock: declines a 2+ pile it could not meld (the take is a sure -100)', () => {
      const state = baseState({
        hasDrawnCard: false,
        deckCount: 0,
        pozzettosAvailable: false,
        deadPileCounts: [],
        yourHand: [c('K', 'hearts'), c('4', 'clubs'), c('7', 'diamonds')],
        // K♠ only pairs into a (locked) king set; 9♦ needs the missing 8♦.
        discardPile: [c('K', 'spades'), c('9', 'diamonds')],
      });
      expect(bot.decide(state).type).to.not.equal('pick_up_pile');
      // Plain pro-direct keeps taking it: on a dead stock it is the continuation.
      expect(bot.decide({ ...state, qanoon: false }).type).to.equal('pick_up_pile');
    });

    it('judges the pile on the hand AFTER the take: a placement that strands it does not count', () => {
      // Hand [Q♣] + pile [8♥]: the 8♥ legally extends 5♥-6♥-7♥, but that leaves
      // Q♣ alone and direct never closes on a discard — the placement would be
      // refused, the take a sure charge.
      const run567 = run('hearts', ['5', '6', '7']);
      const state = baseState({
        hasDrawnCard: false,
        deckCount: 30,
        pozzettosAvailable: true,
        deadPileCounts: [11, 11],
        playerMelds: { 0: [run567], 1: [] },
        yourHand: [c('Q', 'clubs')],
        discardPile: [c('8', 'hearts')],
      });
      const ctx = bot._context(state);
      expect(bot._qanoonPileMeldable(state, ctx, state.discardPile, state.yourHand)).to.equal(false);
      // With a second card in hand the same placement is safe.
      const roomier = { ...state, yourHand: [c('Q', 'clubs'), c('J', 'diamonds')] };
      expect(
        bot._qanoonPileMeldable(roomier, bot._context(roomier), roomier.discardPile, roomier.yourHand)
      ).to.equal(true);
    });

    it('after a take, lays a taken card before anything else', () => {
      const taken = c('7', 'hearts');
      const state = baseState({
        hasDrawnCard: true,
        yourHand: [c('5', 'hearts'), c('6', 'hearts'), c('Q', 'clubs'), c('J', 'diamonds'), c('4', 'spades'), taken],
        qanoonPileCardIds: [String(taken.cardId)],
      });
      const action = bot.decide(state);
      expect(action.type).to.equal('play_meld');
      expect(action.cards.map((x) => x.cardId)).to.include(taken.cardId);
    });
  });
});
