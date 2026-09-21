/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents } = require('../../src/constants');

describe('player photos survive spectator seating', () => {
  let service;
  let handlers;
  let room;
  let registry;
  let emitted;

  const photo = (id) => `https://example.test/${id}.jpg`;

  function socket(id) {
    const participant = {
      id,
      connected: true,
      join() {},
      leave() {},
      emit: (event, payload) => emitted.push({ socketId: id, event, payload }),
      to: (roomId) => ({
        emit: (event, payload) => emitted.push({ roomId, event, payload }),
      }),
    };
    registry.set(id, participant);
    return participant;
  }

  beforeEach(() => {
    emitted = [];
    registry = new Map();
    service = new GameService();
    handlers = new SocketHandlers({
      sockets: { sockets: registry },
      to: (roomId) => ({
        emit: (event, payload) => emitted.push({ roomId, event, payload }),
      }),
    }, service);
    handlers._notifyBackendPlayerCount = () => {};
    handlers._ensureHostHeartbeat = () => {};
    room = service.createRoom('four-player-photos', 4);
    for (const id of ['host', 'direct']) {
      service.joinRoom(room.roomId, id, id, socket(`socket-${id}`).id, photo(id));
    }
  });

  afterEach(() => {
    for (const timer of handlers._waitingGraceTimers.values()) clearTimeout(timer);
    service.shutdown();
  });

  function seatViewer(id, seat, claimProfile = {}) {
    const participant = socket(`socket-${id}`);
    handlers._addSpectator(participant, room.roomId, id, id, photo(id));
    handlers.handleClaimSeat(participant, { seat, playerName: id, ...claimProfile });
    return participant;
  }

  function fillTable() {
    const first = seatViewer('viewer-a', 2);
    seatViewer('viewer-b', 3, { avatarUrl: photo('viewer-b') });
    return first;
  }

  function expectFourPhotos(players, expectedFirstViewer = photo('viewer-a')) {
    expect(players.map((player) => [player.playerId, player.avatarUrl])).to.deep.equal([
      ['host', photo('host')],
      ['direct', photo('direct')],
      ['viewer-a', expectedFirstViewer],
      ['viewer-b', photo('viewer-b')],
    ]);
  }

  it('broadcasts all four photos after two direct joins and two spectators take seats', () => {
    fillTable();

    for (const event of ['seat_changed', SocketEvents.PLAYER_JOINED]) {
      const frames = emitted.filter((entry) => entry.roomId === room.roomId && entry.event === event);
      expect(frames).to.not.be.empty;
      expectFourPhotos(frames[frames.length - 1].payload.players);
    }
  });

  for (const field of ['avatarUrl', 'photoUrl', 'avatar']) {
    it(`uses the current ${field} claim value before the stored spectator photo`, () => {
      seatViewer('viewer-a', 2, { [field]: photo('updated') });

      expect(room.getPlayer('viewer-a').avatarUrl).to.equal(photo('updated'));
    });
  }

  it('preserves the photo through standing up and reclaiming without a new profile payload', () => {
    const participant = fillTable();
    handlers.handleLeaveSeat(participant);
    expect(handlers.roomSpectators.get(room.roomId).get(participant.id).avatarUrl)
      .to.equal(photo('viewer-a'));

    handlers.handleClaimSeat(participant, { seat: 2 });

    expect(room.getPlayer('viewer-a').avatarUrl).to.equal(photo('viewer-a'));
    expect(handlers._serializePlayer(room.getPlayer('viewer-a')).avatarUrl)
      .to.equal(photo('viewer-a'));
  });

  it('retains all four photos in a reconnect snapshot when the reconnect omits the profile', async () => {
    fillTable();
    const returning = socket('viewer-a-returning');
    await handlers.handleJoinRoom(returning, {
      roomId: room.roomId, playerId: 'viewer-a', playerName: 'viewer-a', reconnect: true,
    });
    emitted.length = 0;

    handlers.handleGetGameState(returning, { gameId: room.roomId, playerId: 'viewer-a' });

    const state = emitted.find((entry) =>
      entry.socketId === returning.id && entry.event === SocketEvents.GAME_STATE_UPDATE);
    expect(state).to.exist;
    expectFourPhotos(state.payload.players);
  });

  it('refreshes a photo during reconnect even when the player-to-room mapping must be restored', async () => {
    fillTable();
    service.playerToRoom.delete('viewer-a');
    const returning = socket('viewer-a-mapping-recovery');

    await handlers.handleJoinRoom(returning, {
      roomId: room.roomId, playerId: 'viewer-a', playerName: 'viewer-a',
      avatarUrl: photo('updated'), reconnect: true,
    });
    emitted.length = 0;
    handlers.handleGetGameState(returning, { gameId: room.roomId, playerId: 'viewer-a' });

    const state = emitted.find((entry) =>
      entry.socketId === returning.id && entry.event === SocketEvents.GAME_STATE_UPDATE);
    expect(state).to.exist;
    expectFourPhotos(state.payload.players, photo('updated'));
  });
});
