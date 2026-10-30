/* eslint-env mocha */

/**
 * Connection trouble, end to end through the real handlers (owner, 2026-10-31:
 * "Masalah koneksi 2vs2 cek juga 1vs1 … kalo ada yang melakukan meld itu
 * gaboleh mati gamenya", and "pas mau join lagi ke game, dia malah
 * diperlakukan sebagai spectator").
 *
 * The rules every scenario pins, for 1v1 and 2v2, with and without a meld:
 *   - a dropped connection never ends the match: the seat stays its player's
 *     and every turn of it is auto-played (take + throw);
 *   - the player who comes back gets THAT seat back as a player — whatever
 *     intent they join with, whatever the API says — and the state they are
 *     sent names their seat (yourPlayerIndex), which is what the app trusts;
 *   - nothing that merely follows a dropped connection forfeits: not a late
 *     leave from the dead socket, not joining another table, not a leave with
 *     a meld down. Only a deliberate leave before any meld still does.
 */

const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameRoomStatus = require('../../src/constants/gameStatus');
const { SocketEvents } = require('../../src/constants');

const MELD = [
  { suit: 'hearts', rank: '5' },
  { suit: 'hearts', rank: '6' },
  { suit: 'hearts', rank: '7' },
];

for (const seats of [2, 4]) {
  const mode = seats === 2 ? '1v1' : '2v2';
  const ids = seats === 2 ? ['p0', 'p1'] : ['p0', 'p1', 'p2', 'p3'];

  describe(`connection trouble at a ${mode} table`, () => {
    let service;
    let handlers;
    let sockets;
    let frames;
    let room;
    let apiAsked;

    beforeEach(() => {
      service = new GameService();
      sockets = new Map();
      frames = [];
      apiAsked = [];
      handlers = new SocketHandlers({
        sockets: { sockets },
        to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
        emit: () => {},
      }, service);
      handlers._ensureHostHeartbeat = () => {};
      handlers._notifyBackendPlayerCount = () => {};
      handlers._notifyBackendRoomClosed = () => {};
      handlers._notifyBackendGameResult = () => {};
      handlers._emitPartnerWebhook = () => {};
      handlers._queueSeatLayoutSync = () => {};
      // The API marks a seat `forfeited` after a stray REST leave and calls
      // the user a spectator; a seated player must never be asked about.
      handlers._seatBackendRequest = async (_room, path, body) => {
        apiAsked.push(path);
        return { authorized: true, playerId: String(body.playerId), isSpectator: true, reservationVersion: 0 };
      };

      room = service.createRoom(`conn-${mode}`, seats);
      for (const id of ids) {
        socket(`s-${id}`, id);
        expect(service.joinRoom(room.roomId, id, id, `s-${id}`).success).to.equal(true);
      }
      room.backendManaged = true;
      room.backendBaseUrl = 'http://api.test';
      room.seatReservationProtocol = 1;
      room.seatLayoutProtocol = 1;
      room.seatConnectionProtocol = 1;
      room.startGame(true);
      room.dealCards();
      room.currentTurn = 0;
    });

    afterEach(() => {
      for (const r of service.rooms.values()) handlers._stopTurnTimer(r);
      clearInterval(handlers._heartbeatTimer);
      for (const timer of handlers._waitingGraceTimers.values()) clearTimeout(timer);
      service.shutdown();
    });

    function socket(id, userId) {
      const s = {
        id,
        connected: true,
        data: { authenticated: true, userId },
        join() {},
        leave() {},
        emit: (event, payload) => frames.push({ socketId: id, event, payload }),
        to: (roomId) => ({ emit: (event, payload) => frames.push({ roomId, event, payload }) }),
      };
      sockets.set(id, s);
      return s;
    }

    async function drop(id) {
      const seat = room.getPlayer(id);
      const dead = sockets.get(seat.socketId);
      sockets.delete(seat.socketId);
      dead.connected = false;
      await handlers.handleDisconnect(dead, 'transport close');
      handlers._stopTurnTimer(room);
      return dead;
    }

    async function comeBack(id, { spectatorIntent = false } = {}) {
      const returning = socket(`s-${id}-back`, id);
      await handlers.handleJoinRoom(returning, { roomId: room.roomId, playerId: id, playerName: id, isSpectator: spectatorIntent });
      handlers._stopTurnTimer(room);
      return returning;
    }

    function expireTurnOf(id) {
      room.currentTurn = room.getPlayer(id).playerIndex;
      room.hasDrawnCard = false;
      room.turnHadManualAction = false;
      handlers._onTurnTimerExpired(room);
      handlers._stopTurnTimer(room);
    }

    const ended = () => frames.filter((f) => f.event === SocketEvents.GAME_ENDED);
    const closed = () => frames.filter((f) => f.event === SocketEvents.ROOM_CLOSED);

    function expectMatchGoesOn() {
      expect(ended(), 'no game_ended').to.have.lengthOf(0);
      expect(closed(), 'no room_closed').to.have.lengthOf(0);
      expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);
      expect(room.getPlayers()).to.have.lengthOf(seats);
    }

    function expectSeatedAsPlayer(id, s, seatIndex) {
      const seat = room.getPlayer(id);
      expect(seat, `${id} still seated`).to.exist;
      expect(seat.playerIndex).to.equal(seatIndex);
      expect(seat.socketId).to.equal(s.id);
      expect(service.getPlayerIdBySocket(s.id)).to.equal(id);
      expect(handlers.spectatorSocketToRoom.has(s.id), 'not a spectator').to.equal(false);
      expect(apiAsked, 'the API is never asked about a live seat').to.deep.equal([]);
      // What the app's lobby trusts over its own roster: a state naming the seat.
      const named = frames.filter((f) => f.socketId === s.id && f.payload &&
        Object.prototype.hasOwnProperty.call(f.payload, 'yourPlayerIndex'));
      expect(named.length, 'the returning socket is told its seat').to.be.greaterThan(0);
      expect(named.every((f) => f.payload.yourPlayerIndex === seatIndex)).to.equal(true);
    }

    for (const meld of [false, true]) {
      const withMeld = meld ? 'with a meld down' : 'before any meld';

      describe(withMeld, () => {
        beforeEach(() => {
          if (meld) room.playerMelds.set('p0', [MELD.slice()]);
        });

        it('a dropped connection keeps the seat and auto-plays it; the match goes on', async () => {
          await drop('p1');
          expect(room.getPlayer('p1').isConnected).to.equal(false);
          for (let i = 0; i < 3; i++) expireTurnOf('p1');
          const thrown = frames.filter((f) => f.event === SocketEvents.CARD_DISCARDED && f.payload?.playerIndex === 1);
          expect(thrown.length, 'every expired turn takes and throws').to.equal(3);
          expectMatchGoesOn();
        });

        it('the player who comes back gets the same seat back as a player', async () => {
          await drop('p1');
          expireTurnOf('p1');
          const back = await comeBack('p1');
          expectSeatedAsPlayer('p1', back, 1);
          expect(room.getPlayer('p1').isConnected).to.equal(true);
          expectMatchGoesOn();
        });

        it('coming back through the watcher board (spectator intent) still re-seats them', async () => {
          await drop('p1');
          const back = await comeBack('p1', { spectatorIntent: true });
          expectSeatedAsPlayer('p1', back, 1);
          expectMatchGoesOn();
        });

        it("the dead socket's late leave_room after the comeback changes nothing", async () => {
          const dead = await drop('p1');
          const back = await comeBack('p1');
          dead.connected = true; // a buffered emit flushed by a half-dead transport
          handlers.handleLeaveRoom(dead);
          expectSeatedAsPlayer('p1', back, 1);
          expectMatchGoesOn();
        });

        it('a flapping connection (old socket dies after the new one joined) keeps the new binding', async () => {
          const first = room.getPlayer('p1');
          const old = sockets.get(first.socketId);
          const back = await comeBack('p1');
          sockets.delete(old.id);
          old.connected = false;
          await handlers.handleDisconnect(old, 'ping timeout');
          handlers._stopTurnTimer(room);
          expectSeatedAsPlayer('p1', back, 1);
          expect(room.getPlayer('p1').isConnected).to.equal(true);
          expectMatchGoesOn();
        });

        it('joining another table while the seat is socket-less never forfeits this one', async () => {
          await drop('p1');
          const other = service.createRoom(`other-${mode}`, 2);
          other.backendManaged = true;
          expect(handlers._releaseStaleSeatForNewRoom(room, 'p1', other, { via: 'join_room' })).to.equal(false);
          expect(room.getPlayer('p1')).to.exist;
          expectMatchGoesOn();
          const back = await comeBack('p1');
          expectSeatedAsPlayer('p1', back, 1);
        });

        if (seats === 4) {
          it('both partners of one team drop: the match goes on, both seats auto-played, both come back', async () => {
            await drop('p1');
            await drop('p3');
            expireTurnOf('p1');
            expireTurnOf('p3');
            expectMatchGoesOn();
            const back1 = await comeBack('p1');
            const back3 = await comeBack('p3', { spectatorIntent: true });
            expectSeatedAsPlayer('p1', back1, 1);
            expect(room.getPlayer('p3').socketId).to.equal(back3.id);
            expect(handlers.spectatorSocketToRoom.has(back3.id)).to.equal(false);
            expectMatchGoesOn();
          });
        }

        if (meld) {
          it('a leave_room with a meld down — even a deliberate one — is refused: no forfeit', async () => {
            handlers.handleLeaveRoom(sockets.get('s-p1'));
            const refusal = frames.find((f) => f.socketId === 's-p1' && f.event === 'error');
            expect(refusal?.payload?.code).to.equal('LEAVE_LOCKED_MELDS');
            expectMatchGoesOn();
            // ...and when its connection then goes, the seat is just offline.
            await drop('p1');
            expireTurnOf('p1');
            expectMatchGoesOn();
          });

          it('with everyone disconnected and a meld down, another table does not void this one', async () => {
            for (const id of ids) await drop(id);
            const other = service.createRoom(`other-${mode}`, 2);
            other.backendManaged = true;
            expect(handlers._releaseStaleSeatForNewRoom(room, 'p0', other, { via: 'join_room' })).to.equal(false);
            expect(service.getRoom(room.roomId)).to.equal(room);
            expectMatchGoesOn();
          });
        } else {
          it('a deliberate leave_room before any meld still forfeits (the existing rule)', () => {
            handlers.handleLeaveRoom(sockets.get('s-p1'));
            const toRoom = ended().filter((f) => f.roomId === room.roomId);
            expect(toRoom).to.have.lengthOf(1);
            expect(toRoom[0].payload.reason).to.equal('opponent_left');
            expect(room.status).to.equal(GameRoomStatus.FINISHED);
          });
        }
      });
    }
  });
}
