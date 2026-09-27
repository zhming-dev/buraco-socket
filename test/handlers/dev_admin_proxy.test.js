/**
 * Dev console → WLive admin API proxy (/dev/api/admin/* → wlive-api
 * /api/buraco/admin/*): dev auth (fail closed), 501 when unconfigured, the
 * admin headers it adds (and the ones it never forwards), multipart and JSON
 * passthrough, status passthrough, timeout / unreachable, the path allowlist,
 * the actor rule, the body cap, and that the upstream secret never comes back
 * out (responses, errors, logs).
 *
 * Everything runs against a fake upstream http server on localhost.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const http = require('http');
const crypto = require('crypto');
const { createDevAdminProxy, sanitizeActor, matchRoute } = require('../../src/dev/adminProxy');

const DEV_SECRET = 'dev-console-secret';
const UPSTREAM_SECRET = 'UPSTREAM-admin-secret-7f3a9c';

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  );
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** A fake wlive-api: records every request, answers with `reply(req, body)`. */
function fakeUpstream() {
  const seen = [];
  let reply = (req, body, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data: { ok: true }, message: null }));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      reply(req, body, res);
    });
  });
  return {
    server,
    seen,
    setReply(fn) {
      reply = fn;
    },
  };
}

/**
 * Raw request (no URL normalisation, unlike fetch). The proxy may answer an
 * upload early (413) and, since this client asks for `Connection: close`, the
 * server then closes the socket: the client stops writing once it has an
 * answer, and a write error after the answer is not a failure.
 */
function rawRequest(
  port,
  {
    method = 'GET',
    path,
    headers = {},
    body = null,
    chunks = null,
    gapMs = 0,
    hangAfter = false,
    headersOnly = false,
  }
) {
  if (
    body != null &&
    headers['content-length'] === undefined &&
    headers['transfer-encoding'] === undefined
  ) {
    headers = { ...headers, 'content-length': String(Buffer.byteLength(body)) };
  }
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        answered = true;
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', (err) => {
      if (answered) return;
      if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
        setTimeout(() => {
          if (!answered) reject(err);
        }, 500);
        return;
      }
      reject(err);
    });
    if (headersOnly) {
      req.flushHeaders(); // declare a body, never send it
      return;
    }
    if (chunks) {
      (async () => {
        for (const c of chunks) {
          if (answered) return; // answered mid-upload: stop sending
          req.write(c);
          await new Promise((r) => (gapMs ? setTimeout(r, gapMs) : setImmediate(r)));
        }
        if (!hangAfter && !answered) req.end(); // hangAfter: the client stalls mid-upload
      })();
    } else {
      req.end(body || undefined);
    }
  });
}

describe('dev console admin proxy (/dev/api/admin → wlive-api /api/buraco/admin)', () => {
  let upstream;
  let upstreamPort;
  let proxyServer;
  let proxyPort;
  let logs;
  let proxyOptions;

  const logger = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    debug: (...args) => logs.push(['debug', ...args]),
  };

  async function startProxy(overrides = {}) {
    if (proxyServer) await close(proxyServer);
    proxyOptions = {
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      secret: UPSTREAM_SECRET,
      devSecret: DEV_SECRET,
      timeoutMs: 400,
      logger,
      ...overrides,
    };
    const proxy = createDevAdminProxy(proxyOptions);
    proxyServer = http.createServer((req, res) => proxy.handle(req, res));
    proxyPort = await listen(proxyServer);
    return proxy;
  }

  function call(path, opts = {}) {
    const headers = {
      'x-webhook-secret': DEV_SECRET,
      'x-admin-actor': 'Nizwar',
      ...(opts.headers || {}),
    };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    return rawRequest(proxyPort, { ...opts, path, headers });
  }

  beforeEach(async () => {
    logs = [];
    upstream = fakeUpstream();
    upstreamPort = await listen(upstream.server);
    await startProxy();
  });

  afterEach(async () => {
    await close(proxyServer);
    proxyServer = null;
    await close(upstream.server);
  });

  describe('auth (the dev console rule: header secret, fail closed)', () => {
    it('refuses everything when the dev console secret is unset', async () => {
      await startProxy({ devSecret: null });
      const r = await call('/dev/api/admin/rooms');
      expect(r.status).to.equal(401);
      expect(r.json.error.message).to.match(/set WEBHOOK_SECRET/);
      expect(upstream.seen).to.have.length(0);
    });

    it('refuses a wrong or missing header, and the ?secret= query form', async () => {
      for (const headers of [{ 'x-webhook-secret': 'nope' }, { 'x-webhook-secret': undefined }]) {
        const r = await call('/dev/api/admin/rooms', { headers });
        expect(r.status).to.equal(401);
      }
      const q = await call(`/dev/api/admin/rooms?secret=${DEV_SECRET}`, {
        headers: { 'x-webhook-secret': undefined },
      });
      expect(q.status).to.equal(401);
      expect(upstream.seen).to.have.length(0);
    });

    it('lets the right header through', async () => {
      const r = await call('/dev/api/admin/rooms');
      expect(r.status).to.equal(200);
      expect(upstream.seen).to.have.length(1);
    });
  });

  describe('unconfigured → 501', () => {
    it('names the missing base URL', async () => {
      await startProxy({ baseUrl: null });
      const r = await call('/dev/api/admin/rooms');
      expect(r.status).to.equal(501);
      expect(r.json.success).to.equal(false);
      expect(r.json.error.code).to.equal('ADMIN_PROXY_NOT_CONFIGURED');
      expect(r.json.error.message).to.include('WLIVE_ADMIN_API_BASE');
    });

    it('names the missing secret, and refuses a base that is not http(s)', async () => {
      await startProxy({ secret: '' });
      const r = await call('/dev/api/admin/skins');
      expect(r.status).to.equal(501);
      expect(r.json.error.message).to.include('WLIVE_ADMIN_SECRET');

      await startProxy({ baseUrl: 'ftp://files.example.com' });
      const r2 = await call('/dev/api/admin/skins');
      expect(r2.status).to.equal(501);
      expect(r2.json.error.message).to.match(/not a valid http\(s\) base URL/);
      expect(upstream.seen).to.have.length(0);
    });

    it('reports it on _health without calling anything', async () => {
      await startProxy({ baseUrl: null });
      const r = await call('/dev/api/admin/_health');
      expect(r.status).to.equal(200);
      expect(r.json.data).to.include({ configured: false, reachable: false });
      expect(r.json.data.message).to.include('WLIVE_ADMIN_API_BASE');
    });
  });

  describe('what goes upstream', () => {
    it('adds the admin secret + the sanitized actor, keeps the query, drops the console credentials', async () => {
      const r = await call('/dev/api/admin/collusion-flags?status=all&limit=50', {
        headers: {
          'x-admin-actor': '  Niz<script>war\t R. ',
          cookie: 'session=abc',
          authorization: 'Bearer user-token',
        },
      });
      expect(r.status).to.equal(200);
      const got = upstream.seen[0];
      expect(got.method).to.equal('GET');
      expect(got.url).to.equal('/api/buraco/admin/collusion-flags?status=all&limit=50');
      expect(got.headers['x-buraco-admin-secret']).to.equal(UPSTREAM_SECRET);
      expect(got.headers['x-admin-actor']).to.equal('Nizscriptwar R. (dev console)');
      expect(got.headers.accept).to.equal('application/json');
      expect(got.headers).to.not.have.property('x-webhook-secret');
      expect(got.headers).to.not.have.property('cookie');
      expect(got.headers).to.not.have.property('authorization');
      expect(r.headers['x-request-id']).to.be.a('string');
    });

    it('keeps a base URL path prefix', async () => {
      await startProxy({ baseUrl: `http://127.0.0.1:${upstreamPort}/wlive/` });
      await call('/dev/api/admin/leaderboard?period=monthly');
      expect(upstream.seen[0].url).to.equal('/wlive/api/buraco/admin/leaderboard?period=monthly');
    });

    it('streams a multipart upload through byte for byte', async () => {
      const file = crypto.randomBytes(64 * 1024);
      file[10] = 0; // binary, not text
      const form = new FormData();
      form.append('name', 'Night felt');
      form.append('table_background', new Blob([file], { type: 'image/png' }), 'felt.png');
      const request = new Request('http://x/', { method: 'POST', body: form });
      const bodyBytes = Buffer.from(await request.arrayBuffer());
      const contentType = request.headers.get('content-type');

      upstream.setReply((req, body, res) => {
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            success: true,
            data: { id: 7, name: 'Night felt' },
            message: 'Skin created',
          })
        );
      });
      const r = await call('/dev/api/admin/skins', {
        method: 'POST',
        headers: { 'content-type': contentType, 'content-length': String(bodyBytes.length) },
        body: bodyBytes,
      });
      expect(r.status).to.equal(201);
      expect(r.json).to.deep.equal({
        success: true,
        data: { id: 7, name: 'Night felt' },
        message: 'Skin created',
      });
      const got = upstream.seen[0];
      expect(got.method).to.equal('POST');
      expect(got.url).to.equal('/api/buraco/admin/skins');
      expect(got.headers['content-type']).to.equal(contentType);
      expect(got.headers['content-length']).to.equal(String(bodyBytes.length));
      expect(Buffer.compare(got.body, bodyBytes)).to.equal(0);
      expect(got.body.includes(file)).to.equal(true);
    });

    it('streams a chunked body too', async () => {
      const r = await call('/dev/api/admin/sticker-packs/3/assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        chunks: [Buffer.from('{"type":"emoji",'), Buffer.from('"glyph":"🎉"}')],
      });
      expect(r.status).to.equal(200);
      expect(JSON.parse(upstream.seen[0].body.toString('utf8'))).to.deep.equal({
        type: 'emoji',
        glyph: '🎉',
      });
    });

    it('forwards JSON bodies on PUT and DELETE', async () => {
      await call('/dev/api/admin/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bet_min: 100 }),
      });
      await call('/dev/api/admin/skin-override', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'room', room_id: 'r1' }),
      });
      expect(
        upstream.seen.map((s) => [s.method, s.url, JSON.parse(s.body.toString('utf8'))])
      ).to.deep.equal([
        ['PUT', '/api/buraco/admin/settings', { bet_min: 100 }],
        ['DELETE', '/api/buraco/admin/skin-override', { scope: 'room', room_id: 'r1' }],
      ]);
    });
  });

  describe('what comes back', () => {
    it('passes status codes and JSON through verbatim (a 422 validation envelope)', async () => {
      const envelope = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The given data was invalid.',
          details: { bet_min: ['must be at least 1'] },
        },
      };
      upstream.setReply((req, body, res) => {
        res.statusCode = 422;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(envelope));
      });
      const r = await call('/dev/api/admin/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bet_min: -1 }),
      });
      expect(r.status).to.equal(422);
      expect(r.json).to.deep.equal(envelope);
    });

    it('passes a 204 through with no body', async () => {
      upstream.setReply((req, body, res) => {
        res.statusCode = 204;
        res.end();
      });
      const r = await call('/dev/api/admin/skins/4', { method: 'DELETE' });
      expect(r.status).to.equal(204);
      expect(r.text).to.equal('');
    });

    it('turns a non-JSON answer (HTML error page) into a JSON error with the same status', async () => {
      upstream.setReply((req, body, res) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html');
        res.end(`<html><body>Whoops ${req.headers['x-buraco-admin-secret']}</body></html>`);
      });
      const r = await call('/dev/api/admin/rooms');
      expect(r.status).to.equal(500);
      expect(r.json.success).to.equal(false);
      expect(r.json.error.code).to.equal('UPSTREAM_NOT_JSON');
      expect(r.text).to.not.include('<html');
      expect(r.text).to.not.include(UPSTREAM_SECRET);
    });

    it('never follows a redirect', async () => {
      upstream.setReply((req, body, res) => {
        res.statusCode = 302;
        res.setHeader('Location', 'http://evil.example.com/');
        res.end();
      });
      const r = await call('/dev/api/admin/rooms');
      expect(r.status).to.equal(502);
      expect(r.json.error.code).to.equal('UPSTREAM_NOT_JSON');
      expect(upstream.seen).to.have.length(1);
    });

    it('redacts the upstream secret from anything that comes back', async () => {
      upstream.setReply((req, body, res) => {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: 'debug', headers: req.headers }));
      });
      const r = await call('/dev/api/admin/rooms');
      expect(r.status).to.equal(400);
      expect(r.text).to.not.include(UPSTREAM_SECRET);
      expect(r.json.headers['x-buraco-admin-secret']).to.equal('[redacted]');
    });
  });

  describe('failures', () => {
    it('times out with a 504', async () => {
      upstream.setReply(() => {
        /* never answers */
      });
      const t0 = Date.now();
      const r = await call('/dev/api/admin/rooms');
      expect(r.status).to.equal(504);
      expect(r.json.error.code).to.equal('UPSTREAM_TIMEOUT');
      expect(Date.now() - t0).to.be.within(350, 3000);
    });

    it('lets a slow but moving upload through (the timer idles on each chunk)', async () => {
      await startProxy({ timeoutMs: 300 });
      const t0 = Date.now();
      const r = await call('/dev/api/admin/skins', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
        chunks: [1, 2, 3, 4, 5].map(() => Buffer.alloc(100, 7)),
        gapMs: 150,
      });
      expect(Date.now() - t0).to.be.greaterThan(600);
      expect(r.status).to.equal(200);
      expect(upstream.seen[0].body.length).to.equal(500);
    });

    it('gives up on a stalled upload with a 504', async () => {
      await startProxy({ timeoutMs: 300 });
      const r = await call('/dev/api/admin/skins', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
        chunks: [Buffer.alloc(100, 7)],
        hangAfter: true,
      });
      expect(r.status).to.equal(504);
      expect(r.json.error.code).to.equal('UPLOAD_STALLED');
    });

    it('answers 502 when wlive-api is unreachable', async () => {
      const dead = http.createServer();
      const deadPort = await listen(dead);
      await close(dead);
      await startProxy({ baseUrl: `http://127.0.0.1:${deadPort}` });
      const r = await call('/dev/api/admin/rooms');
      expect(r.status).to.equal(502);
      expect(r.json.error.code).to.equal('UPSTREAM_UNREACHABLE');
    });

    it('_health reports reachable, a refused secret, and a dead upstream', async () => {
      let r = await call('/dev/api/admin/_health');
      expect(r.json.data).to.include({ configured: true, reachable: true, status: 200 });
      expect(upstream.seen[0].url).to.equal('/api/buraco/admin/skin-tokens');

      upstream.setReply((req, body, res) => {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: 'INVALID_ADMIN_PROXY_SECRET' }));
      });
      r = await call('/dev/api/admin/_health');
      expect(r.json.data).to.include({ configured: true, reachable: false, status: 401 });
      expect(r.json.data.message).to.include('BURACO_ADMIN_PROXY_SECRET');
      expect(r.text).to.not.include(UPSTREAM_SECRET);
    });
  });

  describe('allowlist', () => {
    it('proxies only the admin paths the console uses', async () => {
      const refused = [
        ['GET', '/dev/api/admin/users'],
        ['GET', '/dev/api/admin/skins/abc'],
        ['GET', '/dev/api/admin/../admin/rooms'],
        ['GET', '/dev/api/admin/%2e%2e/%2e%2e/api/user'],
        ['GET', '/dev/api/admin/skins%2F1'],
        ['GET', '/dev/api/admin//rooms'],
        ['GET', '/dev/api/admin/rooms/'],
        ['GET', '/dev/api/admin/ROOMS'],
        ['GET', '/dev/api/admin/webhooks/game-result'],
        ['GET', '/dev/api/admin'],
      ];
      for (const [method, path] of refused) {
        const r = await call(path, { method });
        expect(r.status, path).to.equal(404);
      }
      expect(upstream.seen).to.have.length(0);
    });

    it('answers 405 with Allow for a known path and the wrong method', async () => {
      const r = await call('/dev/api/admin/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(r.status).to.equal(405);
      expect(r.headers.allow).to.equal('GET');
      const r2 = await call('/dev/api/admin/settings', { method: 'PATCH' });
      expect(r2.status).to.equal(405);
      expect(r2.headers.allow).to.equal('GET, PUT');
      expect(upstream.seen).to.have.length(0);
    });

    it('knows every route the console pages call', () => {
      const used = [
        ['GET', 'rooms'],
        ['GET', 'skin-override'],
        ['POST', 'skin-override'],
        ['DELETE', 'skin-override'],
        ['GET', 'skin-tokens'],
        ['GET', 'skins'],
        ['POST', 'skins'],
        ['POST', 'skins/12'],
        ['DELETE', 'skins/12'],
        ['GET', 'sticker-packs'],
        ['POST', 'sticker-packs'],
        ['POST', 'sticker-packs/2'],
        ['DELETE', 'sticker-packs/2'],
        ['POST', 'sticker-packs/2/assets'],
        ['POST', 'sticker-packs/2/assets/9'],
        ['DELETE', 'sticker-packs/2/assets/9'],
        ['GET', 'collusion-flags'],
        ['GET', 'collusion-flags/5'],
        ['POST', 'collusion-flags/5/review'],
        ['GET', 'users/1234/opponents'],
        ['GET', 'leaderboard'],
        ['GET', 'settings'],
        ['PUT', 'settings'],
      ];
      for (const [m, p] of used) expect(matchRoute(m, p).ok, `${m} ${p}`).to.equal(true);
    });
  });

  describe('writes', () => {
    it('need an operator name (the actor)', async () => {
      // (a header can only carry latin-1; anything outside printable ASCII is dropped)
      for (const actor of [undefined, '', '   ', 'ÿéé']) {
        const r = await call('/dev/api/admin/collusion-flags/5/review', {
          method: 'POST',
          headers: { 'x-admin-actor': actor, 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'dismissed' }),
        });
        expect(r.status, String(actor)).to.equal(400);
        expect(r.json.error.code).to.equal('ACTOR_REQUIRED');
      }
      expect(upstream.seen).to.have.length(0);
      // reads do not
      const g = await call('/dev/api/admin/collusion-flags', {
        headers: { 'x-admin-actor': undefined },
      });
      expect(g.status).to.equal(200);
      expect(upstream.seen[0].headers['x-admin-actor']).to.equal('dev-console');
    });

    it('refuse a body over the cap (declared or streamed)', async () => {
      await startProxy({ maxBodyBytes: 2048 });
      // declared: refused on the header alone, before a byte of the body is read
      const r = await call('/dev/api/admin/skins', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': '5000' },
        headersOnly: true,
      });
      expect(r.status).to.equal(413);
      expect(r.json.error.code).to.equal('PAYLOAD_TOO_LARGE');

      const r2 = await call('/dev/api/admin/skins', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
        chunks: [Buffer.alloc(1500, 1), Buffer.alloc(1500, 1), Buffer.alloc(1500, 1)],
        gapMs: 60,
      });
      expect(r2.status).to.equal(413);
      expect(r2.json.error.code).to.equal('PAYLOAD_TOO_LARGE');
    });
  });

  it('never logs the upstream secret', async () => {
    upstream.setReply((req, body, res) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: `boom ${UPSTREAM_SECRET}` }));
    });
    await call('/dev/api/admin/skin-override', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', skins: { table_theme: 'pine' } }),
    });
    upstream.setReply(() => {});
    await call('/dev/api/admin/rooms');
    await call('/dev/api/admin/_health');
    expect(logs.length).to.be.greaterThan(0);
    expect(JSON.stringify(logs)).to.not.include(UPSTREAM_SECRET);
    expect(JSON.stringify(logs)).to.not.include(DEV_SECRET);
  });

  it('sanitizes the actor to printable ASCII', () => {
    expect(sanitizeActor('Nizwar')).to.equal('Nizwar');
    expect(sanitizeActor(' a\tb\r\nc ')).to.equal('a b c');
    expect(sanitizeActor('ops@wblue.id')).to.equal('ops@wblue.id');
    expect(sanitizeActor('x'.repeat(100))).to.have.length(48);
    expect(sanitizeActor('نزار')).to.equal('');
    expect(sanitizeActor(null)).to.equal('');
    expect(sanitizeActor({ toString: () => 'x' })).to.equal('');
  });
});
