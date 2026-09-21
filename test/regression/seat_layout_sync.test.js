/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');
const GameRoomStatus = require('../../src/constants/gameStatus');
const config = require('../../src/config');

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('versioned lobby seat layout synchronization', () => {
  let service, handlers, room, calls, reservations, sockets, frames;
  let originalFetch, originalUrl, originalSecret, readHook, writeHook, gates, receipts;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalUrl = config.backend.url;
    originalSecret = config.backend.webhookSecret;
    config.backend.url = null;
    config.backend.webhookSecret = 'layout-test-secret';
    calls = [];
    frames = [];
    gates = [];
    receipts = new Map();
    sockets = new Map();
    readHook = null;
    writeHook = null;
    service = new GameService();
    handlers = new SocketHandlers({
      sockets: { sockets },
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    }, service);
    handlers._ensureHostHeartbeat = () => {};
    handlers._notifyBackendPlayerCount = () => {};
    handlers._notifyBackendRoomClosed = () => {};
    handlers.syncRoomFromBackend({
      roomId: 'layout-room', maxPlayers: 4, hostPlayerId: 'host',
      backendUrl: 'http://layout-backend.test',
    });
    room = service.getRoom('layout-room');
    for (const id of ['host', 'a', 'b']) join(id);
    reservations = new Map(room.getPlayers().map((player, index) => [player.playerId, {
      playerId: player.playerId, playerIndex: player.playerIndex,
      isSpectator: false, reservationVersion: 10 + index,
    }]));
    for (const player of room.getPlayers()) {
      player.apiSeatReservationVersion = reservations.get(player.playerId).reservationVersion;
    }
    global.fetch = async (url, options = {}) => {
      const path = String(url).split('/').at(-1);
      const body = JSON.parse(options.body);
      calls.push({ url, path, options, body });
      if (path === 'room-fetch') {
        const snapshot = {
          roomId: room.roomId, exists: true, status: 'open', seatLayoutProtocol: 1,
          players: [...reservations.values()].map((player) => ({ ...player })),
        };
        if (readHook) await readHook(snapshot);
        return { ok: true, json: async () => snapshot };
      }
      if (path === 'room-seat-layout') {
        const overridden = writeHook ? await writeHook(body) : null;
        return { ok: true, json: async () => overridden || apply(body) };
      }
      if (path === 'rooms-heartbeat') return { ok: true, json: async () => ({ success: true }) };
      throw new Error(`Unexpected layout test request: ${url}`);
    };
  });

  afterEach(async () => {
    room.seatLayoutProtocol = 0;
    for (const gate of gates) gate.resolve();
    await room._seatLayoutSync?.running;
    service.shutdown();
    global.fetch = originalFetch;
    config.backend.url = originalUrl;
    config.backend.webhookSecret = originalSecret;
  });

  function gate() {
    let resolve;
    const promise = new Promise((yes) => { resolve = yes; });
    const value = { promise, resolve };
    gates.push(value);
    return value;
  }

  function join(id) {
    const participant = {
      id: `socket-${id}`, connected: true, join() {}, leave() {},
      emit: (event, payload) => frames.push({ socketId: participant.id, event, payload }),
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    };
    sockets.set(participant.id, participant);
    service.joinRoom(room.roomId, id, id, participant.id);
    return participant;
  }

  function apply(body) {
    if (receipts.has(body.operationId)) return receipts.get(body.operationId);
    for (const player of body.players) {
      const current = reservations.get(player.playerId);
      if (!current || current.isSpectator) return { success: true, applied: false, reason: 'not_joined' };
      if (current.reservationVersion !== player.reservationVersion || current.playerIndex !== player.expectedSeat) {
        return { success: true, applied: false, reason: 'stale_reservation' };
      }
    }
    for (const player of body.players) {
      const current = reservations.get(player.playerId);
      if (current.playerIndex !== player.seat) current.reservationVersion += 1;
      current.playerIndex = player.seat;
    }
    const receipt = { success: true, applied: true, players: [...reservations.values()].map((player) => ({ ...player })) };
    receipts.set(body.operationId, receipt);
    return receipt;
  }

  function swap() {
    const a = room.getPlayer('a');
    const b = room.getPlayer('b');
    [a.playerIndex, b.playerIndex] = [b.playerIndex, a.playerIndex];
    handlers._broadcastSeatChanged(room);
  }

  function writes() { return calls.filter((call) => call.path === 'room-seat-layout'); }

  it('keeps non-opted-in backends entirely free of layout HTTP requests', async () => {
    swap();
    await flush();
    expect(calls).to.be.empty;
  });

  it('publishes the roster immediately and persists a consenting swap with exact API versions', async () => {
    room.seatLayoutProtocol = 1;
    handlers.handleRequestSwap(sockets.get('socket-a'), { targetPlayerId: 'b', targetSeat: 2 });
    handlers.handleRespondSwap(sockets.get('socket-b'), { requesterId: 'a', accept: true });
    expect(room.getPlayer('a').playerIndex).to.equal(2);
    expect(frames.some((frame) => frame.event === 'seat_changed')).to.equal(true);
    expect(calls).to.be.empty; // HTTP is deferred, never in the mutation path.
    await room._seatLayoutSync.running;
    expect(writes()).to.have.length(1);
    expect(writes()[0].body.players).to.deep.equal([
      { playerId: 'host', reservationVersion: 10, expectedSeat: 0, seat: 0 },
      { playerId: 'b', reservationVersion: 12, expectedSeat: 2, seat: 1 },
      { playerId: 'a', reservationVersion: 11, expectedSeat: 1, seat: 2 },
    ]);
    expect(writes()[0].url).to.equal('http://layout-backend.test/api/webhooks/room-seat-layout');
    expect(writes()[0].options.headers['x-webhook-secret']).to.equal('layout-test-secret');
    expect(writes()[0].body.operationId).to.match(/^[0-9a-f]{32}$/);
    expect(reservations.get('a').playerIndex).to.equal(2);
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(12);
    expect(room._seatLayoutSync.dirty).to.equal(false);
  });

  it('uses the newest live positions when moves overtake an in-flight snapshot', async () => {
    room.seatLayoutProtocol = 1;
    const reading = gate();
    readHook = () => reading.promise;
    swap();
    await flush();
    // Restore the original positions while the first snapshot is in flight.
    swap();
    const running = room._seatLayoutSync.running;
    reading.resolve();
    await running;
    expect(calls.filter((call) => call.path === 'room-fetch')).to.have.length(2);
    expect(writes()).to.be.empty;
    expect(room._seatLayoutSync.dirty).to.equal(false);
  });

  it('serializes writes and reconciles a newer move after an older write completes', async () => {
    room.seatLayoutProtocol = 1;
    const writing = gate();
    let writeCount = 0;
    writeHook = async () => { if (++writeCount === 1) await writing.promise; };
    swap();
    await flush();
    expect(writes()).to.have.length(1);
    swap();
    await flush();
    expect(writes()).to.have.length(1);
    writing.resolve();
    await room._seatLayoutSync.running;
    expect(writes()).to.have.length(2);
    expect(writes()[1].body.players.find((player) => player.playerId === 'a'))
      .to.deep.equal({ playerId: 'a', reservationVersion: 12, expectedSeat: 2, seat: 1 });
    expect(reservations.get('a').playerIndex).to.equal(room.getPlayer('a').playerIndex);
  });

  it('a conflict refetches versions and recomputes intent instead of replaying the stale move', async () => {
    room.seatLayoutProtocol = 1;
    const writing = gate();
    writeHook = async () => {
      await writing.promise;
      return { success: true, applied: false, reason: 'stale_reservation' };
    };
    swap();
    await flush();
    swap(); // The current runtime intent now matches the API's newer layout.
    writing.resolve();
    await room._seatLayoutSync.running;
    expect(writes()).to.have.length(1);
    expect(calls.filter((call) => call.path === 'room-fetch')).to.have.length(2);
    expect(room._seatLayoutSync.dirty).to.equal(false);
  });

  it('a timed-out committed write replays its operation receipt without a duplicate mutation', async () => {
    room.seatLayoutProtocol = 1;
    let requests = 0;
    writeHook = (body) => {
      if (++requests === 1) { apply(body); throw new Error('timeout after commit'); }
    };
    swap();
    await room._seatLayoutSync.running;
    expect(writes()).to.have.length(2);
    expect(writes()[1].body).to.deep.equal(writes()[0].body);
    expect(calls.filter((call) => call.path === 'room-fetch')).to.have.length(1);
    expect(reservations.get('a').reservationVersion).to.equal(12);
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(12);
    expect(room._seatLayoutSync.dirty).to.equal(false);
  });

  it('bounds transient retries and recovers on the existing heartbeat', async () => {
    room.seatLayoutProtocol = 1;
    readHook = () => { throw new Error('backend offline'); };
    swap();
    await room._seatLayoutSync.running;
    expect(calls).to.have.length(3);
    expect(room._seatLayoutSync.dirty).to.equal(true);
    readHook = null;
    handlers._hostHeartbeatTick(room);
    await room._seatLayoutSync.running;
    expect(writes()).to.have.length(1);
    expect(room._seatLayoutSync.dirty).to.equal(false);
  });

  for (const change of ['started', 'deleted', 'replaced', 'intermission', 'ownership_lost']) {
    it(`does not write after the room is ${change} during a snapshot fetch`, async () => {
      room.seatLayoutProtocol = 1;
      const reading = gate();
      readHook = () => reading.promise;
      swap();
      await flush();
      if (change === 'started') room.status = GameRoomStatus.IN_PROGRESS;
      if (change === 'deleted') service.rooms.delete(room.roomId);
      if (change === 'replaced') service.rooms.set(room.roomId, { roomId: room.roomId, disposeTimers() {} });
      if (change === 'intermission') room.awaitingNextRound = true;
      if (change === 'ownership_lost') handlers.roomOwnerLease = {};
      reading.resolve();
      await room._seatLayoutSync.running;
      expect(writes()).to.be.empty;
      room.disposeTimers();
    });
  }

  it('excludes bots, spectators, departed members, and unresolved seat claims from the desired roster', async () => {
    room.seatLayoutProtocol = 1;
    service.addBotToRoom(room.roomId, { botId: 'bot' });
    reservations.set('bot', { playerId: 'bot', playerIndex: 1, isSpectator: false, reservationVersion: 1 });
    reservations.get('b').isSpectator = true;
    handlers._unresolvedSeatRejections.set(`${room.roomId}:host`, { room, reservationVersion: 10 });
    swap();
    await room._seatLayoutSync.running;
    expect(writes()[0].body.players.map((player) => player.playerId)).to.deep.equal(['a']);
  });

  it('refetches for a replacement PlayerSession instead of applying a snapshot from its predecessor', async () => {
    room.seatLayoutProtocol = 1;
    const reading = gate();
    let reads = 0;
    readHook = async () => { if (++reads === 1) await reading.promise; };
    swap();
    await flush();
    room.removePlayer('a');
    join('a');
    reservations.get('a').reservationVersion = 50;
    room.getPlayer('a').apiSeatReservationVersion = 50;
    reading.resolve();
    await room._seatLayoutSync.running;
    expect(reads).to.equal(2);
    expect(writes()[0].body.players.find((player) => player.playerId === 'a').reservationVersion).to.equal(50);
  });

  it('does not write when the fetched backend is closed or has not advertised this protocol', async () => {
    room.seatLayoutProtocol = 1;
    readHook = (snapshot) => { snapshot.status = 'in_progress'; };
    swap();
    await room._seatLayoutSync.running;
    readHook = (snapshot) => { delete snapshot.seatLayoutProtocol; };
    handlers._broadcastLobbyPlayers(room);
    await room._seatLayoutSync.running;
    expect(writes()).to.be.empty;
  });

  it('carries the opt-in through backend sync updates and persisted room recovery', async () => {
    handlers.syncRoomFromBackend({ roomId: room.roomId, seatLayoutProtocol: 1 });
    await room._seatLayoutSync.running;
    handlers.syncRoomFromBackend({ roomId: room.roomId, name: 'Updated' });
    await room._seatLayoutSync.running;
    expect(room.seatLayoutProtocol).to.equal(1);
    const redis = new InMemoryRedis();
    const manager = new FailureManager(handlers.io, redis, service, { info() {}, warn() {}, error() {}, debug() {} });
    try {
      await manager.persistGameState(room);
      room = await manager.restorePersistedRoom(room.roomId);
      expect(room.seatLayoutProtocol).to.equal(1);
      expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(11);
      swap();
      await room._seatLayoutSync.running;
      expect(reservations.get('a').playerIndex).to.equal(2);
    } finally {
      manager.dispose();
      await redis.quit();
    }
  });

  it('never adopts a newer REST membership version for an old bound runtime session', async () => {
    room.seatLayoutProtocol = 1;
    reservations.get('a').reservationVersion = 50;
    room.getPlayer('a').playerIndex = 3;
    handlers._broadcastSeatChanged(room);
    await room._seatLayoutSync.running;
    expect(writes()).to.be.empty;
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(11);
    expect(reservations.get('a').playerIndex).to.equal(1);
    expect(room._seatLayoutSync.dirty).to.equal(true);
  });

  it('adopts an unknown legacy binding only when the API and runtime already agree', async () => {
    room.seatLayoutProtocol = 1;
    room.getPlayer('a').apiSeatReservationVersion = null;
    room.getPlayer('b').apiSeatReservationVersion = null;
    room.getPlayer('a').playerIndex = 3;
    handlers._broadcastLobbyPlayers(room);
    await room._seatLayoutSync.running;
    expect(room.getPlayer('b').apiSeatReservationVersion).to.equal(12);
    expect(room.getPlayer('a').apiSeatReservationVersion).to.be.null;
    expect(writes()).to.be.empty;
    expect(room._seatLayoutSync.dirty).to.equal(true);
  });

  it('verified seated rejoin establishes a new generation and then reconciles its position', async () => {
    room.seatLayoutProtocol = 1;
    room.getPlayer('a').playerIndex = 3;
    reservations.get('a').reservationVersion = 50;
    await handlers.handleJoinRoom(sockets.get('socket-a'), {
      roomId: room.roomId, playerId: 'a', playerName: 'A',
    });
    await room._seatLayoutSync.running;
    expect(writes()[0].body.players.find((player) => player.playerId === 'a').reservationVersion).to.equal(50);
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(51);
    expect(reservations.get('a').playerIndex).to.equal(3);
  });

  it('binds a verified spectator claim before its layout synchronization starts', async () => {
    room.seatLayoutProtocol = 1;
    reservations.set('viewer', { playerId: 'viewer', playerIndex: 3, reservationVersion: 70, isSpectator: false });
    const viewer = {
      id: 'socket-viewer', connected: true, join() {}, leave() {},
      emit() {}, to: () => ({ emit() {} }),
    };
    sockets.set(viewer.id, viewer);
    handlers._addSpectator(viewer, room.roomId, 'viewer', 'Viewer');
    await handlers.handleClaimSeat(viewer, { seat: 3 });
    await room._seatLayoutSync.running;
    expect(room.getPlayer('viewer').apiSeatReservationVersion).to.equal(70);
    expect(room._seatLayoutSync.dirty).to.equal(false);
  });

  it('a new verified join binds its API reservation before publishing its full roster', async () => {
    room.seatLayoutProtocol = 1;
    reservations.set('c', { playerId: 'c', playerIndex: 3, reservationVersion: 70, isSpectator: false });
    const joining = {
      id: 'socket-c', connected: true, join() {}, leave() {},
      emit() {}, to: () => ({ emit() {} }),
    };
    sockets.set(joining.id, joining);
    await handlers.handleJoinRoom(joining, { roomId: room.roomId, playerId: 'c', playerName: 'C' });
    await room._seatLayoutSync.running;
    expect(room.getPlayer('c').apiSeatReservationVersion).to.equal(70);
    expect(room.getPlayer('c').playerIndex).to.equal(3);
    expect(room._seatLayoutSync.dirty).to.equal(false);
  });

  it('a stale spectator snapshot cannot mark a newly committed seat layout as clean', async () => {
    room.seatLayoutProtocol = 1;
    room.removePlayer('a');
    service.playerToRoom.delete('a');
    service.socketToPlayer.delete('socket-a');
    reservations.get('a').isSpectator = true;
    const viewer = sockets.get('socket-a');
    handlers._addSpectator(viewer, room.roomId, 'a', 'A');
    const reading = gate();
    let reads = 0;
    readHook = async () => { if (++reads === 1) await reading.promise; };
    handlers._broadcastLobbyPlayers(room);
    await flush();
    reservations.get('a').isSpectator = false;
    reservations.get('a').reservationVersion = 50;
    await handlers.handleClaimSeat(viewer, { seat: 3 });
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(50);
    reading.resolve();
    await room._seatLayoutSync.running;
    expect(reservations.get('a').playerIndex).to.equal(3);
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(51);
    expect(writes()).to.have.length(1);
    expect(room._seatLayoutSync.dirty).to.equal(false);
  });

  it('a delayed spectator verdict cannot demote or rebind a newer socket', async () => {
    room.seatLayoutProtocol = 1;
    reservations.get('a').isSpectator = true;
    const reading = gate();
    readHook = () => reading.promise;
    const old = sockets.get('socket-a');
    const verifying = handlers.handleJoinRoom(old, { roomId: room.roomId, playerId: 'a', playerName: 'A' });
    await flush();
    service.joinRoom(room.roomId, 'a', 'A', 'newer-socket-a');
    reading.resolve();
    await verifying;
    expect(room.getPlayer('a').socketId).to.equal('newer-socket-a');
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(11);
    expect(frames.some((frame) => frame.socketId === old.id && frame.event === 'error')).to.equal(true);
    expect(writes()).to.be.empty;
  });

  it('a proven API spectator sheds a stale runtime seat on reconnect without another refund', async () => {
    room.seatLayoutProtocol = 1;
    reservations.get('a').isSpectator = true;
    room.getPlayer('a').avatarUrl = 'https://avatar.test/a.jpg';
    const oldSocket = sockets.get('socket-a');
    const reconnect = {
      ...oldSocket, id: 'reconnected-a',
      emit: (event, payload) => frames.push({ socketId: 'reconnected-a', event, payload }),
    };
    sockets.set(reconnect.id, reconnect);
    await handlers.handleJoinRoom(reconnect, { roomId: room.roomId, playerId: 'a', playerName: 'A' });
    await room._seatLayoutSync.running;
    expect(room.getPlayer('a')).to.not.exist;
    expect(service.getPlayerIdBySocket(oldSocket.id)).to.not.exist;
    expect(service.getPlayerIdBySocket(reconnect.id)).to.not.exist;
    handlers.handleClaimSeat(oldSocket, { seat: 1 });
    expect(room.getPlayer('a')).to.not.exist;
    expect(room.getPlayer('host').playerIndex).to.equal(0);
    expect(room.hostPlayerId).to.equal('host');
    expect(handlers.spectatorSocketToRoom.get(reconnect.id)).to.equal(room.roomId);
    expect(handlers.roomSpectators.get(room.roomId).get(reconnect.id).avatarUrl).to.equal('https://avatar.test/a.jpg');
    expect(frames.find((frame) => frame.socketId === reconnect.id && frame.event === 'kicked').payload)
      .to.include({ toSpectator: true, reason: 'seat_taken' });
    expect(calls.every((call) => call.path === 'room-fetch')).to.equal(true);
    expect(frames.filter((frame) => frame.event === 'player_joined').at(-1).payload.players
      .some((player) => player.playerId === 'a')).to.equal(false);
  });

  for (const phase of ['started', 'intermission']) {
    it(`a spectator verdict arriving after ${phase} cannot detach the player`, async () => {
      room.seatLayoutProtocol = 1;
      reservations.get('a').isSpectator = true;
      const reading = gate();
      readHook = () => reading.promise;
      const verifying = handlers.handleJoinRoom(sockets.get('socket-a'), {
        roomId: room.roomId, playerId: 'a', playerName: 'A',
      });
      await flush();
      if (phase === 'started') room.status = GameRoomStatus.IN_PROGRESS;
      else room.awaitingNextRound = true;
      reading.resolve();
      await verifying;
      expect(room.getPlayer('a').playerIndex).to.equal(1);
      expect(service.getPlayerIdBySocket('socket-a')).to.equal('a');
      expect(handlers.spectatorSocketToRoom.has('socket-a')).to.equal(false);
      expect(writes()).to.be.empty;
    });
  }

  it('keeps a timed-out operation across heartbeat retries and never advances a replacement session from its receipt', async () => {
    room.seatLayoutProtocol = 1;
    writeHook = (body) => { apply(body); throw new Error('lost response'); };
    swap();
    await room._seatLayoutSync.running;
    expect(writes()).to.have.length(3);
    expect(new Set(writes().map((call) => call.body.operationId)).size).to.equal(1);
    expect(room._seatLayoutSync.operation).to.exist;
    room.removePlayer('a');
    join('a');
    room.getPlayer('a').apiSeatReservationVersion = 50;
    reservations.get('a').reservationVersion = 50;
    writeHook = null;
    handlers._hostHeartbeatTick(room);
    await room._seatLayoutSync.running;
    expect(writes()[3].body).to.deep.equal(writes()[0].body);
    expect(room.getPlayer('a').apiSeatReservationVersion).to.equal(50);
    expect(room._seatLayoutSync.operation).to.be.null;
  });
});
