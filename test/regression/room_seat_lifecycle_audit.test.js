/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');

describe('room/seat lifecycle consistency across client flows', () => {
  let service, handlers, sockets, frames, room;

  beforeEach(() => {
    service = new GameService();
    sockets = new Map();
    frames = [];
    handlers = new SocketHandlers({
      sockets: { sockets },
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    }, service);
    handlers._ensureHostHeartbeat = () => {};
    handlers._notifyBackendPlayerCount = () => {};
    handlers._notifyBackendCardsDealt = () => {};
    handlers._emitPartnerWebhook = () => {};
    handlers._backendUrlForRoom = () => null;
  });

  afterEach(() => {
    for (const current of service.rooms.values()) {
      handlers._stopTurnTimer(current);
      for (const entry of current._pendingSwaps?.values() || []) clearTimeout(entry.timeout);
      for (const entry of current._pendingInvites?.values() || []) clearTimeout(entry.timeout);
    }
    service.shutdown();
  });

  function participant(playerId, id = `socket-${playerId}`) {
    const socket = {
      id, connected: true, data: { authenticated: true, userId: playerId },
      handshake: { headers: {} }, join() {}, leave() {},
      emit: (event, payload) => frames.push({ socketId: id, event, payload }),
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    };
    sockets.set(id, socket);
    return socket;
  }

  function join(socket, isSpectator = false) {
    return handlers.handleJoinRoom(socket, {
      roomId: room.roomId, playerId: socket.data.userId,
      playerName: `User ${socket.data.userId}`, isSpectator,
    });
  }

  function assertConsistent(label) {
    const occupied = new Set();
    const identities = new Set();
    for (const current of service.rooms.values()) {
      const seats = new Set();
      for (const player of current.getPlayers()) {
        expect(identities.has(player.playerId), `${label}: duplicate membership`).to.equal(false);
        identities.add(player.playerId);
        expect(Number.isInteger(player.playerIndex), `${label}: integer seat`).to.equal(true);
        expect(player.playerIndex, `${label}: seat bounds`).to.be.within(0, current.maxPlayers - 1);
        expect(seats.has(player.playerIndex), `${label}: unique seat`).to.equal(false);
        seats.add(player.playerIndex);
        expect(service.playerToRoom.get(player.playerId), `${label}: room binding`).to.equal(current.roomId);
        expect(service.socketToPlayer.get(player.socketId), `${label}: socket binding`).to.equal(player.playerId);
        expect(occupied.has(player.socketId), `${label}: socket owns one seat`).to.equal(false);
        occupied.add(player.socketId);
        if (player.playerId === current.hostPlayerId) expect(player.playerIndex, label).to.equal(0);
      }
    }
    for (const [socketId, playerId] of service.socketToPlayer) {
      const player = service.getPlayerRoom(playerId)?.getPlayer(playerId);
      expect(player?.socketId, `${label}: no stale socket mapping`).to.equal(socketId);
    }
    for (const [roomId, spectators] of handlers.roomSpectators) {
      for (const [socketId, spectator] of spectators) {
        expect(occupied.has(socketId), `${label}: seated socket also spectator`).to.equal(false);
        expect(handlers.spectatorSocketToRoom.get(socketId), `${label}: spectator room binding`).to.equal(roomId);
        expect(service.getRoom(roomId)?.getPlayer(spectator.spectatorId), `${label}: duplicate roster role`).to.not.exist;
      }
    }
  }

  for (const maxPlayers of [2, 4]) {
    it(`keeps one role per socket through watch, join, stand, rejoin and claim (${maxPlayers} seats)`, async () => {
      handlers.syncRoomFromBackend({ roomId: `roles-${maxPlayers}`, hostPlayerId: '1', maxPlayers });
      room = service.getRoom(`roles-${maxPlayers}`);
      const host = participant('1');
      const guest = participant('2');
      await join(host);
      await join(guest, true);
      assertConsistent('watch');

      // The REST sit has succeeded and reconnect sends join_room rather than
      // claim_seat. Both are real admission paths used by the client.
      await join(guest);
      assertConsistent('spectator to seated join');

      handlers.handleLeaveSeat(guest);
      assertConsistent('stand');
      await join(guest);
      assertConsistent('stand then seated rejoin');

      handlers.handleHostKick(host, { targetId: '2', toSpectator: true });
      assertConsistent('host demotion');
      await handlers.handleClaimSeat(guest, { seat: 1 });
      assertConsistent('claim after demotion');

      const replacement = participant('2', 'replacement-2');
      await join(replacement);
      assertConsistent('socket replacement');
      handlers.handleLeaveSeat(guest);
      assertConsistent('stale leave');
      expect(room.getPlayer('2').socketId).to.equal(replacement.id);
    });
  }

  it('preserves the same seats and socket identities through a mixed 2v2 lobby and deal', async () => {
    handlers.syncRoomFromBackend({ roomId: 'mixed-2v2', hostPlayerId: '1', maxPlayers: 4 });
    room = service.getRoom('mixed-2v2');
    const clients = new Map(['1', '2', '3', '4', '5'].map((id) => [id, participant(id)]));
    for (const id of ['2', '3', '4', '1']) await join(clients.get(id));
    await join(clients.get('5'), true);
    assertConsistent('guest-first full lobby');

    handlers.handleRequestSwap(clients.get('2'), { targetPlayerId: '3', targetSeat: 2 });
    handlers.handleRespondSwap(clients.get('3'), { requesterId: '2', accept: true });
    assertConsistent('consensual swap');
    handlers.handleLeaveSeat(clients.get('4'));
    handlers.handleInviteToSeat(clients.get('1'), { spectatorId: '5', seat: 3 });
    handlers.handleRespondSeatInvite(clients.get('5'), { inviterId: '1', seat: 3, accept: true });
    await handlers.handleClaimSeat(clients.get('5'), { seat: 3 });
    await handlers.handleClaimSeat(clients.get('4'), { seat: 3 });
    assertConsistent('invite winner and losing claim');
    expect(room.getPlayer('4')).to.not.exist;

    handlers.handleHostSwapSeats(clients.get('1'), { seatA: 1, seatB: 3 });
    assertConsistent('host moves non-hosts');
    const expected = room.getPlayers().map((player) => [player.playerId, player.playerIndex]);
    expect(handlers.triggerStartGame(room.roomId).success).to.equal(true);
    assertConsistent('deal');
    expect(room.getPlayers().map((player) => [player.playerId, player.playerIndex])).to.deep.equal(expected);
    for (const [playerId, seat] of expected) {
      const state = frames.filter((frame) => frame.socketId === clients.get(playerId).id &&
        frame.event === 'game_state_update').at(-1).payload;
      expect(state.yourPlayerIndex).to.equal(seat);
      expect(state.yourHand).to.have.length(11);
    }
  });

  it('restores the latest swapped and vacated lobby seats after a runtime restart', async () => {
    const redis = new InMemoryRedis();
    const manager = new FailureManager(handlers.io, redis, service, {
      info() {}, warn() {}, error() {}, debug() {},
    });
    handlers.failureManager = manager;
    try {
      handlers.syncRoomFromBackend({ roomId: 'persisted-lobby', hostPlayerId: '1', maxPlayers: 4 });
      room = service.getRoom('persisted-lobby');
      const host = participant('1');
      const a = participant('2');
      const b = participant('3');
      for (const socket of [host, a, b]) await join(socket);
      handlers.handleHostSwapSeats(host, { seatA: 1, seatB: 3 });
      handlers.handleLeaveSeat(b);
      const restored = await manager.restorePersistedRoom(room.roomId);
      expect(restored.getPlayer('1').playerIndex).to.equal(0);
      expect(restored.getPlayer('2').playerIndex).to.equal(3);
      expect(restored.getPlayer('3')).to.not.exist;
      expect(restored.getPlayerByIndex(1)).to.not.exist;
      expect(restored.getPlayerByIndex(2)).to.not.exist;
    } finally {
      manager.dispose();
      await redis.quit();
    }
  });
});
