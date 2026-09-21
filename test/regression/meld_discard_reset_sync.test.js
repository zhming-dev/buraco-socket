/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const GameValidator = require('../../src/validators/GameValidator');
const { Card } = require('../../src/models/Deck');

// RULE CHANGE 2026-09-21 (owner): a meld no longer releases the taken card or
// its twin. What these cases pin now is that the live state frame AND the
// reconnect frame both still CARRY the block after a meld, so a client that
// rebuilds from either one blocks exactly what the validator blocks.
describe('discard restriction snapshots after melding', () => {
  let service;
  let room;
  let handlers;
  let sockets;
  let emitted;

  beforeEach(() => {
    service = new GameService();
    room = service.createRoom('meld-reset', 4);
    emitted = [];
    sockets = new Map();
    for (let seat = 0; seat < 4; seat += 1) {
      const id = `s${seat}`;
      sockets.set(id, {
        id,
        emit: (event, payload) => emitted.push({ event, payload, seat }),
        join: () => {},
        leave: () => {},
        to: () => ({ emit: () => {} }),
      });
      service.joinRoom(room.roomId, `p${seat}`, `P${seat}`, id);
    }
    room.startGame();
    room.dealCards();
    room.currentTurn = 0;
    room.hasDrawnCard = false;
    handlers = new SocketHandlers({
      to: () => ({ emit: () => {} }),
      sockets: { sockets },
    }, service);
    handlers._stopTurnTimer(room);
  });

  afterEach(() => {
    handlers._stopTurnTimer(room);
    service.deleteRoom(room.roomId);
  });

  const card = (suit, rank) => new Card(suit, rank);

  function lastPlayerState() {
    return emitted.filter((e) =>
      e.event === 'game_state_update' && e.seat === 0
    ).pop().payload;
  }

  for (const action of ['new meld', 'add to own meld', 'add to partner meld']) {
    it(`${action} keeps taken-card and twin locks in live and reconnect state`, () => {
      const run = ['3', '4', '5'].map((rank) => card('spades', rank));
      const played = action === 'new meld' ? run : [card('spades', '6')];
      const top = card('hearts', 'K');
      const twin = card('hearts', 'K');
      const spare = card('clubs', '9');
      room.playerHands.set('p0', [...played, twin, spare]);
      if (action !== 'new meld') {
        room.playerMelds.set(action === 'add to partner meld' ? 'p2' : 'p0', [run]);
      }
      room.discardPile = [top];
      handlers.handlePickUpPile(sockets.get('s0'), {});
      expect(GameValidator.validateDiscard(room, 'p0', top).isValid).to.equal(false);
      expect(GameValidator.validateDiscard(room, 'p0', twin).isValid).to.equal(false);
      expect(lastPlayerState().mustMeldCard).to.include({ cardId: top.cardId });

      if (action === 'new meld') {
        handlers.handlePlayMeld(sockets.get('s0'), { cards: played });
      } else {
        handlers.handleAddToMeld(sockets.get('s0'), {
          cards: played,
          targetPlayerIndex: action === 'add to partner meld' ? 2 : 0,
          targetMeldIndex: 0,
        });
      }

      expect(GameValidator.validateDiscard(room, 'p0', top).reason).to.equal('drawnCardRestriction');
      expect(GameValidator.validateDiscard(room, 'p0', twin).reason).to.equal('pingPongLocked');
      expect(
        GameValidator.validateDiscard(room, 'p0', spare).isValid,
        'the spare card keeps the turn playable'
      ).to.equal(true);
      const live = lastPlayerState();
      emitted.length = 0;
      handlers.handleGetGameState(sockets.get('s0'), {
        gameId: room.roomId,
        playerId: 'p0',
      });
      const reconnected = lastPlayerState();
      for (const payload of [live, reconnected]) {
        expect(payload.meldedThisTurn).to.equal(true);
        expect(payload.drawnCardRestriction).to.deep.equal([String(top.cardId)]);
        expect(payload.discardLock).to.include({ suit: 'hearts', rank: 'K' });
        expect(payload.discardLock.cardIds.map(String)).to.have.members([
          String(top.cardId),
          String(twin.cardId),
        ]);
      }
    });
  }
});
