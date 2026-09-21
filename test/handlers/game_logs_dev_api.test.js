/**
 * Per-game logs end to end through SocketHandlers: a socket event wrapped by
 * _wrapSocketEvent lands its lines in that room's log, the dev accessors
 * expose them, and the log outlives the room.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents } = require('../../src/constants');
const GameService = require('../../src/services/GameService');
const logger = require('../../src/utils/logger');

const store = logger.gameLogStore;

describe('per-game logs via SocketHandlers', () => {
  const createSocketMock = (id) => {
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

  const setupDealtRoom = (roomId) => {
    const service = new GameService();
    const s1 = createSocketMock('s1');
    const s2 = createSocketMock('s2');
    const io = createIoMock([s1, s2]);
    const handler = new SocketHandlers(io, service);
    service.createRoom(roomId, 2);
    service.joinRoom(roomId, 'p1', 'P1', 's1');
    service.joinRoom(roomId, 'p2', 'P2', 's2');
    const room = service.getRoom(roomId);
    handler.handleStartGame(s1, {});
    return { service, handler, room, s1, s2 };
  };

  let consoleWas;
  beforeEach(() => {
    consoleWas = logger.enableConsole;
    logger.enableConsole = false;
    store.clear();
  });
  afterEach(() => {
    logger.enableConsole = consoleWas;
    store.clear();
  });

  it('attributes a wrapped socket event (and its untagged lines) to the seated room', async () => {
    const { service, handler, room, s1, s2 } = setupDealtRoom('log-room-1');
    try {
      const current = room.getPlayerByIndex(room.currentTurn);
      const socket = current.playerId === 'p1' ? s1 : s2;

      // The same wrapper registerEventHandlers uses for every socket.on().
      const onDraw = handler._wrapSocketEvent(socket, (data) =>
        handler.handleDrawCard(socket, data)
      );
      await onDraw({ fromDeck: true });

      const res = handler.getRoomLogsForDev('log-room-1');
      expect(res.success).to.equal(true);
      expect(res.live).to.equal(true);
      const msgs = res.entries.map((e) => e.msg);
      // Room-mentioning line...
      expect(msgs.some((m) => m.startsWith('[DRAW_CARD]') && m.includes('log-room-1'))).to.equal(
        true
      );
      // ...and a line that never names the room, captured through the ambient context.
      expect(msgs).to.include('[DRAW_CARD] ✓ Sending updated game state to all players.');
      // Nothing from this game leaked into some other room's log.
      expect(store.list().map((r) => r.roomId)).to.deep.equal(['log-room-1']);
    } finally {
      handler._stopTurnTimer(room);
      service.shutdown();
    }
  });

  it('writes structured [GAME] events with the cards for deal, draw and discard', async () => {
    const { service, handler, room, s1, s2 } = setupDealtRoom('log-room-game');
    try {
      const current = room.getPlayerByIndex(room.currentTurn);
      const socket = current.playerId === 'p1' ? s1 : s2;
      const onDraw = handler._wrapSocketEvent(socket, (data) =>
        handler.handleDrawCard(socket, data)
      );
      await onDraw({ fromDeck: true });
      const hand = room.playerHands.get(current.playerId);
      const toDiscard = hand[hand.length - 1];
      const onDiscard = handler._wrapSocketEvent(socket, (data) =>
        handler.handleDiscardCard(socket, data)
      );
      await onDiscard({ card: toDiscard.toJSON() });

      const events = handler
        .getRoomLogsForDev('log-room-game', { q: '[GAME]' })
        .entries.map((e) => ({ msg: e.msg, data: JSON.parse(e.data) }));
      const types = events.map((e) => e.data.game);
      expect(types).to.include.members(['deal', 'draw', 'discard']);

      const deal = events.find((e) => e.data.game === 'deal').data;
      expect(deal.seats.map((x) => x.cards)).to.deep.equal([11, 11]);
      expect(deal.wells).to.deep.equal([11, 11]);

      const draw = events.find((e) => e.data.game === 'draw').data;
      expect(draw.seat).to.equal(current.playerIndex);
      expect(draw.card).to.include.keys('suit', 'rank', 'cardId');

      const discard = events.find((e) => e.data.game === 'discard').data;
      expect(discard.card.cardId).to.equal(toDiscard.cardId);
      expect(discard.nextSeat).to.equal(room.currentTurn);
      expect(discard.auto).to.equal(undefined);
    } finally {
      handler._stopTurnTimer(room);
      service.shutdown();
    }
  });

  it('resolves the room for a pre-seat event from the payload roomId', () => {
    const service = new GameService();
    const handler = new SocketHandlers(createIoMock(), service);
    const socket = createSocketMock('fresh');
    try {
      expect(handler._roomIdForSocketEvent(socket, { roomId: 42 })).to.equal('42');
      expect(handler._roomIdForSocketEvent(socket, { room_id: 'x' })).to.equal('x');
      expect(handler._roomIdForSocketEvent(socket, undefined)).to.equal(null);
      expect(handler._roomIdForSocketEvent(socket, () => {})).to.equal(null);
    } finally {
      service.shutdown();
    }
  });

  it('keeps the log after the room is deleted and flags it as no longer live', () => {
    const { service, handler, room } = setupDealtRoom('log-room-2');
    try {
      expect(handler.getRoomLogsForDev('log-room-2').live).to.equal(true);
      handler._stopTurnTimer(room);
      service.deleteRoom('log-room-2');

      const after = handler.getRoomLogsForDev('log-room-2');
      expect(after.success).to.equal(true);
      expect(after.live).to.equal(false);
      expect(after.entries.length).to.be.greaterThan(0);

      const listing = handler.listRoomLogsForDev();
      const row = listing.rooms.find((r) => r.roomId === 'log-room-2');
      expect(row).to.not.equal(undefined);
      expect(row.live).to.equal(false);
      expect(listing.retentionMs).to.be.at.least(2 * 60 * 60 * 1000);
    } finally {
      service.shutdown();
    }
  });

  it('returns a 404-shaped result for a room with no log', () => {
    const service = new GameService();
    const handler = new SocketHandlers(createIoMock(), service);
    try {
      const res = handler.getRoomLogsForDev('never-existed');
      expect(res.success).to.equal(false);
      expect(res.error).to.equal('No logs for room');
    } finally {
      service.shutdown();
    }
  });

  it('tags webhook-driven work with the room from the payload', () => {
    const service = new GameService();
    const handler = new SocketHandlers(createIoMock(), service);
    try {
      handler.syncRoomFromBackend({ roomId: 'hook-room', maxPlayers: 2, players: [] });
      const res = handler.getRoomLogsForDev('hook-room');
      expect(res.success).to.equal(true);
      expect(res.entries.some((e) => e.msg.includes('room_synced_from_backend'))).to.equal(true);
    } finally {
      service.shutdown();
    }
  });

  it('every socket.on handler goes through the room-aware wrapper', () => {
    const service = new GameService();
    const handler = new SocketHandlers(createIoMock(), service);
    const seen = [];
    let wrapped = 0;
    const original = handler._wrapSocketEvent.bind(handler);
    handler._wrapSocketEvent = (socket, fn) => {
      wrapped += 1;
      return original(socket, fn);
    };
    const socket = { ...createSocketMock('reg'), on: (event) => seen.push(event) };
    try {
      handler.registerEventHandlers(socket);
      expect(seen).to.include(SocketEvents.DRAW_CARD);
      expect(wrapped).to.equal(seen.length);
    } finally {
      service.shutdown();
    }
  });
});
