/* eslint-env mocha */

/**
 * ABSENT SEATS ARE AUTO-PLAYED (product rule, 2026-09-28) — replaces the
 * offline strikes (2026-08-20).
 *
 * The strikes SKIPPED a disconnected player's turn — the table watched the turn
 * move with no take and no throw — and called the match at the 4th skip of a
 * round (offline_forfeit). Now a seat whose clock runs out is played for its
 * owner every single time: take a card, throw a card. Present, disconnected or
 * app killed makes no difference, and absence never ends the match — the game
 * finishes on its own, and the owner can walk back in at any turn.
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeIo(emitted) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ roomId, event, payload }),
    }),
    sockets: { sockets: new Map() },
  };
}

function liveRoom(id) {
  const service = new GameService();
  const room = service.createRoom(id, 2);
  service.joinRoom(id, 'p1', 'P1', 's1');
  service.joinRoom(id, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  const emitted = [];
  const handlers = new SocketHandlers(fakeIo(emitted), service);
  handlers._stopTurnTimer(room);
  return { service, room, handlers, emitted };
}

/** One clock expiry on whoever holds the turn; the next timer is not left running. */
function expire(handlers, room, emitted) {
  emitted.length = 0;
  handlers._onTurnTimerExpired(room);
  handlers._stopTurnTimer(room);
}

describe('#absent seats are auto-played, absence never ends the match', () => {
  it('an OFFLINE seat takes and throws on every expiry, turn after turn, and the match goes on', () => {
    const { service, room, handlers, emitted } = liveRoom('absent-autoplay');
    const absent = room.getPlayer('p2');
    absent.disconnect();

    for (let turn = 0; turn < 24; turn += 1) {
      const seat = room.currentTurn;
      const owner = room.getPlayerByIndex(seat);
      const handBefore = room.playerHands.get(owner.playerId).length;
      const pileBefore = room.discardPile.length;
      const deckBefore = room.deck.count;

      expire(handlers, room, emitted);

      const at = `turn ${turn} (seat ${seat}, ${owner.isConnected ? 'present' : 'offline'})`;
      expect(room.isInProgress(), at).to.equal(true);
      expect(room.deck.count, `${at}: took a card`).to.equal(deckBefore - 1);
      expect(room.discardPile.length, `${at}: threw a card`).to.equal(pileBefore + 1);
      expect(room.playerHands.get(owner.playerId).length, at).to.equal(handBefore);
      expect(emitted.find((e) => e.event === 'card_drawn').payload.playerIndex, at).to.equal(seat);
      expect(emitted.find((e) => e.event === 'card_discarded').payload.playerIndex, at).to.equal(seat);
      const moved = emitted.find((e) => e.event === 'turn_changed');
      expect(moved.payload.forced, `${at}: never a bare turn skip`).to.not.equal(true);
      expect(emitted.some((e) => e.event === 'game_ended'), `${at}: never a forfeit`).to.equal(false);
      // The server's own throw is no sign of life.
      expect(absent.isConnected, at).to.equal(false);
    }
    service.deleteRoom('absent-autoplay');
  });

  it('an EMPTY hand at expiry (direct well mode) takes the well and throws from it', () => {
    // The seat melded its whole hand and ran out of time before picking the well
    // up. The old path found nothing to throw, then either confiscated the melds
    // or skipped the turn with an empty hand; auto-play now does what the player
    // was about to do.
    const { service, room, handlers, emitted } = liveRoom('absent-well');
    const seat = room.currentTurn;
    const owner = room.getPlayerByIndex(seat);
    owner.disconnect();
    room.hasDrawnCard = true;
    room.playerHands.set(owner.playerId, []);
    const wellSize = room.deadPiles.find((pile) => pile.length > 0).length;

    expire(handlers, room, emitted);

    const took = emitted.find((e) => e.event === 'pozzetto_taken');
    expect(took, 'the well was taken').to.not.equal(undefined);
    expect(took.payload).to.include({ playerIndex: seat, cardCount: wellSize });
    expect(emitted.find((e) => e.event === 'card_discarded').payload.playerIndex).to.equal(seat);
    expect(room.playerHands.get(owner.playerId)).to.have.length(wellSize - 1);
    expect(emitted.find((e) => e.event === 'turn_changed').payload.forced).to.not.equal(true);
    expect(room.currentTurn).to.not.equal(seat);
    expect(owner.isConnected).to.equal(false);
    service.deleteRoom('absent-well');
  });

  it('the strike rule is gone', () => {
    expect(SocketHandlers.MAX_OFFLINE_STRIKES).to.equal(undefined);
    expect(SocketHandlers.prototype._handleInactiveTurnExpiry).to.equal(undefined);
  });
});
