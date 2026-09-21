/**
 * Logger → per-game capture: how a log line gets attributed to a room
 * (explicit room logger, data.roomId, ambient AsyncLocalStorage context,
 * validated "room <id>" mention) and that the capture level is independent of
 * the console level.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const logger = require('../../src/utils/logger');

const store = logger.gameLogStore;
const msgs = (roomId) => (store.get(roomId).entries || []).map((e) => e.msg);

describe('logger per-game capture', () => {
  let consoleWas;
  beforeEach(() => {
    consoleWas = logger.enableConsole;
    logger.enableConsole = false;
    store.clear();
  });
  afterEach(() => {
    logger.enableConsole = consoleWas;
    store.clear();
  });

  it('attributes a structured line through data.roomId', () => {
    logger.info('[ROOM_LIFECYCLE] room_created', { roomId: 'r-1', maxPlayers: 2 });
    logger.info('[ROOM_LIFECYCLE] player_joined', { roomId: 7 });
    expect(msgs('r-1')).to.deep.equal(['[ROOM_LIFECYCLE] room_created']);
    expect(msgs('7')).to.deep.equal(['[ROOM_LIFECYCLE] player_joined']);
  });

  it('drops a line it cannot attribute to any room', () => {
    logger.info('Starting Brazilia Game Server...');
    logger.warn('room not found for socket abc');
    expect(store.stats().rooms).to.equal(0);
  });

  it('runWithRoom makes the room ambient for sync code, awaits and timers', async () => {
    await logger.runWithRoom('ctx-1', async () => {
      logger.info('sync line');
      await new Promise((resolve) => setTimeout(resolve, 5));
      logger.warn('after await');
      await new Promise((resolve) =>
        setTimeout(() => {
          logger.error('inside timer');
          resolve();
        }, 5)
      );
    });
    logger.info('outside context');

    expect(msgs('ctx-1')).to.deep.equal(['sync line', 'after await', 'inside timer']);
    expect(store.stats().rooms).to.equal(1);
  });

  it('runWithRoom with a null room just runs the function', () => {
    let ran = false;
    const out = logger.runWithRoom(null, () => {
      ran = true;
      return 42;
    });
    expect(ran).to.equal(true);
    expect(out).to.equal(42);
    expect(logger.currentRoomId()).to.equal(null);
  });

  it('bindRoom wraps a callback in the room context', async () => {
    let seenInside = null;
    const cb = logger.bindRoom('bound', (x) => {
      logger.info(`tick ${x}`);
      seenInside = logger.currentRoomId();
    });
    await new Promise((resolve) => setTimeout(() => (cb(1), resolve()), 1));
    expect(seenInside).to.equal('bound');
    expect(msgs('bound')).to.deep.equal(['tick 1']);
    expect(logger.currentRoomId()).to.equal(null);
  });

  it('never leaks the room context out of runWithRoom into later work', async () => {
    logger.runWithRoom('scoped', () => {});
    expect(logger.currentRoomId()).to.equal(null);
    await new Promise((resolve) => setTimeout(resolve, 1));
    logger.info('unrelated line');
    expect(store.has('scoped')).to.equal(false);
  });

  it('data.roomId wins over the ambient context', () => {
    logger.runWithRoom('ambient', () => {
      logger.info('for another room', { roomId: 'explicit' });
    });
    expect(msgs('explicit')).to.deep.equal(['for another room']);
    expect(store.has('ambient')).to.equal(false);
  });

  it('forRoom pins every line regardless of context', () => {
    const room = logger.forRoom('pinned');
    logger.runWithRoom('other', () => {
      room.info('hello');
      room.warn('careful', { roomId: 'ignored-because-explicit' });
    });
    expect(msgs('pinned')).to.deep.equal(['hello', 'careful']);
    expect(store.has('other')).to.equal(false);
    expect(store.has('ignored-because-explicit')).to.equal(false);
  });

  it('accepts a "room <id>" mention only for a room the store already knows', () => {
    logger.info('[DEAL_CARDS] Starting to deal cards for room unknown-9 (auto)');
    expect(store.has('unknown-9')).to.equal(false);

    logger.info('[ROOM_LIFECYCLE] room_created', { roomId: 'known-1' });
    logger.info('[DEAL_CARDS] Starting to deal cards for room known-1 (auto)');
    logger.warn('[RESUME] Failed to resume room known-1: boom');
    logger.info('[TURN_TIMER] Room known-1 turn limit 30s -> 20s');
    expect(msgs('known-1')).to.have.length(4);
  });

  it('captures debug lines for the game log even when the console level is info', () => {
    expect(logger.level).to.be.lessThan(3); // console: info (default)
    logger.debug('quiet on console, kept for the game', { roomId: 'dbg' });
    expect(msgs('dbg')).to.deep.equal(['quiet on console, kept for the game']);
    expect(store.get('dbg').entries[0].level).to.equal('DEBUG');
  });

  it('serializes the data payload alongside the line', () => {
    logger.error('[STATE_PERSIST] failed', { roomId: 'd1', error: 'ECONN' });
    const entry = store.get('d1').entries[0];
    expect(JSON.parse(entry.data)).to.deep.equal({ roomId: 'd1', error: 'ECONN' });
  });
});
