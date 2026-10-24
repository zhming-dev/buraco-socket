/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const SocketEvents = require('../../src/constants/events');

// presence_notice (owner, 2026-10-24): when somebody sits down or starts
// watching, the server tells the WHOLE room — the players, the watchers and the
// newcomer themselves — and every client turns it into a toast.
describe('presence_notice', () => {
  let service, handlers, room, sockets, frames, now;

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
    handlers._persistLobbyRoster = () => {};
    now = 1_000_000;
    handlers._presenceClock = () => now;
    handlers._presenceQuietUntil = 0;
    room = service.createRoom('presence-room', 4);
  });

  afterEach(() => {
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

  function sit(id, name = id) {
    socket(`socket-${id}`, id);
    expect(service.joinRoom(room.roomId, id, name, `socket-${id}`).success).to.equal(true);
    handlers._broadcastLobbyPlayers(room);
  }

  function watch(id, name = id, socketId = `viewer-${id}`) {
    const participant = socket(socketId, id);
    handlers._addSpectator(participant, room.roomId, id, name);
    handlers._broadcastSpectatorsChanged(room.roomId);
  }

  function unwatch(socketId) {
    handlers._removeSpectatorBySocket(socketId);
    handlers._broadcastSpectatorsChanged(room.roomId);
  }

  function notices() {
    const out = frames
      .filter((f) => f.event === SocketEvents.PRESENCE_NOTICE)
      .map((f) => ({ roomId: f.roomId, arrivals: f.payload.arrivals }));
    frames = [];
    return out;
  }

  it('is the server\'s own event name', () => {
    expect(SocketEvents.PRESENCE_NOTICE).to.equal('presence_notice');
  });

  it('a newcomer in a seat is announced to the whole room, themselves included', () => {
    sit('host', 'Host');
    expect(notices()).to.deep.equal([{
      roomId: room.roomId,
      arrivals: [{ playerId: 'host', playerName: 'Host', seated: true }],
    }]);

    sit('abdulla', 'Abdulla');
    const sent = notices();
    expect(sent).to.have.length(1);
    // io.to(room): every socket in the room — players, watchers, the joiner.
    expect(sent[0].roomId).to.equal(room.roomId);
    expect(sent[0].arrivals).to.deep.equal([
      { playerId: 'abdulla', playerName: 'Abdulla', seated: true },
    ]);
  });

  it('a new watcher is announced', () => {
    sit('host');
    notices();
    watch('rina', 'Rina');
    expect(notices()).to.deep.equal([{
      roomId: room.roomId,
      arrivals: [{ playerId: 'rina', playerName: 'Rina', seated: false }],
    }]);
  });

  it('the same roster again (a resync, a refresh) is no news', () => {
    sit('host');
    watch('rina');
    notices();
    handlers._broadcastLobbyPlayers(room);
    handlers._broadcastSeatChanged(room);
    handlers._broadcastSpectatorsChanged(room.roomId);
    expect(notices()).to.deep.equal([]);
  });

  it('a watcher back inside the grace (reconnect, lobby → board hop) is no news', () => {
    sit('host');
    watch('rina', 'Rina', 'lobby-socket');
    notices();
    unwatch('lobby-socket');
    now += 3000;
    watch('rina', 'Rina', 'board-socket');
    expect(notices()).to.deep.equal([]);
  });

  it('a watcher back after the grace is a new visit', () => {
    sit('host');
    watch('rina', 'Rina', 'first');
    unwatch('first');
    notices();
    now += 61 * 1000;
    watch('rina', 'Rina', 'second');
    expect(notices()[0].arrivals).to.deep.equal([
      { playerId: 'rina', playerName: 'Rina', seated: false },
    ]);
  });

  it('a second device of somebody already watching is no news', () => {
    sit('host');
    watch('rina', 'Rina', 'phone');
    notices();
    watch('rina', 'Rina', 'tablet');
    expect(notices()).to.deep.equal([]);
  });

  it('a watcher who takes a seat has joined the game', () => {
    sit('host');
    watch('rina', 'Rina');
    notices();
    unwatch('viewer-rina');
    sit('rina', 'Rina');
    expect(notices()).to.deep.equal([{
      roomId: room.roomId,
      arrivals: [{ playerId: 'rina', playerName: 'Rina', seated: true }],
    }]);
  });

  it('a player standing up to watch is no arrival, in either broadcast order', () => {
    sit('host');
    sit('rina', 'Rina');
    notices();
    // Stands first, then the seat roster.
    watch('rina', 'Rina');
    room.removePlayer('rina');
    handlers._broadcastLobbyPlayers(room);
    expect(notices()).to.deep.equal([]);

    // And the other way round, for a second player.
    sit('dan', 'Dan');
    notices();
    room.removePlayer('dan');
    handlers._broadcastLobbyPlayers(room);
    watch('dan', 'Dan');
    expect(notices()).to.deep.equal([]);
  });

  it('bots are never announced', () => {
    sit('host');
    notices();
    socket('socket-bot-1', 'bot-1');
    expect(service.joinRoom(room.roomId, 'bot-1', 'Bot', 'socket-bot-1').success).to.equal(true);
    room.getPlayer('bot-1').isBot = true;
    handlers._broadcastLobbyPlayers(room);
    expect(notices()).to.deep.equal([]);
  });

  it('a room this process only picked up announces nobody already in it', () => {
    sit('host');
    notices();
    handlers.roomPresence.clear(); // a restart / rehydration: never seen
    room.createdAt = new Date(Date.now() - 5 * 60 * 1000);
    handlers._broadcastLobbyPlayers(room);
    expect(notices()).to.deep.equal([]);
    // ...but a real newcomer afterwards still is.
    sit('abdulla', 'Abdulla');
    expect(notices()[0].arrivals.map((a) => a.playerId)).to.deep.equal(['abdulla']);
  });

  it('nothing in the quiet window after a process start', () => {
    handlers._presenceQuietUntil = now + 90 * 1000;
    sit('host');
    watch('rina');
    expect(notices()).to.deep.equal([]);
    // It still learned who is here: no burst once the window closes.
    now += 91 * 1000;
    handlers._broadcastSpectatorsChanged(room.roomId);
    expect(notices()).to.deep.equal([]);
  });

  it('a deleted room forgets its presence', () => {
    sit('host');
    expect(handlers.roomPresence.has(room.roomId)).to.equal(true);
    handlers._clearRoomSpectators(room.roomId);
    expect(handlers.roomPresence.has(room.roomId)).to.equal(false);
  });
});
