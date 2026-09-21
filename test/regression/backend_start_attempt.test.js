/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');

describe('backend start attempt fences lobby refunds and late starts', () => {
  let service, handlers, room, authorizations, allow;
  const attemptId = 'a'.repeat(32);
  const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    service = new GameService();
    handlers = new SocketHandlers({ sockets: { sockets: new Map() }, to: () => ({ emit() {} }) }, service);
    handlers._ensureHostHeartbeat = () => {};
    handlers._notifyBackendPlayerCount = () => {};
    handlers._notifyBackendCardsDealt = () => {};
    handlers._emitPartnerWebhook = () => {};
    handlers._backendUrlForRoom = () => 'https://api.test';
    handlers.syncRoomFromBackend({ roomId: 'start-fence', maxPlayers: 2, hostPlayerId: '1', startAttemptProtocol: 1 });
    room = service.getRoom('start-fence');
    room.cardsDealt = false;
    service.joinRoom(room.roomId, '1', 'Host', 'host-socket');
    service.joinRoom(room.roomId, '2', 'Guest', 'guest-socket');
    authorizations = [];
    allow = true;
    handlers._seatBackendRequest = async (current, path, body) => {
      authorizations.push(body);
      expect(path).to.equal('room-start-authorize');
      return { success: true, authorized: allow, attemptId: body.attemptId };
    };
  });
  afterEach(() => { handlers._stopTurnTimer(room); service.shutdown(); });

  it('requires a backend attempt and leaves an incomplete room undealt', async () => {
    expect((await handlers.triggerStartGame(room.roomId)).success).to.equal(false);
    expect(room.cardsDealt).to.equal(false);
    service.leaveRoom('2');
    expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(false);
    expect(authorizations).to.be.empty;
  });

  it('coalesces double start, deals once and reports the committed result on abort/retry', async () => {
    const waiting = gate();
    let calls = 0;
    const original = room.dealCards.bind(room);
    room.dealCards = (...args) => { calls++; return original(...args); };
    handlers._seatBackendRequest = async () => { await waiting.promise; return { authorized: true, attemptId }; };
    const first = handlers.triggerStartGame(room.roomId, { attemptId });
    const second = handlers.triggerStartGame(room.roomId, { attemptId });
    await flush();
    expect(handlers._seatsLocked(room)).to.equal(true);
    waiting.resolve();
    expect((await first).success).to.equal(true);
    expect((await second).success).to.equal(true);
    expect(calls).to.equal(1);
    expect((await handlers.abortStartFromBackend({ roomId: room.roomId, attemptId })).outcome).to.equal('started');
    expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(true);
    expect(calls).to.equal(1);
  });

  for (const pendingMap of ['_seatMutations', '_pendingSeatClaims']) {
    it(`waits for an unresolved seat admission in ${pendingMap} before authorizing a deal`, async () => {
      const key = `${room.roomId}:2`;
      handlers[pendingMap].set(key, Promise.resolve());
      expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(false);
      expect(authorizations).to.be.empty;
      expect(room.cardsDealt).to.equal(false);
      expect(room._pendingBackendStart).to.not.exist;
      handlers[pendingMap].delete(key);
      // An operation in a different room must not block this room.
      handlers[pendingMap].set('another-room:2', Promise.resolve());
      expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(true);
    });
  }

  it('abort wins while authorization is in flight, and a delayed authorization never deals', async () => {
    const waiting = gate();
    handlers._seatBackendRequest = async () => { await waiting.promise; return { authorized: true, attemptId }; };
    const starting = handlers.triggerStartGame(room.roomId, { attemptId });
    await flush();
    expect((await handlers.abortStartFromBackend({ roomId: room.roomId, attemptId })).outcome).to.equal('not_started');
    waiting.resolve();
    expect((await starting).success).to.equal(false);
    expect(room.cardsDealt).to.equal(false);
    expect(room.status).to.equal('waiting');
    expect(room._pendingBackendStart).to.equal(null);
  });

  it('rejects a late POST after durable API revocation, including a restarted runtime', async () => {
    allow = false;
    expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(false);
    expect(room.cardsDealt).to.equal(false);
    expect(authorizations).to.have.length(1);
  });

  for (const change of ['room replacement', 'member replacement', 'ownership loss']) {
    it(`does not deal after ${change} during authorization`, async () => {
      const waiting = gate();
      handlers._seatBackendRequest = async () => { await waiting.promise; return { authorized: true, attemptId }; };
      const starting = handlers.triggerStartGame(room.roomId, { attemptId });
      await flush();
      if (change === 'room replacement') service.rooms.delete(room.roomId);
      if (change === 'member replacement') room.players.set('2', { ...room.getPlayer('2') });
      if (change === 'ownership loss') handlers._ownershipEnabled = () => true;
      waiting.resolve();
      expect((await starting).success).to.equal(false);
      expect(room.cardsDealt).to.equal(false);
    });
  }

  it('fails closed on an authorization outage without leaving local seat locks stuck', async () => {
    handlers._seatBackendRequest = async () => { throw new Error('connection lost'); };
    expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(false);
    expect(room._pendingBackendStart).to.equal(null);
    expect(room.cardsDealt).to.equal(false);
  });

  it('does not treat an unrelated running game as proof that refunding is safe', async () => {
    expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(true);
    expect((await handlers.abortStartFromBackend({ roomId: room.roomId, attemptId: 'b'.repeat(32) })).success).to.equal(false);
  });
  for (const failure of ['returns false', 'throws after partial allocation']) {
    it(`restores an undealt lobby when dealing ${failure}, then a fresh attempt can start`, async () => {
      const originalDeal = room.dealCards.bind(room);
      let heartbeats = 0, persisted = 0;
      handlers._ensureHostHeartbeat = () => { heartbeats++; };
      handlers._persistRoomState = () => { persisted++; };
      room.cumulativeTeamScores.set('teamA', 125);
      const sessions = room.getPlayers();
      room.dealCards = () => {
        room.deck = { cards: ['partial'] };
        room.playerHands.get('1').push('partial');
        room.deadPiles.push(['partial']);
        room.pozzetto = ['partial'];
        room.discardPile.push('partial');
        room.discardHistory.push('partial');
        room.awaitingDealAnimation = true;
        room.turnTimerTickHandle = setTimeout(() => {}, 60000);
        room.dealAnimationFallbackHandle = setTimeout(() => {}, 60000);
        if (failure.startsWith('throws')) throw new Error('Injected allocation failure');
        return false;
      };
      const result = await handlers.triggerStartGame(room.roomId, { attemptId });
      expect(result.success).to.equal(false);
      expect(room.status).to.equal('waiting');
      expect(room.roundNumber).to.equal(0);
      expect(room.gameStartedAt).to.equal(null);
      expect(room.startAttemptId).to.equal(null);
      expect(room.deck).to.equal(null);
      expect(room.pozzetto).to.equal(null);
      expect(room.deadPiles).to.deep.equal([]);
      expect(room.discardPile).to.deep.equal([]);
      expect(room.discardHistory).to.deep.equal([]);
      expect([...room.playerHands.values()].every((hand) => hand.length === 0)).to.equal(true);
      expect(room.getPlayers()).to.deep.equal(sessions);
      expect(room.cumulativeTeamScores.get('teamA')).to.equal(125);
      expect(room.turnTimerTickHandle).to.equal(null);
      expect(room.dealAnimationFallbackHandle).to.equal(null);
      expect(room.awaitingDealAnimation).to.equal(false);
      expect(heartbeats).to.equal(1);
      expect(persisted).to.equal(1);
      expect((await handlers.abortStartFromBackend({ roomId: room.roomId, attemptId })).outcome).to.equal('not_started');
      room.dealCards = originalDeal;
      expect((await handlers.triggerStartGame(room.roomId, { attemptId: 'b'.repeat(32) })).success).to.equal(true);
      expect(room.roundNumber).to.equal(1);
    });
  }

  it('never rolls back an already running room when an idempotent deal fails', async () => {
    room.startGame();
    room.startAttemptId = 'b'.repeat(32);
    room.dealCards = () => false;
    expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(false);
    expect(room.status).to.equal('inProgress');
    expect(room.roundNumber).to.equal(1);
    expect(room.startAttemptId).to.equal('b'.repeat(32));
    expect((await handlers.abortStartFromBackend({ roomId: room.roomId, attemptId })).success).to.equal(false);
  });

  it('preserves a completed deal if its subsequent broadcast throws', async () => {
    handlers._sendGameStateUpdate = () => { throw new Error('Injected post-deal broadcast failure'); };
    expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(false);
    expect(room.cardsDealt).to.equal(true);
    expect(room.status).to.equal('inProgress');
    expect(room.playerHands.get('1')).to.have.length(11);
    expect(room.startAttemptId).to.equal(attemptId);
    expect((await handlers.abortStartFromBackend({ roomId: room.roomId, attemptId })).outcome).to.equal('started');
  });

  it('binds the attempt before triggering any start notification', async () => {
    const trigger = handlers._triggerStartGameNow.bind(handlers);
    handlers._triggerStartGameNow = (id, options) => {
      expect(room.startAttemptId).to.equal(attemptId);
      expect(options.deferStartAnnouncement).to.equal(true);
      return trigger(id, options);
    };
    expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(true);
  });

  it('rolls back a newly constructed lobby with no cardsDealt field and never announces a failed start', async () => {
    delete room.cardsDealt;
    const frames = [];
    for (const player of room.getPlayers()) {
      handlers.io.sockets.sockets.set(player.socketId, {
        emit: (event, payload) => frames.push({ event, payload }),
      });
    }
    room.dealCards = () => false;
    expect((await handlers.triggerStartGame(room.roomId, { attemptId })).success).to.equal(false);
    expect(room.status).to.equal('waiting');
    expect(room.cardsDealt).to.equal(undefined);
    expect(room.gameStartedAt).to.equal(null);
    expect(room.roundNumber).to.equal(0);
    expect(room.startAttemptId).to.equal(null);
    expect(frames.some((frame) => frame.event === 'game_started')).to.equal(false);
    expect((await handlers.abortStartFromBackend({ roomId: room.roomId, attemptId })).outcome).to.equal('not_started');
  });

});
