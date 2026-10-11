/* eslint-env mocha */
const http = require('http');
const zlib = require('zlib');
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');
const { createSkinOverrideApi, isSkinOverrideApiPath } = require('../../src/dev/skinOverrideApi');

/** A real 2×1 PNG (valid signature + IHDR), so the sniffer has real bytes. */
function png() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('dev console skin override API (socket only, no wlive-api)', () => {
  const SECRET = 'dev-secret';
  let service;
  let handler;
  let server;
  let base;

  beforeEach(async () => {
    service = new GameService();
    const io = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } };
    handler = new SocketHandlers(io, service);
    service.createRoom('room-1', 2);
    service.joinRoom('room-1', 'p1', 'Angel', 's1');
    const api = createSkinOverrideApi({
      redis: new InMemoryRedis(),
      socketHandlers: handler,
      devSecret: () => SECRET,
    });
    server = http.createServer((req, res) => {
      if (isSkinOverrideApiPath(req.url)) api.handle(req, res);
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    handler.globalSkinOverride = null;
    handler._armGlobalSkinOverrideTimer();
    service.shutdown();
    await new Promise((r) => server.close(r));
  });

  const call = (
    path,
    { method = 'GET', body, type, actor = 'ops', secret = SECRET, origin } = {}
  ) => {
    const headers = {};
    if (secret) headers['x-webhook-secret'] = secret;
    if (actor) headers['x-admin-actor'] = actor;
    if (origin) headers.origin = origin;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    } else if (type) headers['content-type'] = type;
    return fetch(base + path, { method, headers, body })
      .then(async (res) => ({
        status: res.status,
        type: res.headers.get('content-type'),
        cache: res.headers.get('cache-control'),
        buf: Buffer.from(await res.arrayBuffer()),
      }))
      .then((r) => ({
        ...r,
        json: r.type && r.type.includes('json') ? JSON.parse(r.buf.toString()) : null,
      }));
  };

  it('is closed without the console secret, and writes need an operator name', async () => {
    expect((await call('/dev/api/skin-override', { secret: null })).status).to.equal(401);
    expect((await call('/dev/api/skin-override', { secret: 'nope' })).status).to.equal(401);
    const noActor = await call('/dev/api/skin-override', {
      method: 'POST',
      actor: null,
      body: { action: 'set', scope: 'global', skins: { table_theme: 'midnight' } },
    });
    expect(noActor.status).to.equal(400);
    expect(noActor.json.code).to.equal('ACTOR_REQUIRED');
  });

  it('lists the rooms on this socket with the look in force', async () => {
    const res = await call('/dev/api/skin-override');
    expect(res.status).to.equal(200);
    expect(res.json.data.global).to.equal(null);
    expect(res.json.data.rooms.map((r) => r.roomId)).to.deep.equal(['room-1']);
    expect(res.json.data.rooms[0].players[0].playerName).to.equal('Angel');
  });

  it('stores an uploaded image and serves it publicly at the URL it hands back', async () => {
    const bytes = png();
    const up = await call('/dev/api/skin-media', {
      method: 'POST',
      body: bytes,
      type: 'image/png',
      origin: base,
    });
    expect(up.status).to.equal(200);
    const url = up.json.data.url;
    expect(url).to.match(new RegExp(`^${base}/media/skins/[a-f0-9]{32}\\.png$`));

    // No secret: the app loads it like any image.
    const got = await call(url.slice(base.length), { secret: null, actor: null });
    expect(got.status).to.equal(200);
    expect(got.type).to.equal('image/png');
    expect(got.cache).to.include('immutable');
    expect(got.buf.equals(bytes)).to.equal(true);

    // The same bytes again → the same name (content-addressed).
    const again = await call('/dev/api/skin-media', {
      method: 'POST',
      body: bytes,
      type: 'image/png',
      origin: base,
    });
    expect(again.json.data.url).to.equal(url);
  });

  it('refuses what is not an image, and images over 8 MB', async () => {
    const pdf = await call('/dev/api/skin-media', {
      method: 'POST',
      body: Buffer.from('%PDF-1.7 not an image at all'),
      type: 'image/png',
    });
    expect(pdf.status).to.equal(422);
    const big = Buffer.concat([png(), Buffer.alloc(8 * 1024 * 1024)]);
    const tooBig = await call('/dev/api/skin-media', {
      method: 'POST',
      body: big,
      type: 'image/png',
    });
    expect(tooBig.status).to.equal(413);
    expect(
      (await call('/media/skins/' + 'a'.repeat(32) + '.png', { secret: null })).status
    ).to.equal(404);
  });

  it('sets a room override with the background slot and records the operator', async () => {
    const res = await call('/dev/api/skin-override', {
      method: 'POST',
      body: {
        action: 'set',
        scope: 'room',
        roomId: 'room-1',
        skins: {
          background_style: 'royalGold',
          background_skin: `${base}/media/skins/${'b'.repeat(32)}.png`,
        },
      },
    });
    expect(res.status).to.equal(200);
    const room = service.getRoom('room-1');
    expect(room.skinOverride.skins).to.deep.equal({
      background_style: 'royalGold',
      background_skin: `${base}/media/skins/${'b'.repeat(32)}.png`,
    });
    expect(room.skinOverride.setBy).to.equal('ops');

    const cleared = await call('/dev/api/skin-override', {
      method: 'POST',
      body: { action: 'clear', scope: 'room', roomId: 'room-1' },
    });
    expect(cleared.status).to.equal(200);
    expect(service.getRoom('room-1').skinOverride).to.equal(null);
  });

  it('a global override carries its duration', async () => {
    const res = await call('/dev/api/skin-override', {
      method: 'POST',
      body: {
        action: 'set',
        scope: 'global',
        durationMinutes: 90,
        skins: { table_theme: 'braziliaPlus' },
      },
    });
    expect(res.status).to.equal(200);
    const left = Date.parse(handler.globalSkinOverride.expiresAt) - Date.now();
    expect(left).to.be.within(89 * 60 * 1000, 90 * 60 * 1000 + 1000);
  });

  it("the in-memory Redis keeps a key whose TTL is past setTimeout's 24.8-day cap", async () => {
    const redis = new InMemoryRedis();
    await redis.setex('k', 90 * 24 * 3600, 'v');
    await redis.set('k2', 'v', 'PX', 30 * 24 * 3600 * 1000);
    await new Promise((r) => setTimeout(r, 20));
    expect(await redis.get('k')).to.equal('v');
    expect(await redis.get('k2')).to.equal('v');
    await redis.setex('short', 0.01, 'v');
    await new Promise((r) => setTimeout(r, 40));
    expect(await redis.get('short')).to.equal(null);
  });

  it('rejects bad input before touching the tables', async () => {
    const post = (body) => call('/dev/api/skin-override', { method: 'POST', body });
    expect((await post({ action: 'set', scope: 'global', skins: {} })).status).to.equal(422);
    expect(
      (await post({ action: 'set', scope: 'room', skins: { table_theme: 'wine' } })).status
    ).to.equal(422);
    const badToken = await post({
      action: 'set',
      scope: 'global',
      skins: { table_theme: 'wine<script>' },
    });
    expect(badToken.status).to.equal(422);
    expect(badToken.json.errors).to.have.property('table_theme');
    const badUrl = await post({
      action: 'set',
      scope: 'global',
      skins: { table_skin: 'javascript:alert(1)' },
    });
    expect(badUrl.status).to.equal(422);
    expect(
      (
        await post({
          action: 'set',
          scope: 'global',
          durationMinutes: 0,
          skins: { table_theme: 'wine' },
        })
      ).status
    ).to.equal(422);
    expect(
      (
        await post({
          action: 'set',
          scope: 'room',
          roomId: 'ghost',
          skins: { table_theme: 'wine' },
        })
      ).status
    ).to.equal(422);
    expect(handler.globalSkinOverride).to.equal(null);
    expect(service.getRoom('room-1').skinOverride || null).to.equal(null);
  });
});
