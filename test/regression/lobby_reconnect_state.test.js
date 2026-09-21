/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { SocketEvents } = require('../../src/constants');

describe('lobby reconnect stays in the waiting room and restores its roster', () => {
  let service;
  let handlers;
  let room;
  let registry;
  let emitted;

  function socket(id) {
    const result = {
      id,
      join() {},
      leave() {},
      emit(event, payload) { emitted.push({ to: id, event, payload }); },
      to(roomId) {
        return { emit(event, payload) { emitted.push({ roomId, event, payload }); } };
      },
    };
    registry.set(id, result);
    return result;
  }

  beforeEach(() => {
    emitted = [];
    registry = new Map();
    service = new GameService();
    handlers = new SocketHandlers({
      sockets: { sockets: registry },
      to(roomId) {
        return { emit(event, payload) { emitted.push({ roomId, event, payload }); } };
      },
    }, service);
    room = service.createRoom('LOBBY-RESUME', 2);
    service.joinRoom(room.roomId, 'host', 'Host', socket('host-old').id);
    service.joinRoom(room.roomId, 'guest', 'Guest', socket('guest').id);
  });

  afterEach(() => {
    for (const timer of handlers._waitingGraceTimers.values()) clearTimeout(timer);
    service.shutdown();
  });

  async function reconnectHost() {
    await handlers.handleDisconnect(registry.get('host-old'), 'transport close');
    registry.delete('host-old');
    emitted.length = 0;
    const returning = socket('host-new');
    await handlers.handleJoinRoom(returning, {
      roomId: room.roomId, playerId: 'host', playerName: 'Host', reconnect: true,
    });
    return returning;
  }

  it('replays the lobby roster after a DC even when no new player joins', async () => {
    await reconnectHost();

    const roster = emitted.find((entry) =>
      entry.roomId === room.roomId && entry.event === SocketEvents.PLAYER_JOINED);
    expect(roster, 'the shipped lobby consumes PLAYER_JOINED, not PLAYER_RECONNECTED').to.exist;
    expect(roster.payload.players.map((player) => player.playerId)).to.deep.equal(['host', 'guest']);
    expect(room.getPlayer('host').socketId).to.equal('host-new');
    expect(handlers._waitingGraceTimers.has(`${room.roomId}:host`)).to.equal(false);
    expect(!!room.cardsDealt).to.equal(false);
  });

  it('answers the reconnect snapshot without sending the lobby into an undealt game', async () => {
    const returning = await reconnectHost();
    emitted.length = 0;

    handlers.handleGetGameState(returning, { gameId: room.roomId, playerId: 'host' });

    expect(emitted.filter((entry) => entry.event === SocketEvents.GAME_STARTED),
      'seated mobile clients navigate to the board on any GAME_STARTED').to.have.length(0);
    const state = emitted.find((entry) =>
      entry.to === returning.id && entry.event === SocketEvents.GAME_STATE_UPDATE);
    expect(state, 'the snapshot must still satisfy the reconnect watchdog').to.exist;
    expect(state.payload.cardsDealt).to.equal(false);
    expect(state.payload.yourHand).to.deep.equal([]);
    expect(emitted.some((entry) => entry.to === returning.id &&
      entry.event === SocketEvents.PLAYER_JOINED)).to.equal(true);
  });

  it('restores a same-socket lobby refresh without inventing a game start', async () => {
    const current = registry.get('host-old');
    await handlers.handleJoinRoom(current, {
      roomId: room.roomId, playerId: 'host', playerName: 'Host', reconnect: true,
    });
    handlers.handleGetGameState(current, { gameId: room.roomId, playerId: 'host' });

    expect(emitted.some((entry) => entry.event === SocketEvents.PLAYER_JOINED)).to.equal(true);
    expect(emitted.some((entry) => entry.event === SocketEvents.PLAYER_RECONNECTED)).to.equal(false);
    expect(emitted.some((entry) => entry.event === SocketEvents.GAME_STARTED)).to.equal(false);
  });

  it('keeps game-start and dealt state replay for a match already under way', () => {
    room.startGame();
    room.dealCards();
    handlers._stopTurnTimer(room);

    handlers.handleGetGameState(registry.get('host-old'), {
      gameId: room.roomId, playerId: 'host',
    });

    const started = emitted.find((entry) => entry.event === SocketEvents.GAME_STARTED);
    const state = emitted.find((entry) => entry.event === SocketEvents.GAME_STATE_UPDATE);
    expect(started.payload.cardsDealt).to.equal(true);
    expect(state.payload.cardsDealt).to.equal(true);
    expect(state.payload.yourHand).to.have.length(11);
  });
});
