/* eslint-env mocha */

/**
 * Deploy-restart resilience (docs/RESTART_RESILIENCE.md).
 *
 * A restart used to be handled like a network drop: io.close() ran the full
 * player-disconnect path for every socket (grace, player_disconnected to
 * sockets being closed, a `player.status` webhook, a state persist racing the
 * Redis quit), and the next boot kicked every restored room's runtime at once —
 * the interrupted turn ran out against an empty chair (auto-play / offline
 * strike for a deploy the player never caused), bots played into an unwatched
 * table, and an intermission re-deal fired into "no humans connected" and
 * settled the match.
 *
 * These pin the new contract:
 *   SHUTDOWN  drain mode (disconnects are not leaves) + one awaited, precise
 *             final snapshot, after which nothing may overwrite it;
 *   BOOT      every human seat is "awaiting reconnect" and the room is HELD —
 *             no turn timer, no bot move, no next-round deal;
 *   REJOIN    the first human back releases the hold and the interrupted turn
 *             resumes with the time it had left (floored), the intermission
 *             with its remaining countdown;
 *   TIMEOUT   a hold nobody returns to expires into the normal runtime.
 */

const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');
const { GameRoomStatus } = require('../../src/constants');
const config = require('../../src/config');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function fakeSocket(id, emitted) {
  return {
    id,
    join() {},
    leave() {},
    emit: (event, payload) => emitted.push({ scope: 'socket', id, event, payload }),
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'socket-to', id, roomId, event, payload }),
    }),
  };
}

function fakeIo(emitted, registry = new Map()) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'room', roomId, event, payload }),
    }),
    emit: (event, payload) => emitted.push({ scope: 'global', event, payload }),
    sockets: { sockets: registry },
  };
}

/** A dealt 2-seat match with the turn timer live on seat 0. */
function liveRoom(service, roomId = 'rr1') {
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, '10', 'Host', 'sHost');
  service.joinRoom(roomId, '20', 'Opp', 'sOpp');
  room.startGame(true);
  room.dealCards();
  room.currentTurn = 0;
  return room;
}

/** Boot a "fresh process" off the same Redis: new service/manager/handlers. */
async function boot(redis, emitted, registry) {
  const service = new GameService();
  const fm = new FailureManager(fakeIo(emitted, registry), redis, service, silentLogger);
  await fm.loadPersistedGames();
  const handlers = new SocketHandlers(fakeIo(emitted, registry), service, null, fm);
  return { service, fm, handlers };
}

describe('deploy restart — drain, snapshot, hold, resume', () => {
  const cleanups = [];
  let emitted;
  let origHold;
  let origMinTurn;

  beforeEach(() => {
    emitted = [];
    origHold = config.game.restartHoldMs;
    origMinTurn = config.game.restartMinTurnMs;
  });

  afterEach(async () => {
    config.game.restartHoldMs = origHold;
    config.game.restartMinTurnMs = origMinTurn;
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      // eslint-disable-next-line no-await-in-loop
      await fn();
    }
  });

  function track({ service, fm, handlers, redis }) {
    cleanups.push(async () => {
      handlers?._stopBackendHeartbeat?.();
      fm?.dispose?.();
      service?.shutdown?.();
      if (redis) await redis.quit();
    });
  }

  it('snapshot carries the exact ms left on the live turn and restores it', async () => {
    const redis = new InMemoryRedis();
    const service = new GameService();
    const fm = new FailureManager(fakeIo(emitted), redis, service, silentLogger);
    track({ service, fm, redis });
    const room = liveRoom(service);
    room.turnTimerDeadline = Date.now() + 12345;

    await fm.persistGameState(room);
    const snap = JSON.parse(await redis.get('game:rr1:state'));
    expect(snap.turnTimerRemainingMs).to.be.within(12000, 12345);

    const fresh = new GameService();
    const freshFm = new FailureManager(fakeIo(emitted), redis, fresh, silentLogger);
    track({ service: fresh, fm: freshFm });
    await freshFm.loadPersistedGames();
    expect(fresh.getRoom('rr1').restoredTurnRemainingMs).to.equal(snap.turnTimerRemainingMs);

    // No timer armed → null, never a stale number — and it restores as null.
    room.turnTimerDeadline = null;
    await fm.persistGameState(room);
    expect(JSON.parse(await redis.get('game:rr1:state')).turnTimerRemainingMs).to.equal(null);
    const again = new GameService();
    const againFm = new FailureManager(fakeIo(emitted), redis, again, silentLogger);
    track({ service: again, fm: againFm });
    await againFm.loadPersistedGames();
    expect(again.getRoom('rr1').restoredTurnRemainingMs).to.equal(null);
  });

  it('persistAllGames writes every room once and freezes later writes', async () => {
    const redis = new InMemoryRedis();
    const service = new GameService();
    const fm = new FailureManager(fakeIo(emitted), redis, service, silentLogger);
    track({ service, fm, redis });
    const a = liveRoom(service, 'a');
    const b = liveRoom(service, 'b');
    b.awaitingNextRound = true;
    b.nextRoundAt = Date.now() + 9000;
    b.status = GameRoomStatus.FINISHED;

    const result = await fm.persistAllGames({ timeoutMs: 1000 });
    expect(result).to.deep.equal({ total: 2, persisted: 2, timedOut: false });
    expect(JSON.parse(await redis.get('game:b:state')).awaitingNextRound).to.equal(true);

    // A straggling write (the old shutdown race) after disposeTimers() must not
    // erase the intermission that the final snapshot captured.
    service.shutdown(); // disposeTimers → awaitingNextRound=false in memory
    expect(b.awaitingNextRound).to.equal(false);
    await fm.persistGameState(b);
    expect(JSON.parse(await redis.get('game:b:state')).awaitingNextRound).to.equal(true);
    a.turnTimerDeadline = null; // silence: room a untouched
  });

  it('drain mode: closing sockets is not a player leaving', async () => {
    const redis = new InMemoryRedis();
    const service = new GameService();
    const registry = new Map();
    const fm = new FailureManager(fakeIo(emitted, registry), redis, service, silentLogger);
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service, null, fm);
    track({ service, fm, handlers, redis });
    const room = liveRoom(service);
    const host = room.getPlayer('10');

    const notified = handlers.beginRestartDrain({ message: 'deploying v2' });
    expect(notified).to.equal(0); // registry is empty in this harness
    const notice = emitted.find((e) => e.event === 'server_restarting');
    expect(notice, 'server_restarting broadcast').to.exist;
    expect(notice.payload.resume).to.equal(true);
    expect(notice.payload.message).to.equal('deploying v2');
    expect(handlers.beginRestartDrain(), 'idempotent').to.equal(0);

    await handlers.handleDisconnect(fakeSocket('sHost', emitted), 'server shutting down');

    expect(host.status).to.equal('connected');
    expect(host.isConnected).to.equal(true);
    expect(host.socketId).to.equal('sHost');
    expect(emitted.some((e) => e.event === 'player_disconnected')).to.equal(false);
    expect(await redis.get('grace:10:rr1')).to.equal(null);
    // Only the socket→player mapping is dropped.
    expect(service.getPlayerIdBySocket('sHost')).to.equal(undefined);
    expect(service.getPlayerRoom('10')).to.equal(room);
  });

  it('boot: restored in-progress room is HELD — seats await reconnect, no timer, no bot', async () => {
    config.game.restartHoldMs = 60000;
    const redis = new InMemoryRedis();
    {
      const service = new GameService();
      const fm = new FailureManager(fakeIo(emitted), redis, service, silentLogger);
      const room = liveRoom(service);
      room.getPlayer('20').isBot = true;
      room.turnTimerDeadline = Date.now() + 17000;
      await fm.persistAllGames();
      fm.dispose();
      service.shutdown();
    }

    const registered = [];
    const { service, fm, handlers } = await boot(redis, emitted, new Map());
    track({ service, fm, handlers, redis });
    handlers.botCoordinator = {
      registerBot: (roomId, playerId) => registered.push(`${roomId}:${playerId}`),
      onRoomStateChanged: () => registered.push('state-changed'),
      unregisterRoom() {},
    };

    const resumed = await handlers.resumePersistedRooms();
    expect(resumed).to.equal(1);
    const room = service.getRoom('rr1');
    expect(room.restartHold, 'room is held').to.exist;
    expect(room.restartHold.remainingTurnMs).to.be.within(16000, 17000);
    expect(room.restartHoldHandle).to.exist;
    expect(room.turnTimerTickHandle, 'no turn timer while held').to.equal(null);
    expect(registered, 'no bot registered / kicked while held').to.deep.equal([]);
    expect(emitted.some((e) => e.event === 'turn_timer_started')).to.equal(false);

    const host = room.getPlayer('10');
    expect(host.status).to.equal('grace_period');
    expect(host.isConnected).to.equal(false);
    expect(host.socketId, 'dead socket id dropped').to.equal(null);
    expect(fm.graceTimers.has('grace:10:rr1'), 'grace re-armed for the human').to.equal(true);
    const bot = room.getPlayer('20');
    expect(bot.isBot).to.equal(true);
    expect(fm.graceTimers.has('grace:20:rr1'), 'bots never enter grace').to.equal(false);
  });

  it('rejoin releases the hold and resumes the interrupted turn with its remaining time', async () => {
    config.game.restartHoldMs = 60000;
    config.game.restartMinTurnMs = 10000;
    const redis = new InMemoryRedis();
    {
      const service = new GameService();
      const fm = new FailureManager(fakeIo(emitted), redis, service, silentLogger);
      const room = liveRoom(service);
      room.turnTimerDeadline = Date.now() + 17000;
      await fm.persistAllGames();
      fm.dispose();
      service.shutdown();
    }
    const registry = new Map();
    const { service, fm, handlers } = await boot(redis, emitted, registry);
    track({ service, fm, handlers, redis });
    const registered = [];
    handlers.botCoordinator = {
      registerBot: (roomId, playerId) => registered.push(`${roomId}:${playerId}`),
      onRoomStateChanged() {},
      unregisterRoom() {},
    };
    await handlers.resumePersistedRooms();
    const room = service.getRoom('rr1');
    expect(room.restartHold).to.exist;

    const socket = fakeSocket('sHost2', emitted);
    registry.set('sHost2', socket);
    await handlers.handleJoinRoom(socket, { roomId: 'rr1', playerId: '10', playerName: 'Host' });

    expect(room.restartHold, 'hold released by the rejoin').to.equal(null);
    expect(room.restartHoldHandle).to.equal(null);
    expect(room.turnTimerTickHandle, 'turn timer re-armed').to.exist;
    const started = emitted.find((e) => e.event === 'turn_timer_started');
    expect(started, 'turn_timer_started broadcast').to.exist;
    expect(started.payload.playerIndex).to.equal(0);
    // The time that was left at shutdown (≈17s), not a fresh 30s turn.
    expect(started.payload.seconds).to.be.within(15, 17);
    expect(room.getPlayer('10').isConnected).to.equal(true);
    expect(room.getPlayer('10').socketId).to.equal('sHost2');
    expect(fm.graceTimers.has('grace:10:rr1')).to.equal(false);

    // A second rejoin (the other seat) is a no-op on the hold and must not
    // restart the timer.
    const before = room.turnTimerDeadline;
    const socket2 = fakeSocket('sOpp2', emitted);
    registry.set('sOpp2', socket2);
    await handlers.handleJoinRoom(socket2, { roomId: 'rr1', playerId: '20', playerName: 'Opp' });
    expect(room.turnTimerDeadline).to.equal(before);
    service.deleteRoom('rr1');
  });

  it('resume floors a nearly-expired turn at restartMinTurnMs', async () => {
    config.game.restartHoldMs = 60000;
    config.game.restartMinTurnMs = 10000;
    const redis = new InMemoryRedis();
    {
      const service = new GameService();
      const fm = new FailureManager(fakeIo(emitted), redis, service, silentLogger);
      const room = liveRoom(service);
      room.turnTimerDeadline = Date.now() + 800; // 0.8s left when the deploy hit
      await fm.persistAllGames();
      fm.dispose();
      service.shutdown();
    }
    const { service, fm, handlers } = await boot(redis, emitted, new Map());
    track({ service, fm, handlers, redis });
    await handlers.resumePersistedRooms();
    const room = service.getRoom('rr1');
    handlers._releaseRestartHold(room, 'test');
    const started = emitted.find((e) => e.event === 'turn_timer_started');
    expect(started.payload.seconds).to.equal(10);
    service.deleteRoom('rr1');
  });

  it('hold expiry with nobody back falls through to the normal runtime', async () => {
    config.game.restartHoldMs = 1000; // clamped floor in _holdRoomForRestart
    const redis = new InMemoryRedis();
    {
      const service = new GameService();
      const fm = new FailureManager(fakeIo(emitted), redis, service, silentLogger);
      const room = liveRoom(service);
      room.turnTimerDeadline = Date.now() + 20000;
      await fm.persistAllGames();
      fm.dispose();
      service.shutdown();
    }
    const { service, fm, handlers } = await boot(redis, emitted, new Map());
    track({ service, fm, handlers, redis });
    await handlers.resumePersistedRooms();
    const room = service.getRoom('rr1');
    expect(room.restartHold).to.exist;

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(room.restartHold, 'hold expired').to.equal(null);
    expect(room.turnTimerTickHandle, 'timer now running for the absent seat').to.exist;
    // The seat is truthfully absent, so the expiry will take the offline-skip
    // path (strike + force-advance), never auto-play cards for the player.
    expect(room.getPlayer('10').isConnected).to.equal(false);
    service.deleteRoom('rr1');
  });

  it('intermission: the next-round deal is NOT armed while held, and resumes on rejoin', async () => {
    config.game.restartHoldMs = 60000;
    const redis = new InMemoryRedis();
    {
      const service = new GameService();
      const fm = new FailureManager(fakeIo(emitted), redis, service, silentLogger);
      const room = liveRoom(service);
      room.status = GameRoomStatus.FINISHED;
      room.awaitingNextRound = true;
      room.nextRoundAt = Date.now() + 8000;
      room.lastRoundEndPayload = { type: 'round_ended', matchEnded: false };
      await fm.persistAllGames();
      fm.dispose();
      service.shutdown();
    }
    const registry = new Map();
    const { service, fm, handlers } = await boot(redis, emitted, registry);
    track({ service, fm, handlers, redis });
    await handlers.resumePersistedRooms();
    const room = service.getRoom('rr1');
    expect(room.awaitingNextRound).to.equal(true);
    expect(room.restartHold).to.exist;
    expect(room.nextRoundHandle, 'no re-deal armed while held').to.equal(null);
    // Every human is "awaiting reconnect": had the deal fired now it would have
    // hit _startScheduledNextRound's no_humans abort and settled the match.
    expect(room.getPlayers().every((p) => p.isConnected === false)).to.equal(true);

    const socket = fakeSocket('sHost2', emitted);
    registry.set('sHost2', socket);
    await handlers.handleJoinRoom(socket, { roomId: 'rr1', playerId: '10', playerName: 'Host' });

    expect(room.restartHold).to.equal(null);
    expect(room.nextRoundHandle, 're-deal armed on rejoin').to.exist;
    expect(room.nextRoundAt).to.be.greaterThan(Date.now());
    expect(room.getPlayer('10').isConnected).to.equal(true);
    service.deleteRoom('rr1');
  });

  it('restored LOBBY seats are held for the restart window, then take the normal waiting-leave', async () => {
    config.game.restartHoldMs = 60000;
    const redis = new InMemoryRedis();
    {
      const service = new GameService();
      const fm = new FailureManager(fakeIo(emitted), redis, service, silentLogger);
      const room = service.createRoom('lobby', 2);
      service.joinRoom('lobby', '10', 'Host', 'sHost');
      expect(room.status).to.equal(GameRoomStatus.WAITING);
      await fm.persistAllGames();
      fm.dispose();
      service.shutdown();
    }
    const { service, fm, handlers } = await boot(redis, emitted, new Map());
    track({ service, fm, handlers, redis });
    const resumed = await handlers.resumePersistedRooms();
    expect(resumed, 'a lobby is not a resumed match').to.equal(0);
    const room = service.getRoom('lobby');
    const host = room.getPlayer('10');
    expect(host.isConnected).to.equal(false);
    expect(host.socketId).to.equal(null);
    expect(handlers._waitingGraceTimers.has('lobby:10'), 'seat-hold leave armed').to.equal(true);
    expect(room.restartHold, 'lobbies are not runtime-held').to.equal(undefined === room.restartHold ? undefined : null);
    handlers._cancelWaitingLeave('lobby', '10');
    service.deleteRoom('lobby');
  });

  it('room teardown cancels a pending hold', async () => {
    config.game.restartHoldMs = 60000;
    const redis = new InMemoryRedis();
    {
      const service = new GameService();
      const fm = new FailureManager(fakeIo(emitted), redis, service, silentLogger);
      liveRoom(service);
      await fm.persistAllGames();
      fm.dispose();
      service.shutdown();
    }
    const { service, fm, handlers } = await boot(redis, emitted, new Map());
    track({ service, fm, handlers, redis });
    await handlers.resumePersistedRooms();
    const room = service.getRoom('rr1');
    expect(room.restartHoldHandle).to.exist;
    room.disposeTimers();
    expect(room.restartHoldHandle).to.equal(null);
    expect(room.restartHold).to.equal(null);
  });
});
