/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameRoomStatus = require('../../src/constants/gameStatus');

describe('room and seat mutation authority', () => {
  let service, handlers, room, sockets, frames;

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
    handlers._notifyBackendRoomClosed = () => {};
    handlers._queueSeatLayoutSync = () => {};
    room = service.createRoom('mutation-room', 4);
    join('host');
    join('a');
    join('b');
  });

  afterEach(() => {
    for (const current of service.rooms.values()) {
      for (const pending of current._pendingSwaps?.values() || []) clearTimeout(pending.timeout);
      for (const pending of current._pendingInvites?.values() || []) clearTimeout(pending.timeout);
    }
    clearInterval(handlers._heartbeatTimer);
    for (const timer of handlers._waitingGraceTimers.values()) clearTimeout(timer);
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

  function join(id, socketId = `socket-${id}`, target = room) {
    const participant = socket(socketId, id);
    expect(service.joinRoom(target.roomId, id, id, socketId).success).to.equal(true);
    return participant;
  }

  function viewer(id = 'viewer', target = room) {
    const participant = socket(`viewer-${id}`, id);
    handlers._addSpectator(participant, target.roomId, id, id);
    return participant;
  }

  it('an authenticated superseded host socket cannot take back the seat through a rejected start', () => {
    const old = sockets.get('socket-host');
    join('host', 'new-host');
    expect(service.getPlayerIdBySocket(old.id)).to.not.exist;
    handlers.handleStartGame(old, { roomId: room.roomId });
    expect(room.getPlayer('host').socketId).to.equal('new-host');
    expect(service.getPlayerIdBySocket(old.id)).to.not.exist;
    expect(room.status).to.equal(GameRoomStatus.WAITING);
  });

  for (const status of [GameRoomStatus.FINISHED, GameRoomStatus.ABANDONED]) {
    it(`keeps a terminal ${status} roster immutable`, () => {
      const watching = viewer();
      room.status = status;
      const before = room.getPlayers().map((player) => [player.playerId, player.playerIndex]);
      handlers.handleClaimSeat(watching, { seat: 3 });
      handlers.handleLeaveSeat(sockets.get('socket-a'));
      handlers.handleHostSwapSeats(sockets.get('socket-host'), { seatA: 1, seatB: 2 });
      handlers.handleHostKick(sockets.get('socket-host'), { targetId: 'b', toSpectator: true });
      expect(room.getPlayers().map((player) => [player.playerId, player.playerIndex])).to.deep.equal(before);
      expect(handlers.spectatorSocketToRoom.get(watching.id)).to.equal(room.roomId);
    });
  }

  it('a host move invalidates a pending swap even if the host later puts the seats back', () => {
    handlers.handleRequestSwap(sockets.get('socket-a'), { targetPlayerId: 'b', targetSeat: 2 });
    expect(room._pendingSwaps.size).to.equal(1);
    handlers.handleHostSwapSeats(sockets.get('socket-host'), { seatA: 1, seatB: 3 });
    handlers.handleHostSwapSeats(sockets.get('socket-host'), { seatA: 3, seatB: 1 });
    handlers.handleRespondSwap(sockets.get('socket-b'), { requesterId: 'a', accept: true });
    expect(room.getPlayer('a').playerIndex).to.equal(1);
    expect(room.getPlayer('b').playerIndex).to.equal(2);
    expect(room._pendingSwaps.size).to.equal(0);
  });

  it('a spectator claim cannot duplicate an identity that is already seated in another runtime room', () => {
    const other = service.createRoom('other-room', 4);
    join('other-host', 'socket-other-host', other);
    const watching = viewer('a', other);
    handlers.handleClaimSeat(watching, { seat: 1 });
    expect(other.getPlayer('a')).to.not.exist;
    expect(service.getPlayerRoom('a')).to.equal(room);
    expect(room.getPlayer('a').socketId).to.equal('socket-a');
  });

  it('an old invite answer cannot consume a newer invitation with a different seat', () => {
    const watching = viewer();
    const host = sockets.get('socket-host');
    handlers.handleInviteToSeat(host, { spectatorId: 'viewer', seat: 3 });
    handlers.handleCancelSeatInvite(host, { spectatorId: 'viewer' });
    handlers.handleLeaveSeat(sockets.get('socket-b'));
    handlers.handleInviteToSeat(host, { spectatorId: 'viewer', seat: 2 });
    frames.length = 0;
    handlers.handleRespondSeatInvite(watching, { inviterId: 'host', seat: 3, accept: true });
    expect(room._pendingInvites.get('viewer')?.seat).to.equal(2);
    expect(frames.some((frame) => frame.event === 'seat_invite_responded')).to.equal(false);
  });

  it('a sticky spectator reconnect reconciles a proven API stand-up despite its lost socket leave', async () => {
    room.seatLayoutProtocol = 1;
    room.backendBaseUrl = 'http://reservation.test';
    handlers._fetchSeatReservation = async () => ({ isSpectator: true, reservationVersion: 22 });
    const watching = socket('returning-a', 'a');
    await handlers.handleJoinRoom(watching, {
      roomId: room.roomId, playerId: 'a', playerName: 'A', isSpectator: true,
    });
    expect(room.getPlayer('a')).to.not.exist;
    expect(service.getPlayerIdBySocket('socket-a')).to.not.exist;
    expect(service.getPlayerRoom('a')).to.not.exist;
    expect(handlers.spectatorSocketToRoom.get(watching.id)).to.equal(room.roomId);
    expect(room.getPlayer('host').playerIndex).to.equal(0);
  });
  function enableBackend(target = room) {
    target.backendManaged = true;
    target.backendBaseUrl = 'http://reservation.test';
    target.seatReservationProtocol = 1;
    target.seatLayoutProtocol = 1;
    target.seatConnectionProtocol = 1;
  }

  it('honors the verified API chair and binds its activated connection generation', async () => {
    enableBackend();
    service.leaveRoom('a');
    const entering = socket('socket-new', 'new');
    const calls = [];
    handlers._seatBackendRequest = async (_room, path, body) => {
      calls.push({ path, body });
      if (path === 'room-fetch') return { exists: true, status: 'open', players: [
        { playerId: 'new', isSpectator: false, playerIndex: 3, reservationVersion: 4 },
      ] };
      expect(path).to.equal('room-seat-activate');
      return { activated: true, playerIndex: 3, reservationVersion: 5 };
    };
    await handlers.handleJoinRoom(entering, { roomId: room.roomId, playerId: 'new', playerName: 'New' });
    expect(room.getPlayer('new').playerIndex).to.equal(3);
    expect(room.getPlayer('new').apiSeatReservationVersion).to.equal(5);
    expect(calls[1].body).to.deep.equal({ roomId: room.roomId, playerId: 'new', expectedReservationVersion: 4, connectionId: entering.id });
    expect(frames.some((frame) => frame.socketId === entering.id && frame.event === 'player_joined' && frame.payload.isSpectator === false)).to.equal(true);
  });

  it('replays the same activation after a lost ACK without incrementing a second generation', async () => {
    enableBackend();
    const attempts = [];
    handlers._seatBackendRequest = async (_room, path, body) => {
      expect(path).to.equal('room-seat-activate');
      attempts.push(body);
      if (attempts.length === 1) throw new Error('lost response after commit');
      return { activated: true, playerIndex: 3, reservationVersion: 8 };
    };
    const bound = await handlers._activateSeatConnection(socket('reconnected', 'new'), room, 'new', {
      isSpectator: false, playerIndex: 3, reservationVersion: 7,
    });
    expect(attempts).to.have.length(2);
    expect(attempts[1]).to.deep.equal(attempts[0]);
    expect(bound.reservationVersion).to.equal(8);
  });

  it('never rebinds an existing seat when activation rejects a stale generation', async () => {
    enableBackend();
    room.getPlayer('a').apiSeatReservationVersion = 4;
    handlers._fetchSeatReservation = async () => ({ isSpectator: false, playerIndex: 1, reservationVersion: 4 });
    handlers._seatBackendRequest = async () => ({ activated: false, reason: 'stale_reservation' });
    await handlers.handleJoinRoom(socket('stale-a', 'a'), { roomId: room.roomId, playerId: 'a', playerName: 'A' });
    expect(room.getPlayer('a').socketId).to.equal('socket-a');
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(4);
    expect(service.getPlayerIdBySocket('stale-a')).to.not.exist;
  });

  it('does not seat or re-register a join whose lookup completed after leave', async () => {
    enableBackend();
    let finish;
    handlers._fetchSeatReservation = () => new Promise((resolve) => { finish = resolve; });
    const entering = socket('cancelled', 'new');
    const pending = handlers.handleJoinRoom(entering, { roomId: room.roomId, playerId: 'new', playerName: 'New' });
    await Promise.resolve();
    handlers.handleLeaveRoom(entering);
    finish({ isSpectator: false, playerIndex: 3, reservationVersion: 1 });
    await pending;
    expect(room.getPlayer('new')).to.not.exist;
    expect(handlers.spectatorSocketToRoom.has(entering.id)).to.equal(false);
  });

  it('rejects unknown private watchers and unauthenticated opted-in viewers', async () => {
    enableBackend();
    let calls = 0;
    handlers._seatBackendRequest = async () => { calls += 1; return { authorized: false, reason: 'not_joined' }; };
    const unknown = socket('unknown', 'unknown');
    await handlers.handleJoinRoom(unknown, { roomId: room.roomId, playerId: 'unknown', isSpectator: true });
    expect(handlers.spectatorSocketToRoom.has(unknown.id)).to.equal(false);
    unknown.data = {};
    await handlers.handleJoinRoom(unknown, { roomId: room.roomId, playerId: 'host', isSpectator: true });
    expect(calls).to.equal(1);
    expect(handlers.spectatorSocketToRoom.has(unknown.id)).to.equal(false);
  });

  for (const status of [GameRoomStatus.WAITING, GameRoomStatus.IN_PROGRESS]) {
    it(`admits an authorized ${status} viewer under their verified identity`, async () => {
      enableBackend();
      room.status = status;
      const watching = socket('viewer-verified', 'verified');
      handlers._seatBackendRequest = async (_room, path, body) => {
        expect(path).to.equal('room-participant');
        expect(body.playerId).to.equal('verified');
        return { authorized: true, playerId: 'verified', isSpectator: true, reservationVersion: 0 };
      };
      await handlers.handleJoinRoom(watching, { roomId: room.roomId, playerId: 'host', playerName: 'Viewer', isSpectator: true });
      expect(handlers.roomSpectators.get(room.roomId).get(watching.id).spectatorId).to.equal('verified');
      expect(service.getPlayerIdBySocket(watching.id)).to.not.exist;
      expect(frames.find((frame) => frame.socketId === watching.id && frame.event === 'player_joined').payload.spectatorId).to.equal('verified');
    });
  }

  it('cancels viewer admission when its permission response arrives after leaving', async () => {
    enableBackend();
    let finish;
    handlers._seatBackendRequest = () => new Promise((resolve) => { finish = resolve; });
    const watching = socket('cancel-view', 'viewer');
    const pending = handlers.handleJoinRoom(watching, { roomId: room.roomId, playerId: 'viewer', isSpectator: true });
    handlers.handleLeaveRoom(watching);
    finish({ authorized: true, playerId: 'viewer', isSpectator: true });
    await pending;
    expect(handlers.spectatorSocketToRoom.has(watching.id)).to.equal(false);
  });

  it('keeps only the current room spectator registration after switching rooms', async () => {
    const watching = viewer();
    const other = service.createRoom('watch-other', 2);
    await handlers.handleJoinRoom(watching, { roomId: other.roomId, playerId: 'viewer', isSpectator: true });
    expect(handlers.roomSpectators.get(room.roomId)?.has(watching.id) || false).to.equal(false);
    expect(handlers.spectatorSocketToRoom.get(watching.id)).to.equal(other.roomId);
  });

  it('a reserved-chair collision refunds only that generation and keeps the loser watching', async () => {
    enableBackend();
    const entering = socket('seat-loser', 'loser');
    const releases = [];
    handlers._seatBackendRequest = async (_room, path, body) => {
      if (path === 'room-fetch') return { exists: true, status: 'open', players: [
        { playerId: 'loser', isSpectator: false, playerIndex: 1, reservationVersion: 4 },
      ] };
      if (path === 'room-seat-activate') return { activated: true, playerIndex: 1, reservationVersion: 5 };
      if (path === 'room-seat-claim-rejected') { releases.push(body); return { success: true, isSpectator: true }; }
      expect(path).to.equal('room-participant');
      return { authorized: true, playerId: 'loser', isSpectator: true, reservationVersion: 6 };
    };
    await handlers.handleJoinRoom(entering, { roomId: room.roomId, playerId: 'loser', playerName: 'Loser' });
    expect(room.getPlayer('loser')).to.not.exist;
    expect(room.getPlayerByIndex(3)).to.not.exist;
    expect(releases[0].reservationVersion).to.equal(5);
    expect(handlers.spectatorSocketToRoom.get(entering.id)).to.equal(room.roomId);
    expect(frames.some((frame) => frame.socketId === entering.id && frame.event === 'kicked' && frame.payload.reason === 'seat_taken')).to.equal(true);
  });

  it('rejecting a full destination preserves the original standalone seat', () => {
    const other = service.createRoom('full-destination', 2);
    join('other-host', 'other-host-socket', other);
    join('other-guest', 'other-guest-socket', other);
    const result = service.joinRoom(other.roomId, 'a', 'A', 'socket-a');
    expect(result.success).to.equal(false);
    expect(service.getPlayerRoom('a')).to.equal(room);
    expect(room.getPlayer('a').socketId).to.equal('socket-a');
  });

  it('never moves a live player into a different room through incidental join', async () => {
    room.status = GameRoomStatus.IN_PROGRESS;
    const other = service.createRoom('next-room', 2);
    join('next-host', 'next-host-socket', other);
    enableBackend(other);
    const releases = [];
    handlers._fetchSeatReservation = async () => ({ isSpectator: false, playerIndex: 1, reservationVersion: 1 });
    handlers._seatBackendRequest = async (_room, path, body) => {
      if (path === 'room-seat-activate') return { activated: true, playerIndex: 1, reservationVersion: 2 };
      expect(path).to.equal('room-seat-claim-rejected');
      releases.push(body); return { success: true, isSpectator: true };
    };
    await handlers.handleJoinRoom(sockets.get('socket-a'), { roomId: other.roomId, playerId: 'a', playerName: 'A' });
    expect(service.getPlayerRoom('a')).to.equal(room);
    expect(room.getPlayer('a').socketId).to.equal('socket-a');
    expect(other.getPlayer('a')).to.not.exist;
    expect(handlers.spectatorSocketToRoom.has('socket-a')).to.equal(false);
    expect(releases[0].reservationVersion).to.equal(2);
  });

  it('reconciles an API-released old lobby only after its destination reservation is proved', async () => {
    enableBackend();
    room.getPlayer('a').apiSeatReservationVersion = 2;
    const other = service.createRoom('next-room', 4);
    join('next-host', 'next-host-socket', other);
    enableBackend(other);
    const callbacks = [];
    handlers._seatBackendRequest = async (target, path, body) => {
      callbacks.push(path);
      if (path === 'room-seat-activate') return { activated: true, playerIndex: 3, reservationVersion: 6 };
      expect(path).to.equal('room-fetch');
      return { exists: true, status: 'open', players: target === room ? [] : [
        { playerId: 'a', isSpectator: false, playerIndex: 3, reservationVersion: callbacks.includes('room-seat-activate') ? 6 : 5 },
      ] };
    };
    await handlers.handleJoinRoom(sockets.get('socket-a'), { roomId: other.roomId, playerId: 'a', playerName: 'A' });
    expect(service.getPlayerRoom('a')).to.equal(other);
    expect(other.getPlayer('a').playerIndex).to.equal(3);
    expect(room.getPlayer('a')).to.not.exist;
    expect(callbacks).to.not.include('room-player-left');
    expect(frames.some((frame) => frame.roomId === room.roomId && frame.event === 'player_left')).to.equal(true);
  });

  it('keeps an empty backend room reserved for its host after the first guest leaves', () => {
    const other = service.createRoom('host-not-here', 2);
    other.backendManaged = true;
    other.hostPlayerId = 'expected-host';
    join('first-guest', 'first-guest-socket', other);
    service.leaveRoom('first-guest');
    expect(service.getRoom(other.roomId)).to.equal(other);
    join('expected-host', 'expected-host-socket', other);
    expect(other.getPlayer('expected-host').playerIndex).to.equal(0);
  });

  it('does not admit new seats into an already-started nonfull runtime', () => {
    room.status = GameRoomStatus.IN_PROGRESS;
    expect(service.joinRoom(room.roomId, 'new', 'New', 'new-socket').success).to.equal(false);
    expect(room.getPlayer('new')).to.not.exist;
  });

  it('rejects a host swap if either captured occupant changed before dispatch', () => {
    handlers.handleHostSwapSeats(sockets.get('socket-host'), {
      seatA: 1, seatB: 2, expectedPlayerAId: 'old-a', expectedPlayerBId: 'b',
    });
    expect(room.getPlayer('a').playerIndex).to.equal(1);
    expect(room.getPlayer('b').playerIndex).to.equal(2);
  });

  it('recovers a lost layout ACK before sending a captured generation leave', async () => {
    enableBackend();
    const departed = room.getPlayer('a');
    departed.apiSeatReservationVersion = 3;
    const operation = {
      body: { roomId: room.roomId, operationId: 'same-operation', players: [
        { playerId: 'a', reservationVersion: 3, expectedSeat: 1, seat: 3 },
      ] }, members: new Map([['a', departed]]),
    };
    room._seatLayoutSync = { operation };
    const sent = [];
    handlers._seatBackendRequest = async (_room, path, body) => {
      sent.push({ path, body });
      if (path === 'room-seat-layout') return { applied: true, players: [{ playerId: 'a', playerIndex: 3, reservationVersion: 4 }] };
      return { success: true, left: false, reason: 'stale_reservation' };
    };
    service.leaveRoom('a');
    join('a', 'new-generation');
    room.getPlayer('a').apiSeatReservationVersion = 6;
    await handlers._notifyBackendPlayerLeft(room.roomId, 'a', false, departed, room);
    expect(sent.map((call) => call.path)).to.deep.equal(['room-seat-layout', 'room-player-left']);
    expect(sent[0].body).to.equal(operation.body);
    expect(sent[1].body.reservationVersion).to.equal(4);
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(6);
    expect(handlers._pendingBackendLeaves.size).to.equal(0);
  });

  it('retains pending-start leave callbacks for bounded retry without changing their token', async () => {
    const departed = room.getPlayer('a');
    departed.apiSeatReservationVersion = 9;
    room.backendBaseUrl = 'http://reservation.test';
    const sent = [];
    let pending = true;
    handlers._seatBackendRequest = async (_room, path, body) => {
      sent.push({ path, body: { ...body } });
      return pending ? { success: true, left: false, reason: 'room_start_pending' } : { success: true, left: true };
    };
    await handlers._notifyBackendPlayerLeft(room.roomId, 'a', false, departed, room);
    expect(sent).to.have.length(3);
    expect(handlers._pendingBackendLeaves.size).to.equal(1);
    pending = false;
    const [key, job] = [...handlers._pendingBackendLeaves][0];
    await handlers._runBackendPlayerLeft(key, job);
    expect(sent[3].body.reservationVersion).to.equal(9);
    expect(handlers._pendingBackendLeaves.size).to.equal(0);
  });

  for (const spectatorIntent of [true, false]) {
    it(`a forfeited live participant rejoins as viewer with spectator intent ${spectatorIntent}`, async () => {
      enableBackend();
      room.status = GameRoomStatus.IN_PROGRESS;
      const old = room.getPlayer('a');
      old.apiSeatReservationVersion = 4;
      handlers._seatBackendRequest = async (_room, path) => {
        expect(path).to.equal('room-participant');
        return { authorized: true, playerId: 'a', isSpectator: true, reservationVersion: 4 };
      };
      const returning = socket('returning-a', 'a');
      await handlers.handleJoinRoom(returning, { roomId: room.roomId, playerId: 'a', playerName: 'A', isSpectator: spectatorIntent });
      expect(room.getPlayer('a')).to.equal(old);
      expect(old.playerIndex).to.equal(1);
      expect(old.isConnected).to.equal(false);
      expect(old.socketId).to.equal(null);
      expect(service.getPlayerIdBySocket('socket-a')).to.not.exist;
      expect(service.getPlayerIdBySocket(returning.id)).to.not.exist;
      expect(handlers.spectatorSocketToRoom.get(returning.id)).to.equal(room.roomId);
    });
  }

  it('still resumes an active live paid participant who has stale spectator intent', async () => {
    enableBackend();
    room.status = GameRoomStatus.IN_PROGRESS;
    room.getPlayer('a').apiSeatReservationVersion = 4;
    handlers._seatBackendRequest = async () => ({ authorized: true, playerId: 'a', isSpectator: false, reservationVersion: 4 });
    const returning = socket('returning-a', 'a');
    await handlers.handleJoinRoom(returning, { roomId: room.roomId, playerId: 'a', playerName: 'A', isSpectator: true });
    expect(room.getPlayer('a').socketId).to.equal(returning.id);
    expect(service.getPlayerIdBySocket(returning.id)).to.equal('a');
    expect(handlers.spectatorSocketToRoom.has(returning.id)).to.equal(false);
  });

  it('a REST role flip during a serialized join never waits on its own actor queue', async function () {
    this.timeout(1000);
    enableBackend();
    let lookups = 0;
    handlers._fetchSeatReservation = async () => ++lookups === 1
      ? { isSpectator: true, reservationVersion: 1 }
      : { isSpectator: false, playerIndex: 3, reservationVersion: 2 };
    handlers._seatBackendRequest = async (_room, path) => path === 'room-participant'
      ? { authorized: true, playerId: 'new', isSpectator: false, reservationVersion: 2 }
      : { activated: true, playerIndex: 3, reservationVersion: 3 };
    const entering = socket('role-flip', 'new');
    await handlers.handleJoinRoom(entering, { roomId: room.roomId, playerId: 'new', playerName: 'New' });
    expect(room.getPlayer('new').socketId).to.equal(entering.id);
    expect(room.getPlayer('new').apiSeatReservationVersion).to.equal(3);
    expect(handlers._seatMutations.size).to.equal(0);
    expect(frames.some((frame) => frame.socketId === entering.id && frame.event === 'kicked')).to.equal(false);
  });

});
