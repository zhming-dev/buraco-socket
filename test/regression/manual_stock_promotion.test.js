/* eslint-env mocha */

// Reproduces deck=0 with one 11-card pozzetto still available. A stock tap used
// to be rejected while timeout auto-draw promoted the same well successfully.
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { SocketEvents } = require('../../src/constants');

function table(ruleset = 'classic', pileCount = 1) {
  const service = new GameService();
  const room = service.createRoom('stock-promotion', 4);
  const registry = new Map();
  const emitted = [];
  for (let seat = 0; seat < 4; seat += 1) {
    const id = `s${seat}`;
    service.joinRoom(room.roomId, `p${seat}`, `P${seat}`, id);
    registry.set(id, {
      id,
      emit: (event, payload) => emitted.push({ id, event, payload }),
      join: () => {},
      leave: () => {},
      to: () => ({ emit: () => {} }),
    });
  }
  room.startGame();
  room.dealCards();
  room.ruleset = ruleset;
  room.currentTurn = 0;
  room.hasDrawnCard = false;
  room.discardPile = Array.from({ length: pileCount }, () => room.deck.draw());
  room.deck.cards = [];
  room.deadPiles[0] = [];
  const handlers = new SocketHandlers({
    to: () => ({ emit: () => {} }),
    sockets: { sockets: registry },
  }, service);
  handlers._stopTurnTimer(room);
  return { service, room, handlers, emitted, socket: registry.get('s0'), registry };
}

describe('manual stock draw promotes the available pozzetto immediately', () => {
  let fixture;
  afterEach(() => {
    if (fixture) fixture.service.deleteRoom(fixture.room.roomId);
    fixture = null;
  });

  for (const ruleset of ['classic', 'professional']) {
    for (const pileCount of [0, 1, 6]) {
      it(`${ruleset}: manual draw with ${pileCount} discard cards refills and broadcasts`, () => {
        fixture = table(ruleset, pileCount);
        const { room, handlers, socket, emitted } = fixture;
        const pileBefore = [...room.discardPile];
        const handBefore = [...room.playerHands.get('p0')];
        const wellIds = new Set(room.deadPiles[1].map((card) => card.cardId));
        const wellCreditBefore = [...room.playerHasTakenPozzetto];
        const wellCountBefore = [...room.playerDeadPileCount];

        handlers.handleDrawCard(socket, { fromDeck: true });

        expect(emitted.filter((e) => e.event === SocketEvents.ERROR)).to.be.empty;
        expect(room.deck.count).to.equal(10);
        expect(room.deadPiles.map((pile) => pile.length)).to.deep.equal([0, 0]);
        expect(room.discardPile).to.deep.equal(pileBefore);
        expect(room.currentTurn).to.equal(0);
        expect(room.hasDrawnCard).to.equal(true);
        const handAfter = room.playerHands.get('p0');
        expect(handAfter.slice(0, handBefore.length)).to.deep.equal(handBefore);
        expect(handAfter).to.have.length(handBefore.length + 1);
        expect(wellIds.has(handAfter[handAfter.length - 1].cardId)).to.equal(true);
        expect([...room.playerHasTakenPozzetto]).to.deep.equal(wellCreditBefore);
        expect([...room.playerDeadPileCount]).to.deep.equal(wellCountBefore);
        const drawn = emitted.find((e) => e.id === 's0' && e.event === SocketEvents.CARD_DRAWN);
        expect(drawn.payload.card.cardId).to.equal(handAfter[handAfter.length - 1].cardId);
        const snapshot = emitted.filter((e) => e.id === 's0' && e.event === SocketEvents.GAME_STATE_UPDATE).pop();
        expect(snapshot.payload.deckCount).to.equal(10);
        expect(snapshot.payload.deadPileCounts).to.deep.equal([0, 0]);
      });
    }

    it(`${ruleset}: timeout draw consumes the same single well and advances the turn`, () => {
      fixture = table(ruleset, 6);
      const { room, handlers } = fixture;
      const handCount = room.playerHands.get('p0').length;
      const pileBefore = [...room.discardPile];

      handlers._onTurnTimerExpired(room);

      expect(room.deck.count).to.equal(10);
      expect(room.deadPiles.map((pile) => pile.length)).to.deep.equal([0, 0]);
      expect(room.discardPile.slice(0, pileBefore.length)).to.deep.equal(pileBefore);
      expect(room.discardPile).to.have.length(pileBefore.length + 1);
      expect(room.playerHands.get('p0')).to.have.length(handCount);
      expect(room.currentTurn).to.equal(1);
    });
  }

  for (const alreadyDrawn of [false, true]) {
    it(`${alreadyDrawn ? 'repeat' : 'out-of-turn'} draw cannot consume an available well`, () => {
      fixture = table();
      const { room, handlers, socket, registry, emitted } = fixture;
      room.hasDrawnCard = alreadyDrawn;
      const before = [...room.deadPiles[1]];

      handlers.handleDrawCard(alreadyDrawn ? socket : registry.get('s1'), { fromDeck: true });

      expect(room.deck.count).to.equal(0);
      expect(room.deadPiles[1]).to.deep.equal(before);
      expect(emitted.some((e) => e.event === SocketEvents.ERROR)).to.equal(true);
      expect(emitted.some((e) => e.event === SocketEvents.CARD_DRAWN)).to.equal(false);
    });
  }
});
