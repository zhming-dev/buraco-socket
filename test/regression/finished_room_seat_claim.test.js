/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameRoomStatus = require('../../src/constants/gameStatus');

describe('taking a lobby seat after a finished room', () => {
  let service, handlers, room, oldRoom, oldSocket, viewer, frames, requests, sockets;

  beforeEach(() => {
    service = new GameService();
    frames = [];
    requests = [];
    sockets = new Map();
    handlers = new SocketHandlers({
      sockets: { sockets },
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    }, service);
    handlers._ensureHostHeartbeat = () => {};
    handlers._notifyBackendPlayerCount = () => {};
    handlers._notifyBackendRoomClosed = () => {};
    handlers._queueSeatLayoutSync = () => {};

    oldRoom = service.createRoom('finished-old-room', 2);
    oldRoom.backendManaged = true;
    oldRoom.backendBaseUrl = 'http://reservation.test';
    oldRoom.hostPlayerId = 'returning';
    oldSocket = socket('old-returning', 'returning');
    expect(service.joinRoom(oldRoom.roomId, 'returning', 'Returning', oldSocket.id).success).to.equal(true);
    expect(service.joinRoom(oldRoom.roomId, 'old-peer', 'Old peer', socket('old-peer').id).success).to.equal(true);
    oldRoom.status = GameRoomStatus.FINISHED;
    oldRoom.lastRoundEndPayload = { matchEnded: true, winnerId: 'returning', scores: { returning: 210, 'old-peer': 90 } };

    room = service.createRoom('new-2v2-lobby', 4);
    room.backendManaged = true;
    room.backendBaseUrl = 'http://reservation.test';
    room.hostPlayerId = 'new-host';
    room.seatReservationProtocol = 1;
    room.seatLayoutProtocol = 1;
    room.seatConnectionProtocol = 1;
    expect(service.joinRoom(room.roomId, 'new-host', 'New host', socket('new-host').id).success).to.equal(true);
    expect(service.joinRoom(room.roomId, 'new-peer', 'New peer', socket('new-peer').id).success).to.equal(true);
    viewer = socket('new-returning', 'returning');
    handlers._addSpectator(viewer, room.roomId, 'returning', 'Returning');
    handlers._seatBackendRequest = async (target, path, body) => {
      requests.push({ roomId: target.roomId, path, body });
      expect(target).to.equal(room);
      if (path === 'room-fetch') return {
        exists: true, status: 'open', players: [
          { playerId: 'returning', playerIndex: 2, isSpectator: false, reservationVersion: 10 },
        ],
      };
      if (path === 'room-seat-activate') return { activated: true, playerIndex: 2, reservationVersion: 11 };
      if (path === 'room-seat-claim-rejected') return { success: true, isSpectator: true, released: true };
      throw new Error(`Unexpected request: ${path}`);
    };
  });

  afterEach(() => {
    clearInterval(handlers._heartbeatTimer);
    for (const timer of handlers._waitingGraceTimers.values()) clearTimeout(timer);
    for (const target of service.rooms.values()) {
      for (const invite of target._pendingInvites?.values() || []) clearTimeout(invite.timeout);
    }
    service.shutdown();
  });

  function socket(id, playerId = id) {
    const participant = {
      id, connected: true, data: { authenticated: true, userId: playerId },
      join() {}, leave() {},
      emit: (event, payload) => frames.push({ socketId: id, event, payload }),
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    };
    sockets.set(id, participant);
    return participant;
  }

  function direct(event) {
    return frames.filter((frame) => frame.socketId === viewer.id && frame.event === event);
  }

  it('admits a former finished host to either empty 2v2 chair without refunding its verified reservation', async () => {
    const resultPayload = JSON.parse(JSON.stringify(oldRoom.lastRoundEndPayload));
    expect(room.getPlayers().map((player) => player.playerIndex)).to.deep.equal([0, 1]);

    // REST reserves first-free chair 2, but the viewer selected empty chair 3.
    await handlers.handleClaimSeat(viewer, { seat: 3 });

    expect(room.getPlayer('returning'), 'an ended match must not occupy a live seat').to.exist;
    expect(room.getPlayer('returning').playerIndex).to.equal(3);
    expect(room.getPlayer('returning').apiSeatReservationVersion).to.equal(11);
    expect(service.getPlayerRoom('returning')).to.equal(room);
    expect(service.getPlayerIdBySocket(viewer.id)).to.equal('returning');
    expect(service.getPlayerIdBySocket(oldSocket.id)).to.not.exist;
    expect(handlers.spectatorSocketToRoom.has(viewer.id)).to.equal(false);
    expect(requests.map((request) => request.path)).to.deep.equal(['room-fetch', 'room-seat-activate']);
    expect(direct('swap_failed')).to.be.empty;
    expect(direct('kicked')).to.be.empty;
    expect(oldRoom.lastRoundEndPayload).to.deep.equal(resultPayload);
    expect(service.getRoom(oldRoom.roomId)).to.not.exist;

    await handlers.handleDisconnect(oldSocket, 'late old socket disconnect');
    service.deleteRoom(oldRoom.roomId);
    expect(service.getPlayerRoom('returning')).to.equal(room);
    expect(service.getPlayerIdBySocket(viewer.id)).to.equal('returning');
    expect(room.getPlayer('returning').socketId).to.equal(viewer.id);
  });

  it('preserves the old finished peer roster and result when a non-host claims a new seat', async () => {
    oldRoom.hostPlayerId = 'old-peer';
    const peer = oldRoom.getPlayer('old-peer');
    const resultPayload = oldRoom.lastRoundEndPayload;

    await handlers.handleClaimSeat(viewer, { seat: 2 });

    expect(room.getPlayer('returning')).to.exist;
    expect(service.getRoom(oldRoom.roomId)).to.equal(oldRoom);
    expect(oldRoom.getPlayers()).to.deep.equal([peer]);
    expect(oldRoom.lastRoundEndPayload).to.equal(resultPayload);
    expect(service.getPlayerRoom('old-peer')).to.equal(oldRoom);
    expect(requests.some((request) => request.path === 'room-seat-claim-rejected')).to.equal(false);
    await handlers.handleDisconnect(oldSocket, 'late old socket disconnect');
    service.deleteRoom(oldRoom.roomId);
    expect(service.getPlayerRoom('returning')).to.equal(room);
    expect(service.getPlayerIdBySocket(viewer.id)).to.equal('returning');
    expect(room.getPlayer('returning').socketId).to.equal(viewer.id);
  });

  it('accepts a host invitation followed by a verified reservation from the former finished host', async () => {
    handlers.handleInviteToSeat(sockets.get('new-host'), { spectatorId: 'returning', seat: 3 });
    expect(direct('seat_invite')).to.have.length(1);
    handlers.handleRespondSeatInvite(viewer, { inviterId: 'new-host', seat: 3, accept: true });

    await handlers.handleClaimSeat(viewer, { seat: 3 });

    expect(room.getPlayer('returning')?.playerIndex).to.equal(3);
    expect(requests.some((request) => request.path === 'room-seat-claim-rejected')).to.equal(false);
    expect(direct('swap_failed')).to.be.empty;
    expect(direct('kicked')).to.be.empty;
  });

  it('retains the new binding when the old finished roster contains the same socket id', async () => {
    oldRoom.hostPlayerId = 'old-peer';
    service.socketToPlayer.delete(oldSocket.id);
    oldRoom.getPlayer('returning').socketId = viewer.id;

    await handlers.handleClaimSeat(viewer, { seat: 3 });
    service.deleteRoom(oldRoom.roomId);

    expect(service.getPlayerRoom('returning')).to.equal(room);
    expect(service.getPlayerIdBySocket(viewer.id)).to.equal('returning');
    expect(room.getPlayer('returning').socketId).to.equal(viewer.id);
  });

  for (const previousState of ['live', 'intermission', 'pending-start']) {
    it(`keeps the previous ${previousState} seat protected and refunds only the new rejected reservation`, async () => {
      if (previousState === 'live') oldRoom.status = GameRoomStatus.IN_PROGRESS;
      if (previousState === 'intermission') oldRoom.awaitingNextRound = true;
      if (previousState === 'pending-start') oldRoom._pendingBackendStart = { attemptId: 'pending' };

      await handlers.handleClaimSeat(viewer, { seat: 3 });

      expect(room.getPlayer('returning')).to.not.exist;
      expect(service.getPlayerRoom('returning')).to.equal(oldRoom);
      expect(oldRoom.getPlayer('returning').socketId).to.equal(oldSocket.id);
      expect(handlers.spectatorSocketToRoom.get(viewer.id)).to.equal(room.roomId);
      expect(requests.filter((request) => request.path === 'room-seat-claim-rejected').map((request) => request.body))
        .to.deep.equal([{ roomId: room.roomId, playerId: 'returning', reservationVersion: 11 }]);
      expect(direct('kicked')).to.have.length(1);
    });
  }

  it('does not abandon the finished result when the desired chair fills during verification', async () => {
    const request = handlers._seatBackendRequest;
    handlers._seatBackendRequest = async (target, path, body) => {
      const response = await request(target, path, body);
      if (path === 'room-seat-activate') {
        expect(service.joinRoom(room.roomId, 'winner', 'Winner', socket('winner').id, null, 3).success).to.equal(true);
      }
      return response;
    };

    await handlers.handleClaimSeat(viewer, { seat: 3 });

    expect(room.getPlayer('returning')).to.not.exist;
    expect(room.getPlayerByIndex(3).playerId).to.equal('winner');
    expect(room.getPlayerByIndex(2)).to.not.exist;
    expect(service.getPlayerRoom('returning')).to.equal(oldRoom);
    expect(oldRoom.getPlayer('returning')).to.exist;
    expect(handlers.spectatorSocketToRoom.get(viewer.id)).to.equal(room.roomId);
    expect(direct('kicked')[0].payload.reason).to.equal('seat_taken');
  });
});
