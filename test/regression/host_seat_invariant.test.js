/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');
const GameRoomStatus = require('../../src/constants/gameStatus');

describe('the lobby host keeps seat zero', () => {
  let service;
  let handlers;
  let sockets;
  let frames;

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
    handlers._emitPartnerWebhook = () => {};
  });

  afterEach(() => {
    for (const room of service.rooms.values()) {
      for (const pending of room._pendingSwaps?.values() || []) clearTimeout(pending.timeout);
      for (const pending of room._pendingInvites?.values() || []) clearTimeout(pending.timeout);
    }
    service.shutdown();
  });

  function socket(id) {
    const participant = {
      id, connected: true, join() {}, leave() {},
      emit: (event, payload) => frames.push({ socketId: id, event, payload }),
      to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
    };
    sockets.set(id, participant);
    return participant;
  }

  function lobby(maxPlayers = 4) {
    handlers.syncRoomFromBackend({ roomId: 'host-seat', hostPlayerId: 'host', maxPlayers });
    return service.getRoom('host-seat');
  }

  function join(room, id, socketId = `socket-${id}`) {
    const participant = socket(socketId);
    const result = service.joinRoom(room.roomId, id, id, socketId);
    return { participant, result };
  }

  function direct(participant, event) {
    return frames.filter((frame) => frame.socketId === participant.id && frame.event === event);
  }

  for (const maxPlayers of [2, 4]) {
    it(`reserves host zero when all ${maxPlayers - 1} guests connect first (${maxPlayers} players)`, () => {
      const room = lobby(maxPlayers);
      for (let seat = 1; seat < maxPlayers; seat += 1) {
        expect(join(room, `guest-${seat}`).result.player.playerIndex).to.equal(seat);
      }
      expect(join(room, 'extra').result.success).to.equal(false);
      expect(room.getPlayerByIndex(0)).to.not.exist;
      expect(join(room, 'host').result.player.playerIndex).to.equal(0);
      expect(room.canStart()).to.equal(true);
      expect(join(room, 'guest-1', 'reconnected-guest').result.player.playerIndex).to.equal(1);
      expect(room.getPlayers().map((player) => player.playerIndex))
        .to.deep.equal(Array.from({ length: maxPlayers }, (_, seat) => seat));
    });

    it(`keeps bot allocation away from the absent host in a ${maxPlayers}-player lobby`, () => {
      const room = lobby(maxPlayers);
      for (let seat = 1; seat < maxPlayers; seat += 1) {
        const result = service.addBotToRoom(room.roomId, { botId: `bot-${seat}`, playerIndex: 0 });
        expect(result.success).to.equal(true);
        expect(result.player.playerIndex).to.equal(seat);
      }
      expect(service.addBotToRoom(room.roomId, { botId: 'overflow' }).success).to.equal(false);
      expect(room.hostPlayerId).to.equal('host');
      expect(join(room, 'host').result.player.playerIndex).to.equal(0);
      expect(room.canStart()).to.equal(true);
    });

    it(`repairs an old guest-zero/host-one roster on lobby reconnect (${maxPlayers} players)`, async () => {
      const room = lobby(maxPlayers);
      join(room, 'host');
      join(room, 'guest');
      room.getPlayer('host').playerIndex = 1;
      room.getPlayer('guest').playerIndex = 0;
      const reconnect = socket('new-host-socket');
      frames.length = 0;

      await handlers.handleJoinRoom(reconnect, {
        roomId: room.roomId, playerId: 'host', playerName: 'Host',
      });

      expect(room.getPlayer('host').playerIndex).to.equal(0);
      expect(room.hostPlayerIndex).to.equal(0);
      expect(room.getPlayer('guest').playerIndex).to.equal(1);
      expect(service.getPlayerIdBySocket('socket-host')).to.not.exist;
      const rosters = frames.filter((frame) => frame.roomId === room.roomId && frame.event === 'player_joined');
      expect(rosters).to.not.be.empty;
      expect(rosters.at(-1).payload.players.find((player) => player.playerId === 'host').playerIndex).to.equal(0);
    });
  }

  it('repairs a displaced host on backend sync and replays the full roster to peers', () => {
    const room = lobby();
    join(room, 'host');
    join(room, 'guest');
    room.getPlayer('host').playerIndex = 1;
    room.getPlayer('guest').playerIndex = 0;
    frames.length = 0;
    handlers.syncRoomFromBackend({ roomId: room.roomId, hostPlayerId: 'host' });
    expect(room.getPlayer('host').playerIndex).to.equal(0);
    expect(room.getPlayer('guest').playerIndex).to.equal(1);
    for (const event of ['seat_changed', 'player_joined']) {
      const roster = frames.find((frame) => frame.roomId === room.roomId && frame.event === event).payload.players;
      expect(roster.map((player) => [player.playerId, player.playerIndex])).to.deep.equal([['host', 0], ['guest', 1]]);
    }
  });

  it('a rejected join to a full lobby does not silently repair the existing seats', async () => {
    const room = lobby(2);
    join(room, 'host');
    join(room, 'guest');
    room.getPlayer('host').playerIndex = 1;
    room.getPlayer('guest').playerIndex = 0;
    const outsider = socket('outsider');
    frames.length = 0;
    await handlers.handleJoinRoom(outsider, {
      roomId: room.roomId, playerId: 'outsider', playerName: 'Outsider',
    });
    expect(room.getPlayer('host').playerIndex).to.equal(1);
    expect(room.getPlayer('guest').playerIndex).to.equal(0);
    expect(direct(outsider, 'error')).to.not.be.empty;
  });

  it('a duplicate bot request does not silently repair the existing seats', () => {
    const room = lobby();
    join(room, 'host');
    service.addBotToRoom(room.roomId, { botId: 'bot' });
    room.getPlayer('host').playerIndex = 1;
    room.getPlayer('bot').playerIndex = 0;
    expect(service.addBotToRoom(room.roomId, { botId: 'bot' }).success).to.equal(false);
    expect(room.getPlayer('host').playerIndex).to.equal(1);
    expect(room.getPlayer('bot').playerIndex).to.equal(0);
  });

  it('overflow guests or bots cannot silently move an old guest out of zero', () => {
    const room = lobby(2);
    join(room, 'guest');
    room.getPlayer('guest').playerIndex = 0;
    expect(join(room, 'extra').result.success).to.equal(false);
    expect(service.addBotToRoom(room.roomId, { botId: 'extra-bot' }).success).to.equal(false);
    expect(room.getPlayer('guest').playerIndex).to.equal(0);
  });

  it('a successful new join repairs and broadcasts the displaced host', async () => {
    const room = lobby();
    join(room, 'host');
    join(room, 'guest');
    room.getPlayer('host').playerIndex = 1;
    room.getPlayer('guest').playerIndex = 0;
    const newcomer = socket('newcomer');
    frames.length = 0;
    await handlers.handleJoinRoom(newcomer, {
      roomId: room.roomId, playerId: 'newcomer', playerName: 'Newcomer',
    });
    const roster = frames.filter((frame) => frame.roomId === room.roomId && frame.event === 'player_joined')
      .at(-1).payload.players;
    expect(roster.map((player) => [player.playerId, player.playerIndex]))
      .to.deep.equal([['host', 0], ['guest', 1], ['newcomer', 2]]);
  });

  it('a declared bot host takes zero even if a guest connected before it', () => {
    const room = lobby(2);
    join(room, 'guest');
    expect(service.addBotToRoom(room.roomId, { botId: 'host', playerIndex: 1 }).player.playerIndex).to.equal(0);
  });

  it('hostless backend tables preserve human capacity until a host is declared', () => {
    handlers.syncRoomFromBackend({ roomId: 'hostless', maxPlayers: 2 });
    const room = service.getRoom('hostless');
    expect(join(room, 'first').result.player.playerIndex).to.equal(0);
    expect(join(room, 'second').result.player.playerIndex).to.equal(1);
    expect(room.hostPlayerId).to.be.null;
  });

  it('a standalone spectator can establish the first host by claiming zero', () => {
    const room = service.createRoom('standalone-claim', 2);
    const viewer = socket('standalone-viewer');
    handlers._addSpectator(viewer, room.roomId, 'viewer', 'Viewer');
    handlers.handleClaimSeat(viewer, { seat: 0 });
    expect(room.getPlayer('viewer').playerIndex).to.equal(0);
    expect(room.hostPlayerId).to.equal('viewer');
  });

  it('a restored numeric host identity cannot move out of zero', async () => {
    const room = service.createRoom('numeric-host', 4);
    const host = join(room, '7').participant;
    room.hostPlayerId = 7; // Older snapshots did not normalize this field.
    const redis = new InMemoryRedis();
    const manager = new FailureManager(handlers.io, redis, service, {
      info() {}, warn() {}, error() {}, debug() {},
    });
    try {
      await manager.persistGameState(room);
      const restored = await manager.restorePersistedRoom(room.roomId);
      expect(restored.hostPlayerId).to.equal('7');
      handlers.handleClaimSeat(host, { seat: 2 });
      expect(restored.getPlayer('7').playerIndex).to.equal(0);
      expect(direct(host, 'swap_failed').at(-1).payload.reason).to.equal('host_seat');
    } finally {
      manager.dispose();
      await redis.quit();
    }
  });

  for (const [status, awaitingNextRound] of [[GameRoomStatus.IN_PROGRESS, false], [GameRoomStatus.FINISHED, true]]) {
    it(`never reseats an existing ${status} match on reconnect or sync`, () => {
      const room = lobby();
      join(room, 'host');
      join(room, 'guest');
      room.getPlayer('host').playerIndex = 1;
      room.getPlayer('guest').playerIndex = 0;
      room.status = status;
      room.awaitingNextRound = awaitingNextRound;
      join(room, 'host', 'new-host');
      handlers.syncRoomFromBackend({ roomId: room.roomId, hostPlayerId: 'host' });
      expect(room.getPlayer('host').playerIndex).to.equal(1);
      expect(room.getPlayer('guest').playerIndex).to.equal(0);
    });
  }

  it('rejects a legacy host switch and supplies the real roster after rejection', () => {
    const room = lobby();
    const host = join(room, 'host').participant;
    handlers.handleSwitchTeam(host, {});
    expect(room.getPlayer('host').playerIndex).to.equal(0);
    expect(direct(host, 'swap_failed').at(-1).payload.reason).to.equal('host_seat');
    expect(direct(host, 'seat_changed').at(-1).payload.players[0].playerIndex).to.equal(0);
  });

  it('a valid non-host team switch skips zero and broadcasts complete occupancy', () => {
    const room = lobby();
    const guest = join(room, 'guest').participant;
    expect(room.getPlayer('guest').playerIndex).to.equal(1);
    frames.length = 0;
    handlers.handleSwitchTeam(guest, {});
    expect(room.getPlayer('guest').playerIndex).to.equal(2);
    expect(room.getPlayerByIndex(0)).to.not.exist;
    for (const event of ['seat_changed', 'player_joined']) {
      const roster = frames.find((frame) => frame.roomId === room.roomId && frame.event === event).payload.players;
      expect(roster.map((player) => [player.playerId, player.playerIndex])).to.deep.equal([['guest', 2]]);
    }
  });

  it('a superseded socket cannot switch the current connection’s team', () => {
    const room = lobby();
    const old = join(room, 'guest').participant;
    join(room, 'guest', 'new-guest');
    // Even an old leftover socket mapping must not authorize the corpse.
    service.socketToPlayer.set(old.id, 'guest');
    handlers.handleSwitchTeam(old, {});
    expect(room.getPlayer('guest').playerIndex).to.equal(1);
  });

  it('a vacant zero cannot be claimed or used as an invite target', async () => {
    const room = lobby();
    const guest = join(room, 'guest').participant;
    const viewer = socket('viewer');
    handlers._addSpectator(viewer, room.roomId, 'viewer', 'Viewer');
    handlers.handleClaimSeat(guest, { seat: 0 });
    await handlers.handleClaimSeat(viewer, { seat: 0 });
    handlers.handleInviteToSeat(guest, { seat: 0, spectatorId: 'viewer' });
    expect(room.getPlayerByIndex(0)).to.not.exist;
    expect(room.getPlayer('guest').playerIndex).to.equal(1);
    expect(room.getPlayer('viewer')).to.not.exist;
    expect(direct(guest, 'swap_failed')).to.have.length(2);
    expect(direct(viewer, 'swap_failed')[0].payload.reason).to.equal('host_seat');
    expect(direct(viewer, 'seat_invite')).to.be.empty;
  });

  it('host force-swap cannot put another player into a vacant zero', () => {
    const room = lobby();
    const host = join(room, 'host').participant;
    join(room, 'guest');
    room.getPlayer('host').playerIndex = 2;
    handlers.handleHostSwapSeats(host, { seatA: 1, seatB: 0 });
    expect(room.getPlayer('guest').playerIndex).to.equal(1);
    expect(room.getPlayerByIndex(0)).to.not.exist;
    expect(direct(host, 'swap_failed').at(-1).payload.reason).to.equal('host_seat');
  });

  it('omitting the target index cannot offer a swap with a drifted occupant of zero', () => {
    const room = lobby();
    join(room, 'host');
    const first = join(room, 'first').participant;
    const second = join(room, 'second').participant;
    room.getPlayer('host').playerIndex = 3;
    room.getPlayer('first').playerIndex = 0;
    frames.length = 0;
    handlers.handleRequestSwap(second, { targetPlayerId: 'first' });
    expect(direct(first, 'swap_requested')).to.be.empty;
    expect(direct(second, 'swap_failed').at(-1).payload.reason).to.equal('host_seat');
  });

  it('still swaps two consenting non-host players and publishes the complete roster', () => {
    const room = lobby();
    join(room, 'host');
    const first = join(room, 'first').participant;
    const second = join(room, 'second').participant;
    handlers.handleRequestSwap(first, { targetPlayerId: 'second', targetSeat: 2 });
    expect(direct(second, 'swap_requested')).to.have.length(1);
    handlers.handleRespondSwap(second, { requesterId: 'first', accept: true });
    expect(room.getPlayer('host').playerIndex).to.equal(0);
    expect(room.getPlayer('first').playerIndex).to.equal(2);
    expect(room.getPlayer('second').playerIndex).to.equal(1);
    for (const event of ['seat_changed', 'player_joined']) {
      const roster = frames.filter((frame) => frame.roomId === room.roomId && frame.event === event).at(-1).payload.players;
      expect(roster.map((player) => [player.playerId, player.playerIndex]))
        .to.deep.equal([['host', 0], ['second', 1], ['first', 2]]);
    }
  });

  it('releases a rejected backend reservation instead of committing a spectator into zero', async () => {
    const room = lobby();
    room.backendBaseUrl = 'https://seat-test.invalid';
    room.seatReservationProtocol = 1;
    const viewer = socket('viewer');
    handlers._addSpectator(viewer, room.roomId, 'viewer', 'Viewer');
    handlers._fetchSeatReservation = async () => ({ isSpectator: false, reservationVersion: 7 });
    const released = [];
    handlers._releaseSeatReservation = async (_, id, version) => {
      released.push({ id, version });
      return { success: true, isSpectator: true };
    };
    await handlers.handleClaimSeat(viewer, { seat: 0 });
    expect(released).to.deep.equal([{ id: 'viewer', version: 7 }]);
    expect(room.getPlayerByIndex(0)).to.not.exist;
    expect(room.getPlayer('viewer')).to.not.exist;
    expect(handlers.spectatorSocketToRoom.get(viewer.id)).to.equal(room.roomId);
    expect(direct(viewer, 'kicked').at(-1).payload.toSpectator).to.equal(true);
  });

  it('standalone first join and bot-owned tables keep their normal host assignment', () => {
    const humanRoom = service.createRoom('standalone', 2);
    expect(join(humanRoom, 'first').result.player.playerIndex).to.equal(0);
    expect(humanRoom.hostPlayerId).to.equal('first');
    const botRoom = service.createRoom('bots', 2);
    const first = service.addBotToRoom(botRoom.roomId, { botId: 'first-bot' });
    expect(first.player.playerIndex).to.equal(0);
    expect(botRoom.hostPlayerId).to.equal('first-bot');
    expect(service.addBotToRoom(botRoom.roomId, { botId: 'second-bot' }).player.playerIndex).to.equal(1);
  });
});
