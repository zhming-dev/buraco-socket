/* eslint-env mocha */

/**
 * Ghost tables — a room this server keeps alive while its players can no
 * longer reach it (reported 2026-09-22).
 *
 *   1. A deploy restart restored a live room and HELD it for its players; the
 *      liveness heartbeat omitted it ("no connected human"), so the backend hid
 *      it from the lobby and detached the players while the hold was waiting for
 *      exactly those players. → the heartbeat now reports every room that still
 *      seats a human (heartbeat_retry.test.js).
 *   2. The stranded host created a NEW room; join_room was refused ("Player is
 *      already in another active room") because this server still bound them to
 *      the ghost, and _rejectReservedJoin demoted them to a SPECTATOR of their own
 *      room until the ghost reaped itself minutes later. → a verified seat in a
 *      new room releases a stale (socket-less) seat in a live old room: void the
 *      old room when nobody is left in it, forfeit when someone still plays.
 *   3. "Maintenance on" / "Announce restart" / "Restart process" made every
 *      client leave the table but left the rooms on the server — and the deploy
 *      drain then snapshotted and RESTORED them as ghosts. → the notice voids
 *      every live room server-side.
 */

const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents, GameRoomStatus } = require('../../src/constants');

function fakeSocket(id, emitted) {
  return {
    id,
    connected: true,
    joined: [],
    left: [],
    join(r) { this.joined.push(r); },
    leave(r) { this.left.push(r); },
    emit: (event, payload) => emitted.push({ scope: 'socket', id, event, payload }),
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ scope: 'socket-to', id, roomId, event, payload }) }),
  };
}

function fakeIo(emitted, registry = new Map()) {
  return {
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ scope: 'room', roomId, event, payload }) }),
    emit: (event, payload) => emitted.push({ scope: 'global', event, payload }),
    sockets: { sockets: registry },
  };
}

/** A dealt 2-seat match: host '10' on sHost, opponent '20' on sOpp. */
function liveRoom(service, roomId, { hostSocket = 'sHost', oppSocket = 'sOpp' } = {}) {
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, '10', 'Host', hostSocket);
  service.joinRoom(roomId, '20', 'Opp', oppSocket);
  room.backendManaged = true;
  room.startGame(true);
  room.dealCards();
  room.currentTurn = 0;
  return room;
}

describe('ghost rooms after a restart / a "leave the table" notice', () => {
  let emitted;
  let registry;
  let service;
  let handlers;
  let closed;

  beforeEach(() => {
    emitted = [];
    registry = new Map();
    closed = [];
    service = new GameService();
    handlers = new SocketHandlers(fakeIo(emitted, registry), service);
    // onRoomDeleted passes reason=null; the real notifier reads the stash.
    handlers._notifyBackendRoomClosed = function (roomId, reason) {
      const ctx = this._roomCloseContext.get(String(roomId));
      closed.push({ roomId: String(roomId), reason: reason || (ctx && ctx.reason) || null });
    };
    handlers._notifyBackendGameResult = () => {};
    handlers._emitPartnerWebhook = () => {};
  });

  afterEach(() => {
    for (const room of service.rooms.values()) handlers._stopTurnTimer(room);
    service.shutdown();
  });

  const roomClosedFor = (roomId) =>
    emitted.filter((e) => e.scope === 'room' && e.roomId === roomId && e.event === SocketEvents.ROOM_CLOSED);

  describe('a verified seat in a new room releases a stale seat in a live old room', () => {
    it('voids the old room when nobody is left in it (restart hold nobody rejoined) and lets the join proceed', () => {
      const ghost = liveRoom(service, 'ghost');
      // As after a restart: every seat socket-less, room held.
      for (const p of ghost.getPlayers()) { p.socketId = null; p.disconnect?.(); }
      handlers._holdRoomForRestart(ghost);
      // The host creates a new room via the backend (sync-room) and joins it.
      const fresh = service.createRoom('fresh', 2);
      fresh.backendManaged = true;

      const released = handlers._releaseStaleSeatForNewRoom(ghost, '10', fresh, { via: 'join_room' });

      expect(released).to.equal(true);
      expect(service.getRoom('ghost')).to.equal(undefined, 'ghost room voided');
      expect(ghost.restartHold).to.equal(null);
      expect(ghost.restartHoldHandle).to.equal(null);
      expect(roomClosedFor('ghost')).to.have.lengthOf(1);
      expect(roomClosedFor('ghost')[0].payload.reason).to.equal('abandoned');
      expect(closed).to.deep.equal([{ roomId: 'ghost', reason: 'abandoned' }]);
      // No result was produced — the match is voided, not decided.
      expect(emitted.some((e) => e.event === SocketEvents.GAME_ENDED)).to.equal(false);

      // The join that used to be refused now goes through as a normal seat.
      const join = service.joinRoom('fresh', '10', 'Host', 'sNew');
      expect(join.success).to.equal(true);
      expect(join.reconnected).to.not.equal(true);
      expect(service.getPlayerRoom('10')).to.equal(fresh);
      // ...and the opponent, equally stranded, is free too.
      expect(service.getPlayerRoom('20')).to.equal(undefined);
    });

    it('forfeits the stale seat when the opponent is still playing (same as an explicit leave)', () => {
      const old = liveRoom(service, 'old');
      // Opponent is live on sOpp; the host's seat has no socket (app lost).
      registry.set('sOpp', fakeSocket('sOpp', emitted));
      old.getPlayer('10').socketId = null;
      const fresh = service.createRoom('fresh', 2);
      fresh.backendManaged = true;

      const released = handlers._releaseStaleSeatForNewRoom(old, '10', fresh, { via: 'join_room' });

      expect(released).to.equal(true);
      expect(old.status).to.equal(GameRoomStatus.FINISHED);
      expect(old.winnerId).to.equal('20');
      const ended = emitted.find((e) => e.scope === 'room' && e.roomId === 'old' && e.event === SocketEvents.GAME_ENDED);
      expect(ended.payload.reason).to.equal('host_left');
      expect(ended.payload.matchEnded).to.equal(true);
      expect(roomClosedFor('old')).to.have.lengthOf(0, 'a forfeit is a result, not a void');

      const join = service.joinRoom('fresh', '10', 'Host', 'sNew');
      expect(join.success).to.equal(true);
      expect(service.getPlayerRoom('10')).to.equal(fresh);
    });

    it('still refuses a seat that has a LIVE socket (a real double-play)', () => {
      const old = liveRoom(service, 'old');
      registry.set('sHost', fakeSocket('sHost', emitted));
      const fresh = service.createRoom('fresh', 2);
      fresh.backendManaged = true;

      expect(handlers._releaseStaleSeatForNewRoom(old, '10', fresh)).to.equal(false);
      expect(service.getRoom('old')).to.equal(old);
      expect(old.status).to.equal(GameRoomStatus.IN_PROGRESS);
      expect(service.joinRoom('fresh', '10', 'Host', 'sHost').error).to.equal('Player is already in another active room');
    });

    it('leaves lobby seats and pending starts to their own paths', () => {
      const lobby = service.createRoom('lobby', 2);
      lobby.backendManaged = true;
      service.joinRoom('lobby', '40', 'Waiting', null);
      const fresh = service.createRoom('fresh', 2);
      expect(handlers._releaseStaleSeatForNewRoom(lobby, '40', fresh)).to.equal(false);
      expect(service.getRoom('lobby')).to.equal(lobby);

      const starting = liveRoom(service, 'starting');
      starting.getPlayer('10').socketId = null;
      starting._pendingBackendStart = { attemptId: 'a1', cancelled: false };
      expect(handlers._releaseStaleSeatForNewRoom(starting, '10', fresh)).to.equal(false);
      starting._pendingBackendStart = null;
    });
  });

  describe('end to end through join_room with a backend seat reservation', () => {
    const config = require('../../src/config');
    let originalFetch;
    let originalBackendUrl;

    beforeEach(() => {
      originalFetch = global.fetch;
      originalBackendUrl = config.backend.url;
      config.backend.url = 'http://backend.test';
      handlers._notifyBackendPlayerCount = () => {};
      handlers._ensureHostHeartbeat = () => {};
    });

    afterEach(() => {
      global.fetch = originalFetch;
      config.backend.url = originalBackendUrl;
      for (const timer of handlers._waitingGraceTimers.values()) clearTimeout(timer);
    });

    it('the stranded host of a ghost room takes a real seat in the room they just created (not a spectator)', async () => {
      // The ghost: a restored, held match with nobody connected.
      const ghost = liveRoom(service, 'ghost');
      for (const p of ghost.getPlayers()) { p.socketId = null; p.disconnect?.(); }
      handlers._holdRoomForRestart(ghost);

      // The new lobby the backend created for '10' (sync-room), with a
      // reservation for seat 0 (host).
      const fresh = service.createRoom('fresh', 2);
      fresh.backendManaged = true;
      fresh.seatReservationProtocol = 1;
      fresh.backendBaseUrl = 'http://backend.test';
      fresh.hostPlayerId = '10';
      global.fetch = (url) => {
        if (String(url).endsWith('/api/webhooks/room-fetch')) {
          return Promise.resolve({ ok: true, json: async () => ({
            success: true, exists: true, roomId: 'fresh', status: 'open', maxPlayers: 2, hostPlayerId: '10',
            seatReservationProtocol: 1,
            players: [{ playerId: '10', playerIndex: 0, isSpectator: false, reservationVersion: 1 }],
          }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      };
      const sock = fakeSocket('sNew', emitted);
      sock.data = { authenticated: true, userId: '10' };
      registry.set('sNew', sock);

      await handlers.handleJoinRoom(sock, { roomId: 'fresh', playerId: '10', playerName: 'Host', isSpectator: false });

      expect(service.getRoom('ghost')).to.equal(undefined, 'ghost voided');
      expect(closed).to.deep.equal([{ roomId: 'ghost', reason: 'abandoned' }]);
      expect(fresh.getPlayer('10'), 'seated in the new room').to.exist;
      expect(fresh.getPlayer('10').playerIndex).to.equal(0);
      expect(service.getPlayerRoom('10')).to.equal(fresh);
      expect(handlers.spectatorSocketToRoom.get('sNew')).to.equal(undefined, 'never demoted to spectator');
      expect(emitted.some((e) => e.event === 'kicked')).to.equal(false);
      expect(emitted.some((e) => e.scope === 'socket' && e.event === SocketEvents.ERROR)).to.equal(false);
    });
  });

  describe('a "leave the table" notice clears the tables server-side too', () => {
    it('maintenance_mode voids every live room, tells the backend, and reports the count', () => {
      const a = liveRoom(service, 'a');
      const lobby = service.createRoom('lobby', 2);
      service.joinRoom('lobby', '30', 'Solo', 'sSolo');
      registry.set('sHost', fakeSocket('sHost', emitted));
      expect(handlers.listRoomsForDev().rooms.map((r) => r.roomId)).to.have.members([a.roomId, lobby.roomId]);

      const res = handlers.broadcastDevelopmentNotice({ maintenance_mode: true, message: 'Back in 10 min' });

      expect(res.success).to.equal(true);
      expect(res.roomsClosed).to.equal(2);
      expect(service.getRoom('a')).to.equal(undefined);
      expect(service.getRoom('lobby')).to.equal(undefined);
      expect(a.turnTimerHandle).to.equal(null);
      // The notice reaches every socket BEFORE the per-room room_closed.
      const order = emitted.map((e) => e.event);
      expect(order.indexOf(SocketEvents.DEVELOPMENT)).to.be.lessThan(order.indexOf(SocketEvents.ROOM_CLOSED));
      expect(roomClosedFor('a')[0].payload).to.include({ reason: 'maintenance', message: 'Back in 10 min' });
      expect(closed.map((c) => c.reason)).to.deep.equal(['maintenance', 'maintenance']);
      // Nobody is bound to a table anymore.
      expect(service.getPlayerRoom('10')).to.equal(undefined);
      expect(service.getPlayerRoom('30')).to.equal(undefined);
      expect(handlers.listRoomsForDev().rooms).to.have.lengthOf(0);
    });

    it('restart_server voids with reason server_restart; all-clear voids nothing', () => {
      liveRoom(service, 'a');
      const allClear = handlers.broadcastDevelopmentNotice({ maintenance_mode: false, restart_server: false });
      expect(allClear.success).to.equal(true);
      expect(allClear.roomsClosed).to.equal(0);
      expect(service.getRoom('a')).to.not.equal(undefined);

      const res = handlers.broadcastDevelopmentNotice({ restart_server: true });
      expect(res.roomsClosed).to.equal(1);
      expect(closed).to.deep.equal([{ roomId: 'a', reason: 'server_restart' }]);
      expect(service.getRoom('a')).to.equal(undefined);
    });
  });
});

describe('a grace timer must not resurrect a room that was torn down while the seat was in grace', () => {
  const FailureManager = require('../../src/managers/FailureManager');
  const InMemoryRedis = require('../../src/utils/InMemoryRedis');
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

  it('drops the marker and does NOT re-persist the deleted room', async () => {
    const redis = new InMemoryRedis();
    const service = new GameService();
    const emitted = [];
    const registry = new Map();
    const fm = new FailureManager(fakeIo(emitted, registry), redis, service, silentLogger);
    fm.GRACE_PERIOD_SECONDS = 0.01;
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service, null, fm);
    handlers._notifyBackendRoomClosed = () => {};
    const room = liveRoom(service, 'g1');
    const seat = room.getPlayer('20');
    seat.socketId = null;
    seat.status = 'grace_period';
    const graceKey = 'grace:20:g1';
    fm._scheduleGracePeriodExpiry(room, seat, graceKey);

    // Admin closes the game (snapshot purged) while the seat is still in grace.
    expect(handlers.closeRoomFromDev({ roomId: 'g1' }).success).to.equal(true);
    await new Promise((r) => setTimeout(r, 40));

    expect(await redis.get('game:g1:state')).to.equal(null, 'no snapshot written back');
    expect(fm.graceTimers.has(graceKey)).to.equal(false);
    service.shutdown();
  });
});
