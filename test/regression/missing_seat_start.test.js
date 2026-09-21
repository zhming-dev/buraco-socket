/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');

/** A WAITING grace expiry must not turn a four-seat match into sparse three-player play. */
describe('starting a lobby after a seat disconnects', () => {
  let service;
  let handlers;
  let registry;
  let frames;
  let timers;
  let originalSetTimeout;
  let originalClearTimeout;
  let originalFetch;

  beforeEach(() => {
    originalSetTimeout = global.setTimeout;
    originalClearTimeout = global.clearTimeout;
    originalFetch = global.fetch;
    timers = new Map();
    global.setTimeout = (run, delay) => {
      const handle = { run, delay, unref() {} };
      timers.set(handle, handle);
      return handle;
    };
    global.clearTimeout = (handle) => {
      if (!timers.delete(handle)) originalClearTimeout(handle);
    };
    global.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    frames = [];
    registry = new Map();
    service = new GameService();
    handlers = new SocketHandlers({
      sockets: { sockets: registry },
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    }, service);
    handlers._notifyBackendPlayerCount = () => {};
    handlers._notifyBackendPlayerLeft = () => {};
  });

  afterEach(() => {
    for (const handle of handlers._waitingGraceTimers.values()) clearTimeout(handle);
    service.shutdown();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.fetch = originalFetch;
  });

  function lobby(count) {
    const room = service.createRoom(`missing-seat-${count}`, count);
    for (let index = 0; index < count; index += 1) {
      const id = `s${index}`;
      const participant = {
        id,
        connected: true,
        join() {},
        leave() {},
        emit: (event, payload) => frames.push({ socketId: id, event, payload }),
        to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
      };
      registry.set(id, participant);
      service.joinRoom(room.roomId, `p${index}`, `Player ${index}`, id);
    }
    return room;
  }

  async function disconnectInLobby(room, index) {
    const participant = registry.get(`s${index}`);
    participant.connected = false;
    registry.delete(participant.id);
    await handlers.handleDisconnect(participant, 'transport close');
    const handle = handlers._waitingGraceTimers.get(`${room.roomId}:p${index}`);
    expect(timers.has(handle), 'the lobby seat must be held by a real grace callback').to.equal(true);
    return async () => {
      timers.delete(handle);
      await handle.run();
    };
  }

  function start(room, path) {
    if (path === 'webhook') return handlers.triggerStartGame(room.roomId);
    handlers.handleStartGame(registry.get('s0'), { roomId: room.roomId });
    return null;
  }

  function assertUndealt(room, count) {
    expect(room.status).to.equal('waiting');
    expect(room.isInProgress()).to.equal(false);
    expect(room.maxPlayers, 'the advertised game mode must not silently shrink').to.equal(count);
    expect(room.cardsDealt).to.not.equal(true);
    expect(room.turnOrder).to.equal(null);
    expect(room.turnTimerTickHandle).to.equal(null);
    expect(frames.some((frame) => frame.event === 'game_started')).to.equal(false);
    expect(frames.some((frame) => frame.event === 'cards_dealt')).to.equal(false);
  }

  for (const count of [2, 4]) {
    const mode = count === 2 ? '1v1' : '2v2';
    const lostIndex = count === 4 ? 2 : 1;
    for (const path of ['manual', 'webhook']) {
      it(`${mode}: ${path} start refuses the seat missing after lobby disconnect grace expires`, async () => {
        const room = lobby(count);
        const expireGrace = await disconnectInLobby(room, lostIndex);
        await expireGrace();
        expect(room.getPlayer(`p${lostIndex}`)).to.not.exist;
        expect(room.getPlayers().map((player) => player.playerIndex))
          .to.deep.equal(count === 4 ? [0, 1, 3] : [0]);
        frames.length = 0;

        const result = start(room, path);

        if (path === 'webhook') expect(result.success).to.equal(false);
        else expect(frames.some((frame) => frame.socketId === 's0' && frame.event === 'error')).to.equal(true);
        assertUndealt(room, count);
      });

      it(`${mode}: ${path} start still deals a complete lobby`, () => {
        const room = lobby(count);
        frames.length = 0;

        const result = start(room, path);

        if (path === 'webhook') expect(result.success).to.equal(true);
        expect(room.isInProgress()).to.equal(true);
        expect(room.cardsDealt).to.equal(true);
        expect(room.maxPlayers).to.equal(count);
        expect(room.getPlayers()).to.have.length(count);
        expect(room.turnOrder).to.have.length(count);
        expect(room.turnOrder.every((index) => room.getPlayerByIndex(index))).to.equal(true);
        expect(frames.some((frame) => frame.event === 'game_started')).to.equal(true);
      });

      it(`${mode}: ${path} start allows a still-held grace seat and its old lobby callback cannot remove it`, async () => {
        const room = lobby(count);
        const expireGrace = await disconnectInLobby(room, lostIndex);
        expect(room.getPlayers()).to.have.length(count);
        frames.length = 0;

        const result = start(room, path);
        if (path === 'webhook') expect(result.success).to.equal(true);
        expect(room.isInProgress()).to.equal(true);
        expect(room.cardsDealt).to.equal(true);
        await expireGrace();

        expect(room.isInProgress()).to.equal(true);
        expect(room.maxPlayers).to.equal(count);
        expect(room.getPlayers()).to.have.length(count);
        expect(room.getPlayer(`p${lostIndex}`)).to.exist;
        expect(room.turnOrder.every((index) => room.getPlayerByIndex(index))).to.equal(true);
      });
    }
  }

  for (const remaining of [2, 3]) {
    it(`the room model refuses a forced 2v2 start with only ${remaining} seated players`, () => {
      const room = lobby(4);
      service.leaveRoom('p2');
      if (remaining === 2) service.leaveRoom('p3');
      frames.length = 0;

      expect(room.startGame(true)).to.equal(false);

      assertUndealt(room, 4);
    });
  }
});
