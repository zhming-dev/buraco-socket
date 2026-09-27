/**
 * Dev console HTTP helpers that are testable without booting the server
 * (src/index.js starts listening on require): the /dev/api auth rule, the
 * per-room log responses and the match replay endpoints.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const ReplayEngine = require('../observability/ReplayEngine');

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * /dev/api auth. FAIL CLOSED: no configured secret means nobody is let in
 * (the endpoints hand out every player's cards). Header only — the old
 * `?secret=` query form leaked the secret into access logs and history.
 * Constant-time compare.
 * @param {import('http').IncomingMessage} req
 * @param {string|null|undefined} secret
 * @returns {boolean}
 */
function isDevAuthorized(req, secret) {
  if (!secret) return false;
  const header = req && req.headers ? req.headers['x-webhook-secret'] : undefined;
  if (typeof header !== 'string' || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(String(secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * GET /dev/api/rooms/<roomId>/logs[.txt] (after GameLogStore.ensureLoaded).
 * @param {object} deps
 * @param {import('../observability/GameLogStore')} deps.store
 * @param {(roomId: string, opts: object) => object} deps.getRoomLogs
 */
function sendRoomLogs(req, res, roomId, asText, { store, getRoomLogs }) {
  const query = new URL(req.url, 'http://localhost').searchParams;
  const opts = {
    since: query.get('since'),
    level: query.get('level'),
    q: query.get('q'),
    limit: query.get('limit'),
    tail: ['1', 'true'].includes(query.get('tail')),
    narrative: ['1', 'true'].includes(query.get('narrative')),
    excludeGame: ['1', 'true'].includes(query.get('excludeGame')),
  };
  if (asText) {
    const text = store.renderText(roomId, { level: opts.level, q: opts.q });
    if (text === null) {
      sendJson(res, 404, { success: false, error: 'No logs for room' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="game-${String(roomId).replace(/[^A-Za-z0-9._-]/g, '_')}.log"`
    );
    res.end(text);
    return;
  }
  const result = getRoomLogs(roomId, opts);
  sendJson(res, result.success ? 200 : 404, result);
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(String((req.headers && req.headers['accept-encoding']) || ''));
}

/**
 * The /dev/api/matches family. See the route comment in src/index.js.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} deps
 * @param {import('../observability/GameEventRecorder')} deps.recorder
 * @param {(roomId: string) => {live: boolean, roomStatus: string|null}} [deps.liveness]
 */
async function handleDevMatches(req, res, { recorder, liveness }) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // dev api matches <id> [state]
  const query = url.searchParams;

  if (parts.length === 3) {
    const listing = await recorder.list({
      roomId: query.get('roomId'),
      status: query.get('status'),
      limit: query.get('limit'),
      offset: query.get('offset'),
    });
    const matches = listing.matches.map((row) => ({
      ...row,
      room: liveness ? liveness(row.roomId) : undefined,
    }));
    sendJson(res, 200, { success: true, ...listing, matches, stats: recorder.stats() });
    return;
  }

  const matchId = decodeURIComponent(parts[3] || '');
  const sub = parts[4] || null;

  if (!sub) {
    const since = query.get('since');
    // Whole finished match straight off the disk, still compressed.
    if (since == null && acceptsGzip(req)) {
      const gz = await recorder.readCompressed(matchId);
      if (gz) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        if (query.get('download')) {
          res.setHeader('Content-Disposition', `attachment; filename="${matchId}.json"`);
        }
        res.end(gz);
        return;
      }
    }
    const stream = await recorder.load(matchId);
    if (!stream) {
      sendJson(res, 404, { success: false, error: 'No such match' });
      return;
    }
    let events = stream.events;
    if (since != null && Number.isFinite(Number(since))) {
      const from = ReplayEngine.indexAt(events, Number(since)) + 1;
      events = events.slice(Math.max(0, from));
    }
    const body = JSON.stringify({
      success: true,
      v: stream.v,
      live: stream.live === true,
      header: stream.header,
      rounds: ReplayEngine.roundsOf(stream),
      events,
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    if (query.get('download')) {
      res.setHeader('Content-Disposition', `attachment; filename="${matchId}.json"`);
    }
    if (acceptsGzip(req) && body.length > 8192) {
      const gz = await new Promise((resolve, reject) =>
        zlib.gzip(body, (err, buf) => (err ? reject(err) : resolve(buf)))
      );
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.end(gz);
      return;
    }
    res.end(body);
    return;
  }

  if (sub === 'state') {
    const stream = await recorder.load(matchId);
    if (!stream) {
      sendJson(res, 404, { success: false, error: 'No such match' });
      return;
    }
    const at = query.get('at');
    const table = ReplayEngine.tableAt(stream, at === null || at === '' ? undefined : Number(at));
    sendJson(res, 200, { ...table, live: stream.live === true });
    return;
  }

  sendJson(res, 404, { success: false, error: 'Not Found' });
}

module.exports = { isDevAuthorized, sendRoomLogs, handleDevMatches, sendJson };
