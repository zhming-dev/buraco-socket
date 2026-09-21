/**
 * ANTI PING-PONG discard lock — server half.
 *
 * The bug: two players volley one card forever. P1 throws K♥, P2 takes the pile
 * for it, P2 throws K♥ straight back, P1 takes the pile for it, on and on —
 * neither melds, the round never progresses.
 *
 * The rule: taking the pile locks THAT CARD INSTANCE for the taker, for two of
 * the taker's turn ENDS (the take turn plus the next one), or until they meld.
 *
 * TWO THINGS IT IS NOT, both of which it WAS and both of which shipped as "one
 * card type is stuck forever":
 *
 *   * NOT rank+suit. The shoe is two decks, so a rank+suit lock also froze the
 *     twin, including a twin drawn from the stock turns after the take.
 *   * NOT open-ended. It used to die only on a meld or a new round, so a taker
 *     who simply never melded carried it for the whole round.
 *
 * RULE A (product owner, 2026-09-02) narrows one of those back on purpose, and
 * a future reader must not "restore" the old assertions: on a take of EXACTLY
 * ONE card the lock ALSO takes in every copy of that rank+suit ALREADY IN HAND
 * when the card lands. That is not the old bug returning. The old bug froze the
 * family on EVERY take, forever, including copies drawn from the stock long
 * afterwards. RULE A recruits a twin only on a LONE-card take, only what was
 * already held, and the very next deck draw (RULE C) or multi-card take (RULE
 * B) releases it. It closes a real hole: without it you take the 8H off the
 * pile and throw your OWN 8H, and the opponent watches the identical card come
 * straight back — the volley the whole file exists to stop.
 *
 * The other two rules, same date, same product call:
 *   * RULE B — a take of TWO OR MORE locks NOTHING and RELEASES everything.
 *   * RULE C — a DECK DRAW, manual or timeout auto-draw, locks nothing and
 *     releases everything. This is the product call on the divergence the notes
 *     carried as unresolved (the timeout draw used to restrict, the manual draw
 *     did not).
 *
 * The ESCAPE HATCH keeps it from wedging a turn: the lock yields the moment no
 * OTHER card in hand is discardable. Every "still has a legal discard" assertion
 * below is guarding that.
 *
 * The Flutter client mirrors all of it in GameController._pingPongBlocks. If the
 * two predicates ever disagree the turn HANGS — the client offers a discard the
 * server rejects, or refuses one the server would take. That class of bug has
 * shipped here before, so the parity cases are pinned explicitly.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const BotStrategy = require('../../src/bots/BotStrategy');
const GameService = require('../../src/services/GameService');
const { GameRoom } = require('../../src/models');
const { DISCARD_LOCK_TURNS } = require('../../src/models/GameRoom');
// Real Card instances (auto-assigned cardId) everywhere the lock is involved:
// the rule binds an INSTANCE, so a plain {suit, rank} literal has no identity to
// bind and the predicate would (correctly) refuse to block anything.
const { Card } = require('../../src/models/Deck');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank) => new Card(suit, rank);
const KH = () => card('hearts', 'K');

/** The stored lock shape, for deep-equal assertions. */
/** The stored lock shape. `cards` is every copy the lock holds, in take order. */
const lockFor = (...args) => {
  const trailing = typeof args[args.length - 1] === 'number' ? args.pop() : DISCARD_LOCK_TURNS;
  const cards = args;
  const newest = cards[cards.length - 1];
  return {
    cardId: newest.cardId,
    cardIds: cards.map((c) => c.cardId),
    suit: newest.suit,
    rank: newest.rank,
    turnsLeft: trailing,
  };
};

/** Minimal seated room; no deal, so the test owns every hand. */
function makeRoom({ seats = 2 } = {}) {
  const room = new GameRoom({ roomId: 'ping-pong-room', maxPlayers: seats });
  room.status = GameRoomStatus.IN_PROGRESS;
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
  }
  return room;
}

function fakeIo(reg) {
  return { to: () => ({ emit: () => {} }), sockets: { sockets: reg } };
}
function fakeSocket(id, emitted) {
  return {
    id,
    emit: (event, payload) => emitted.push({ event, payload }),
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
  };
}

/**
 * Drop every copy of `proto`'s rank+suit from a seat's hand.
 *
 * liveRoom() deals from a real shuffled shoe, so a seat may already hold a twin
 * of whatever synthetic card a test pushes onto the discard pile. Since RULE A
 * (2026-09-02) a lone-card take recruits those twins into the lock, which would
 * make an exact `lockFor(top)` assertion depend on the shuffle. Tests that pin
 * the lock's IDENTITY purge first; the twin behaviour has its own tests below.
 */
function purgeTwins(room, playerId, proto) {
  const hand = room.playerHands.get(playerId) || [];
  room.playerHands.set(
    playerId,
    hand.filter((c) => !(c.suit === proto.suit && c.rank === proto.rank))
  );
}

/** A real dealt room driven through the actual socket handlers. */
function liveRoom() {
  const service = new GameService();
  const room = service.createRoom('pingpong', 2);
  service.joinRoom('pingpong', 'p1', 'P1', 's1');
  service.joinRoom('pingpong', 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  room.hasDrawnCard = false;
  const reg = new Map();
  const emitted = [];
  reg.set('s1', fakeSocket('s1', emitted));
  reg.set('s2', fakeSocket('s2', emitted));
  const handlers = new SocketHandlers(fakeIo(reg), service);
  handlers._stopTurnTimer(room);
  return { service, room, handlers, emitted, s1: reg.get('s1'), s2: reg.get('s2') };
}

describe('#anti ping-pong discard lock', () => {
  describe('the volley the rule exists to stop', () => {
    it('take the pile, pass, and the card still cannot go back next turn', () => {
      const room = makeRoom();
      const kh = KH(); // the card U1 throws and U2 takes
      const filler = card('spades', '4');

      // --- U1 discarded K♥; U2 takes the pile for it.
      room.discardPile = [kh];
      room.playerHands.set('p2', [filler, card('clubs', '8')]);
      room.currentTurn = 1;
      room.hasDrawnCard = false;

      const picked = room.discardPile.slice();
      const res = ActionHandlers.handlePickUpPile(room, 'p2', picked);
      expect(res.success).to.equal(true);
      // The handler validates; SocketHandlers owns the state mutation, so mirror
      // the lines that matter here.
      room.playerHands.get('p2').push(...picked);
      room.discardPile = [];
      room.hasDrawnCard = true;
      room.armDiscardLock('p2', kh);

      // Throwing it straight back is exactly the move the rule forbids.
      const blocked = GameValidator.validateDiscard(room, 'p2', kh);
      expect(blocked.isValid).to.equal(false);
      expect(blocked.reason).to.equal('pingPongLocked');
      // ...but the turn is not wedged.
      expect(GameValidator.validateDiscard(room, 'p2', filler).isValid).to.equal(true);

      // --- U2 throws the filler instead. The lock must SURVIVE the boundary, or
      //     the volley just moves one turn later.
      room.playerHands.set(
        'p2',
        room.playerHands.get('p2').filter((c) => c !== filler)
      );
      room.discardPile = [filler];
      room.nextTurn();
      expect(room.discardLocks.get('p2')).to.deep.equal(lockFor(kh, 1));

      // --- Back around to U2. Still cannot throw it back.
      room.currentTurn = 1;
      room.hasDrawnCard = true;
      room.playerHands.set('p2', [kh, card('clubs', '8')]);
      const stillBlocked = GameValidator.validateDiscard(room, 'p2', kh);
      expect(stillBlocked.isValid).to.equal(false);
      expect(stillBlocked.reason).to.equal('pingPongLocked');
      expect(GameValidator.validateDiscard(room, 'p2', room.playerHands.get('p2')[1]).isValid).to.equal(
        true
      );
    });

    it('pick_up_pile arms the lock on the real handler path', () => {
      const { service, room, handlers, s1 } = liveRoom();
      const top = room.discardPile[room.discardPile.length - 1];
      purgeTwins(room, 'p1', top); // RULE A: a dealt twin would join the lock

      handlers.handlePickUpPile(s1, {});

      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(top));
      expect(room.discardLocks.has('p2')).to.equal(false);
      service.deleteRoom('pingpong');
    });

    it('a MULTI-card take RELEASES the lock an earlier take left behind', () => {
      // REPORTED LIVE: "I take more than one card off the pile and the card that
      // ends up blocked is an OLD one, sitting first in my hand."
      //
      // The lock outlives its take turn by design, so it is still live on the
      // taker's NEXT turn. Taking again used to leave it standing whenever the
      // new take was multi-card: arming is gated on a single-card take, and
      // nothing on the multi-card path released what the previous take armed. The
      // taker was left blocked on a card with nothing to do with the pile they
      // just took. A take now REPLACES the previous take's lock — one lock per
      // player, owned by the most recent take.
      const { service, room, handlers, s1 } = liveRoom();

      // --- Turn N: a ONE-card take arms the lock.
      const firstTake = KH();
      purgeTwins(room, 'p1', firstTake); // RULE A: pin the lock's identity
      room.discardPile = [firstTake];
      handlers.handlePickUpPile(s1, {});
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(firstTake));

      // --- Round the table once. The lock survives the boundary, as designed.
      room.nextTurn(); // p1's turn ends → turnsLeft 1
      room.nextTurn(); // p2's turn ends → back to p1, still locked
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(firstTake, 1));
      expect(room.currentTurn).to.equal(0);

      // --- Turn N+1: the pile is TWO cards deep and p1 takes it again.
      room.hasDrawnCard = false;
      room.discardPile = [card('spades', '4'), card('diamonds', '7')];
      handlers.handlePickUpPile(s1, {});

      expect(room.discardLocks.has('p1'), 'the new take replaces the old lock').to.equal(false);
      expect(
        GameValidator.validateDiscard(room, 'p1', firstTake).isValid,
        'the stale lock must not block a card from the LAST take'
      ).to.equal(true);
      service.deleteRoom('pingpong');
    });

    it('RULE B: a MULTI-card take locks NOTHING — not even the top card', () => {
      // TWO RULES, TWO LIFETIMES, and this test pins the seam between them.
      //
      // The CROSS-TURN lock needs the pile to come back EXACTLY as it was: take
      // the lone card, throw it straight back, keep whatever you gained, repeat.
      // Take two or more and throwing the top one back leaves a SMALLER pile and
      // costs you a card — there is nothing to repeat, so no lock is armed.
      //
      // HISTORY, so nobody flips this a third time. Before 2026-09-01 this test
      // asserted "the top card can go straight back" and the per-turn
      // restriction was gated on a lone-card take. On 2026-09-01 it was reversed
      // to fire on EVERY take size. On 2026-09-02 the product owner stated the
      // rule outright — "kalo ada lebih dari 1 discarded pile, boleh dibuang dan
      // unlock semua discarded lock" — and the 09-01 reversal is reverted: a
      // multi-card take locks NOTHING and RELEASES everything. The stricter
      // same-turn restriction now belongs to the LONE-card take alone (RULE A),
      // which is the only shape that has a volley to police.
      const { service, room, handlers, s1 } = liveRoom();
      const top = KH();
      const alsoTaken = card('spades', '4');
      room.discardPile = [alsoTaken, top];

      handlers.handlePickUpPile(s1, {});

      expect(room.discardLocks.has('p1'), 'no lock from a multi-card take').to.equal(false);
      expect(
        room.drawnCardThisTurnRestriction.size,
        'RULE B: a multi-card take restricts nothing at all'
      ).to.equal(0);
      expect(
        GameValidator.validateDiscard(room, 'p1', top).isValid,
        'RULE B: the top card of a multi-card take may be thrown straight back'
      ).to.equal(true);
      expect(
        GameValidator.validateDiscard(room, 'p1', alsoTaken).isValid,
        'the rest of the pile came along for the ride and stays discardable'
      ).to.equal(true);
      service.deleteRoom('pingpong');
    });

    it('RULE B: a multi-card take always leaves a legal discard', () => {
      // The wedge check. NOTHING is restricted after a multi-card take, so every
      // card in hand is throwable — a strictly stronger guarantee than the
      // hand.length - 1 this asserted while the 2026-09-01 hoist was in place.
      const { service, room, handlers, s1 } = liveRoom();
      room.discardPile = [card('spades', '4'), KH()];

      handlers.handlePickUpPile(s1, {});

      const hand = room.playerHands.get('p1');
      const legal = hand.filter((c) => GameValidator.validateDiscard(room, 'p1', c).isValid);
      expect(hand.length).to.be.greaterThan(1);
      expect(legal.length, 'the turn cannot wedge').to.equal(hand.length);
      service.deleteRoom('pingpong');
    });

    it('RULE A: the LONE-take restriction SURVIVES a meld, and dies at the turn boundary', () => {
      // Re-pointed at a ONE-card take on 2026-09-02: under RULE B there is no
      // multi-take restriction left. RULE CHANGE 2026-09-21 (owner): a meld no
      // longer lifts it either — "keep it this turn" is the whole rule now.
      const { service, room, handlers, s1 } = liveRoom();
      const top = KH();
      purgeTwins(room, 'p1', top);
      room.discardPile = [top];
      handlers.handlePickUpPile(s1, {});
      expect(GameValidator.validateDiscard(room, 'p1', top).isValid).to.equal(false);

      // A meld this turn changes nothing about it. `meldedThisTurn` is what a
      // real meld sets (ActionHandlers.handlePlayMeld); the validator must not
      // read it as a release any more.
      room.meldedThisTurn = true;
      expect(
        GameValidator.validateDiscard(room, 'p1', top).reason,
        'the per-turn restriction is still the reason after a meld'
      ).to.equal('drawnCardRestriction');
      // Even with the cross-turn lock gone, the per-turn half holds on its own.
      room.clearDiscardLock('p1');
      expect(
        GameValidator.validateDiscard(room, 'p1', top).isValid,
        'melding this turn does not release the taken card'
      ).to.equal(false);

      // It is per-TURN: nextTurn() wipes the set outright.
      room.meldedThisTurn = false;
      room.nextTurn();
      expect(room.drawnCardThisTurnRestriction.size, 'wiped at the boundary').to.equal(0);
      service.deleteRoom('pingpong');
    });

    it('taking again MOVES the lock instead of stacking a second one', () => {
      const { service, room, handlers, s1 } = liveRoom();
      const first = card('spades', '4');
      const second = card('diamonds', '7');
      purgeTwins(room, 'p1', first); // RULE A: pin the lock's identity
      purgeTwins(room, 'p1', second);
      room.discardPile = [first];
      handlers.handlePickUpPile(s1, {});
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(first));

      room.hasDrawnCard = false;
      room.discardPile = [second];
      handlers.handlePickUpPile(s1, {});

      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(second));
      service.deleteRoom('pingpong');
    });
  });

  describe('it binds ONE CARD, not a rank+suit', () => {
    it('the twin from the other deck is free', () => {
      // The reported bug: after taking the pile for a K♥, BOTH K♥ in the shoe
      // were frozen — including one that never touched the pile.
      const room = makeRoom();
      const taken = KH();
      const twin = KH();
      room.playerHands.set('p1', [taken, twin, card('clubs', '8')]);
      room.armDiscardLock('p1', taken);

      const blocked = GameValidator.validateDiscard(room, 'p1', taken);
      expect(blocked.isValid).to.equal(false);
      expect(blocked.reason).to.equal('pingPongLocked');
      expect(
        GameValidator.validateDiscard(room, 'p1', twin).isValid,
        "the other deck's K♥ has nothing to do with this take"
      ).to.equal(true);
    });

    it('a lock with no usable cardId binds nothing', () => {
      // Rather than falling back to rank+suit, which is what froze the twin.
      const room = makeRoom();
      const kh = KH();
      room.playerHands.set('p1', [kh, card('spades', '4')]);
      room.discardLocks.set('p1', { suit: 'hearts', rank: 'K', turnsLeft: 2 });

      expect(GameValidator._pingPongBlocks(room, 'p1', kh, room.playerHands.get('p1'))).to.equal(
        false
      );
    });
  });

  describe('the lock EXPIRES on its own', () => {
    it('two of the taker\'s turn ends and it is gone, with no meld anywhere', () => {
      // The whole point of the change: a player who never melds is not locked
      // out of a card for the rest of the round.
      const room = makeRoom();
      const taken = KH();
      room.armDiscardLock('p1', taken);
      expect(room.discardLocks.get('p1').turnsLeft).to.equal(DISCARD_LOCK_TURNS);

      room.currentTurn = 0;
      room.nextTurn(); // end of the take turn
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(taken, 1), 'still locked');

      room.currentTurn = 0;
      room.nextTurn(); // end of the seat's NEXT turn
      expect(
        room.discardLocks.has('p1'),
        'the lock expires; it is not a life sentence'
      ).to.equal(false);

      room.currentTurn = 0;
      room.playerHands.set('p1', [taken, card('spades', '4')]);
      room.hasDrawnCard = true;
      expect(GameValidator.validateDiscard(room, 'p1', taken).isValid).to.equal(true);
    });

    it('only the OUTGOING seat ticks on a turn change', () => {
      const room = makeRoom({ seats: 4 });
      const a = KH();
      const b = card('spades', '4');
      room.armDiscardLock('p2', a);
      room.armDiscardLock('p3', b);

      room.currentTurn = 1; // p2 is to act
      room.nextTurn();

      expect(room.discardLocks.get('p2')).to.deep.equal(lockFor(a, 1), 'p2 acted');
      expect(
        room.discardLocks.get('p3'),
        'p3 has not had a turn end yet'
      ).to.deep.equal(lockFor(b, DISCARD_LOCK_TURNS));
    });

    it('an already-expired lock blocks nothing', () => {
      const room = makeRoom();
      const kh = KH();
      room.playerHands.set('p1', [kh, card('spades', '4')]);
      room.discardLocks.set('p1', { ...lockFor(kh), turnsLeft: 0 });

      expect(GameValidator._pingPongBlocks(room, 'p1', kh, room.playerHands.get('p1'))).to.equal(
        false
      );
    });
  });

  describe('the escape hatch', () => {
    it('a hand of nothing but the locked card: the lock yields', () => {
      // No other card to throw, so the lock must stand down or every discard is
      // rejected and the turn wedges.
      const room = makeRoom();
      const locked = KH();
      room.playerHands.set('p1', [locked]);
      room.armDiscardLock('p1', locked);
      room.deadPiles = [];

      expect(GameValidator.validateDiscard(room, 'p1', locked).reason).to.not.equal(
        'pingPongLocked'
      );
    });

    it('add ONE different card and the hatch shuts again', () => {
      const room = makeRoom();
      const locked = KH();
      const free = card('spades', '4');
      room.playerHands.set('p1', [locked, free]);
      room.armDiscardLock('p1', locked);

      const res = GameValidator.validateDiscard(room, 'p1', locked);
      expect(res.isValid).to.equal(false);
      expect(res.reason).to.equal('pingPongLocked');
      expect(GameValidator.validateDiscard(room, 'p1', free).isValid).to.equal(true);
    });

    it('the hatch opens when the only other card is itself drawn-restricted', () => {
      // Otherwise the two rules combine into a hand with no legal discard at all.
      const room = makeRoom();
      const locked = KH();
      const justDrawn = card('spades', '4');
      room.playerHands.set('p1', [locked, justDrawn]);
      room.armDiscardLock('p1', locked);
      room.drawnCardThisTurnRestriction.add(String(justDrawn.cardId));
      room.meldedThisTurn = false;

      expect(GameValidator.validateDiscard(room, 'p1', justDrawn).reason).to.equal(
        'drawnCardRestriction'
      );
      expect(
        GameValidator.validateDiscard(room, 'p1', locked).isValid,
        'lock + drawn-card restriction must never combine into a wedge'
      ).to.equal(true);
    });

    it('the LOCK never takes away the last discardable card', () => {
      // Probed against the lock predicate alone, not validateDiscard: the close
      // requirements may legitimately refuse a one-card hand, and that is a
      // different rule. What must hold is that the LOCK never contributes the
      // final "no". The locked card is always hand[0].
      const shapes = {
        'locked + twin': () => [KH(), KH()],
        'locked + free': () => [KH(), card('spades', '4')],
        'locked + wild': () => [KH(), card('clubs', '2')],
        'single locked': () => [KH()],
        'locked + drawn-restricted': () => [KH(), card('spades', '4')],
      };
      Object.entries(shapes).forEach(([name, build]) => {
        const room = makeRoom();
        const hand = build();
        room.playerHands.set('p1', hand);
        room.armDiscardLock('p1', hand[0]);
        if (name === 'locked + drawn-restricted') {
          room.drawnCardThisTurnRestriction.add(String(hand[1].cardId));
        }
        const anyUnlocked = hand.some((c) => !GameValidator._pingPongBlocks(room, 'p1', c, hand));
        expect(anyUnlocked, `hand shape "${name}" was locked out of every card`).to.equal(true);
      });
    });

    it('a multi-card hand with a lock always has a fully legal discard', () => {
      // Two or more cards can never be a closing discard, so here the full
      // validator must agree — no wedge is possible.
      const shapes = {
        'locked + twin': () => [KH(), KH()],
        'locked + free': () => [KH(), card('spades', '4')],
        'locked + wild': () => [KH(), card('clubs', '2')],
      };
      Object.entries(shapes).forEach(([name, build]) => {
        const room = makeRoom();
        const hand = build();
        room.playerHands.set('p1', hand);
        room.armDiscardLock('p1', hand[0]);
        const anyLegal = hand.some((c) => GameValidator.validateDiscard(room, 'p1', c).isValid);
        expect(anyLegal, `hand shape "${name}" left the turn with no legal discard`).to.equal(true);
      });
    });
  });

  // THE TWO-DECK VOLLEY, reported live: the opponent throws 5♥, the taker picks
  // it up; the taker throws something else, the opponent takes it and then throws
  // the OTHER 5♥, which the taker also picks up. A one-instance lock moved to the
  // second copy and set the first free to go straight back — the same infinite
  // volley, running on two cards. The lock is a SET and a further single-card
  // take of the same rank+suit JOINS it.
  describe('the same card taken twice locks BOTH copies', () => {
    it('the second take ADDS to the lock instead of moving it', () => {
      const { service, room, handlers, s1 } = liveRoom();
      const fiveA = card('hearts', '5');
      const fiveB = card('hearts', '5'); // the other deck's copy

      // RULE A: a twin dealt into p1's hand would join the lock and make this
      // identity assertion depend on the shuffle. Twin behaviour is tested below.
      purgeTwins(room, 'p1', fiveA);
      room.discardPile = [fiveA];
      handlers.handlePickUpPile(s1, {});
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(fiveA));

      // Round the table for real: the per-turn restriction clears on the
      // boundary, so what still blocks the first copy is the LOCK and nothing
      // else. The taker never draws — it keeps feeding off the pile.
      room.nextTurn();
      room.nextTurn();
      expect(room.currentTurn).to.equal(0);
      room.hasDrawnCard = false;
      room.discardPile = [fiveB];
      handlers.handlePickUpPile(s1, {});

      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(fiveA, fiveB));
      const hand = room.playerHands.get('p1');
      expect(
        GameValidator.validateDiscard(room, 'p1', fiveA).reason,
        'the copy taken FIRST is still held'
      ).to.equal('pingPongLocked');
      expect(
        hand.some((c) => GameValidator.validateDiscard(room, 'p1', c).isValid),
        'and the turn is not wedged'
      ).to.equal(true);
      service.deleteRoom('pingpong');
    });

    it('survives the OPPONENT taking the pile in between', () => {
      // The reported sequence, with the wrinkle a hand-built fixture skips: the
      // opponent picks the pile up between my two takes, which arms THEIR lock.
      // Mine must be untouched by that — the lock binds the taker, not the pile.
      const { service, room, handlers, s1, s2 } = liveRoom();
      const j1 = card('clubs', 'J');
      const j2 = card('clubs', 'J');

      // RULE A: a twin dealt into p1's hand would join the lock and make this
      // identity assertion depend on the shuffle. Twin behaviour is tested below.
      purgeTwins(room, 'p1', j1);

      // I take the first J♣.
      room.discardPile = [j1];
      handlers.handlePickUpPile(s1, {});
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(j1));

      // My turn ends; the opponent takes the card I threw, then throws the
      // second J♣.
      room.nextTurn();
      room.hasDrawnCard = false;
      room.discardPile = [card('diamonds', '6')];
      handlers.handlePickUpPile(s2, {});
      expect(room.discardLocks.has('p2'), "the opponent has a lock of their own").to.equal(true);
      room.nextTurn();
      room.hasDrawnCard = false;
      room.discardPile = [j2];

      // I take the second J♣.
      handlers.handlePickUpPile(s1, {});

      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(j1, j2));
      expect(
        GameValidator.validateDiscard(room, 'p1', j1).reason,
        'the FIRST J♣ used to go straight back — that was the bug'
      ).to.equal('pingPongLocked');
      expect(
        GameValidator.validateDiscard(room, 'p1', j2).isValid,
        'and the one just taken is blocked too'
      ).to.equal(false);
      service.deleteRoom('pingpong');
    });

    it('a DIFFERENT single card replaces the set instead of joining it', () => {
      const { service, room, handlers, s1 } = liveRoom();
      const five = card('hearts', '5');
      const seven = card('diamonds', '7');

      // RULE A: a twin dealt into p1's hand would join the lock and make this
      // identity assertion depend on the shuffle. Twin behaviour is tested below.
      purgeTwins(room, 'p1', five);
      purgeTwins(room, 'p1', seven);
      room.discardPile = [five];
      handlers.handlePickUpPile(s1, {});
      room.nextTurn();
      room.nextTurn();
      room.hasDrawnCard = false;
      room.discardPile = [seven];
      handlers.handlePickUpPile(s1, {});

      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(seven));
      expect(GameValidator.validateDiscard(room, 'p1', five).isValid).to.equal(true);
      service.deleteRoom('pingpong');
    });

    it('a MULTI-card take releases both copies and locks nothing', () => {
      const { service, room, handlers, s1 } = liveRoom();
      const fiveA = card('hearts', '5');
      const fiveB = card('hearts', '5');
      // RULE A: a twin dealt into p1's hand would join the lock and make this
      // identity assertion depend on the shuffle. Twin behaviour is tested below.
      purgeTwins(room, 'p1', fiveA);
      room.discardPile = [fiveA];
      handlers.handlePickUpPile(s1, {});
      room.nextTurn();
      room.nextTurn();
      room.hasDrawnCard = false;
      room.discardPile = [fiveB];
      handlers.handlePickUpPile(s1, {});
      expect(room.discardLocks.get('p1').cardIds).to.have.length(2);

      room.nextTurn();
      room.nextTurn();
      room.hasDrawnCard = false;
      room.discardPile = [card('clubs', '8'), card('spades', '9')];
      handlers.handlePickUpPile(s1, {});

      expect(room.discardLocks.has('p1')).to.equal(false);
      service.deleteRoom('pingpong');
    });

    it('a hand of nothing but the two held copies still has a legal discard', () => {
      const room = makeRoom();
      const fiveA = card('hearts', '5');
      const fiveB = card('hearts', '5');
      room.playerHands.set('p1', [fiveA, fiveB]);
      room.armDiscardLock('p1', fiveA);
      room.armDiscardLock('p1', fiveB);
      expect(room.discardLocks.get('p1').cardIds).to.have.length(2);

      expect(
        [fiveA, fiveB].some((c) => GameValidator.validateDiscard(room, 'p1', c).isValid),
        'the escape hatch must skip EVERY held copy'
      ).to.equal(true);
    });
  });

  describe('lifetime', () => {
    it('a DECK DRAW RELEASES the lock, every copy of it', () => {
      // PRODUCT DECISION (this test used to assert the opposite). The lock stops
      // a card bouncing straight back off the DISCARD PILE. Reaching for the
      // STOCK instead is the seat leaving that exchange, so there is nothing left
      // to police — the lock is held only while the seat keeps feeding off the
      // pile. And that is also why the volley stays shut: a turn carries exactly
      // ONE acquisition, so a take never passes through a draw.
      const { service, room, handlers, s1 } = liveRoom();
      const top = KH();
      // RULE A: a twin dealt into p1's hand would join the lock and make this
      // identity assertion depend on the shuffle. Twin behaviour is tested below.
      purgeTwins(room, 'p1', top);
      room.discardPile = [top];
      handlers.handlePickUpPile(s1, {});
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(top));

      room.hasDrawnCard = false;
      handlers.handleDrawCard(s1, { fromDeck: true });

      expect(room.hasDrawnCard).to.equal(true, 'the draw actually happened');
      expect(
        room.discardLocks.has('p1'),
        'the draw let go of the pile, and of the lock with it'
      ).to.equal(false);
      service.deleteRoom('pingpong');
    });

    it('nextTurn() ticks the lock rather than clearing it', () => {
      const room = makeRoom();
      const locked = KH();
      room.armDiscardLock('p1', locked);
      room.drawnCardThisTurnRestriction.add('hearts-K');
      room.meldedThisTurn = true;
      room.currentTurn = 0;

      room.nextTurn();

      expect(room.drawnCardThisTurnRestriction.size).to.equal(0, 'per-turn state IS reset');
      expect(room.meldedThisTurn).to.equal(false);
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(locked, 1));
    });

    it('a new round clears every lock', () => {
      // startGame() is the per-round reset (a room is REUSED across rounds);
      // it is where wellsTakenThisRound and the discard pile are cleared too.
      const room = makeRoom();
      room.armDiscardLock('p1', KH());
      room.armDiscardLock('p2', card('spades', '4'));

      room.startGame(true);

      expect(room.discardLocks.size).to.equal(0);
    });

    it('a successful meld KEEPS the lock (2026-09-21)', () => {
      // Owner rule change: melding — anything — no longer unblocks the card the
      // pile was taken for. The lock keeps its countdown and the taken card
      // stays unthrowable while a free card is in hand.
      const room = makeRoom();
      const locked = KH();
      const spare = card('clubs', '9');
      const kings = [card('spades', 'K'), card('diamonds', 'K'), card('clubs', 'K')];
      room.playerHands.set('p1', [...kings, locked, spare]);
      room.armDiscardLock('p1', locked);

      const res = ActionHandlers.handlePlayMeld(room, 'p1', kings);
      expect(res.success).to.equal(true);
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(locked));
      expect(
        GameValidator.validateDiscard(room, 'p1', locked).reason,
        'the meld paid nothing off'
      ).to.equal('pingPongLocked');
      expect(
        GameValidator.validateDiscard(room, 'p1', spare).isValid,
        'the free card is still the way out of the turn'
      ).to.equal(true);
    });

    it('add-to-meld KEEPS the lock (2026-09-21)', () => {
      const room = makeRoom();
      const locked = KH();
      // Two spare cards, not one: leaving a LONE card turns the add into a
      // go-out and the keep-a-discardable guard refuses it for its own reasons.
      const kings = [card('spades', 'K'), card('diamonds', 'K'), card('clubs', 'K')];
      // The other deck's K♥: free to add to the kings, and NOT under the lock.
      const freeKH = KH();
      room.playerHands.set('p1', [
        ...kings,
        locked,
        freeKH,
        card('clubs', '9'),
        card('diamonds', '5'),
      ]);
      expect(ActionHandlers.handlePlayMeld(room, 'p1', kings).success).to.equal(true);

      // Re-arm as if the player took the pile after going down, then add a
      // DIFFERENT card: the lock must still be standing afterwards.
      room.armDiscardLock('p1', locked);
      const res = ActionHandlers.handleAddToMeld(room, 'p1', [freeKH], 0, 0);
      expect(res.success).to.equal(true);
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(locked));
      expect(GameValidator.validateDiscard(room, 'p1', locked).reason).to.equal('pingPongLocked');
    });

    it('UNDOING the meld leaves the lock exactly as it was', () => {
      // The meld never touched the lock (2026-09-21), and the undo restores the
      // snapshot it took — so the lock reads the same before, during and after.
      const room = makeRoom();
      const locked = KH();
      const kings = [card('spades', 'K'), card('diamonds', 'K'), card('clubs', 'K')];
      room.playerHands.set('p1', [...kings, locked, card('clubs', '9')]);
      room.armDiscardLock('p1', locked);

      ActionHandlers.handlePlayMeld(room, 'p1', kings);
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(locked));

      const undo = ActionHandlers.handleUndoMeld(room, 'p1');
      expect(undo.success).to.equal(true);
      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(locked));
    });

    it('a rollback snapshot round-trips the lock', () => {
      const room = makeRoom();
      const locked = KH();
      room.playerHands.set('p1', [locked, card('clubs', '9')]);
      room.armDiscardLock('p1', locked);

      const snap = ActionHandlers._snapshotForRollback(room, 'p1');
      room.discardLocks.delete('p1');
      ActionHandlers._restoreRollback(room, 'p1', snap);

      expect(room.discardLocks.get('p1')).to.deep.equal(lockFor(locked));
    });
  });

  describe('2v2', () => {
    it('the partner of the taker is completely unaffected', () => {
      const room = makeRoom({ seats: 4 });
      const taken = KH();
      room.armDiscardLock('p2', taken);
      // The partner holds the VERY SAME card object — still free, because the
      // lock is keyed on the player, not the team.
      room.playerHands.set('p4', [taken, card('spades', '4')]);
      room.currentTurn = 3;
      room.hasDrawnCard = true;

      expect(
        GameValidator.validateDiscard(room, 'p4', taken).isValid,
        'the lock binds the taker, not the team'
      ).to.equal(true);
    });
  });

  describe('the wire + host failover', () => {
    it('_serializeDiscardLock ships the cardId and the countdown, per recipient', () => {
      // cardId is the load-bearing field: it is the ONLY thing the client matches
      // on. turnsLeft is the expiry, which the client cannot compute for itself
      // because its own _nextTurn never runs online.
      const room = makeRoom();
      const locked = KH();
      room.armDiscardLock('p1', locked);
      const handlers = new SocketHandlers(fakeIo(new Map()), null);

      expect(handlers._serializeDiscardLock(room, 'p1')).to.deep.equal({
        cardIds: [locked.cardId],
        cardId: locked.cardId,
        suit: 'hearts',
        rank: 'K',
        turnsLeft: DISCARD_LOCK_TURNS,
      });
      expect(handlers._serializeDiscardLock(room, 'p2')).to.equal(null);
    });

    it('the RECONNECT builder (get_game_state) carries the lock', () => {
      // A client that restarted holds no local lock. If this payload omits the
      // field the client offers a discard the server rejects — a hung turn, the
      // exact failure this project has shipped before.
      const { service, room, handlers, emitted, s1 } = liveRoom();
      const top = KH();
      purgeTwins(room, 'p1', top); // RULE A: pin the lock's identity
      room.discardPile = [top];
      handlers.handlePickUpPile(s1, {});
      emitted.length = 0;

      handlers.handleGetGameState(s1, { gameId: room.roomId, playerId: 'p1' });

      const state = emitted.filter((e) => e.event === 'game_state_update').pop();
      expect(state, 'a game_state_update was sent').to.not.equal(undefined);
      expect(state.payload).to.have.property('discardLock');
      expect(state.payload.discardLock).to.deep.equal({
        cardIds: [top.cardId],
        cardId: top.cardId,
        suit: 'hearts',
        rank: 'K',
        turnsLeft: DISCARD_LOCK_TURNS,
      });
      service.deleteRoom('pingpong');
    });

    it('the RECONNECT builder also carries the DRAWN-CARD restriction, or the hatch hangs the turn', () => {
      // Two decks, so K♥ exists twice. Take a ONE-card pile of K♥ while already
      // holding the sibling: the server restricts the TAKEN instance by cardId
      // and locks that same instance.
      //
      // The client REPLACES its restriction state from whatever this builder
      // sends, so an omitted key reads as "cleared", not "unchanged". With
      // drawnCardRestriction missing, a client that restarted saw NEITHER K♥ as
      // restricted, and the anti ping-pong lock did NOT cover the gap: its
      // escape hatch opens precisely when every other card is undiscardable.
      const { service, room, handlers, emitted, s1 } = liveRoom();
      room.playerHands.set('p1', [new Card('hearts', 'K')]);
      const top = new Card('hearts', 'K');
      room.discardPile = [top];
      room.currentTurn = 0;
      room.hasDrawnCard = false;
      handlers.handlePickUpPile(s1, {});

      const hand = room.playerHands.get('p1');
      const taken = hand.find((c) =>
        GameValidator._restrictionMatches(room.drawnCardThisTurnRestriction, c)
      );
      const sibling = hand.find((c) => c !== taken);
      expect(
        GameValidator.validateDiscard(room, 'p1', taken).isValid,
        'the taken K♥ is restricted'
      ).to.equal(false);
      expect(
        GameValidator.validateDiscard(room, 'p1', sibling).isValid,
        'the sibling K♥ is the legal discard'
      ).to.equal(true);

      emitted.length = 0;
      handlers.handleGetGameState(s1, { gameId: room.roomId, playerId: 'p1' });
      const payload = emitted.filter((e) => e.event === 'game_state_update').pop().payload;

      // The rebuilt client must be able to tell the two identical cards apart,
      // which it can only do from the cardId key.
      expect(payload.drawnCardRestriction).to.deep.equal([String(taken.cardId)]);
      expect(payload.drawnCardRestriction).to.not.include(String(sibling.cardId));
      expect(payload.meldedThisTurn).to.equal(false);
      expect(payload.mustMeldCard).to.include({ suit: 'hearts', rank: 'K' });
      expect(payload.discardLock.cardId).to.equal(taken.cardId);
      expect(payload.discardLock.cardId).to.not.equal(sibling.cardId);
      // The hand it ships must carry the same ids the restriction keys name.
      expect(payload.yourHand.map((c) => String(c.cardId))).to.include(String(taken.cardId));
      service.deleteRoom('pingpong');
    });

    it('the in-play builder sends the lock PER RECIPIENT, not room-wide', () => {
      const { service, room, handlers, emitted, s1 } = liveRoom();
      const top = KH();
      room.discardPile = [top];
      handlers.handlePickUpPile(s1, {});
      emitted.length = 0;

      handlers._sendInitialGameState(room);

      const states = emitted.filter((e) => e.event === 'game_state_update');
      const forP1 = states.find((e) => e.payload.yourPlayerIndex === 0);
      const forP2 = states.find((e) => e.payload.yourPlayerIndex === 1);
      expect(forP1.payload.discardLock.cardId).to.equal(top.cardId);
      expect(forP2.payload.discardLock, 'p2 never took the pile').to.equal(null);
      service.deleteRoom('pingpong');
    });

    it('a host migration carries the lock across (persist → rehydrate)', async () => {
      // A field absent from the FailureManager snapshot is silently lost. Here
      // that means the new host forgets a lock every client still enforces, so
      // the client forbids a discard the server allows.
      const room = makeRoom();
      const locked = KH();
      room.armDiscardLock('p1', locked);

      let persisted = null;
      const noop = () => {};
      const manager = new FailureManager(
        null,
        { setex: (key, ttl, json) => { persisted = json; } },
        null,
        { debug: noop, info: noop, warn: noop, error: noop }
      );

      await manager.persistGameState(room);
      expect(persisted, 'state was persisted').to.not.equal(null);
      const state = JSON.parse(persisted);
      expect(state.discardLocks).to.deep.equal([['p1', lockFor(locked)]]);

      const rebuilt = manager._reconstructGameRoom(state);
      expect(rebuilt.discardLocks.get('p1')).to.deep.equal(lockFor(locked));
    });

    it('rehydrating a pre-rule snapshot yields an empty lock map, not a crash', () => {
      const noop = () => {};
      const manager = new FailureManager(null, null, null, {
        debug: noop, info: noop, warn: noop, error: noop,
      });
      const rebuilt = manager._reconstructGameRoom({ roomId: 'legacy', maxPlayers: 2 });
      expect(rebuilt.discardLocks.size).to.equal(0);
    });
  });

  describe('the bot planner obeys it', () => {
    const strategy = new BotStrategy();
    const botCard = (suit, rank, id) => ({ cardId: id, instanceId: id, suit, rank });
    const botLock = (id, suit, rank) => ({ cardId: id, suit, rank, turnsLeft: DISCARD_LOCK_TURNS });
    const baseState = (overrides) => ({
      roomId: 'r1',
      playerId: 'bot-1',
      playerIndex: 1,
      currentPlayerIndex: 1,
      cardsDealt: true,
      hasDrawnCard: true,
      meldedThisTurn: false,
      ruleset: 'classic',
      professionalWellMode: 'indirect',
      yourHand: [],
      playerMelds: {},
      discardPile: [],
      deckCount: 40,
      deadPileCounts: [11],
      pozzettosAvailable: true,
      teamHasTakenPozzetto: false,
      teamWellsTaken: 0,
      opponentWellsTaken: 0,
      wellsTakenThisRound: 0,
      mustMeldCard: null,
      drawnCardRestriction: [],
      discardLock: null,
      ...overrides,
    });

    it('never proposes the locked card while a free card exists', () => {
      // A bot that proposes one gets rejected by the validator and the
      // coordinator has to force-resolve the turn.
      const hand = [
        botCard('hearts', 'K', 'k1'),
        botCard('spades', '4', 'x1'),
      ];
      const state = baseState({ yourHand: hand, discardLock: botLock('k1', 'hearts', 'K') });
      const ctx = strategy._context(state);

      const pick = strategy._pickDiscard(state, ctx, hand);

      expect(pick).to.not.equal(null);
      expect(pick.cardId).to.equal('x1');
    });

    it('a twin the LOCK DOES NOT HOLD is fair game for the bot too', () => {
      // The predicate is id-based and stays id-based. RULE A (2026-09-02) does
      // put a twin under the lock, but by adding its ID at arm time — so a lock
      // that names only k1 still binds only k1, exactly as before.
      const hand = [botCard('hearts', 'K', 'k1'), botCard('hearts', 'K', 'k2')];
      const state = baseState({ yourHand: hand, discardLock: botLock('k1', 'hearts', 'K') });
      const ctx = strategy._context(state);

      expect(strategy._pingPongBlocks(state, ctx, hand[1], hand)).to.equal(false);
    });

    it('avoids BOTH copies when the lock holds two', () => {
      // The two-deck volley reaches the planner too: with both copies held it
      // must reach past them, not propose one and get rejected by the validator.
      const hand = [
        botCard('hearts', '5', 'f1'),
        botCard('hearts', '5', 'f2'),
        botCard('spades', '4', 'x1'),
      ];
      const state = baseState({
        yourHand: hand,
        discardLock: { cardIds: ['f1', 'f2'], cardId: 'f2', suit: 'hearts', rank: '5', turnsLeft: DISCARD_LOCK_TURNS },
      });
      const ctx = strategy._context(state);

      expect(strategy._pingPongBlocks(state, ctx, hand[0], hand)).to.equal(true);
      expect(strategy._pingPongBlocks(state, ctx, hand[1], hand)).to.equal(true);
      const pick = strategy._pickDiscard(state, ctx, hand);
      expect(pick).to.not.equal(null);
      expect(pick.cardId).to.equal('x1');
    });

    it('still finds a move when the hand is NOTHING but the two held copies', () => {
      // The escape hatch has to skip every held copy, or the bot has no legal
      // discard at all and its turn force-resolves.
      const hand = [botCard('hearts', '5', 'f1'), botCard('hearts', '5', 'f2')];
      const state = baseState({
        yourHand: hand,
        discardLock: { cardIds: ['f1', 'f2'], cardId: 'f2', suit: 'hearts', rank: '5', turnsLeft: DISCARD_LOCK_TURNS },
      });
      const ctx = strategy._context(state);

      expect(strategy._pingPongBlocks(state, ctx, hand[0], hand)).to.equal(false);
      expect(strategy._pickDiscard(state, ctx, hand)).to.not.equal(null);
    });

    it('DOES propose the locked card when it is the only option', () => {
      const hand = [botCard('hearts', 'K', 'k1')];
      const state = baseState({ yourHand: hand, discardLock: botLock('k1', 'hearts', 'K') });
      const ctx = strategy._context(state);

      const pick = strategy._pickDiscard(state, ctx, hand);

      expect(pick, 'the hatch must open for the bot too, or its turn force-resolves').to.not.equal(
        null
      );
      expect(pick.cardId).to.equal('k1');
    });

    it('is unaffected when it holds no lock', () => {
      const hand = [botCard('hearts', 'K', 'k1'), botCard('spades', '4', 'x1')];
      const state = baseState({ yourHand: hand });
      const ctx = strategy._context(state);

      expect(strategy._pickDiscard(state, ctx, hand)).to.not.equal(null);
    });
  });

  describe('client/server parity of the predicate', () => {
    it('agrees with the Flutter predicate on every documented case', () => {
      // These are the exact cases pinned in
      // buraco_sdk/test/ping_pong_discard_lock_test.dart. If a row here flips,
      // the client and server disagree and the turn hangs. hand[0] is always the
      // locked card, and `probe` is picked by index for the same reason.
      const cases = [
        {
          build: () => [KH()],
          probe: 0,
          blocked: false,
          why: 'sole card → hatch open',
        },
        {
          build: () => [KH(), card('spades', '4')],
          probe: 0,
          blocked: true,
          why: 'one free card → locked',
        },
        {
          build: () => [KH(), card('spades', '4')],
          probe: 1,
          blocked: false,
          why: 'a different card is never locked',
        },
        {
          build: () => [KH(), KH()],
          probe: 1,
          blocked: false,
          why: 'a twin whose id the lock does not hold is a different card',
        },
      ];

      cases.forEach(({ build, probe, blocked, why }) => {
        const room = makeRoom();
        const hand = build();
        room.playerHands.set('p1', hand);
        room.armDiscardLock('p1', hand[0]);
        expect(GameValidator._pingPongBlocks(room, 'p1', hand[probe], hand), why).to.equal(blocked);
      });
    });

    it('no lock means no block, ever', () => {
      const room = makeRoom();
      const hand = [KH(), card('spades', '4')];
      room.playerHands.set('p1', hand);
      expect(GameValidator._pingPongBlocks(room, 'p1', hand[0], hand)).to.equal(false);
    });
  });

  // ==========================================================================
  // RULE A / RULE B / RULE C — the product owner's three shapes, 2026-09-02.
  // ==========================================================================
  describe('RULE A — a LONE take also locks the twin already in hand', () => {
    it("the user's example: take the 8H holding an 8H, and BOTH are undiscardable", () => {
      // "kalo discarded card hanya 1 diambil / misal ambil 8 love / ditangan
      // sudah ada 8 love / pas kartu sampe ketangan, kartu yang diambil 1 dari
      // discarded pile, dan ditangan yang sudah ada gaboleh di buang."
      //
      // WITHOUT the twin the volley is trivially defeated: take the 8H off the
      // pile, throw your OWN 8H, and the opponent sees the identical card come
      // straight back. The lock exists to stop exactly that.
      const { service, room, handlers, s1 } = liveRoom();
      const twin = new Card('hearts', '8'); // already in hand when the take lands
      const spare = new Card('clubs', '3');
      const taken = new Card('hearts', '8'); // the lone card on the pile
      room.playerHands.set('p1', [twin, spare]);
      room.discardPile = [taken];
      room.currentTurn = 0;
      room.hasDrawnCard = false;

      handlers.handlePickUpPile(s1, {});

      expect(
        room.discardLocks.get('p1').cardIds.map(String).sort(),
        'the lock holds the taken card AND the twin'
      ).to.deep.equal([taken.cardId, twin.cardId].map(String).sort());
      expect(
        GameValidator.validateDiscard(room, 'p1', taken).isValid,
        'the card the pile was taken for'
      ).to.equal(false);
      expect(
        GameValidator.validateDiscard(room, 'p1', twin).reason,
        'the twin that was already in hand'
      ).to.equal('pingPongLocked');
      expect(
        GameValidator.validateDiscard(room, 'p1', spare).isValid,
        'anything else is still throwable — the turn is not wedged'
      ).to.equal(true);
      service.deleteRoom('pingpong');
    });

    it('a twin that arrives AFTER the take is NOT recruited', () => {
      // RULE A binds what was in hand WHEN THE CARD LANDED, nothing later. This
      // is the boundary that keeps it from becoming the old "one card type is
      // stuck forever" bug: a rank+suit key would have frozen this card too.
      const { service, room, handlers, s1 } = liveRoom();
      const taken = new Card('hearts', '8');
      room.playerHands.set('p1', [new Card('clubs', '3')]);
      room.discardPile = [taken];
      room.currentTurn = 0;
      room.hasDrawnCard = false;

      handlers.handlePickUpPile(s1, {});
      const late = new Card('hearts', '8');
      room.playerHands.get('p1').push(late);

      expect(room.discardLocks.get('p1').cardIds.map(String)).to.deep.equal([String(taken.cardId)]);
      expect(
        GameValidator.validateDiscard(room, 'p1', late).isValid,
        'the second-deck 8H that arrived later has nothing to do with this take'
      ).to.equal(true);
      service.deleteRoom('pingpong');
    });

    it('a lone JOKER take recruits every joker already in hand', () => {
      // The only rank+suit in the shoe with more than two copies: Deck.initialize
      // adds FOUR jokers, all suit "joker" rank "joker". RULE A locks all of the
      // ones already held, so this shape is worth pinning explicitly.
      const { service, room, handlers, s1 } = liveRoom();
      const held = [new Card('joker', 'joker'), new Card('joker', 'joker')];
      const spare = new Card('clubs', '3');
      const taken = new Card('joker', 'joker');
      room.playerHands.set('p1', [...held, spare]);
      room.discardPile = [taken];
      room.currentTurn = 0;
      room.hasDrawnCard = false;

      handlers.handlePickUpPile(s1, {});

      expect(room.discardLocks.get('p1').cardIds.map(String).sort()).to.deep.equal(
        [taken.cardId, held[0].cardId, held[1].cardId].map(String).sort()
      );
      expect(
        GameValidator.validateDiscard(room, 'p1', spare).isValid,
        'and a natural is still throwable'
      ).to.equal(true);
      service.deleteRoom('pingpong');
    });

    it('THE WEDGE: hand of nothing but the taken card and its twin still has a legal discard', () => {
      // RULE A adds a SECOND locked card, which makes a wedge more reachable
      // than it was: a two-card hand of {taken, twin} has every card locked.
      // The per-turn restriction's only hatch is handSize === 1, so if the twin
      // had been put in THAT set the turn would freeze. It is in the CROSS-TURN
      // lock instead, whose hatch yields the moment no OTHER card is throwable.
      // A rule that can freeze a turn is worse than the bug it fixes.
      const { service, room, handlers, s1 } = liveRoom();
      const twin = new Card('hearts', '8');
      const taken = new Card('hearts', '8');
      room.playerHands.set('p1', [twin]);
      room.discardPile = [taken];
      room.currentTurn = 0;
      room.hasDrawnCard = false;

      handlers.handlePickUpPile(s1, {});

      const hand = room.playerHands.get('p1');
      expect(hand.length, 'exactly the taken card and its twin').to.equal(2);
      const legal = hand.filter((c) => GameValidator.validateDiscard(room, 'p1', c).isValid);
      expect(legal.length, 'the escape hatch must fire on the TAKE turn').to.be.greaterThan(0);
      expect(
        GameValidator.validateDiscard(room, 'p1', twin).isValid,
        'the twin is the card the hatch opens — the taken one is still per-turn restricted'
      ).to.equal(true);

      // ...and on the NEXT turn, with the per-turn set wiped and the lock still
      // holding both, the hatch opens for BOTH rather than for neither.
      room.nextTurn();
      room.nextTurn();
      expect(room.currentTurn).to.equal(0);
      room.hasDrawnCard = true;
      room.playerHands.set('p1', [twin, taken]);
      expect(room.discardLocks.get('p1').cardIds, 'the lock survived the boundary').to.have.length(
        2
      );
      const nextTurnLegal = room.playerHands
        .get('p1')
        .filter((c) => GameValidator.validateDiscard(room, 'p1', c).isValid);
      expect(nextTurnLegal.length, 'the turn after cannot wedge either').to.equal(2);
      service.deleteRoom('pingpong');
    });

    it('the BOT planner never proposes a discard the validator refuses after a RULE A take', () => {
      // The bot mirror reads the SERIALIZED lock, so RULE A reaches it through
      // `cardIds` with no change to BotStrategy. Drive a real take and check the
      // two predicates agree card for card — a bot offering an illegal move is
      // how the game froze before.
      const { service, room, handlers, s1 } = liveRoom();
      const twin = new Card('hearts', '8');
      const spare = new Card('clubs', '3');
      const taken = new Card('hearts', '8');
      room.playerHands.set('p1', [twin, spare]);
      room.discardPile = [taken];
      room.currentTurn = 0;
      room.hasDrawnCard = false;
      handlers.handlePickUpPile(s1, {});

      const hand = room.playerHands.get('p1').map((c) => c.toJSON());
      const strategy = new BotStrategy({ difficulty: 'hard' });
      const state = {
        yourPlayerIndex: 0,
        currentTurn: 0,
        phase: 'discard',
        hasDrawnCard: true,
        meldedThisTurn: false,
        ruleset: 'classic',
        professionalWellMode: 'indirect',
        yourHand: hand,
        playerMelds: {},
        discardPile: [],
        deckCount: 40,
        deadPileCounts: [11],
        pozzettosAvailable: true,
        teamHasTakenPozzetto: false,
        teamWellsTaken: 0,
        opponentWellsTaken: 0,
        wellsTakenThisRound: 0,
        mustMeldCard: null,
        drawnCardRestriction: Array.from(room.drawnCardThisTurnRestriction),
        discardLock: room.discardLocks.get('p1'),
      };
      const ctx = strategy._context(state);
      const pick = strategy._pickDiscard(state, ctx, hand);

      expect(pick, 'the bot found a move').to.not.equal(null);
      expect(String(pick.cardId), 'and it is the one card the validator allows').to.equal(
        String(spare.cardId)
      );
      const asCard = room.playerHands.get('p1').find((c) => String(c.cardId) === String(pick.cardId));
      expect(
        GameValidator.validateDiscard(room, 'p1', asCard).isValid,
        'the validator accepts exactly what the bot proposed'
      ).to.equal(true);
      service.deleteRoom('pingpong');
    });
  });

  describe('RULE C — a deck draw never locks anything, however it happened', () => {
    it('the TIMEOUT auto-draw restricts NOTHING, so the drawn card can go straight back', () => {
      // THE PRODUCT CALL, made 2026-09-02. The project notes carried this open
      // for weeks: "the socket's timeout auto-draw restricts the just-drawn card
      // while its manual draw explicitly does not... Unresolved — needs a
      // product call on which draw rule wins." The MANUAL rule wins, everywhere.
      //
      // Visible consequence: the timeout's own stated preference — throw back the
      // card the player never chose to keep — can finally fire. While the
      // restriction was there that card was always filtered out as illegal.
      const { service, room, handlers } = liveRoom();
      const willDraw = new Card('clubs', '9');
      room.deck.cards.unshift(willDraw);
      room.playerHands.set('p1', [new Card('spades', 'K'), new Card('hearts', 'Q')]);
      room.currentTurn = 0;
      room.hasDrawnCard = false;
      room.meldedThisTurn = false;
      room.drawnCardThisTurnRestriction = new Set();
      room.discardPile = [];

      handlers._onTurnTimerExpired(room);

      const thrown = room.discardPile[room.discardPile.length - 1];
      expect(thrown, 'the timeout discarded something').to.not.equal(undefined);
      expect(
        String(thrown.cardId),
        'the freshly auto-drawn card was legally throwable and was preferred'
      ).to.equal(String(willDraw.cardId));
      expect(room.playerHands.get('p1').length, 'the rest of the hand is untouched').to.equal(2);
      service.deleteRoom('pingpong');
    });

    it('the TIMEOUT auto-draw RELEASES a lock an earlier take armed', () => {
      const { service, room, handlers, s1 } = liveRoom();
      const top = KH();
      purgeTwins(room, 'p1', top);
      room.discardPile = [top];
      room.currentTurn = 0;
      room.hasDrawnCard = false;
      handlers.handlePickUpPile(s1, {});
      expect(room.discardLocks.has('p1'), 'armed by the lone take').to.equal(true);

      room.nextTurn();
      room.nextTurn();
      expect(room.currentTurn).to.equal(0);
      room.hasDrawnCard = false;
      room.playerHands.set('p1', [new Card('spades', 'K'), new Card('hearts', 'Q')]);

      handlers._onTurnTimerExpired(room);

      expect(
        room.discardLocks.has('p1'),
        'RULE C: reaching for the stock releases every lock the seat holds'
      ).to.equal(false);
      service.deleteRoom('pingpong');
    });
  });
});
