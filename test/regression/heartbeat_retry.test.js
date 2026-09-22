/* eslint-env mocha */

/**
 * The liveness heartbeat is what keeps rooms VISIBLE in the lobby.
 *
 * The backend hides any room whose `last_runtime_seen_at` has aged past
 * `room_runtime_fresh_seconds` — and it applies that predicate in BOTH listing
 * scopes (scopeJoinable for open rooms, the spectatable predicate for
 * in-progress ones). So a dropped beat is not a lost log line: it is every live
 * room disappearing from every user's lobby at once, then reappearing on the
 * next successful beat. That is the reported "table list kadang muncul kadang
 * engga".
 *
 * The beat used to be a bare fire-and-forget fetch: no timeout (Node's fetch has
 * none by default, so a stalled backend hangs the request forever) and no retry.
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

const fakeIo = () => ({ to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } });

/** A room with one connected human seat. */
function liveRoom(service, roomId) {
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'u1', 'Human', 's1');
  const seat = room.getPlayer('u1');
  seat.isBot = false;
  seat.isConnected = true;
  room.backendBaseUrl = 'http://backend.test';
  return room;
}

describe('#the lobby heartbeat survives a blip', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = global.fetch;
    calls = [];
    process.env.BURACO_HEARTBEAT_RETRY_DELAY_MS = '0';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.BURACO_HEARTBEAT_RETRY_DELAY_MS;
    delete process.env.BURACO_HEARTBEAT_MAX_RETRIES;
  });

  it('retries a beat the backend refused, and succeeds', async () => {
    const service = new GameService();
    liveRoom(service, 'hb1');
    const handlers = new SocketHandlers(fakeIo(), service);

    global.fetch = (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (calls.length === 1) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve({ ok: true, status: 200 });
    };

    await handlers._notifyBackendHeartbeat();

    expect(calls).to.have.lengthOf(2, 'the blip cost a retry, not the beat');
    expect(calls[1].body.activeRoomIds).to.deep.equal(['hb1']);
    service.deleteRoom('hb1');
  });

  it('treats a NON-OK response as a failed beat, not a delivered one', async () => {
    // The old code only caught network errors: a 502 from a reloading backend
    // resolved cleanly and the beat was counted as delivered.
    const service = new GameService();
    liveRoom(service, 'hb2');
    const handlers = new SocketHandlers(fakeIo(), service);

    global.fetch = (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return Promise.resolve(calls.length === 1 ? { ok: false, status: 502 } : { ok: true, status: 200 });
    };

    await handlers._notifyBackendHeartbeat();

    expect(calls).to.have.lengthOf(2);
    service.deleteRoom('hb2');
  });

  it('gives up after the retry budget instead of hammering', async () => {
    const service = new GameService();
    liveRoom(service, 'hb3');
    const handlers = new SocketHandlers(fakeIo(), service);

    global.fetch = () => {
      calls.push(1);
      return Promise.reject(new Error('down'));
    };

    await handlers._notifyBackendHeartbeat();

    expect(calls).to.have.lengthOf(
      SocketHandlers.HEARTBEAT_MAX_RETRIES + 1,
      'one initial attempt plus the retry budget'
    );
    service.deleteRoom('hb3');
  });

  it('bounds the request so a stalled backend cannot hang the beat forever', async () => {
    const service = new GameService();
    liveRoom(service, 'hb4');
    const handlers = new SocketHandlers(fakeIo(), service);

    let sawSignal = false;
    global.fetch = (url, opts) => {
      sawSignal = Boolean(opts.signal);
      return Promise.resolve({ ok: true, status: 200 });
    };

    await handlers._notifyBackendHeartbeat();

    expect(sawSignal, 'an abort signal rides with every beat').to.equal(true);
    expect(SocketHandlers.HEARTBEAT_TIMEOUT_MS).to.be.lessThan(SocketHandlers.HEARTBEAT_MS);
    service.deleteRoom('hb4');
  });

  // A room whose humans are all DISCONNECTED is still alive here: after a deploy
  // every restored room is exactly that for the whole restart hold, and a
  // mid-game drop keeps its reconnectable seat. Omitting it made the backend hide
  // the table and detach its players while this server was holding it for them
  // (they could never find their way back, and were refused a seat anywhere
  // else). The beat now reports every room that still seats a human.
  it('still beats a room whose only human is disconnected (held for reconnect)', async () => {
    const service = new GameService();
    const room = liveRoom(service, 'hb5');
    room.getPlayer('u1').isConnected = false;
    room.getPlayer('u1').socketId = null;
    const handlers = new SocketHandlers(fakeIo(), service);

    global.fetch = (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200 });
    };

    await handlers._notifyBackendHeartbeat();

    expect(calls).to.have.lengthOf(1, 'the held room is reported alive');
    expect(calls[0].activeRoomIds).to.deep.equal(['hb5']);
    service.deleteRoom('hb5');
  });

  it('omits a bot-only room', async () => {
    const service = new GameService();
    const room = liveRoom(service, 'hb6');
    room.getPlayer('u1').isBot = true;
    const handlers = new SocketHandlers(fakeIo(), service);

    global.fetch = () => {
      calls.push(1);
      return Promise.resolve({ ok: true, status: 200 });
    };

    await handlers._notifyBackendHeartbeat();

    expect(calls).to.have.lengthOf(0, 'nothing human to report');
    service.deleteRoom('hb6');
  });
});
