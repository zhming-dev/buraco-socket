/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents } = require('../../src/constants');
const GameService = require('../../src/services/GameService');
const { Card } = require('../../src/models/Deck');
const config = require('../../src/config');

describe('dev_change_cards (dev hand surgery)', () => {
  const createSocketMock = (id = 'socket-1') => {
    const emitted = [];
    return {
      id,
      handshake: { headers: {} },
      join: () => {},
      leave: () => {},
      to: () => ({ emit: () => {} }),
      emit: (event, payload) => emitted.push({ event, payload }),
      get emitted() {
        return emitted;
      },
    };
  };

  const createIoMock = (sockets = []) => ({
    sockets: { sockets: new Map(sockets.map((socket) => [socket.id, socket])) },
    to: () => ({ emit: () => {} }),
    emit: () => {},
  });

  const setupDealtRoom = () => {
    const service = new GameService();
    const s1 = createSocketMock('s1');
    const s2 = createSocketMock('s2');
    const io = createIoMock([s1, s2]);
    const handler = new SocketHandlers(io, service);
    service.createRoom('dev-room', 2);
    service.joinRoom('dev-room', 'p1', 'P1', 's1');
    service.joinRoom('dev-room', 'p2', 'P2', 's2');
    const room = service.getRoom('dev-room');
    handler.handleStartGame(s1, {});
    return { service, handler, room, s1, s2 };
  };

  const cleanup = (service, handler, room) => {
    if (room) handler?._stopTurnTimer(room);
    service?.shutdown();
  };

  it('replaces the target hand with the requested cards and recycles the old ones into the deck', () => {
    const { service, handler, room, s1 } = setupDealtRoom();
    try {
      // Deterministic availability: request instances that provably sit in the
      // allowed pools (deck / target's own hand / wells), not fixed labels —
      // a fixed label can land in the opponent's hand depending on the shuffle.
      const deckCard = room.deck.cards[0];
      const ownCard = room.playerHands.get('p1')[0];
      const wellCard = room.deadPiles[1][0];
      const deckCountBefore = room.deck.count;

      const result = handler.changePlayerCards({
        roomId: 'dev-room',
        target_user: 'p1',
        change_cards: [
          { cardId: deckCard.cardId },
          { suit: ownCard.suit, rank: ownCard.rank },
          { suit: wellCard.suit, rank: wellCard.rank },
        ],
      });

      expect(result.success).to.equal(true);
      expect(result.targetPlayerId).to.equal('p1');

      const hand = room.playerHands.get('p1');
      expect(hand).to.have.length(3);
      expect(hand.map((c) => c.cardId)).to.include(deckCard.cardId);
      expect(hand.some((c) => c.suit === ownCard.suit && c.rank === ownCard.rank)).to.equal(true);
      expect(hand.some((c) => c.suit === wellCard.suit && c.rank === wellCard.rank)).to.equal(true);
      // 11 old cards went back to the deck bottom; 3 new ones were pulled out
      // (some may have come from the old hand itself, so exact count is
      // bounded, not fixed).
      expect(room.deck.count).to.be.at.least(deckCountBefore + 8);
      expect(room.deck.count).to.be.at.most(deckCountBefore + 11);
      // Card conservation: hands + deck + wells + discard still sum to 108.
      const total =
        room.getPlayers().reduce((sum, p) => sum + room.playerHands.get(p.playerId).length, 0) +
        room.deck.count +
        room.deadPiles.reduce((sum, pile) => sum + pile.length, 0) +
        room.discardPile.length;
      expect(total).to.equal(108);

      // A personalized game_state_update reached the target with the new hand.
      const update = s1.emitted
        .filter((e) => e.event === SocketEvents.GAME_STATE_UPDATE)
        .pop();
      expect(update).to.not.equal(undefined);
      expect(update.payload.yourHand).to.have.length(3);
      expect(update.payload.otherPlayersHandCounts[0]).to.equal(3);
    } finally {
      cleanup(service, handler, room);
    }
  });

  it('resolves the target by seat index and keeps request order', () => {
    const { service, handler, room } = setupDealtRoom();
    try {
      const first = room.deck.cards[0];
      const second = room.deck.cards[1];
      const result = handler.changePlayerCards({
        roomId: 'dev-room',
        target_user: 1, // seat index → p2
        change_cards: [
          { suit: first.suit, rank: first.rank },
          { suit: second.suit, rank: second.rank },
        ],
      });

      expect(result.success).to.equal(true);
      expect(result.targetSeat).to.equal(1);

      const hand = room.playerHands.get('p2');
      expect(hand.map((c) => [c.suit, c.rank])).to.deep.equal([
        [first.suit, first.rank],
        [second.suit, second.rank],
      ]);
    } finally {
      cleanup(service, handler, room);
    }
  });

  it('matches a joker request when one exists in the pools', () => {
    const { service, handler, room } = setupDealtRoom();
    try {
      // Inject a joker into the deck so availability is deterministic (the
      // natural 4 jokers may all sit in the opponent's hand after a shuffle).
      const injected = new Card('joker', 'joker');
      room.deck.cards.push(injected);

      // The world holds 4 natural jokers + this injected one = 5 total, so
      // asking for 6 is ALWAYS over-asking → atomic rejection with a missing
      // report, wherever the natural ones happen to sit.
      const result = handler.changePlayerCards({
        roomId: 'dev-room',
        target_user: 'p1',
        change_cards: [
          { rank: 'joker' },
          { rank: 'joker' },
          { rank: 'joker' },
          { rank: 'joker' },
          { rank: 'joker' },
          { rank: 'joker' },
        ],
      });

      expect(result.success).to.equal(false);
      expect(result.missing.length).to.be.at.least(1);
      expect(room.playerHands.get('p1')).to.have.length(11);

      // Now ask for just the one guaranteed joker.
      const ok = handler.changePlayerCards({
        roomId: 'dev-room',
        target_user: 'p1',
        change_cards: [{ rank: 'joker' }],
      });
      expect(ok.success).to.equal(true);
      const hand = room.playerHands.get('p1');
      expect(hand).to.have.length(1);
      expect(hand[0].isJoker).to.equal(true);
    } finally {
      cleanup(service, handler, room);
    }
  });

  it('rejects atomically when more copies are requested than exist outside other hands', () => {
    const { service, handler, room } = setupDealtRoom();
    try {
      const handBefore = room.playerHands.get('p1').slice();
      // A two-deck world holds at most 2 instances of any label — asking for
      // 3 of the deck-top label is ALWAYS over-asking, wherever they sit.
      const label = room.deck.cards[0];
      const result = handler.changePlayerCards({
        roomId: 'dev-room',
        target_user: 'p1',
        change_cards: [
          { suit: label.suit, rank: label.rank },
          { suit: label.suit, rank: label.rank },
          { suit: label.suit, rank: label.rank },
        ],
      });

      expect(result.success).to.equal(false);
      expect(result.missing.length).to.be.at.least(1);
      // Nothing was mutated.
      expect(room.playerHands.get('p1').map((c) => c.cardId)).to.deep.equal(
        handBefore.map((c) => c.cardId)
      );
    } finally {
      cleanup(service, handler, room);
    }
  });

  // Card conservation: a dev replace may only draw from the deck, the wells and
  // the target's own hand. Every physical card stays in the game exactly once.
  const allCardIds = (room) => {
    const ids = [];
    ids.push(...room.deck.cards.map((c) => c.cardId));
    for (const pile of room.deadPiles) ids.push(...pile.map((c) => c.cardId));
    ids.push(...room.discardPile.map((c) => c.cardId));
    for (const p of room.getPlayers()) {
      ids.push(...(room.playerHands.get(p.playerId) || []).map((c) => c.cardId));
      for (const meld of room.playerMelds.get(p.playerId) || []) ids.push(...meld.map((c) => c.cardId));
    }
    return ids.sort((a, b) => a - b);
  };

  it('keeps every physical card in the game exactly once after a replace', () => {
    const { service, handler, room } = setupDealtRoom();
    try {
      const before = allCardIds(room);
      expect(new Set(before).size).to.equal(before.length); // no duplicates to begin with
      const fromDeck = room.deck.cards[0];
      const fromWell = room.deadPiles[0][0];
      const own = room.playerHands.get('p1')[0];
      const result = handler.changePlayerCards({
        roomId: 'dev-room',
        target_user: 'p1',
        change_cards: [{ cardId: fromDeck.cardId }, { cardId: fromWell.cardId }, { cardId: own.cardId }],
      });
      expect(result.success).to.equal(true);
      const after = allCardIds(room);
      expect(after).to.deep.equal(before);
      // and each source actually gave up its instance
      expect(room.deck.cards.some((c) => c.cardId === fromDeck.cardId)).to.equal(false);
      expect(room.deadPiles[0].some((c) => c.cardId === fromWell.cardId)).to.equal(false);
      expect(room.playerHands.get('p1').map((c) => c.cardId)).to.deep.equal([
        fromDeck.cardId,
        fromWell.cardId,
        own.cardId,
      ]);
    } finally {
      cleanup(service, handler, room);
    }
  });

  it('refuses a card that sits in another hand, a meld or the discard pile — and says where', () => {
    const { service, handler, room } = setupDealtRoom();
    try {
      const inOpponentHand = room.playerHands.get('p2')[0];
      const inDiscard = room.deck.cards.pop();
      room.discardPile.push(inDiscard);
      const inMeld = room.deck.cards.pop();
      room.playerMelds.set('p2', [[inMeld]]);
      const before = allCardIds(room);

      const result = handler.changePlayerCards({
        roomId: 'dev-room',
        target_user: 'p1',
        change_cards: [
          { cardId: inOpponentHand.cardId },
          { cardId: inDiscard.cardId },
          { cardId: inMeld.cardId },
        ],
      });

      expect(result.success).to.equal(false);
      expect(result.missing.map((m) => m.where)).to.deep.equal([
        ['seat 1 hand'],
        ['discard pile'],
        ['seat 1 meld'],
      ]);
      expect(result.error).to.include('seat 1 hand');
      expect(result.error).to.include('discard pile');
      expect(allCardIds(room)).to.deep.equal(before); // untouched
    } finally {
      cleanup(service, handler, room);
    }
  });

  it('reports "no copy left" when more copies are asked than the two decks hold', () => {
    const { service, handler, room } = setupDealtRoom();
    try {
      const result = handler.changePlayerCards({
        roomId: 'dev-room',
        target_user: 'p1',
        change_cards: [
          { suit: 'hearts', rank: 'A' },
          { suit: 'hearts', rank: 'A' },
          { suit: 'hearts', rank: 'A' },
        ],
      });
      expect(result.success).to.equal(false);
      const last = result.missing[result.missing.length - 1];
      expect(last.rank).to.equal('A');
      // The third A♥ does not exist anywhere free; `where` lists only the
      // copies that are locked up (possibly none).
      expect(last.where).to.be.an('array');
      expect(result.error).to.match(/no copy left|seat \d hand|meld|discard/);
    } finally {
      cleanup(service, handler, room);
    }
  });

  it('dev detail exposes the free pools (deck, wells) and melds for availability checks', () => {
    const { service, handler, room } = setupDealtRoom();
    try {
      const detail = handler.getRoomDevDetail('dev-room');
      expect(detail.deck).to.have.length(room.deck.count);
      expect(detail.deck[0]).to.have.property('cardId');
      expect(detail.deadPiles.map((p) => p.length)).to.deep.equal(detail.deadPileCounts);
      expect(detail.players[0].melds).to.deep.equal([]);
    } finally {
      cleanup(service, handler, room);
    }
  });

  it('socket route rejects a bad secret and acks the failure', () => {
    const { service, handler, room, s1 } = setupDealtRoom();
    const originalSecret = config.security.webhookSecret;
    config.security.webhookSecret = 'correct-horse';
    try {
      const operator = createSocketMock('operator');
      handler.handleDevChangeCards(operator, {
        roomId: 'dev-room',
        target_user: 'p1',
        change_cards: [{ suit: 'hearts', rank: 'A' }],
        secret: 'wrong',
      });

      const ack = operator.emitted.find(
        (e) => e.event === SocketEvents.DEV_CHANGE_CARDS_RESULT
      );
      expect(ack).to.not.equal(undefined);
      expect(ack.payload.success).to.equal(false);
      expect(ack.payload.error).to.include('Unauthorized');
      expect(room.playerHands.get('p1')).to.have.length(11);
      expect(s1).to.not.equal(undefined);
    } finally {
      config.security.webhookSecret = originalSecret;
      cleanup(service, handler, room);
    }
  });

  it('socket route accepts the correct secret and applies the change', () => {
    const { service, handler, room } = setupDealtRoom();
    const originalSecret = config.security.webhookSecret;
    config.security.webhookSecret = 'correct-horse';
    try {
      const operator = createSocketMock('operator');
      handler.handleDevChangeCards(operator, {
        roomId: 'dev-room',
        target_user: 'p1',
        change_cards: [{ cardId: room.playerHands.get('p1')[3].cardId }],
        secret: 'correct-horse',
      });

      const ack = operator.emitted.find(
        (e) => e.event === SocketEvents.DEV_CHANGE_CARDS_RESULT
      );
      expect(ack.payload.success).to.equal(true);
      // Exact-instance request: the same physical card came back, alone.
      const hand = room.playerHands.get('p1');
      expect(hand).to.have.length(1);
      expect(hand[0].cardId).to.equal(ack.payload.hand[0].cardId);
    } finally {
      config.security.webhookSecret = originalSecret;
      cleanup(service, handler, room);
    }
  });

  it('rejects when the game is not in progress', () => {
    const service = new GameService();
    const s1 = createSocketMock('s1');
    const handler = new SocketHandlers(createIoMock([s1]), service);
    service.createRoom('lobby-room', 2);
    service.joinRoom('lobby-room', 'p1', 'P1', 's1');
    try {
      const result = handler.changePlayerCards({
        roomId: 'lobby-room',
        target_user: 'p1',
        change_cards: [{ suit: 'hearts', rank: 'A' }],
      });
      expect(result.success).to.equal(false);
      expect(result.error).to.include('not in progress');
    } finally {
      service.shutdown();
    }
  });

  it('dev reads: lists rooms and serves full detail with real hands', () => {
    const { service, handler, room } = setupDealtRoom();
    try {
      const listing = handler.listRoomsForDev();
      expect(listing.success).to.equal(true);
      const entry = listing.rooms.find((r) => r.roomId === 'dev-room');
      expect(entry).to.not.equal(undefined);
      expect(entry.playerCount).to.equal(2);
      expect(entry.cardsDealt).to.equal(true);
      expect(entry.deckCount).to.equal(63); // 108 - 22 hands - 22 wells - 1 flip

      const detail = handler.getRoomDevDetail('dev-room');
      expect(detail.success).to.equal(true);
      expect(detail.players).to.have.length(2);
      const p1 = detail.players.find((p) => p.playerId === 'p1');
      expect(p1.hand).to.have.length(11);
      expect(p1.hand[0]).to.have.property('cardId');
      expect(detail.discardPile).to.have.length(1);
      expect(detail.deadPileCounts).to.deep.equal([11, 11]);

      expect(handler.getRoomDevDetail('missing-room').success).to.equal(false);
    } finally {
      cleanup(service, handler, room);
    }
  });

  it('development broadcast state is surfaced for the dashboard', () => {
    const service = new GameService();
    const handler = new SocketHandlers(createIoMock([]), service);
    try {
      // All-false flags are a valid "all clear" for the maintenance toggle.
      const allClear = handler.broadcastDevelopmentNotice({
        maintenance_mode: false,
        restart_server: false,
      });
      expect(allClear.success).to.equal(true);

      handler.broadcastDevelopmentNotice({ maintenance_mode: true });
      const listing = handler.listRoomsForDev();
      expect(listing.development.maintenance_mode).to.equal(true);
      expect(listing.development.at).to.be.a('string');

      // A payload with NO flag keys is rejected (typo guard).
      const bad = handler.broadcastDevelopmentNotice({ message: 'no flags' });
      expect(bad.success).to.equal(false);
    } finally {
      service.shutdown();
    }
  });
});
