/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents } = require('../../src/constants');

describe('lobby seats remain consistent when the match starts', () => {
  it('keeps guest-first joins, a valid swap, a rejected host move and reconnect aligned with the board', async () => {
    const service = new GameService();
    const frames = [];
    const sockets = new Map();
    const io = {
      sockets: { sockets },
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    };
    const handlers = new SocketHandlers(io, service);
    // Keep the game and all roster builders real; isolate background/backend I/O.
    handlers._ensureHostHeartbeat = () => {};
    handlers._notifyBackendPlayerCount = () => {};
    handlers._notifyBackendCardsDealt = () => {};
    handlers._emitPartnerWebhook = () => {};

    function participant(playerId, id = `socket-${playerId}`) {
      const socket = {
        id, connected: true, join() {}, leave() {},
        data: { authenticated: true, userId: playerId },
        handshake: { headers: {} },
        emit: (event, payload) => frames.push({ socketId: id, event, payload }),
        to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
      };
      sockets.set(id, socket);
      return socket;
    }

    const roster = (players) => players.map(({ playerId, playerIndex }) => [playerId, playerIndex]);
    const direct = (socket, event) => frames.filter((frame) => frame.socketId === socket.id && frame.event === event);
    let room;
    try {
      handlers.syncRoomFromBackend({ roomId: 'lobby-to-board', hostPlayerId: 'host', maxPlayers: 4 });
      room = service.getRoom('lobby-to-board');
      const clients = new Map();
      for (const playerId of ['alice', 'bob', 'carol', 'host']) {
        const socket = participant(playerId);
        clients.set(playerId, socket);
        await handlers.handleJoinRoom(socket, { roomId: room.roomId, playerId, playerName: playerId });
      }
      expect(roster(room.getPlayers())).to.deep.equal([
        ['host', 0], ['alice', 1], ['bob', 2], ['carol', 3],
      ]);

      handlers.handleRequestSwap(clients.get('alice'), { targetPlayerId: 'bob', targetSeat: 2 });
      expect(direct(clients.get('bob'), 'swap_requested')).to.have.length(1);
      handlers.handleRespondSwap(clients.get('bob'), { requesterId: 'alice', accept: true });

      const expected = [['host', 0], ['bob', 1], ['alice', 2], ['carol', 3]];
      const lobbyFrames = frames.filter((frame) => frame.roomId === room.roomId && frame.event === 'seat_changed');
      expect(lobbyFrames).to.not.be.empty;
      expect(roster(lobbyFrames.at(-1).payload.players)).to.deep.equal(expected);
      const legacyRoster = frames.filter((frame) => frame.roomId === room.roomId && frame.event === SocketEvents.PLAYER_JOINED).at(-1);
      expect(roster(legacyRoster.payload.players)).to.deep.equal(expected);

      await handlers.handleClaimSeat(clients.get('host'), { seat: 3 });
      expect(direct(clients.get('host'), 'swap_failed').at(-1).payload.reason).to.equal('host_seat');
      expect(roster(direct(clients.get('host'), 'seat_changed').at(-1).payload.players)).to.deep.equal(expected);

      const oldHost = clients.get('host');
      const reconnectedHost = participant('host', 'socket-host-reconnected');
      await handlers.handleJoinRoom(reconnectedHost, { roomId: room.roomId, playerId: 'host', playerName: 'host' });
      clients.set('host', reconnectedHost);
      expect(service.getPlayerIdBySocket(oldHost.id)).to.equal(undefined);
      expect(roster(room.getPlayers())).to.deep.equal(expected);

      frames.length = 0;
      const result = handlers.triggerStartGame(room.roomId);
      expect(result.success).to.equal(true);
      expect(room.cardsDealt).to.equal(true);
      expect(room.hostPlayerId).to.equal('host');
      expect(direct(oldHost, SocketEvents.GAME_STARTED)).to.be.empty;
      for (const [playerId, seat] of expected) {
        const socket = clients.get(playerId);
        const started = direct(socket, SocketEvents.GAME_STARTED);
        expect(started, `game_started for ${playerId}`).to.not.be.empty;
        for (const frame of started) {
          expect(frame.payload.yourPlayerIndex).to.equal(seat);
          expect(frame.payload.hostId).to.equal('host');
          expect(roster(frame.payload.players)).to.deep.equal(expected);
        }
        const state = direct(socket, SocketEvents.GAME_STATE_UPDATE).at(-1).payload;
        expect(state.yourPlayerIndex).to.equal(seat);
        expect(roster(state.players)).to.deep.equal(expected);
        expect(state.yourHand).to.have.length(11);
        expect(service.getPlayerIdBySocket(socket.id)).to.equal(playerId);
      }
    } finally {
      if (room) {
        handlers._stopTurnTimer(room);
        for (const pending of room._pendingSwaps?.values() || []) clearTimeout(pending.timeout);
        for (const pending of room._pendingInvites?.values() || []) clearTimeout(pending.timeout);
      }
      service.shutdown();
    }
  });
});
