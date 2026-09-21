/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const PlayerSession = require('../../src/models/PlayerSession');

/**
 * A burst of seat requests must commit one winner. Losing clients may have
 * missed the winning broadcast, so their rejection must also replay the live
 * roster through the events understood by the shipped lobby.
 */
describe('lobby seat contention', () => {
  let service;
  let handlers;
  let registry;
  let emitted;

  beforeEach(() => {
    emitted = [];
    registry = new Map();
    const io = {
      sockets: { sockets: registry },
      to: (roomId) => ({
        emit: (event, payload) => emitted.push({ roomId, event, payload }),
      }),
    };
    service = new GameService();
    handlers = new SocketHandlers(io, service);
    handlers._notifyBackendPlayerCount = () => {};
  });

  afterEach(() => {
    for (const room of service.rooms.values()) {
      for (const invite of room._pendingInvites?.values() || []) {
        clearTimeout(invite.timeout);
      }
    }
    service.shutdown();
  });

  function socket(id) {
    const value = {
      id,
      connected: true,
      join() {},
      leave() {},
      emit: (event, payload) => emitted.push({ socketId: id, event, payload }),
      to: (roomId) => ({
        emit: (event, payload) => emitted.push({ roomId, event, payload }),
      }),
    };
    registry.set(id, value);
    return value;
  }

  function lobby() {
    const room = service.createRoom('seat-contention', 4);
    const seated = ['host', 'guest-a', 'guest-b'].map((id) => {
      const participant = socket(`socket-${id}`);
      expect(service.joinRoom(room.roomId, id, id, participant.id).success).to.equal(true);
      return participant;
    });
    const spectators = ['spectator-a', 'spectator-b', 'spectator-c'].map((id) => {
      const participant = socket(`socket-${id}`);
      handlers._addSpectator(participant, room.roomId, id, id);
      return participant;
    });
    return { room, seated, spectators };
  }

  function direct(socketId, event) {
    return emitted.filter((entry) => entry.socketId === socketId && entry.event === event);
  }

  it('seats exactly one of three simultaneous claimants and retains the other viewers', async () => {
    const { room, spectators } = lobby();

    await Promise.all(spectators.map((participant) =>
      Promise.resolve().then(() => handlers.handleClaimSeat(participant, { seat: 3 }))
    ));

    expect(room.getPlayers().filter((player) => player.playerIndex === 3)).to.have.length(1);
    expect(room.getPlayers()).to.have.length(4);
    expect(new Set(room.getPlayers().map((player) => player.playerIndex)).size).to.equal(4);
    expect(room.getPlayerByIndex(3).playerId).to.equal('spectator-a');
    expect(service.getPlayerIdBySocket(spectators[0].id)).to.equal('spectator-a');
    expect(handlers.spectatorSocketToRoom.has(spectators[0].id)).to.equal(false);

    for (const loser of spectators.slice(1)) {
      expect(direct(loser.id, 'swap_failed').map((entry) => entry.payload.reason))
        .to.deep.equal(['seat_taken']);
      expect(service.getPlayerIdBySocket(loser.id)).to.not.exist;
      expect(handlers.spectatorSocketToRoom.get(loser.id)).to.equal(room.roomId);
      expect(handlers.roomSpectators.get(room.roomId).has(loser.id)).to.equal(true);
    }
  });

  it('replays the current seat roster directly to a losing claimant who missed the winner broadcast', () => {
    const { room, spectators } = lobby();
    handlers.handleClaimSeat(spectators[0], { seat: 3 });
    // Only responses to the stale request count: the previous broadcast may
    // have arrived before this client attached its lobby event listeners.
    emitted.length = 0;

    handlers.handleClaimSeat(spectators[1], { seat: 3 });

    expect(direct(spectators[1].id, 'swap_failed')[0].payload.reason).to.equal('seat_taken');
    for (const event of ['seat_changed', 'player_joined']) {
      const frames = direct(spectators[1].id, event);
      expect(frames, `missing direct ${event} after a rejected seat claim`).to.have.length(1);
      const roster = frames[0].payload.players;
      expect(roster.map((player) => player.playerId)).to.deep.equal(
        room.getPlayers().map((player) => player.playerId)
      );
      expect(roster.find((player) => player.playerIndex === 3).playerId).to.equal('spectator-a');
    }
  });

  it('arbitrates competing accepted invitations at the actual claim without duplicating a seat', () => {
    const { room, seated, spectators } = lobby();
    handlers.handleInviteToSeat(seated[0], { spectatorId: 'spectator-a', seat: 3 });
    handlers.handleInviteToSeat(seated[1], { spectatorId: 'spectator-b', seat: 3 });

    // Acceptance coordinates the invitation; claim_seat is still the commit.
    handlers.handleRespondSeatInvite(spectators[0], { accept: true });
    handlers.handleRespondSeatInvite(spectators[1], { accept: true });
    expect(room.getPlayerByIndex(3)).to.not.exist;

    handlers.handleClaimSeat(spectators[1], { seat: 3 });
    handlers.handleClaimSeat(spectators[0], { seat: 3 });

    expect(room.getPlayers().filter((player) => player.playerIndex === 3)).to.have.length(1);
    expect(room.getPlayerByIndex(3).playerId).to.equal('spectator-b');
    expect(direct(spectators[0].id, 'swap_failed')[0].payload.reason).to.equal('seat_taken');
    expect(handlers.spectatorSocketToRoom.get(spectators[0].id)).to.equal(room.roomId);
  });

  it('replays a seated loser\'s real position after another player wins their requested destination', () => {
    const { room, seated, spectators } = lobby();
    handlers.handleClaimSeat(spectators[0], { seat: 3 });
    emitted.length = 0;

    handlers.handleClaimSeat(seated[1], { seat: 3 });

    expect(direct(seated[1].id, 'swap_failed')[0].payload.reason).to.equal('seat_taken');
    expect(room.getPlayer('guest-a').playerIndex).to.equal(1);
    for (const event of ['seat_changed', 'player_joined']) {
      const frames = direct(seated[1].id, event);
      expect(frames, `missing direct ${event} for a rejected move`).to.have.length(1);
      expect(frames[0].payload.players.find((player) => player.playerId === 'guest-a').playerIndex)
        .to.equal(1);
      expect(frames[0].payload.players.find((player) => player.playerIndex === 3).playerId)
        .to.equal('spectator-a');
    }
  });

  it('rejects a duplicate seat at the room boundary even when other seats remain empty', () => {
    const room = service.createRoom('duplicate-seat', 4);
    expect(service.joinRoom(room.roomId, 'host', 'Host', 'socket-host').success).to.equal(true);
    const originalPlayer = room.getPlayer('host');

    const added = room.addPlayer(new PlayerSession({
      playerId: 'contender', playerName: 'Contender', playerIndex: 0, socketId: 'socket-contender',
    }));

    expect(added).to.equal(false);
    expect(room.players.size).to.equal(1);
    expect(room.getPlayerByIndex(0)).to.equal(originalPlayer);
    expect(room.getPlayer('contender')).to.not.exist;
  });

  for (const invalidSeat of [-1, 4, 1.5, '1', null, undefined]) {
    it(`rejects invalid seat index ${JSON.stringify(invalidSeat)} without occupying a room slot`, () => {
      const room = service.createRoom('invalid-seat', 4);

      const added = room.addPlayer(new PlayerSession({
        playerId: 'invalid', playerName: 'Invalid', playerIndex: invalidSeat, socketId: 'socket-invalid',
      }));

      expect(added).to.equal(false);
      expect(room.players.size).to.equal(0);
      expect(room.everHadPlayers).to.not.equal(true);
    });
  }
});
