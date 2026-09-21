/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');
const GameRoomStatus = require('../../src/constants/gameStatus');
const config = require('../../src/config');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('backend reservations during concurrent seat claims', () => {
  let service;
  let handlers;
  let room;
  let sockets;
  let emitted;
  let reservations;
  let fetches;
  let reads;
  let extraGates;
  let rollbacks;
  let pending;
  let originalFetch;
  let originalBackendUrl;
  let originalSecret;
  let autoRead;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalBackendUrl = config.backend.url;
    originalSecret = config.backend.webhookSecret;
    config.backend.url = 'http://wrong-default-backend.test';
    config.backend.webhookSecret = 'test-only-secret';
    emitted = [];
    sockets = new Map();
    fetches = [];
    reads = [];
    extraGates = [];
    rollbacks = [];
    pending = [];
    autoRead = false;
    service = new GameService();
    handlers = new SocketHandlers({
      sockets: { sockets },
      to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
    }, service);
    handlers._notifyBackendPlayerCount = () => {};
    handlers._notifyBackendRoomClosed = () => {};
    handlers._ensureHostHeartbeat = () => {};
    room = service.createRoom('backend-seat-race', 4);
    room.backendManaged = true;
    room.seatReservationProtocol = 1;
    room.backendBaseUrl = 'http://room-backend.test';
    room.hostPlayerId = 'host';
    service.joinRoom(room.roomId, 'host', 'Host', socket('host').id);
    reservations = new Map([
      ['host', { playerId: 'host', playerIndex: 0, isSpectator: false, reservationVersion: 1 }],
      ['a', { playerId: 'a', playerIndex: 1, isSpectator: false, reservationVersion: 11 }],
      ['b', { playerId: 'b', playerIndex: 2, isSpectator: false, reservationVersion: 12 }],
      ['c', { playerId: 'c', playerIndex: 3, isSpectator: false, reservationVersion: 13 }],
    ]);
    global.fetch = (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      fetches.push({ url: String(url), options, body });
      if (String(url).endsWith('/api/webhooks/room-fetch')) {
        const gate = deferred();
        const payload = {
          success: true,
          exists: true,
          roomId: room.roomId,
          status: 'open',
          maxPlayers: room.maxPlayers,
          hostPlayerId: 'host',
          seatReservationProtocol: room.seatReservationProtocol,
          players: [...reservations.values()].map((reservation) => ({ ...reservation })),
        };
        reads.push(gate);
        if (autoRead) gate.resolve();
        return gate.promise.then(() => ({ ok: true, json: async () => payload }));
      }
      if (String(url).endsWith('/api/webhooks/room-seat-claim-rejected')) {
        rollbacks.push(body);
        const reservation = reservations.get(String(body.playerId));
        const matches = reservation && reservation.reservationVersion === body.reservationVersion;
        const released = !!matches && !reservation.isSpectator;
        if (released) reservation.isSpectator = true;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            released,
            isSpectator: !!reservation?.isSpectator,
            ...(!matches ? { reason: 'stale_reservation' } : {}),
          }),
        });
      }
      throw new Error(`Unexpected fetch in seat test: ${url}`);
    };
  });

  afterEach(async () => {
    autoRead = true;
    for (const read of reads) read.resolve();
    for (const gate of extraGates) gate.resolve();
    await Promise.allSettled(pending);
    for (const timer of handlers._waitingGraceTimers.values()) clearTimeout(timer);
    service.shutdown();
    global.fetch = originalFetch;
    config.backend.url = originalBackendUrl;
    config.backend.webhookSecret = originalSecret;
  });

  function socket(playerId, suffix = '') {
    const value = {
      id: `socket-${playerId}${suffix}`,
      connected: true,
      data: { authenticated: true, userId: playerId },
      join() {},
      leave() {},
      emit: (event, payload) => emitted.push({ socketId: value.id, event, payload }),
      to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
    };
    sockets.set(value.id, value);
    return value;
  }

  function spectator(playerId, suffix = '') {
    const value = socket(playerId, suffix);
    handlers._addSpectator(value, room.roomId, playerId, `Viewer ${playerId}`);
    return value;
  }

  function claim(participant, seat = 1) {
    const attempt = Promise.resolve(handlers.handleClaimSeat(participant, { seat }));
    pending.push(attempt);
    return attempt;
  }

  function direct(participant, event) {
    return emitted.filter((entry) => entry.socketId === participant.id && entry.event === event);
  }

  async function expectReads(count) {
    await flush();
    expect(reads, 'claims must validate their backend reservations before sitting').to.have.length(count);
  }

  it('keeps legacy backend spectator claims synchronous when no reservation protocol is advertised', async () => {
    delete room.seatReservationProtocol;
    const participant = spectator('a');

    await claim(participant, 1);

    expect(room.getPlayer('a').playerIndex).to.equal(1);
    expect(service.getPlayerIdBySocket(participant.id)).to.equal('a');
    expect(fetches).to.be.empty;
  });

  it('keeps legacy backend player joins available without a reservation lookup', async () => {
    delete room.seatReservationProtocol;
    const participant = socket('a');

    await handlers.handleJoinRoom(participant, {
      roomId: room.roomId, playerId: 'a', playerName: 'Legacy player', isSpectator: false,
    });

    expect(room.getPlayer('a').playerIndex).to.equal(1);
    expect(service.getPlayerIdBySocket(participant.id)).to.equal('a');
    expect(fetches).to.be.empty;
  });

  it('enables reservation validation from the backend sync marker and keeps it across partial syncs', async () => {
    delete room.seatReservationProtocol;
    const synced = handlers.syncRoomFromBackend({
      roomId: room.roomId,
      hostPlayerId: 'host',
      maxPlayers: 4,
      backendUrl: room.backendBaseUrl,
      seatReservationProtocol: 1,
    });
    expect(synced.success).to.equal(true);
    expect(room.seatReservationProtocol).to.equal(1);
    handlers.syncRoomFromBackend({ roomId: room.roomId, name: 'Updated lobby' });
    expect(room.seatReservationProtocol).to.equal(1);
    const participant = spectator('a');
    const attempt = claim(participant, 1);
    await expectReads(1);
    expect(room.getPlayer('a')).to.not.exist;
    reads[0].resolve();
    await attempt;
    expect(room.getPlayer('a').playerIndex).to.equal(1);
  });

  it('preserves reservation validation when the room is restored from its persisted snapshot', async () => {
    const redis = new InMemoryRedis();
    const manager = new FailureManager(handlers.io, redis, service, {
      info() {}, warn() {}, error() {}, debug() {},
    });
    try {
      await manager.persistGameState(room);
      const previousRoom = room;
      room = await manager.restorePersistedRoom(room.roomId);
      expect(room).to.not.equal(previousRoom);
      expect(room.seatReservationProtocol).to.equal(1);
      expect(room.backendBaseUrl).to.equal('http://room-backend.test');
      const participant = spectator('a');
      const attempt = claim(participant, 1);
      await expectReads(1);
      expect(room.getPlayer('a')).to.not.exist;
      reads[0].resolve();
      await attempt;
      expect(room.getPlayer('a').playerIndex).to.equal(1);
    } finally {
      manager.dispose();
      await redis.quit();
    }
  });

  it('keeps two losers as spectators and releases only their reservations even with other chairs free', async () => {
    const contenders = ['a', 'b', 'c'].map((id) => spectator(id));
    const attempts = contenders.map((participant) => claim(participant));
    await expectReads(3);
    expect(room.players.size, 'no seat is committed before reservation validation').to.equal(1);

    reads[0].resolve();
    await attempts[0];
    reads[1].resolve();
    reads[2].resolve();
    await Promise.all(attempts);

    expect(room.getPlayers().map((player) => [player.playerId, player.playerIndex]))
      .to.deep.equal([['host', 0], ['a', 1]]);
    expect(room.getPlayerByIndex(2)).to.not.exist;
    expect(room.getPlayerByIndex(3)).to.not.exist;
    expect(rollbacks).to.have.deep.members([
      { roomId: room.roomId, playerId: 'b', reservationVersion: 12 },
      { roomId: room.roomId, playerId: 'c', reservationVersion: 13 },
    ]);
    expect(reservations.get('a').isSpectator).to.equal(false);
    for (const loser of contenders.slice(1)) {
      expect(reservations.get(loser.data.userId).isSpectator).to.equal(true);
      expect(service.getPlayerIdBySocket(loser.id)).to.not.exist;
      expect(handlers.spectatorSocketToRoom.get(loser.id)).to.equal(room.roomId);
      expect(direct(loser, 'kicked').some((entry) =>
        entry.payload.toSpectator === true && entry.payload.reason === 'seat_taken'
      )).to.equal(true);
      expect(direct(loser, 'swap_failed').some((entry) => entry.payload.reason === 'seat_taken'))
        .to.equal(true);
      for (const event of ['seat_changed', 'player_joined']) {
        const frames = direct(loser, event);
        expect(frames, `loser needs a direct ${event} roster`).to.not.be.empty;
        expect(frames[frames.length - 1].payload.players.map((player) => player.playerId))
          .to.deep.equal(['host', 'a']);
      }
    }
    for (const request of fetches) {
      expect(request.url).to.match(/^http:\/\/room-backend\.test\//);
      expect(request.options.headers['x-webhook-secret']).to.equal('test-only-secret');
    }
  });

  it('commits one seat when duplicate pending requests arrive from the same actor\'s sockets', async () => {
    const first = spectator('a');
    const otherSocket = spectator('a', '-other');
    const firstAttempt = claim(first, 1);
    const duplicateAttempt = claim(first, 2);
    const otherAttempt = claim(otherSocket, 3);
    await expectReads(1);
    reads[0].resolve();
    await Promise.all([firstAttempt, duplicateAttempt, otherAttempt]);

    expect(room.getPlayers().filter((player) => player.playerId === 'a')).to.have.length(1);
    expect(room.getPlayer('a').playerIndex).to.equal(1);
    expect(room.getPlayerByIndex(2)).to.not.exist;
    expect(room.getPlayerByIndex(3)).to.not.exist;
    expect(rollbacks).to.be.empty;
  });

  it('tells a replacement socket it remains a spectator after the disconnected original loses', async () => {
    service.joinRoom(room.roomId, 'a', 'Winner', socket('a').id);
    const original = spectator('b', '-original');
    const originalAttempt = claim(original, 1);
    await expectReads(1);
    original.connected = false;
    sockets.delete(original.id);
    await handlers.handleDisconnect(original);
    const replacement = spectator('b', '-replacement');
    const replacementAttempt = claim(replacement, 1);
    await flush();
    expect(reads).to.have.length(1);

    reads[0].resolve();
    await originalAttempt;
    await expectReads(2);
    reads[1].resolve();
    await replacementAttempt;

    expect(room.getPlayer('b')).to.not.exist;
    expect(rollbacks).to.deep.equal([
      { roomId: room.roomId, playerId: 'b', reservationVersion: 12 },
    ]);
    expect(reservations.get('b').isSpectator).to.equal(true);
    expect(handlers.spectatorSocketToRoom.get(replacement.id)).to.equal(room.roomId);
    expect(direct(replacement, 'kicked').filter((entry) =>
      entry.payload.toSpectator === true && entry.payload.reason === 'seat_taken'
    )).to.have.length(1);
    expect(direct(replacement, 'swap_failed').some((entry) => entry.payload.reason === 'seat_taken'))
      .to.equal(true);
  });

  it('never releases the winning reservation when an older spectator socket retries for the seated actor', async () => {
    const winner = spectator('a');
    const oldSocket = spectator('a', '-older');
    const winningAttempt = claim(winner, 1);
    await expectReads(1);
    reads[0].resolve();
    await winningAttempt;

    const staleAttempt = claim(oldSocket, 2);
    // Drain any unintended lookup too, so this catches the damaging release
    // rather than hanging if the stale socket incorrectly reaches the API.
    await flush();
    for (const read of reads) read.resolve();
    await staleAttempt;

    expect(room.getPlayer('a').socketId).to.equal(winner.id);
    expect(room.getPlayer('a').playerIndex).to.equal(1);
    expect(reservations.get('a').isSpectator).to.equal(false);
    expect(rollbacks).to.be.empty;
  });

  it('never releases a reservation if another socket seated the actor while validation was pending', async () => {
    const pendingSpectator = spectator('a');
    const attempt = claim(pendingSpectator, 1);
    await expectReads(1);
    const winner = socket('a', '-winner');
    expect(service.joinRoom(room.roomId, 'a', 'Winner', winner.id).success).to.equal(true);
    reads[0].resolve();
    await attempt;

    expect(room.getPlayer('a').socketId).to.equal(winner.id);
    expect(reservations.get('a').isSpectator).to.equal(false);
    expect(rollbacks).to.be.empty;
  });

  for (const missing of [false, true]) {
    it(`keeps a caller with ${missing ? 'no backend row' : 'only a spectator backend row'} as a spectator`, async () => {
      if (missing) reservations.delete('a');
      else reservations.get('a').isSpectator = true;
      const participant = spectator('a');
      const attempt = claim(participant);
      await expectReads(1);
      reads[0].resolve();
      await attempt;

      expect(room.getPlayer('a')).to.not.exist;
      expect(handlers.spectatorSocketToRoom.get(participant.id)).to.equal(room.roomId);
      expect(service.getPlayerIdBySocket(participant.id)).to.not.exist;
      expect(rollbacks, 'an unreserved viewer has nothing to release').to.be.empty;
    });
  }

  for (const version of [undefined, '11', 1.5, -1]) {
    it(`does not seat an API row with invalid reservation version ${JSON.stringify(version)}`, async () => {
      reservations.get('a').reservationVersion = version;
      const participant = spectator('a');
      const attempt = claim(participant);
      await expectReads(1);
      reads[0].resolve();
      await attempt;

      expect(room.getPlayer('a')).to.not.exist;
      expect(handlers.spectatorSocketToRoom.get(participant.id)).to.equal(room.roomId);
      expect(rollbacks).to.be.empty;
    });
  }

  for (const change of ['disconnect', 'leave', 'start', 'replace']) {
    it(`does not create a ghost seat when the room or membership changes via ${change} during validation`, async () => {
      const participant = spectator('a');
      const attempt = claim(participant);
      await expectReads(1);
      const originalRoom = room;

      if (change === 'disconnect') {
        participant.connected = false;
        sockets.delete(participant.id);
        await handlers.handleDisconnect(participant);
      } else if (change === 'leave') {
        handlers.handleLeaveRoom(participant);
      } else if (change === 'start') {
        room.status = GameRoomStatus.IN_PROGRESS;
      } else {
        service.rooms.delete(room.roomId);
        room = service.createRoom(originalRoom.roomId, 4);
        room.backendManaged = true;
        room.seatReservationProtocol = 1;
        room.backendBaseUrl = originalRoom.backendBaseUrl;
      }

      reads[0].resolve();
      await attempt;

      expect(originalRoom.getPlayer('a')).to.not.exist;
      expect(room.getPlayer('a')).to.not.exist;
      expect(service.getPlayerIdBySocket(participant.id)).to.not.exist;
      if (change === 'disconnect' || change === 'leave') {
        expect(handlers.spectatorSocketToRoom.has(participant.id)).to.equal(false);
      }
    });
  }

  it('does not revive an old claim after the same socket leaves and rejoins as a spectator', async () => {
    const participant = spectator('a');
    const attempt = claim(participant);
    await expectReads(1);

    handlers.handleLeaveRoom(participant);
    reservations.get('a').isSpectator = true;
    reservations.get('a').reservationVersion = 21;
    handlers._addSpectator(participant, room.roomId, 'a', 'Returned viewer');
    reads[0].resolve();
    await attempt;

    expect(room.getPlayer('a')).to.not.exist;
    expect(service.getPlayerIdBySocket(participant.id)).to.not.exist;
    expect(handlers.spectatorSocketToRoom.get(participant.id)).to.equal(room.roomId);
    expect(reservations.get('a')).to.include({ isSpectator: true, reservationVersion: 21 });
  });

  it('honors a stand-up request that arrives while the approved claim is still waiting for its response', async () => {
    const participant = spectator('a');
    const attempt = claim(participant);
    await expectReads(1);

    // The REST stand-up already released the stake, but the earlier room-fetch
    // still has the pre-release row in flight when the socket leave_seat lands.
    reservations.get('a').isSpectator = true;
    handlers.handleLeaveSeat(participant);
    reads[0].resolve();
    await attempt;

    expect(room.getPlayer('a')).to.not.exist;
    expect(service.getPlayerIdBySocket(participant.id)).to.not.exist;
    expect(handlers.spectatorSocketToRoom.get(participant.id)).to.equal(room.roomId);
    expect(reservations.get('a').isSpectator).to.equal(true);
  });

  it('allows a harmless spectator identity refresh while the same membership claim is pending', async () => {
    const participant = spectator('a');
    const attempt = claim(participant);
    await expectReads(1);

    handlers._addSpectator(participant, room.roomId, 'a', 'Refreshed viewer');
    reads[0].resolve();
    await attempt;

    expect(room.getPlayer('a').playerIndex).to.equal(1);
    expect(reservations.get('a').isSpectator).to.equal(false);
    expect(rollbacks).to.be.empty;
  });

  it('does not seat a caller if the reservation lookup fails', async () => {
    const participant = spectator('a');
    const attempt = claim(participant);
    await expectReads(1);
    reads[0].reject(new Error('backend unavailable'));
    await attempt;

    expect(room.getPlayer('a')).to.not.exist;
    expect(handlers.spectatorSocketToRoom.get(participant.id)).to.equal(room.roomId);
    expect(rollbacks).to.be.empty;
  });

  it('does not clear a newer reservation when a stale rejection callback is refused', async () => {
    const participant = spectator('b');
    const attempt = claim(participant);
    await expectReads(1);
    service.joinRoom(room.roomId, 'a', 'Winner', socket('a').id);
    reservations.get('b').reservationVersion = 99;
    reads[0].resolve();
    await attempt;

    expect(rollbacks).to.deep.equal([
      { roomId: room.roomId, playerId: 'b', reservationVersion: 12 },
    ]);
    expect(reservations.get('b')).to.include({ reservationVersion: 99, isSpectator: false });
    expect(direct(participant, 'kicked').filter((entry) => entry.payload.toSpectator === true))
      .to.be.empty;
    expect(room.getPlayer('b')).to.not.exist;
  });

  it('retries a transient release failure with the same reservation version and demotes only once', async () => {
    const backendFetch = global.fetch;
    const releaseAttempts = [];
    global.fetch = (url, options) => {
      if (String(url).endsWith('/api/webhooks/room-seat-claim-rejected')) {
        releaseAttempts.push(JSON.parse(options.body));
        if (releaseAttempts.length === 1) return Promise.reject(new Error('temporary connection reset'));
      }
      return backendFetch(url, options);
    };
    service.joinRoom(room.roomId, 'a', 'Winner', socket('a').id);
    const participant = spectator('b');
    const attempt = claim(participant);
    await expectReads(1);
    reads[0].resolve();
    await attempt;

    expect(releaseAttempts).to.deep.equal([
      { roomId: room.roomId, playerId: 'b', reservationVersion: 12 },
      { roomId: room.roomId, playerId: 'b', reservationVersion: 12 },
    ]);
    expect(rollbacks).to.have.length(1);
    expect(reservations.get('b').isSpectator).to.equal(true);
    expect(direct(participant, 'kicked').filter((entry) => entry.payload.toSpectator === true))
      .to.have.length(1);
    expect(room.getPlayer('b')).to.not.exist;
  });

  for (const retryVia of ['claim', 'join']) {
    it(`does not admit a refunded player through ${retryVia} after an ambiguous release timeout`, async function () {
      this.timeout(10000);
      service.joinRoom(room.roomId, 'a', 'Winner', socket('a').id);
      const participant = spectator('b');
      const backendFetch = global.fetch;
      const timedOutReleases = [];
      global.fetch = (url, options) => {
        if (String(url).endsWith('/api/webhooks/room-seat-claim-rejected')) {
          // The client times out before it knows whether the API committed.
          // Keep the API row active until the delayed original request lands.
          timedOutReleases.push({ url, options, body: JSON.parse(options.body) });
          return Promise.reject(new Error('release response timed out before its commit was known'));
        }
        return backendFetch(url, options);
      };
      const firstClaim = claim(participant, 1);
      await expectReads(1);
      reads[0].resolve();
      await firstClaim;
      expect(timedOutReleases).to.not.be.empty;
      expect(reservations.get('b').isSpectator).to.equal(false);
      expect(room.getPlayer('b')).to.not.exist;

      // A fresh lookup still reports the OLD reserved row. It must not turn an
      // unresolved compensation into a seated player at a different free chair.
      autoRead = true;
      const retry = retryVia === 'claim'
        ? claim(participant, 2)
        : handlers.handleJoinRoom(participant, {
          roomId: room.roomId, playerId: 'b', playerName: 'Viewer b', isSpectator: false,
        });
      if (retryVia === 'join') pending.push(retry);
      await retry;

      expect(room.getPlayer('b'), 'an unresolved release token cannot be reused for admission').to.not.exist;
      expect(room.getPlayerByIndex(2)).to.not.exist;
      expect(timedOutReleases.every((request) => request.body.reservationVersion === 12)).to.equal(true);

      const delayed = timedOutReleases[0];
      const result = await backendFetch(delayed.url, delayed.options);
      expect((await result.json()).released).to.equal(true);
      expect(reservations.get('b').isSpectator).to.equal(true);
      expect(room.getPlayer('b'), 'a delayed refund must never leave a live unpaid player').to.not.exist;
      expect(service.getPlayerIdBySocket(participant.id)).to.not.exist;
    });
  }

  it('accepts a fresh reservation generation without letting an old delayed release refund it', async () => {
    service.joinRoom(room.roomId, 'a', 'Winner', socket('a').id);
    const participant = spectator('b');
    const backendFetch = global.fetch;
    const timedOutReleases = [];
    global.fetch = (url, options) => {
      if (String(url).endsWith('/api/webhooks/room-seat-claim-rejected')) {
        timedOutReleases.push({ url, options, body: JSON.parse(options.body) });
        return Promise.reject(new Error('old release response timed out'));
      }
      return backendFetch(url, options);
    };
    const losing = claim(participant, 1);
    await expectReads(1);
    reads[0].resolve();
    await losing;
    expect(timedOutReleases).to.not.be.empty;

    reservations.get('b').reservationVersion = 22;
    autoRead = true;
    await claim(participant, 2);

    expect(room.getPlayer('b').playerIndex).to.equal(2);
    expect(reservations.get('b')).to.include({ reservationVersion: 22, isSpectator: false });
    expect(timedOutReleases.every((request) => request.body.reservationVersion === 12)).to.equal(true);
    const delayed = timedOutReleases[0];
    const result = await backendFetch(delayed.url, delayed.options);
    expect(await result.json()).to.include({ released: false, isSpectator: false });
    expect(reservations.get('b').isSpectator).to.equal(false);
    expect(room.getPlayer('b').playerIndex).to.equal(2);
  });

  it('does not let a reconnect take another chair while a claim started during its API lookup is rolling back', async () => {
    service.joinRoom(room.roomId, 'a', 'Winner', socket('a').id);
    const participant = spectator('b');
    const releaseGate = deferred();
    extraGates.push(releaseGate);
    const backendFetch = global.fetch;
    let releaseRequested = false;
    global.fetch = (url, options) => {
      if (String(url).endsWith('/api/webhooks/room-seat-claim-rejected')) {
        releaseRequested = true;
        return releaseGate.promise.then(() => backendFetch(url, options));
      }
      return backendFetch(url, options);
    };

    const joining = handlers.handleJoinRoom(participant, {
      roomId: room.roomId, playerId: 'b', playerName: 'Viewer b', isSpectator: false,
    });
    pending.push(joining);
    await expectReads(1);
    const claiming = claim(participant, 1);
    // A join that started first must yield its automatic seat allocation once
    // an explicit seat choice has arrived. The claim can run after it in the
    // actor queue; the join must not await its own queued successor.
    reads[0].resolve();
    await flush();
    expect(room.getPlayer('b'), 'the reconnect must not automatically occupy another chair').to.not.exist;
    await expectReads(2);
    reads[1].resolve();
    await flush();
    expect(releaseRequested).to.equal(true);
    expect(room.getPlayer('b'), 'a failed claim cannot occupy another chair while releasing').to.not.exist;

    releaseGate.resolve();
    await claiming;
    await joining;

    expect(room.getPlayer('b')).to.not.exist;
    expect(room.getPlayerByIndex(2)).to.not.exist;
    expect(handlers.spectatorSocketToRoom.get(participant.id)).to.equal(room.roomId);
    expect(reservations.get('b').isSpectator).to.equal(true);
    expect(rollbacks).to.have.length(1);
  });

  it('reconnects a rejected reservation as a spectator despite stale client isSpectator=false', async () => {
    reservations.get('b').isSpectator = true;
    const participant = socket('b', '-reconnected');
    const attempt = handlers.handleJoinRoom(participant, {
      roomId: room.roomId, playerId: 'b', playerName: 'Viewer b', isSpectator: false,
    });
    pending.push(attempt);
    await expectReads(1);
    reads[0].resolve();
    await attempt;

    expect(room.getPlayer('b')).to.not.exist;
    expect(service.getPlayerIdBySocket(participant.id)).to.not.exist;
    expect(handlers.spectatorSocketToRoom.get(participant.id)).to.equal(room.roomId);
    expect(direct(participant, 'player_joined').some((entry) => entry.payload.isSpectator === true))
      .to.equal(true);
    expect(rollbacks).to.be.empty;
  });

  it('makes a reconnect arriving during a pending losing claim observe its completed rollback', async () => {
    service.joinRoom(room.roomId, 'a', 'Winner', socket('a').id);
    const participant = spectator('b');
    const claiming = claim(participant, 1);
    await expectReads(1);
    const joining = handlers.handleJoinRoom(participant, {
      roomId: room.roomId, playerId: 'b', playerName: 'Viewer b', isSpectator: false,
    });
    pending.push(joining);
    await flush();
    expect(room.getPlayer('b')).to.not.exist;
    reads[0].resolve();
    await claiming;
    await expectReads(2);
    reads[1].resolve();
    await joining;

    expect(room.getPlayer('b')).to.not.exist;
    expect(room.getPlayerByIndex(2)).to.not.exist;
    expect(reservations.get('b').isSpectator).to.equal(true);
    expect(handlers.spectatorSocketToRoom.get(participant.id)).to.equal(room.roomId);
    expect(rollbacks).to.have.length(1);
  });
});
