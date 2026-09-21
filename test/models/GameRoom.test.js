/**
 * GameRoom Model Tests
 * Unit tests for the GameRoom class
 */

const { expect } = require('chai');
const { GameRoom } = require('../../src/models');
const { PlayerSession } = require('../../src/models');
const { GameRoomStatus } = require('../../src/constants');

describe('GameRoom Model', () => {
  describe('Initialization', () => {
    it('should create a room with default settings', () => {
      const room = new GameRoom({ roomId: 'test-room' });

      expect(room.roomId).to.equal('test-room');
      expect(room.maxPlayers).to.equal(2);
      expect(room.status).to.equal(GameRoomStatus.WAITING);
      expect(room.players.size).to.equal(0);
      expect(room.currentTurn).to.equal(0);
    });

    it('should create a room with custom max players', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 4 });

      expect(room.maxPlayers).to.equal(4);
    });

    it('should initialize with empty game state', () => {
      const room = new GameRoom({ roomId: 'test-room' });

      expect(room.deck).to.be.null;
      expect(room.discardPile).to.be.an('array').that.is.empty;
      expect(room.deadPiles).to.be.an('array').that.is.empty;
      expect(room.playerHands.size).to.equal(0);
      expect(room.playerMelds.size).to.equal(0);
    });
  });

  describe('Player Management', () => {
    it('should add a player successfully', () => {
      const room = new GameRoom({ roomId: 'test-room' });
      const player = new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      });

      const result = room.addPlayer(player);

      expect(result).to.be.true;
      expect(room.players.size).to.equal(1);
      expect(room.getPlayer('p1')).to.equal(player);
    });

    it('should not add player if room is full', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });
      
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      const result = room.addPlayer(new PlayerSession({
        playerId: 'p3',
        playerName: 'Charlie',
        playerIndex: 2,
        socketId: 's3',
      }));

      expect(result).to.be.false;
      expect(room.players.size).to.equal(2);
    });

    it('should remove a player successfully', () => {
      const room = new GameRoom({ roomId: 'test-room' });
      const player = new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      });

      room.addPlayer(player);
      const result = room.removePlayer('p1');

      expect(result).to.be.true;
      expect(room.players.size).to.equal(0);
    });

    it('should get players sorted by index', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 4 });

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p3',
        playerName: 'Charlie',
        playerIndex: 2,
        socketId: 's3',
      }));

      const players = room.getPlayers();

      expect(players).to.have.lengthOf(3);
      expect(players[0].playerIndex).to.equal(0);
      expect(players[1].playerIndex).to.equal(1);
      expect(players[2].playerIndex).to.equal(2);
    });
  });

  describe('Room Status', () => {
    it('should report if room is full', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      expect(room.isFull()).to.be.false;

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      expect(room.isFull()).to.be.false;

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      expect(room.isFull()).to.be.true;
    });

    it('should report if room can start', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      expect(room.canStart()).to.be.false;

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      expect(room.canStart()).to.be.false;

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      expect(room.canStart()).to.be.true;
    });
  });

  describe('Game Start', () => {
    it('should start game when room is full', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      const result = room.startGame();

      expect(result).to.be.true;
      expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);
      expect(room.gameStartedAt).to.not.be.null;
      expect(room.cardsDealt).to.be.false;
    });

    it('should not start game when room is not full', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      const result = room.startGame();

      expect(result).to.be.false;
      expect(room.status).to.equal(GameRoomStatus.WAITING);
    });

    it('should preserve the 2v2 mode and refuse a forced start with only 2 players', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 4 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      const result = room.startGame(true);

      expect(result).to.be.false;
      expect(room.maxPlayers).to.equal(4);
      expect(room.status).to.equal(GameRoomStatus.WAITING);
      expect(room.gameStartedAt).to.be.null;
      expect(room.cardsDealt).to.not.equal(true);
    });

    for (const [label, indices] of [
      ['duplicate', [0, 1, 1, 3]],
      ['sparse', [0, 1, 3, 4]],
    ]) {
      it(`should reject ${label} seat indices even when the player count is full`, () => {
        const room = new GameRoom({ roomId: `invalid-${label}`, maxPlayers: 4 });
        for (let index = 0; index < 4; index += 1) {
          room.addPlayer(new PlayerSession({
            playerId: `p${index}`, playerName: `Player ${index}`, playerIndex: index, socketId: `s${index}`,
          }));
        }
        // addPlayer already guards new admissions; this pins the independent
        // start boundary against malformed/restored mutable session indices.
        room.getPlayers().forEach((player, index) => { player.playerIndex = indices[index]; });

        expect(room.players.size).to.equal(4);
        expect(room.canStart()).to.equal(false);
        expect(room.startGame()).to.equal(false);
        expect(room.startGame(true)).to.equal(false);
        expect(room.maxPlayers).to.equal(4);
        expect(room.status).to.equal(GameRoomStatus.WAITING);
        expect(room.gameStartedAt).to.equal(null);
        expect(room.cardsDealt).to.not.equal(true);
      });
    }
  });

  describe('Card Dealing', () => {
    it('should deal 11 cards to each player', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      room.startGame();
      const result = room.dealCards();

      expect(result).to.be.true;
      expect(room.playerHands.get('p1')).to.have.lengthOf(11);
      expect(room.playerHands.get('p2')).to.have.lengthOf(11);
    });

    it('should create two dead piles of 11 cards each', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      room.startGame();
      room.dealCards();

      expect(room.deadPiles).to.have.lengthOf(2);
      expect(room.deadPiles[0]).to.have.lengthOf(11);
      expect(room.deadPiles[1]).to.have.lengthOf(11);
    });

    it('should flip one card to discard pile', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      room.startGame();
      room.dealCards();

      expect(room.discardPile).to.have.lengthOf(1);
    });

    it('should not deal cards twice', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      room.startGame();
      room.dealCards();

      const result = room.dealCards();

      expect(result).to.be.false;
      expect(room.playerHands.get('p1')).to.have.lengthOf(11); // Still 11, not 22
    });
  });

  describe('Turn Management', () => {
    it('should check if it is a players turn', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      room.currentTurn = 0;

      expect(room.isPlayerTurn('p1')).to.be.true;
      expect(room.isPlayerTurn('p2')).to.be.false;
    });

    it('should advance to next turn', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      room.currentTurn = 0;
      room.nextTurn();

      expect(room.currentTurn).to.equal(1);
    });

    it('should wrap turn around to 0', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      room.currentTurn = 1;
      room.nextTurn();

      expect(room.currentTurn).to.equal(0);
    });
  });

  describe('Game State', () => {
    it('should report game is in progress', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      expect(room.isInProgress()).to.be.false;

      room.startGame();

      expect(room.isInProgress()).to.be.true;
    });

    it('should report game has ended', () => {
      const room = new GameRoom({ roomId: 'test-room', maxPlayers: 2 });

      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));

      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));

      room.startGame();
      room.endGame('p1');

      expect(room.hasEnded()).to.be.true;
      expect(room.status).to.equal(GameRoomStatus.FINISHED);
      expect(room.winnerId).to.equal('p1');
    });
  });

  describe('Ruleset Configuration', () => {
    it('should default to classic ruleset', () => {
      const room = new GameRoom({ roomId: 'test-room' });

      expect(room.ruleset).to.equal('classic');
    });

    it('should allow professional ruleset', () => {
      const room = new GameRoom({ roomId: 'test-room' });
      room.ruleset = 'professional';

      expect(room.ruleset).to.equal('professional');
    });
  });
});
