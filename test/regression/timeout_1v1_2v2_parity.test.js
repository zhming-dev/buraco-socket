/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const GameService = require('../../src/services/GameService');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');
const { Card } = require('../../src/models/Deck');

/** The same finite-clock contract, exercised in every seat in both game sizes. */
describe('finite turn timeout parity between 1v1 and 2v2', () => {
  let originalSetTimeout;
  let originalClearTimeout;
  let originalNow;
  let originalFetch;
  let now;
  let timers;
  let ctx;

  beforeEach(() => {
    originalSetTimeout = global.setTimeout;
    originalClearTimeout = global.clearTimeout;
    originalNow = Date.now;
    originalFetch = global.fetch;
    now = originalNow();
    timers = new Map();
    Date.now = () => now;
    global.setTimeout = (run, delay) => {
      const handle = { run, deadline: now + delay, unref() {} };
      timers.set(handle, handle);
      return handle;
    };
    global.clearTimeout = (handle) => {
      if (!timers.delete(handle)) originalClearTimeout(handle);
    };
    global.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
  });

  afterEach(async () => {
    if (ctx) {
      ctx.manager.dispose();
      ctx.service.shutdown();
      await ctx.redis.quit();
      ctx = null;
    }
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.fetch = originalFetch;
    Date.now = originalNow;
  });

  function newSocket(id, io, frames) {
    const value = {
      id,
      connected: true,
      join() {},
      leave() {},
      emit: (event, payload) => frames.push({ socketId: id, event, payload }),
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    };
    io.sockets.sockets.set(id, value);
    return value;
  }

  function setup(count, currentIndex = 0, hasDrawn = false) {
    const frames = [];
    const io = {
      sockets: { sockets: new Map() },
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    };
    const service = new GameService();
    const redis = new InMemoryRedis();
    const manager = new FailureManager(io, redis, service, {
      info() {}, warn() {}, error() {}, debug() {},
    });
    const handlers = new SocketHandlers(io, service, null, manager);
    handlers._notifyBackendPlayerCount = () => {};
    const room = service.createRoom(`parity-${count}`, count);
    for (let index = 0; index < count; index += 1) {
      const participant = newSocket(`socket-${index}`, io, frames);
      service.joinRoom(room.roomId, `p${index}`, `Player ${index}`, participant.id);
    }
    room.startGame(true);
    room.dealCards();
    room.currentTurn = currentIndex;
    room.turnOrder = Array.from({ length: count }, (_, index) => index);
    room.turnTimeLimit = 15;
    room.hasDrawnCard = hasDrawn;
    room.phase = hasDrawn ? 'discard' : 'draw';
    room.discardPile = [];
    room.deadPiles = [[], []];
    for (let index = 0; index < count; index += 1) {
      room.playerHands.set(`p${index}`, [
        new Card('clubs', '7'), new Card('diamonds', 'Q'),
      ]);
    }
    if (hasDrawn) room.playerHands.get(`p${currentIndex}`).push(new Card('hearts', '4'));
    handlers._startTurnTimer(room);
    ctx = { service, redis, manager, handlers, room, io, frames };
    return ctx;
  }

  async function disconnect(index) {
    const participant = ctx.io.sockets.sockets.get(`socket-${index}`);
    participant.connected = false;
    ctx.io.sockets.sockets.delete(participant.id);
    await ctx.handlers.handleDisconnect(participant, 'transport close');
  }

  async function expire() {
    const handle = ctx.room.turnTimerTickHandle;
    const timer = timers.get(handle);
    expect(timer, 'the room needs a registered authoritative expiry').to.exist;
    timers.delete(handle);
    now = timer.deadline;
    await timer.run();
  }

  function lastFrame(event, socketId) {
    const matches = ctx.frames.filter((frame) => frame.event === event &&
      (socketId === undefined ? frame.roomId === ctx.room.roomId : frame.socketId === socketId));
    return matches[matches.length - 1];
  }

  function assertNextTurn(previousIndex, { discarded = true } = {}) {
    const { room } = ctx;
    const nextIndex = (previousIndex + 1) % room.maxPlayers;
    expect(room.isInProgress()).to.equal(true);
    expect(room.currentTurn).to.equal(nextIndex);
    expect(lastFrame('turn_timer_expired').payload.playerIndex).to.equal(previousIndex);
    if (discarded) expect(lastFrame('card_discarded').payload.playerIndex).to.equal(previousIndex);
    else {
      expect(lastFrame('card_discarded'), 'the existing offline rule skips without discarding').to.not.exist;
      expect(lastFrame('card_drawn'), 'the existing offline rule skips without drawing').to.not.exist;
    }
    expect(lastFrame('turn_changed').payload).to.include({
      previousPlayerIndex: previousIndex, newPlayerIndex: nextIndex,
    });
    const announcedClock = lastFrame('turn_timer_started').payload;
    expect(announcedClock).to.include({
      playerIndex: nextIndex,
      seconds: 15,
      durationSeconds: 15,
      serverTime: now,
      deadline: now + 15000,
    });
    expect(room.turnTimerDeadline).to.equal(announcedClock.deadline);
    expect(timers.get(room.turnTimerTickHandle).deadline).to.equal(announcedClock.deadline);

    for (const player of room.getPlayers().filter((participant) => participant.isConnected)) {
      const state = lastFrame('game_state_update', player.socketId);
      expect(state, `${player.playerId} needs the same next-turn state`).to.exist;
      expect(state.payload.currentPlayerIndex).to.equal(nextIndex);
      expect(state.payload.turnTimeRemaining).to.equal(15);
      expect(state.payload.turnTimeLimitSeconds).to.equal(15);
    }
  }

  for (const count of [2, 4]) {
    const mode = count === 2 ? '1v1' : '2v2';

    it(`${mode}: connected expiry publishes one coherent next turn and deadline`, async () => {
      const { room } = setup(count);
      const before = room.deck.count;
      await expire();

      expect(room.deck.count).to.equal(before - 1);
      expect(room.discardPile).to.have.length(1);
      assertNextTurn(0);
    });

    for (let index = 0; index < count; index += 1) {
      for (const hasDrawn of [false, true]) {
        it(`${mode}: seat ${index} disconnects ${hasDrawn ? 'after' : 'before'} drawing and expires at its original deadline`, async () => {
          const { room } = setup(count, index, hasDrawn);
          const deadline = room.turnTimerDeadline;
          const handle = room.turnTimerTickHandle;
          const deckBefore = room.deck.count;
          now += 4000;
          await disconnect(index);

          expect(room.turnTimerDeadline).to.equal(deadline);
          expect(room.turnTimerTickHandle).to.equal(handle);
          expect(room.getTurnTimeRemaining()).to.equal(11);
          await expire();

          expect(room.deck.count).to.equal(deckBefore);
          expect(room.discardPile).to.have.length(0);
          expect(room.playerHands.get(`p${index}`)).to.have.length(hasDrawn ? 3 : 2);
          expect(room.getPlayer(`p${index}`).isConnected).to.equal(false);
          expect(room.getPlayer(`p${index}`).socketId).to.equal(null);
          expect(room.offlineStrikes.get(`p${index}`)).to.equal(1);
          expect(room.hostPlayerId).to.equal('p0');
          assertNextTurn(index, { discarded: false });
        });
      }

      it(`${mode}: peer seat ${index} disconnects without resetting another player's deadline`, async () => {
        const currentIndex = (index + 1) % count;
        const { room } = setup(count, currentIndex);
        const deadline = room.turnTimerDeadline;
        const handle = room.turnTimerTickHandle;
        now += 3000;
        await disconnect(index);

        expect(room.turnTimerDeadline).to.equal(deadline);
        expect(room.turnTimerTickHandle).to.equal(handle);
        expect(room.getTurnTimeRemaining()).to.equal(12);
        await expire();

        expect(room.offlineStrikes.get(`p${index}`) || 0).to.equal(0);
        expect(room.getPlayer(`p${index}`).isConnected).to.equal(false);
        assertNextTurn(currentIndex);
      });
    }

    it(`${mode}: reconnect during a turn preserves the original deadline and resynchronizes remaining seconds`, async () => {
      const currentIndex = count - 1;
      const { room, io, frames, handlers } = setup(count, currentIndex);
      const deadline = room.turnTimerDeadline;
      const handle = room.turnTimerTickHandle;
      now += 4000;
      await disconnect(currentIndex);
      now += 4000;
      const replacement = newSocket(`socket-${currentIndex}-new`, io, frames);
      await handlers.handleJoinRoom(replacement, {
        roomId: room.roomId, playerId: `p${currentIndex}`, playerName: `Player ${currentIndex}`,
      });

      expect(room.turnTimerDeadline).to.equal(deadline);
      expect(room.turnTimerTickHandle).to.equal(handle);
      expect(room.currentTurn).to.equal(currentIndex);
      expect(room.getTurnTimeRemaining()).to.equal(7);
      expect(room.getPlayer(`p${currentIndex}`).socketId).to.equal(replacement.id);
      expect(room.getPlayer(`p${currentIndex}`).isConnected).to.equal(true);
      const synced = lastFrame('game_state_update', replacement.id).payload;
      expect(synced).to.include({
        yourPlayerIndex: currentIndex, currentPlayerIndex: currentIndex, turnTimeRemaining: 7,
      });
      await expire();

      expect(room.offlineStrikes.get(`p${currentIndex}`) || 0).to.equal(0);
      assertNextTurn(currentIndex);
    });
  }
});
