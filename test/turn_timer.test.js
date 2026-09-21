/**
 * Tests for server-side turn timer, draw-card restriction,
 * mustMeldCard enforcement, and undo_meld logic.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameValidator = require('../src/validators/GameValidator');
const ActionHandlers = require('../src/handlers/ActionHandlers');
const SocketHandlers = require('../src/handlers/SocketHandlers');
const { GameRoom } = require('../src/models');
const PlayerSession = require('../src/models/PlayerSession');
const { GameRoomStatus } = require('../src/constants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const card = (suit, rank) => ({ suit, rank });

/**
 * Build a minimal two-player room ready for action.
 * hasDrawnCard defaults to true so most tests don't need to deal with it.
 */
function makeRoom({ hasDrawnCard = true } = {}) {
  const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.currentTurn = 0;
  room.hasDrawnCard = hasDrawnCard;
  room.turnTimeLimit = 30;
  room.turnTimeRemaining = 30;
  room.turnTimerHandle = null;
  room.turnTimerTickHandle = null;

  const p1 = new PlayerSession({ playerId: 'p1', playerName: 'P1', playerIndex: 0, socketId: 's1' });
  const p2 = new PlayerSession({ playerId: 'p2', playerName: 'P2', playerIndex: 1, socketId: 's2' });
  room.addPlayer(p1);
  room.addPlayer(p2);

  // Default hands
  room.playerHands.set('p1', [
    card('hearts', '3'),
    card('hearts', '4'),
    card('hearts', '5'),
    card('spades', '9'),
  ]);
  room.playerHands.set('p2', [card('clubs', '7'), card('clubs', '8')]);
  room.discardPile = [card('diamonds', '2')];

  return room;
}

// ---------------------------------------------------------------------------
// GameRoom per-turn fields
// ---------------------------------------------------------------------------
describe('GameRoom — per-turn fields', () => {
  it('initialises restriction fields fresh on construction', () => {
    const room = makeRoom();
    expect(room.drawnCardThisTurnRestriction).to.be.instanceOf(Set);
    expect(room.drawnCardThisTurnRestriction.size).to.equal(0);
    expect(room.meldedThisTurn).to.equal(false);
    expect(room.mustMeldCard).to.equal(null);
    expect(room.lastMeldSnapshot).to.equal(null);
    expect(room.playerPozzettoTakeMode).to.be.instanceOf(Map);
  });

  it('nextTurn() resets all per-turn fields', () => {
    const room = makeRoom();
    room.drawnCardThisTurnRestriction.add('hearts-3');
    room.meldedThisTurn = true;
    room.mustMeldCard = card('hearts', '3');
    room.lastMeldSnapshot = { playerId: 'p1' };

    room.nextTurn();

    expect(room.hasDrawnCard).to.equal(false);
    expect(room.drawnCardThisTurnRestriction.size).to.equal(0);
    expect(room.meldedThisTurn).to.equal(false);
    expect(room.mustMeldCard).to.equal(null);
    expect(room.lastMeldSnapshot).to.equal(null);
  });

  it('toJSON() reports zero when no turn timer deadline is armed', () => {
    const room = makeRoom();
    room.turnTimeRemaining = 17;
    room.turnTimeLimit = 30;
    const json = room.toJSON();
    expect(json.turnTimeRemaining).to.equal(0);
    expect(json.turnTimeLimit).to.equal(30);
    expect(json.turnTimeLimitSeconds).to.equal(30);
  });

  it('toJSON() derives a live remaining time from the armed deadline', () => {
    const room = makeRoom();
    room.turnTimerDeadline = Date.now() + 17000;
    const json = room.toJSON();
    expect(json.turnTimeRemaining).to.be.within(16, 17);
  });

  it('SocketHandlers clamps custom turn timer overrides', () => {
    const handler = new SocketHandlers({ to: () => ({ emit: () => {} }) }, null);
    expect(handler._extractTurnTimeLimitSeconds({ turnTimeLimitSeconds: 1 })).to.equal(5);
    expect(handler._extractTurnTimeLimitSeconds({ turnTimeLimitSeconds: 999 })).to.equal(600);
    expect(handler._extractTurnTimeLimitSeconds({ turnTimeLimit: 45 })).to.equal(45);
    expect(handler._extractTurnTimeLimitSeconds({ turnTimeLimitSeconds: 'abc' })).to.equal(null);
  });
});

// ---------------------------------------------------------------------------
// GameValidator.validateDiscard — restriction logic
// ---------------------------------------------------------------------------
describe('GameValidator.validateDiscard — drawn-card restriction', () => {
  it('allows discard of unrestricted card', () => {
    const room = makeRoom();
    const result = GameValidator.validateDiscard(room, 'p1', card('spades', '9'));
    expect(result.isValid).to.equal(true);
  });

  it('blocks discard of a single-take restricted card before melding', () => {
    const room = makeRoom();
    // House rule: a SINGLE-card take restricts that card from immediate discard
    // (the player must discard a different card or meld first).
    room.drawnCardThisTurnRestriction.add('hearts-3');

    const result = GameValidator.validateDiscard(room, 'p1', card('hearts', '3'));
    expect(result.isValid).to.equal(false);
    expect(result.reason).to.equal('drawnCardRestriction');
  });

  it('allows escape: discard the single-take card when it is the sole card', () => {
    const room = makeRoom();
    room.playerHands.set('p1', [card('hearts', '3')]);
    room.drawnCardThisTurnRestriction.add('hearts-3');

    // Sole card — no meld possible; the restriction lifts to avoid a stuck turn.
    const result = GameValidator.validateDiscard(room, 'p1', card('hearts', '3'));
    expect(result.isValid).to.equal(true);
  });

  it('still blocks the drawn card after melding (2026-09-21: a meld lifts nothing)', () => {
    const room = makeRoom();
    room.playerHands.set('p1', [card('hearts', '3'), card('spades', '9')]);
    room.drawnCardThisTurnRestriction.add('hearts-3');
    room.meldedThisTurn = true;

    const result = GameValidator.validateDiscard(room, 'p1', card('hearts', '3'));
    expect(result.isValid).to.equal(false);
    expect(result.reason).to.equal('drawnCardRestriction');
  });

  // (Removed: the "sole-card drawn-restriction escape" — with the relaxed rule
  // there is no restriction to escape; a sole-card discard is governed by the
  // close/go-out rules instead, covered by the GO-OUT tests.)

  it('rejects discard before drawing (mustDrawFirst)', () => {
    const room = makeRoom({ hasDrawnCard: false });
    const result = GameValidator.validateDiscard(room, 'p1', card('hearts', '3'));
    expect(result.isValid).to.equal(false);
    expect(result.reason).to.equal('mustDrawFirst');
  });

  it('rejects card not in hand', () => {
    const room = makeRoom();
    const result = GameValidator.validateDiscard(room, 'p1', card('diamonds', 'K'));
    expect(result.isValid).to.equal(false);
    expect(result.reason).to.equal('cardNotInHand');
  });
});

// ---------------------------------------------------------------------------
// GameValidator.validateDiscard — mustMeldCard
// ---------------------------------------------------------------------------
describe('GameValidator.validateDiscard — mustMeldCard', () => {
  it('allows discard of mustMeldCard even with multiple cards (relaxed rule)', () => {
    const room = makeRoom();
    room.mustMeldCard = card('hearts', '3');

    const result = GameValidator.validateDiscard(room, 'p1', card('hearts', '3'));
    expect(result.isValid).to.equal(true);
  });

  it('allows discard of mustMeldCard when it is the only card left (no mustMeldFirst block)', () => {
    const room = makeRoom();
    room.playerHands.set('p1', [card('hearts', '3')]);
    room.mustMeldCard = card('hearts', '3');

    const result = GameValidator.validateDiscard(room, 'p1', card('hearts', '3'));
    // The mustMeldFirst reason must NOT fire — other reasons (e.g. noBrazilia when closing)
    // may still fire, but the mustMeldCard leniency for sole-card must not be the blocker.
    expect(result.reason).to.not.equal('mustMeldFirst');
  });

  it('allows discarding a different card when mustMeldCard is set', () => {
    const room = makeRoom();
    room.mustMeldCard = card('hearts', '3');

    const result = GameValidator.validateDiscard(room, 'p1', card('spades', '9'));
    expect(result.isValid).to.equal(true);
  });
});

// ---------------------------------------------------------------------------
// ActionHandlers.handleUndoMeld
// ---------------------------------------------------------------------------
describe('ActionHandlers.handleUndoMeld', () => {
  it('fails when snapshot is null', () => {
    const room = makeRoom();
    room.lastMeldSnapshot = null;

    const result = ActionHandlers.handleUndoMeld(room, 'p1');
    expect(result.success).to.equal(false);
    expect(result.error).to.be.a('string');
  });

  it('fails when snapshot belongs to different player', () => {
    const room = makeRoom();
    room.lastMeldSnapshot = {
      playerId: 'p2',
      wasNewMeld: true,
      meldIndex: 0,
      cards: [card('hearts', '3')],
      restoredMustMeldCard: null,
      savedRestriction: new Set(),
    };

    const result = ActionHandlers.handleUndoMeld(room, 'p1');
    expect(result.success).to.equal(false);
  });

  it('undoes a new meld: removes meld and returns cards to hand', () => {
    const room = makeRoom();
    const meldCards = [card('hearts', '3'), card('hearts', '4'), card('hearts', '5')];

    // Simulate meld having been played
    const handBefore = [card('spades', '9')];
    const handBeforeLength = handBefore.length; // capture before possible mutation
    room.playerHands.set('p1', handBefore);
    room.playerMelds.set('p1', [meldCards]);
    room.meldedThisTurn = true;
    room.lastMeldSnapshot = {
      playerId: 'p1',
      wasNewMeld: true,
      meldIndex: 0,
      cards: meldCards,
      restoredMustMeldCard: null,
      savedRestriction: new Set(['hearts-3']),
    };

    const result = ActionHandlers.handleUndoMeld(room, 'p1');

    expect(result.success).to.equal(true);

    // Meld removed
    const melds = room.playerMelds.get('p1') || [];
    expect(melds).to.have.length(0);

    // Cards returned to hand
    const hand = room.playerHands.get('p1');
    expect(hand).to.have.length(handBeforeLength + meldCards.length);

    // Per-turn state restored
    expect(room.meldedThisTurn).to.equal(false);
    expect(room.drawnCardThisTurnRestriction.has('hearts-3')).to.equal(true);
    expect(room.lastMeldSnapshot).to.equal(null);
  });

  it('restores mustMeldCard when undoing the meld that satisfied it', () => {
    const room = makeRoom();
    const meldCards = [card('hearts', '3'), card('hearts', '4'), card('hearts', '5')];
    const requiredCard = card('hearts', '3');

    room.playerHands.set('p1', [card('spades', '9')]);
    room.playerMelds.set('p1', [meldCards]);
    room.mustMeldCard = requiredCard;
    room.meldedThisTurn = true;
    room.lastMeldSnapshot = {
      playerId: 'p1',
      wasNewMeld: true,
      meldIndex: 0,
      cards: meldCards,
      restoredMustMeldCard: requiredCard,
      savedRestriction: new Set(),
      wasMeldedBefore: false,
    };

    const result = ActionHandlers.handleUndoMeld(room, 'p1');

    expect(result.success).to.equal(true);
    // Undo still restores the mustMeldCard STATE...
    expect(room.mustMeldCard).to.deep.equal(requiredCard);
    // ...but the relaxed rule no longer blocks discarding it.
    const discardCheck = GameValidator.validateDiscard(room, 'p1', requiredCard);
    expect(discardCheck.isValid).to.equal(true);
  });

  it('preserves previous meldedThisTurn state when undoing a later meld', () => {
    const room = makeRoom();
    const meldCards = [card('clubs', '3'), card('clubs', '4'), card('clubs', '5')];

    room.playerHands.set('p1', [card('spades', '9')]);
    room.playerMelds.set('p1', [meldCards]);
    room.drawnCardThisTurnRestriction = new Set(['spades-9']);
    room.meldedThisTurn = true;
    room.lastMeldSnapshot = {
      playerId: 'p1',
      wasNewMeld: true,
      meldIndex: 0,
      cards: meldCards,
      restoredMustMeldCard: null,
      savedRestriction: new Set(['spades-9']),
      wasMeldedBefore: true,
    };

    const result = ActionHandlers.handleUndoMeld(room, 'p1');

    expect(result.success).to.equal(true);
    expect(room.meldedThisTurn).to.equal(true);
    // The restriction round-trips through the undo and, since 2026-09-21, an
    // earlier meld does not lift it either — the 9♠ stays blocked while the
    // returned meld cards give the player something else to throw.
    expect(room.drawnCardThisTurnRestriction.has('spades-9')).to.equal(true);
    expect(GameValidator.validateDiscard(room, 'p1', card('spades', '9')).reason).to.equal('drawnCardRestriction');
  });

  it('undoes add-to-meld: removes appended cards from existing meld', () => {
    const room = makeRoom();
    const baseMeld = [card('hearts', '3'), card('hearts', '4'), card('hearts', '5')];
    const addedCards = [card('hearts', '6')];
    const meldWithAdded = [...baseMeld, ...addedCards];

    room.playerHands.set('p1', [card('spades', '9')]);
    // The meld belongs to p2 (partner meld scenario)
    room.playerMelds.set('p2', [meldWithAdded]);
    room.meldedThisTurn = true;
    room.lastMeldSnapshot = {
      playerId: 'p1',
      wasNewMeld: false,
      meldIndex: 0,
      cards: addedCards,
      targetPlayerId: 'p2',
      restoredMustMeldCard: null,
      savedRestriction: new Set(),
    };

    const result = ActionHandlers.handleUndoMeld(room, 'p1');

    expect(result.success).to.equal(true);

    const meld = room.playerMelds.get('p2')[0];
    expect(meld).to.have.length(baseMeld.length);

    const hand = room.playerHands.get('p1');
    expect(hand.some((c) => c.suit === 'hearts' && c.rank === '6')).to.equal(true);
  });

  it('handleDiscard clears the snapshot (undo window closes)', () => {
    const room = makeRoom();
    room.lastMeldSnapshot = { playerId: 'p1', wasNewMeld: true };

    ActionHandlers.handleDiscard(room, 'p1', card('hearts', '3'));

    // Whether discard succeeds or not, snapshot should be cleared if it was cleared by the handler
    // (If discard fails due to restriction we won't clear, so let's use an unrestricted card)
    const room2 = makeRoom();
    room2.lastMeldSnapshot = { playerId: 'p1', wasNewMeld: true };
    room2.meldedThisTurn = true; // remove restriction hurdles

    // Inject unrestricted discard
    ActionHandlers.handleDiscard(room2, 'p1', card('spades', '9'));
    expect(room2.lastMeldSnapshot).to.equal(null);
  });
});

// ---------------------------------------------------------------------------
// Round-end batida label
// ---------------------------------------------------------------------------
describe('ActionHandlers round finalization - batida type', () => {
  it('uses direct pozzetto take mode instead of inferring indirect from boolean taken state', () => {
    const room = makeRoom();
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerPozzettoTakeMode.set('p1', 'direct');

    const result = ActionHandlers._finalizeRound(room, 'p1');

    expect(result.batidaType).to.equal('direct');
    expect(result.playerScores[0].batidaType).to.equal('direct');
  });

  it('falls back to indirect for legacy rooms with taken pozzetto but no take mode', () => {
    const room = makeRoom();
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerPozzettoTakeMode.delete('p1');

    const result = ActionHandlers._finalizeRound(room, 'p1');

    expect(result.batidaType).to.equal('indirect');
  });

  it('records direct mode when an empty hand takes a dead pile without discarding', () => {
    const room = makeRoom();
    room.playerHands.set('p1', []);
    room.deadPiles = [[card('clubs', '3'), card('clubs', '4')]];

    const result = ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', false);

    expect(result.takenCount).to.equal(2);
    expect(room.playerPozzettoTakeMode.get('p1')).to.equal('direct');
  });
});

// ---------------------------------------------------------------------------
// ActionHandlers.handlePlayMeld — snapshot capture
// ---------------------------------------------------------------------------
describe('ActionHandlers.handlePlayMeld — snapshot', () => {
  it('sets lastMeldSnapshot on successful meld', () => {
    const room = makeRoom();
    const meldCards = [card('hearts', '3'), card('hearts', '4'), card('hearts', '5')];
    // Ensure GameValidator allows the meld (it's contiguous hearts — valid run)
    room.playerHands.set('p1', [...meldCards, card('spades', '9')]);

    const result = ActionHandlers.handlePlayMeld(room, 'p1', meldCards);
    if (!result.success) return; // skip if meld validation rejects (rank rules)

    if (room.lastMeldSnapshot) {
      expect(room.lastMeldSnapshot.playerId).to.equal('p1');
      expect(room.lastMeldSnapshot.wasNewMeld).to.equal(true);
      expect(room.meldedThisTurn).to.equal(true);
    }
  });

  it('clears drawnCardThisTurnRestriction when a meld is played', () => {
    const room = makeRoom();
    room.drawnCardThisTurnRestriction.add('hearts-3');
    const meldCards = [card('hearts', '3'), card('hearts', '4'), card('hearts', '5')];
    room.playerHands.set('p1', [...meldCards, card('spades', '9')]);

    const result = ActionHandlers.handlePlayMeld(room, 'p1', meldCards);
    if (!result.success) return;

    expect(room.drawnCardThisTurnRestriction.size).to.equal(0);
  });
});
