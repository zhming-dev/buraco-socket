/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents, GameRoomStatus } = require('../../src/constants');
const GameService = require('../../src/services/GameService');
const config = require('../../src/config');
const metrics = require('../../src/observability/metrics');

describe('SocketHandlers', () => {
  const createSocketMock = (id = 'socket-1') => {
    const emitted = [];
    const joinedRooms = [];
    const leftRooms = [];

    return {
      id,
      handshake: { headers: {} },
      join: (roomId) => joinedRooms.push(roomId),
      leave: (roomId) => leftRooms.push(roomId),
      to: () => ({ emit: () => {} }),
      emit: (event, payload) => emitted.push({ event, payload }),
      get emitted() {
        return emitted;
      },
      get joinedRooms() {
        return joinedRooms;
      },
      get leftRooms() {
        return leftRooms;
      },
    };
  };

  const createIoMock = (sockets = []) => {
    const io = {
      roomEmits: [],
      sockets: { sockets: new Map(sockets.map((socket) => [socket.id, socket])) },
      to: (roomId) => ({
        emit: (event, payload) => io.roomEmits.push({ roomId, event, payload }),
      }),
    };
    return io;
  };

  const setupStartedRoom = () => {
    const service = new GameService();
    const s1 = createSocketMock('s1');
    const s2 = createSocketMock('s2');
    const io = createIoMock([s1, s2]);
    const handler = new SocketHandlers(io, service);
    const room = service.createRoom('auto-deal', 2);
    service.joinRoom('auto-deal', 'p1', 'P1', 's1');
    service.joinRoom('auto-deal', 'p2', 'P2', 's2');
    return { service, handler, room, s1, s2, io };
  };

  const cleanupRoom = (service, handler, room) => {
    if (room) handler?._stopTurnTimer(room);
    service?.shutdown();
  };

  it('rejects explicit room join when room is not synced in memory', async () => {
    const ioMock = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } };

    const gameServiceMock = {
      getRoom: () => undefined,
      markPlayerActive: () => {},
      findOrCreateRoom: () => undefined,
    };

    const handler = new SocketHandlers(ioMock, gameServiceMock);
    const socket = createSocketMock();

    await handler.handleJoinRoom(socket, {
      playerId: 'player-1',
      playerName: 'Player 1',
      roomId: 'room-404',
    });

    const errorEvent = socket.emitted.find((e) => e.event === SocketEvents.ERROR);
    expect(errorEvent).to.not.equal(undefined);
    expect(errorEvent.payload).to.have.property('success', false);
    expect(errorEvent.payload.error).to.include('Room is not ready on realtime server');
  });

  it('returns idempotent success when triggerStartGame is called on already started room', () => {
    const ioMock = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } };

    const inProgressRoom = {
      roomId: 'room-1',
      players: new Map(),
      maxPlayers: 2,
      isInProgress: () => true,
      getPlayers: () => [],
    };

    const gameServiceMock = {
      getRoom: () => inProgressRoom,
      createRoom: () => inProgressRoom,
    };

    const handler = new SocketHandlers(ioMock, gameServiceMock);

    let stateResyncCalled = false;
    handler._sendInitialGameState = () => {
      stateResyncCalled = true;
    };

    const result = handler.triggerStartGame('room-1', {});

    expect(result.success).to.equal(true);
    expect(result.alreadyStarted).to.equal(true);
    expect(stateResyncCalled).to.equal(true);
  });

  it('auto-deals cards after manual start and waits for deal animation before timer starts', () => {
    const { service, handler, room, s1 } = setupStartedRoom();

    try {
      handler.handleStartGame(s1, {});

      expect(room.cardsDealt).to.equal(true);
      expect(room.playerHands.get('p1')).to.have.length(11);
      expect(room.playerHands.get('p2')).to.have.length(11);
      expect(room.deadPiles.map((pile) => pile.length)).to.deep.equal([11, 11]);
      expect(room.awaitingDealAnimation).to.equal(true);
      expect(room.turnTimerTickHandle).to.equal(null);

      const dealtUpdate = s1.emitted.find(
        (event) =>
          event.event === SocketEvents.GAME_STATE_UPDATE && event.payload.cardsDealt === true
      );
      expect(dealtUpdate).to.not.equal(undefined);
      expect(dealtUpdate.payload.yourHand).to.have.length(11);
      expect(dealtUpdate.payload.otherPlayersHands).to.equal(undefined);
      expect(dealtUpdate.payload.otherPlayersHandCounts[1]).to.equal(11);
    } finally {
      cleanupRoom(service, handler, room);
    }
  });

  describe('first-turn timer waits for every seated human to finish the deal', () => {
    // Clients run the opening deal at their own animation SPEED setting (the
    // SDK's "fast" is ~half the reference length), so the room's shared clock
    // must not start on the quickest report — the slower seat would lose turn
    // time to its own deal animation.
    const dealtRoom = () => {
      const ctx = setupStartedRoom();
      ctx.handler.handleStartGame(ctx.s1, {});
      expect(ctx.room.awaitingDealAnimation).to.equal(true);
      expect(ctx.room.dealAnimationAcks).to.be.instanceOf(Set);
      return ctx;
    };

    it('does not start on the first report while another seat is still animating', () => {
      const { service, handler, room, s1, s2 } = dealtRoom();
      try {
        handler.handleDealAnimationComplete(s1, {});
        expect(room.awaitingDealAnimation).to.equal(true);
        expect(room.turnTimerTickHandle).to.equal(null);
        expect(room.dealAnimationFallbackHandle).to.not.equal(null);

        handler.handleDealAnimationComplete(s2, {});
        expect(room.awaitingDealAnimation).to.equal(false);
        expect(room.dealAnimationFallbackHandle).to.equal(null);
        expect(room.firstTurnDraw).to.equal(null);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('a repeated report from the same seat does not count twice', () => {
      const { service, handler, room, s1 } = dealtRoom();
      try {
        handler.handleDealAnimationComplete(s1, {});
        handler.handleDealAnimationComplete(s1, {});
        expect(room.awaitingDealAnimation).to.equal(true);
        expect(room.dealAnimationAcks.size).to.equal(1);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it("a spectator's report never stands in for a seat's", () => {
      const { service, handler, room, s1, s2, io } = dealtRoom();
      const spectator = createSocketMock('spec-1');
      io.sockets.sockets.set(spectator.id, spectator);
      handler.spectatorSocketToRoom.set(spectator.id, room.roomId);
      try {
        handler.handleDealAnimationComplete(spectator, {});
        expect(room.awaitingDealAnimation).to.equal(true);

        handler.handleDealAnimationComplete(s1, {});
        handler.handleDealAnimationComplete(s2, {});
        expect(room.awaitingDealAnimation).to.equal(false);
      } finally {
        handler.spectatorSocketToRoom.delete(spectator.id);
        cleanupRoom(service, handler, room);
      }
    });

    it('a bot seat never holds the first turn', () => {
      const { service, handler, room, s1 } = dealtRoom();
      try {
        room.getPlayer('p2').isBot = true;
        handler.handleDealAnimationComplete(s1, {});
        expect(room.awaitingDealAnimation).to.equal(false);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('a seat that drops mid-deal releases the others once they have reported', async () => {
      const { service, handler, room, s1, s2 } = dealtRoom();
      try {
        handler.handleDealAnimationComplete(s1, {});
        expect(room.awaitingDealAnimation).to.equal(true);

        await handler.handleDisconnect(s2, 'transport close');
        expect(room.getPlayer('p2').isConnected).to.equal(false);
        expect(room.awaitingDealAnimation).to.equal(false);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('a drop before anyone reported is left to the fallback', async () => {
      const { service, handler, room, s2 } = dealtRoom();
      try {
        await handler.handleDisconnect(s2, 'transport close');
        expect(room.awaitingDealAnimation).to.equal(true);
        expect(room.dealAnimationFallbackHandle).to.not.equal(null);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('a real turn start drops the gate, so a late report cannot restart the clock', () => {
      const { service, handler, room, s1, s2 } = dealtRoom();
      try {
        handler.handleDealAnimationComplete(s1, {});
        // The quick seat acts before the slow one has finished animating; the
        // turn clock that starts with that play is the one that stands.
        handler._startTurnTimer(room);
        expect(room.awaitingDealAnimation).to.equal(false);
        const handleAfterPlay = room.turnTimerTickHandle;

        handler.handleDealAnimationComplete(s2, {});
        expect(room.turnTimerTickHandle).to.equal(handleAfterPlay);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });
  });

  it('repairs an in-progress room that was started before cards were dealt', () => {
    const { service, handler, room, s1 } = setupStartedRoom();

    try {
      room.startGame(true);
      expect(room.cardsDealt).to.equal(false);

      handler.handleStartGame(s1, {});

      expect(room.cardsDealt).to.equal(true);
      expect(room.playerHands.get('p1')).to.have.length(11);
      expect(room.awaitingDealAnimation).to.equal(true);
    } finally {
      cleanupRoom(service, handler, room);
    }
  });

  it('auto-deals cards after webhook start', () => {
    const { service, handler, room } = setupStartedRoom();

    try {
      const result = handler.triggerStartGame('auto-deal', {});

      expect(result.success).to.equal(true);
      expect(room.cardsDealt).to.equal(true);
      expect(room.playerHands.get('p1')).to.have.length(11);
      expect(room.playerHands.get('p2')).to.have.length(11);
      expect(room.awaitingDealAnimation).to.equal(true);
    } finally {
      cleanupRoom(service, handler, room);
    }
  });

  it('invites a server-side bot to a room and broadcasts bot metadata', () => {
    const service = new GameService();
    const owner = createSocketMock('owner-socket');
    const io = createIoMock([owner]);
    const handler = new SocketHandlers(io, service);
    const room = service.createRoom('bot-invite', 2);
    service.joinRoom('bot-invite', 'owner', 'Owner', 'owner-socket');

    try {
      handler.handleInviteBot(owner, {
        roomId: 'bot-invite',
        botId: 'bot-a',
        botName: 'Bot A',
      });

      const bot = room.getPlayer('bot-a');
      expect(bot).to.not.equal(undefined);
      expect(bot.isBot).to.equal(true);
      expect(bot.playerIndex).to.equal(1);

      const invited = owner.emitted.find((event) => event.event === SocketEvents.BOT_INVITED);
      expect(invited).to.not.equal(undefined);
      expect(invited.payload.isBot).to.equal(true);

      const joinedBroadcast = io.roomEmits.find(
        (event) => event.event === SocketEvents.PLAYER_JOINED
      );
      expect(joinedBroadcast.payload.isBot).to.equal(true);
    } finally {
      cleanupRoom(service, handler, room);
    }
  });

  it('rejects bot invites from spectator sockets', async () => {
    const service = new GameService();
    const owner = createSocketMock('owner-socket');
    const spectator = createSocketMock('spectator-socket');
    const io = createIoMock([owner, spectator]);
    const handler = new SocketHandlers(io, service);
    const room = service.createRoom('spectator-bot-invite', 2);
    service.joinRoom('spectator-bot-invite', 'owner', 'Owner', 'owner-socket');

    try {
      await handler.handleJoinRoom(spectator, {
        roomId: 'spectator-bot-invite',
        playerId: 'media-owner',
        playerName: 'Media Owner',
        isSpectator: true,
      });

      handler.handleInviteBot(spectator, {
        roomId: 'spectator-bot-invite',
        botId: 'bot-from-spectator',
      });

      const error = spectator.emitted.find((event) => event.event === SocketEvents.ERROR);
      expect(error).to.not.equal(undefined);
      // The security property is what matters: a non-owner spectator is rejected
      // and NO bot is seated. A plain spectator (not the room's owner-controller)
      // gets the "room owner" rejection; a recognized media-owner is told to use
      // the backend webhook. Accept either valid rejection.
      expect(error.payload.error.toLowerCase()).to.satisfy(
        (msg) => msg.includes('owner') || msg.includes('webhook')
      );
      expect(room.getPlayer('bot-from-spectator')).to.equal(undefined);
    } finally {
      cleanupRoom(service, handler, room);
    }
  });

  it('starts and deals a bot-vs-bot room from backend orchestration', () => {
    const service = new GameService();
    const io = createIoMock([]);
    const handler = new SocketHandlers(io, service);

    const sync = handler.syncRoomFromBackend({
      roomId: 'bot-vs-bot',
      maxPlayers: 2,
      bots: [
        { botId: 'bot-1', botName: 'Bot 1' },
        { botId: 'bot-2', botName: 'Bot 2' },
      ],
      autoStart: true,
    });
    const room = service.getRoom('bot-vs-bot');

    try {
      expect(sync.success).to.equal(true);
      expect(sync.addedBots).to.have.length(2);
      expect(sync.startResult.success).to.equal(true);
      expect(room.cardsDealt).to.equal(true);
      expect(room.getPlayers().every((player) => player.isBot)).to.equal(true);
      expect(room.playerHands.get('bot-1')).to.have.length(11);
      expect(room.playerHands.get('bot-2')).to.have.length(11);
    } finally {
      cleanupRoom(service, handler, room);
    }
  });

  it('syncRoomFromBackend creates/updates room state in memory', () => {
    const ioMock = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } };

    const room = {
      roomId: '100',
      players: new Map(),
      maxPlayers: 2,
      ruleset: 'classic',
      professionalWellMode: 'indirect',
      hostPlayerId: null,
    };

    const gameServiceMock = {
      createRoom: () => room,
    };

    const handler = new SocketHandlers(ioMock, gameServiceMock);
    const result = handler.syncRoomFromBackend({
      roomId: 100,
      maxPlayers: 4,
      ruleset: 'professional',
      professionalWellMode: 'direct',
      hostPlayerId: 'host-1',
      skins: { table_skin: 't-1', card_skin: 'c-1' },
      status: 'open',
    });

    expect(result.success).to.equal(true);
    expect(result.roomId).to.equal('100');
    expect(room.maxPlayers).to.equal(4);
    expect(room.ruleset).to.equal('professional');
    expect(room.professionalWellMode).to.equal('direct');
    expect(room.hostPlayerId).to.equal('host-1');
    expect(room.skins).to.deep.equal({ table_skin: 't-1', card_skin: 'c-1' });
  });

  describe('ROOM_SETTINGS_CHANGED lobby broadcast', () => {
    const settingsEmits = (io) =>
      io.roomEmits.filter((e) => e.event === SocketEvents.ROOM_SETTINGS_CHANGED);

    const baseSync = (roomId) => ({
      roomId,
      maxPlayers: 4,
      ruleset: 'professional',
      professionalWellMode: 'indirect',
      targetScore: 1000,
      status: 'open',
    });

    it('emits room_settings_changed when targetScore changes on a WAITING room', () => {
      const service = new GameService();
      const io = createIoMock([]);
      const handler = new SocketHandlers(io, service);
      const room = service.getRoom('rsc-change') || null;

      try {
        // Initial create-sync; ignore any first-configure emit.
        handler.syncRoomFromBackend(baseSync('rsc-change'));
        io.roomEmits.length = 0;

        // Host edits targetScore 1000 -> 2000 on the lobby room.
        handler.syncRoomFromBackend({ ...baseSync('rsc-change'), targetScore: 2000 });

        const emits = settingsEmits(io);
        expect(emits).to.have.length(1);
        expect(emits[0].roomId).to.equal('rsc-change');
        expect(emits[0].payload.targetScore).to.equal(2000);
        expect(emits[0].payload).to.include.keys([
          'roomId',
          'name',
          'visibility',
          'targetScore',
          'turnTimeLimitSeconds',
          'professionalWellMode',
          'chatEnabled',
          'hasPassword',
        ]);
      } finally {
        cleanupRoom(service, handler, service.getRoom('rsc-change') || room);
      }
    });

    it('does NOT emit on a no-op re-sync (same values)', () => {
      const service = new GameService();
      const io = createIoMock([]);
      const handler = new SocketHandlers(io, service);

      try {
        handler.syncRoomFromBackend(baseSync('rsc-noop'));
        io.roomEmits.length = 0;

        // Identical payload — nothing client-visible changed.
        handler.syncRoomFromBackend(baseSync('rsc-noop'));

        expect(settingsEmits(io)).to.have.length(0);
      } finally {
        cleanupRoom(service, handler, service.getRoom('rsc-noop'));
      }
    });

    it('does NOT emit for an in-progress room', () => {
      const service = new GameService();
      const io = createIoMock([]);
      const handler = new SocketHandlers(io, service);

      try {
        handler.syncRoomFromBackend(baseSync('rsc-inprogress'));
        const room = service.getRoom('rsc-inprogress');
        room.status = GameRoomStatus.IN_PROGRESS;
        io.roomEmits.length = 0;

        // Even a real value change is suppressed once the match is running.
        handler.syncRoomFromBackend({ ...baseSync('rsc-inprogress'), targetScore: 3000 });

        expect(settingsEmits(io)).to.have.length(0);
      } finally {
        cleanupRoom(service, handler, service.getRoom('rsc-inprogress'));
      }
    });
  });

  it('getRoomRuntimeSnapshot returns empty snapshot when room is missing', () => {
    const ioMock = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } };
    const gameServiceMock = {
      getRoom: () => undefined,
    };

    const handler = new SocketHandlers(ioMock, gameServiceMock);
    const result = handler.getRoomRuntimeSnapshot({ roomId: 'missing-room' });

    expect(result.success).to.equal(true);
    expect(result.exists).to.equal(false);
    expect(result.hostConnected).to.equal(false);
    expect(result.playerCount).to.equal(0);
    expect(result.playerIds).to.deep.equal([]);
  });

  it('getRoomRuntimeSnapshot reports hostConnected from the live host socket', () => {
    const service = new GameService();
    const hostSock = createSocketMock('host-sock');
    const io = createIoMock([hostSock]);
    const handler = new SocketHandlers(io, service);
    const room = service.createRoom('snap-host', 2); // WAITING lobby
    service.joinRoom('snap-host', 'host', 'Host', 'host-sock');
    room.hostPlayerId = 'host';

    try {
      // Host socket present in io.sockets.sockets → authoritative live signal true.
      const present = handler.getRoomRuntimeSnapshot({ roomId: 'snap-host' });
      expect(present.success).to.equal(true);
      expect(present.status).to.equal(GameRoomStatus.WAITING);
      expect(present.hostPlayerId).to.equal('host');
      expect(present.hostConnected).to.equal(true);

      // Host socket gone (swiped-away app, transport torn down) → false even though
      // the optimistic seat-model isConnected can still read true for ~60s.
      io.sockets.sockets.delete('host-sock');
      const gone = handler.getRoomRuntimeSnapshot({ roomId: 'snap-host' });
      expect(gone.hostConnected).to.equal(false);
      expect(gone.hostPlayerId).to.equal('host');
    } finally {
      cleanupRoom(service, handler, room);
    }
  });

  it('cancelRoomFromBackend closes and deletes a runtime room', () => {
    const service = new GameService();
    const s1 = createSocketMock('s1');
    const io = createIoMock([s1]);
    const handler = new SocketHandlers(io, service);
    const room = service.createRoom('cancel-me', 2);
    service.joinRoom('cancel-me', 'p1', 'P1', 's1');

    try {
      const result = handler.cancelRoomFromBackend({
        roomId: 'cancel-me',
        reason: 'host_not_connected',
      });

      expect(result.success).to.equal(true);
      expect(service.getRoom('cancel-me')).to.equal(undefined);
      expect(io.roomEmits.some((event) => event.event === SocketEvents.ROOM_CLOSED)).to.equal(true);
      expect(s1.leftRooms).to.include('cancel-me');
    } finally {
      cleanupRoom(service, handler, room);
    }
  });

  describe('closeRoomFromDev (dev console "Close game")', () => {
    it('voids a lobby room: room_closed to the table, sockets detached, backend told admin_closed', () => {
      const service = new GameService();
      const s1 = createSocketMock('s1');
      const io = createIoMock([s1]);
      const handler = new SocketHandlers(io, service);
      const room = service.createRoom('lobby-close', 2);
      service.joinRoom('lobby-close', 'p1', 'P1', 's1');
      const closed = [];
      // onRoomDeleted passes reason=null; the real notifier reads the stashed
      // close context — mirror that so the stub sees what the backend would.
      handler._notifyBackendRoomClosed = function (roomId, reason) {
        const ctx = this._roomCloseContext.get(String(roomId));
        closed.push({ roomId, reason: reason || (ctx && ctx.reason) || null });
      };

      try {
        const result = handler.closeRoomFromDev({ roomId: 'lobby-close', message: 'Server maintenance' });

        expect(result.success).to.equal(true);
        expect(result.reason).to.equal('admin_closed');
        expect(result.wasInProgress).to.equal(false);
        expect(result.playerCount).to.equal(1);
        expect(service.getRoom('lobby-close')).to.equal(undefined);
        const notice = io.roomEmits.find((e) => e.event === SocketEvents.ROOM_CLOSED);
        expect(notice.roomId).to.equal('lobby-close');
        expect(notice.payload.reason).to.equal('admin_closed');
        expect(notice.payload.message).to.equal('Server maintenance');
        expect(s1.leftRooms).to.include('lobby-close');
        // onRoomDeleted forwards the stashed reason (not null) to the backend.
        expect(closed).to.deep.equal([{ roomId: 'lobby-close', reason: 'admin_closed' }]);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('voids a dealt game with no result: turn timer stopped, no game.completed, no result webhook', () => {
      const { service, handler, room, s1, s2, io } = setupStartedRoom();
      const results = [];
      const partner = [];
      handler._notifyBackendGameResult = (r, winnerId) => results.push(winnerId);
      handler._emitPartnerWebhook = (event) => partner.push(event);
      handler._notifyBackendRoomClosed = () => {};
      try {
        handler.handleStartGame(s1, {});
        expect(room.isInProgress()).to.equal(true);

        const result = handler.closeRoomFromDev({ roomId: 'auto-deal' });

        expect(result.success).to.equal(true);
        expect(result.wasInProgress).to.equal(true);
        expect(result.playerCount).to.equal(2);
        expect(service.getRoom('auto-deal')).to.equal(undefined);
        expect(room.turnTimerHandle).to.equal(null);
        expect(io.roomEmits.some((e) => e.event === SocketEvents.ROOM_CLOSED)).to.equal(true);
        expect(io.roomEmits.some((e) => e.event === SocketEvents.GAME_ENDED)).to.equal(false);
        expect(results).to.deep.equal([]);
        expect(partner).to.not.include('game.completed');
        expect(s1.leftRooms).to.include('auto-deal');
        expect(s2.leftRooms).to.include('auto-deal');
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('is idempotent on a room that is already gone and rejects a missing roomId', () => {
      const service = new GameService();
      const io = createIoMock([]);
      const handler = new SocketHandlers(io, service);
      try {
        expect(handler.closeRoomFromDev({})).to.deep.equal({ success: false, error: 'roomId required' });
        const gone = handler.closeRoomFromDev({ roomId: 'nope' });
        expect(gone.success).to.equal(true);
        expect(gone.alreadyClosed).to.equal(true);
        expect(io.roomEmits).to.deep.equal([]);
      } finally {
        cleanupRoom(service, handler, null);
      }
    });
  });

  it('uses FailureManager reconnection path for in-progress room with previous socket id', async () => {
    const ioMock = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } };

    const room = {
      roomId: 'room-live',
      players: new Map(),
      isInProgress: () => true,
      getPlayers: () => [],
    };

    const gameServiceMock = {
      getRoom: () => room,
      markPlayerActive: () => {},
      findOrCreateRoom: () => room,
      socketToPlayer: new Map(),
      playerToRoom: new Map(),
      joinRoom: () => {
        throw new Error('joinRoom should not be called on failure-manager reconnection path');
      },
    };

    let failureManagerCalled = false;
    const failureManagerMock = {
      handlePlayerConnection: async (_socket, payload) => {
        failureManagerCalled = true;
        expect(payload.userId).to.equal('player-1');
        expect(payload.roomId).to.equal('room-live');
        expect(payload.previousSocketId).to.equal('old-socket-1');
        return { success: true, isReconnection: true };
      },
    };

    const handler = new SocketHandlers(ioMock, gameServiceMock, null, failureManagerMock);
    const socket = createSocketMock();

    let initialStateCalled = false;
    handler._sendInitialGameState = () => {
      initialStateCalled = true;
    };

    await handler.handleJoinRoom(socket, {
      playerId: 'player-1',
      playerName: 'Player 1',
      roomId: 'room-live',
      previousSocketId: 'old-socket-1',
    });

    expect(failureManagerCalled).to.equal(true);
    expect(initialStateCalled).to.equal(true);
    expect(socket.joinedRooms).to.include('room-live');
    expect(gameServiceMock.socketToPlayer.get('socket-1')).to.equal('player-1');
    expect(gameServiceMock.playerToRoom.get('player-1')).to.equal('room-live');
  });

  describe('host heartbeat (lobby kill)', () => {
    // Build a WAITING lobby room with a seated host, and return the pieces a test
    // needs to drive the heartbeat tick directly (no real timers / no sleeping).
    const setupLobby = () => {
      const service = new GameService();
      const hostSock = createSocketMock('host-sock');
      const guestSock = createSocketMock('guest-sock');
      const io = createIoMock([hostSock, guestSock]);
      const handler = new SocketHandlers(io, service);
      const room = service.createRoom('lobby-hb', 2);
      service.joinRoom('lobby-hb', 'host', 'Host', 'host-sock');
      service.joinRoom('lobby-hb', 'guest', 'Guest', 'guest-sock');
      room.hostPlayerId = 'host';
      return { service, handler, room, io, hostSock, guestSock };
    };

    it('kills the room after maxMisses, emits room_closed, deletes runtime + bumps metric', () => {
      const { service, handler, room, io } = setupLobby();
      try {
        const before = metrics.get('buraco_host_heartbeat_kill_total', {
          reason: 'host_heartbeat_timeout',
        });
        // Drive ticks directly maxMisses times — each tick counts one miss
        // (no pong arrives). The final tick crosses the threshold and kills.
        for (let i = 0; i < config.hostHeartbeat.maxMisses; i++) {
          handler._hostHeartbeatTick(room);
        }

        expect(service.getRoom('lobby-hb')).to.equal(undefined);
        const closed = io.roomEmits.find((e) => e.event === SocketEvents.ROOM_CLOSED);
        expect(closed, 'room_closed emitted').to.not.equal(undefined);
        expect(closed.payload.reason).to.equal('host_heartbeat_timeout');
        expect(closed.payload.message).to.equal('Room sudah diakhiri host');
        expect(
          metrics.get('buraco_host_heartbeat_kill_total', {
            reason: 'host_heartbeat_timeout',
          })
        ).to.equal(before + 1);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('does NOT kill a room whose host never had a live socket (owned by the backend deadline)', () => {
      const service = new GameService();
      const io = createIoMock([]); // no live sockets → host socket always absent
      const handler = new SocketHandlers(io, service);
      const room = service.createRoom('lobby-nohost', 2);
      room.hostPlayerId = 'host'; // host seat known from sync, but never socket-joined
      try {
        for (let i = 0; i < config.hostHeartbeat.maxMisses + 2; i++) {
          handler._hostHeartbeatTick(room);
        }
        expect(service.getRoom('lobby-nohost'), 'room still alive').to.not.equal(undefined);
        expect(room.hostHeartbeatMissed, 'no misses accrued before first connect').to.equal(0);
        expect(room.hostEverConnected).to.equal(false);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('kills + notifies the backend even when the host never socket-joined (everHadPlayers=false)', () => {
      const service = new GameService();
      const io = createIoMock([]); // host vanished → no live host socket
      const handler = new SocketHandlers(io, service);
      const room = service.createRoom('lobby-phantom', 2);
      room.hostPlayerId = 'host';
      room.everHadPlayers = false; // synced from backend, no socket join ever
      room.hostEverConnected = true; // host WAS briefly present, then swiped away
      const notified = [];
      handler._notifyBackendRoomClosed = (roomId, reason) => {
        const ctx = handler._roomCloseContext.get(String(roomId));
        notified.push({ roomId, reason: reason || ctx?.reason || null });
      };
      try {
        for (let i = 0; i < config.hostHeartbeat.maxMisses; i++) {
          handler._hostHeartbeatTick(room);
        }
        expect(service.getRoom('lobby-phantom'), 'room killed').to.equal(undefined);
        expect(notified.length, 'backend notified despite everHadPlayers=false').to.equal(1);
        expect(notified[0].roomId).to.equal('lobby-phantom');
        expect(notified[0].reason).to.equal('host_heartbeat_timeout');
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('a valid host pong resets the miss counter', () => {
      const { service, handler, room, hostSock } = setupLobby();
      try {
        handler._hostHeartbeatTick(room);
        handler._hostHeartbeatTick(room);
        expect(room.hostHeartbeatMissed).to.equal(2);

        handler.handleHostHeartbeatPong(hostSock, { roomId: 'lobby-hb', seq: 1 });
        expect(room.hostHeartbeatMissed).to.equal(0);
        expect(room.lastHostPongAt).to.be.a('number');

        // A non-host pong must NOT reset the counter (anti-spoof).
        handler._hostHeartbeatTick(room);
        handler.handleHostHeartbeatPong({ id: 'guest-sock', handshake: { headers: {} } }, {
          roomId: 'lobby-hb',
          seq: 2,
        });
        expect(room.hostHeartbeatMissed).to.equal(1);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('a host pong refreshes host activity so the inactivity sweep cannot reap a ponging host', () => {
      const { service, handler, room, hostSock } = setupLobby();
      try {
        const host = room.players.get('host');
        host.lastActivity = new Date(Date.now() - 60 * 60 * 1000); // 1h stale
        handler._hostHeartbeatTick(room);
        handler.handleHostHeartbeatPong(hostSock, { roomId: 'lobby-hb', seq: 1 });
        expect(Date.now() - host.lastActivity.getTime(), 'activity refreshed').to.be.lessThan(5000);
        expect(room.allPlayersInactive(30 * 60 * 1000), 'not reapable by inactivity').to.equal(false);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('host (re)join clears accrued heartbeat misses (no kill on the tick it returns)', () => {
      const { service, handler, room } = setupLobby();
      try {
        room.hostEverConnected = true;
        handler._hostHeartbeatTick(room);
        handler._hostHeartbeatTick(room);
        expect(room.hostHeartbeatMissed).to.equal(2);
        handler._noteHostHeartbeatPresence(room, 'host');
        expect(room.hostHeartbeatMissed).to.equal(0);
        expect(room._hostSocketAbsent).to.equal(false);
        // A non-host (re)join must NOT reset the host's counter.
        handler._hostHeartbeatTick(room);
        handler._noteHostHeartbeatPresence(room, 'guest');
        expect(room.hostHeartbeatMissed).to.equal(1);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('starting the game stops the heartbeat', () => {
      const { service, handler, room, hostSock } = setupLobby();
      try {
        handler._ensureHostHeartbeat(room);
        expect(room.hostHeartbeatHandle).to.not.equal(null);

        handler.handleStartGame(hostSock, { roomId: 'lobby-hb' });

        expect(room.isInProgress()).to.equal(true);
        expect(room.hostHeartbeatHandle).to.equal(null);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('_ensureHostHeartbeat is idempotent and skipped for non-WAITING rooms', () => {
      const { service, handler, room } = setupLobby();
      try {
        handler._ensureHostHeartbeat(room);
        const handle = room.hostHeartbeatHandle;
        expect(handle).to.not.equal(null);
        // Second call must not replace the live handle.
        handler._ensureHostHeartbeat(room);
        expect(room.hostHeartbeatHandle).to.equal(handle);

        handler._stopHostHeartbeat(room);
        expect(room.hostHeartbeatHandle).to.equal(null);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });
  });

  describe('spectator seat security', () => {
    it('seats an authenticated spectator under their VERIFIED user id, never a forged client id', () => {
      const service = new GameService();
      const specSock = createSocketMock('spec-sock');
      specSock.data = { authenticated: true, userId: 'specA' }; // verified as specA
      const io = createIoMock([specSock]);
      const handler = new SocketHandlers(io, service);
      const room = service.createRoom('lobby-imp', 2);
      service.joinRoom('lobby-imp', 'host', 'Host', 'host-sock');
      room.hostPlayerId = 'host';
      try {
        // Spectator joins claiming to be 'victimB' — _addSpectator must bind the
        // server-verified id 'specA', not the forged client id.
        handler._addSpectator(specSock, room.roomId, 'victimB', 'Imposter');
        expect(handler.roomSpectators.get(room.roomId).get('spec-sock').spectatorId).to.equal('specA');

        // Sitting down must seat 'specA', never 'victimB'.
        handler.handleClaimSeat(specSock, { seat: 1 });
        expect(room.getPlayer('specA'), 'seated under verified id').to.not.equal(undefined);
        expect(room.getPlayer('victimB'), 'forged id never seated').to.equal(undefined);
        expect(service.getPlayerIdBySocket('spec-sock')).to.equal('specA');
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('keeps the client-supplied id for a legacy (unauthenticated) spectator', () => {
      const service = new GameService();
      const specSock = createSocketMock('legacy-sock'); // no socket.data → unauthenticated
      const io = createIoMock([specSock]);
      const handler = new SocketHandlers(io, service);
      const room = service.createRoom('lobby-legacy', 2);
      service.joinRoom('lobby-legacy', 'host', 'Host', 'host-sock');
      room.hostPlayerId = 'host';
      try {
        handler._addSpectator(specSock, room.roomId, 'legacyGuest', 'Guest');
        expect(handler.roomSpectators.get(room.roomId).get('legacy-sock').spectatorId).to.equal('legacyGuest');
      } finally {
        cleanupRoom(service, handler, room);
      }
    });
  });

  describe('in-game chat', () => {
    it('broadcasts a seated player chat with authoritative identity', () => {
      const { service, handler, room, io } = setupStartedRoom();
      try {
        handler.handleChatMessage({ id: 's1' }, { text: '  hello   world  ' });

        const chat = io.roomEmits.find((e) => e.event === SocketEvents.CHAT_MESSAGE);
        expect(chat, 'chat broadcast').to.not.equal(undefined);
        expect(chat.roomId).to.equal(room.roomId);
        expect(chat.payload.playerIndex).to.equal(0);
        expect(chat.payload.playerName).to.equal('P1');
        expect(chat.payload.kind).to.equal('text');
        // Sanitized: trimmed + collapsed whitespace.
        expect(chat.payload.text).to.equal('hello world');
        expect(room.getChatHistory()).to.have.lengthOf(1);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('ignores empty / whitespace-only messages', () => {
      const { service, handler, room, io } = setupStartedRoom();
      try {
        handler.handleChatMessage({ id: 's1' }, { text: '   ' });
        const chat = io.roomEmits.find((e) => e.event === SocketEvents.CHAT_MESSAGE);
        expect(chat).to.equal(undefined);
        expect(room.getChatHistory()).to.have.lengthOf(0);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('throttles back-to-back messages from the same socket', () => {
      const { service, handler, room, io } = setupStartedRoom();
      try {
        handler.handleChatMessage({ id: 's1' }, { text: 'first' });
        handler.handleChatMessage({ id: 's1' }, { text: 'second' });
        const chats = io.roomEmits.filter((e) => e.event === SocketEvents.CHAT_MESSAGE);
        expect(chats).to.have.lengthOf(1);
        expect(chats[0].payload.text).to.equal('first');
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('marks emote messages with kind=emote', () => {
      const { service, handler, room, io } = setupStartedRoom();
      try {
        handler.handleChatMessage({ id: 's2' }, { text: '👍', kind: 'emote' });
        const chat = io.roomEmits.find((e) => e.event === SocketEvents.CHAT_MESSAGE);
        expect(chat.payload.kind).to.equal('emote');
        expect(chat.payload.playerIndex).to.equal(1);
        expect(chat.payload.playerName).to.equal('P2');
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('replays the chat backlog on get_chat_history', () => {
      const { service, handler, room, s1 } = setupStartedRoom();
      try {
        handler.handleChatMessage({ id: 's1' }, { text: 'one' });
        handler.handleGetChatHistory(s1, { gameId: room.roomId, playerId: 'p1' });

        const history = s1.emitted.find((e) => e.event === SocketEvents.CHAT_HISTORY);
        expect(history, 'chat_history reply').to.not.equal(undefined);
        expect(history.payload.messages).to.have.lengthOf(1);
        expect(history.payload.messages[0].text).to.equal('one');
      } finally {
        cleanupRoom(service, handler, room);
      }
    });

    it('returns an empty backlog when the socket is not in any room', () => {
      const { service, handler, room } = setupStartedRoom();
      try {
        const stranger = createSocketMock('unknown-socket');
        handler.handleGetChatHistory(stranger, {});
        const history = stranger.emitted.find((e) => e.event === SocketEvents.CHAT_HISTORY);
        expect(history).to.not.equal(undefined);
        expect(history.payload.messages).to.have.lengthOf(0);
      } finally {
        cleanupRoom(service, handler, room);
      }
    });
  });
});
