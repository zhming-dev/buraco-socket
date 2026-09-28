/**
 * Leaving an in-progress game = forfeit.
 * The player who deliberately leaves loses; the remaining player wins. Everyone
 * gets a `game_ended` with a reason so the client can explain what happened.
 */

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeIo(emitted, socketRegistry) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'room', roomId, event, payload }),
    }),
    sockets: { sockets: socketRegistry },
  };
}

function fakeSocket(id, emitted) {
  return {
    id,
    leave: () => {},
    emit: (event, payload) => emitted.push({ scope: 'socket', id, event, payload }),
    // socket.io sockets support `.to(room).emit(...)` for room broadcasts.
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'socket-to', id, roomId, event, payload }),
    }),
  };
}

function startedRoom(service, roomId) {
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'host', 'Host', 'sHost'); // first joiner becomes host (index 0)
  service.joinRoom(roomId, 'opp', 'Opp', 'sOpp');     // index 1
  room.startGame();
  room.dealCards();
  return room;
}

describe('Leave-as-forfeit (in-progress)', () => {
  const services = [];

  afterEach(() => {
    while (services.length > 0) {
      services.pop().shutdown();
    }
  });

  it('host leaving forfeits: opponent (index 1) wins, reason host_left, room closed', () => {
    const service = new GameService();
    services.push(service);
    startedRoom(service, 'r-host');

    const emitted = [];
    const registry = new Map();
    const io = fakeIo(emitted, registry);
    registry.set('sHost', fakeSocket('sHost', emitted));
    registry.set('sOpp', fakeSocket('sOpp', emitted));
    const handlers = new SocketHandlers(io, service);

    handlers.handleLeaveRoom(fakeSocket('sHost', emitted));

    const ended = emitted.find((e) => e.event === 'game_ended');
    expect(ended, 'game_ended emitted').to.exist;
    expect(ended.payload.reason).to.equal('host_left');
    expect(ended.payload.winnerIndex).to.equal(1);
    expect(ended.payload.hostLeft).to.equal(true);
    expect(ended.payload.roomClosed).to.equal(true);
    // Room is kept for a reconnect grace (not deleted immediately), but it IS
    // finished and scheduled for teardown.
    const graceHost = service.getRoom('r-host');
    expect(graceHost, 'room kept for reconnect grace').to.exist;
    expect(graceHost.finalizeCleanupHandle, 'deletion scheduled').to.exist;
  });

  it('opponent leaving forfeits: room owner (index 0) wins, reason opponent_left', () => {
    const service = new GameService();
    services.push(service);
    startedRoom(service, 'r-opp');

    const emitted = [];
    const registry = new Map();
    const io = fakeIo(emitted, registry);
    registry.set('sHost', fakeSocket('sHost', emitted));
    registry.set('sOpp', fakeSocket('sOpp', emitted));
    const handlers = new SocketHandlers(io, service);

    handlers.handleLeaveRoom(fakeSocket('sOpp', emitted));

    const ended = emitted.find((e) => e.event === 'game_ended');
    expect(ended, 'game_ended emitted').to.exist;
    expect(ended.payload.reason).to.equal('opponent_left');
    expect(ended.payload.winnerIndex).to.equal(0);
    expect(ended.payload.hostLeft).to.equal(false);
    const graceOpp = service.getRoom('r-opp');
    expect(graceOpp, 'room kept for reconnect grace').to.exist;
    expect(graceOpp.finalizeCleanupHandle, 'deletion scheduled').to.exist;
  });

  it('leaving in the lobby (not in progress) does NOT trigger a forfeit game_ended', () => {
    const service = new GameService();
    services.push(service);
    const room = service.createRoom('r-lobby', 2);
    service.joinRoom('r-lobby', 'host', 'Host', 'sHost');
    service.joinRoom('r-lobby', 'opp', 'Opp', 'sOpp');
    // Not started — still waiting.

    const emitted = [];
    const registry = new Map();
    const io = fakeIo(emitted, registry);
    registry.set('sHost', fakeSocket('sHost', emitted));
    registry.set('sOpp', fakeSocket('sOpp', emitted));
    const handlers = new SocketHandlers(io, service);

    handlers.handleLeaveRoom(fakeSocket('sOpp', emitted));

    expect(emitted.find((e) => e.event === 'game_ended')).to.equal(undefined);
  });

  it('does NOT forfeit a CONNECTED player who simply idles', () => {
    const service = new GameService();
    services.push(service);
    const room = startedRoom(service, 'r-idle');
    room.currentTurn = 1;
    room.hasDrawnCard = true;
    room.playerHands.set('opp', [{ suit: 'joker', rank: 'joker' }]);

    const emitted = [];
    const registry = new Map();
    const io = fakeIo(emitted, registry);
    registry.set('sHost', fakeSocket('sHost', emitted));
    registry.set('sOpp', fakeSocket('sOpp', emitted));
    const handlers = new SocketHandlers(io, service);

    for (let i = 0; i < 5; i++) {
      room.currentTurn = 1;
      room.hasDrawnCard = true;
      room.turnHadManualAction = false;
      handlers._onTurnTimerExpired(room);
      if (room.turnTimerTickHandle) {
        clearTimeout(room.turnTimerTickHandle);
        room.turnTimerTickHandle = null;
      }
    }

    // The idle forfeit is GONE (product decision, 2026-08-20). Ending a match
    // because someone is slow punished the wrong thing: the counter reset on any
    // action, so a player could drop out, come back for one move, drop out again
    // and never accrue — while a present-but-thinking player got timed out of the
    // match. Being absent does not end it either (2026-09-28, see below): an
    // idle player's turn is auto-played, so the round keeps moving and finishes
    // on its own.
    const ended = emitted.find((e) => e.event === 'game_ended');
    expect(ended, 'no forfeit for a connected player').to.equal(undefined);
  });

  it('a DISCONNECTED player is auto-played (take + throw), never bot-converted, never forfeited', () => {
    const service = new GameService();
    services.push(service);
    const room = startedRoom(service, 'r-dc');

    // Opponent (index 1) drops their connection mid-game. NO bot takeover, and
    // (product rule 2026-09-28) no skip and no forfeit either: every expiry of
    // their turn takes a card and throws a card for them.
    const opp = room.getPlayer('opp');
    opp.disconnect();
    expect(opp.isConnected).to.equal(false);

    const emitted = [];
    const registry = new Map();
    const io = fakeIo(emitted, registry);
    registry.set('sHost', fakeSocket('sHost', emitted));
    registry.set('sOpp', fakeSocket('sOpp', emitted));
    const handlers = new SocketHandlers(io, service);

    const handBefore = (room.playerHands.get('opp') || []).length;
    const pileBefore = room.discardPile.length;

    for (let i = 0; i < 5; i++) {
      room.currentTurn = 1; // the disconnected opponent's turn
      room.hasDrawnCard = false;
      room.turnHadManualAction = false;
      handlers._onTurnTimerExpired(room);
      if (room.turnTimerTickHandle) {
        clearTimeout(room.turnTimerTickHandle);
        room.turnTimerTickHandle = null;
      }
    }

    // Five turns, five takes and five throws: the hand size is unchanged and
    // the pile grew by one card per turn.
    expect((room.playerHands.get('opp') || []).length).to.equal(handBefore);
    expect(room.discardPile.length).to.equal(pileBefore + 5);
    const thrown = emitted.filter((e) => e.event === 'card_discarded' && e.payload.playerIndex === 1);
    expect(thrown).to.have.length(5);
    expect(emitted.some((e) => e.event === 'turn_changed' && e.payload.forced), 'never a bare skip').to.equal(false);
    // Seat was never bot-converted, and is still offline.
    expect(room.getPlayer('opp').isBot).to.equal(false);
    expect(room.getPlayer('opp').isConnected).to.equal(false);

    expect(emitted.find((e) => e.event === 'game_ended'), 'absence never ends the match').to.equal(undefined);
    expect(room.isInProgress()).to.equal(true);
  });

  it("2v2 forfeit: the abandoner's team loses — winner comes from the OPPOSING team", () => {
    const service = new GameService();
    services.push(service);
    const room = service.createRoom('r-2v2', 4);
    service.joinRoom('r-2v2', 'a0', 'A0', 's0'); // index 0, team A (host)
    service.joinRoom('r-2v2', 'b1', 'B1', 's1'); // index 1, team B
    service.joinRoom('r-2v2', 'a2', 'A2', 's2'); // index 2, team A
    service.joinRoom('r-2v2', 'b3', 'B3', 's3'); // index 3, team B
    room.startGame();
    room.dealCards();

    const emitted = [];
    const registry = new Map();
    const io = fakeIo(emitted, registry);
    ['s0', 's1', 's2', 's3'].forEach((s) => registry.set(s, fakeSocket(s, emitted)));
    const handlers = new SocketHandlers(io, service);

    // Player at index 2 (team A) abandons. Team A forfeits → a team B seat (odd
    // index) must win, NOT the leaver's own partner at index 0.
    handlers.handleLeaveRoom(fakeSocket('s2', emitted));

    const ended = emitted.find((e) => e.event === 'game_ended');
    expect(ended, 'game_ended emitted').to.exist;
    expect(ended.payload.winnerIndex % 2, 'winner is on the opposing (team B) side').to.equal(1);

    // THE SETTLEMENT SHAPE. A forfeit is terminal (matchEnded true), so wlive
    // settles the escrow off this payload — and _buildPartnerGameEndData reads
    // the match-winner fields straight from it. They used to be absent, so every
    // forfeit settled with matchWinnerId/Index/Team all null and the only field
    // naming a person was a single seat: in 2v2 the winning PARTNER could not be
    // identified at all.
    expect(ended.payload.matchEnded).to.equal(true);
    expect(ended.payload.matchWinnerTeam, 'the winning SIDE is named').to.equal('teamB');
    expect(ended.payload.winningTeam).to.equal('teamB');
    expect(ended.payload.matchWinnerId).to.equal(ended.payload.winnerId);
    expect(ended.payload.matchWinnerIndex).to.equal(ended.payload.winnerIndex);

    const data = handlers._buildPartnerGameEndData(room, ended.payload);
    expect(data.matchWinnerTeam, 'and it survives into the settlement body').to.equal('teamB');
    expect(data.matchWinnerId).to.not.equal(null);
    expect(data.matchWinnerIndex).to.not.equal(null);
  });
});
