/**
 * Skin overrides straight from the dev console — no wlive-api in the loop.
 *
 * An override only ever lives on this socket (a room's dies with its game, the
 * global one sits in Redis until its deadline), so the console talks to the
 * socket directly:
 *
 *   GET    /dev/api/skin-override      every room here + the global override
 *   POST   /dev/api/skin-override      { action: 'set'|'clear', scope: 'room'|'global',
 *                                        roomId?, skins?, durationMinutes? }
 *   POST   /dev/api/skin-media         raw image body (PNG/JPEG/WebP) → { url }
 *   GET    /media/skins/<id>.<ext>     the stored image, PUBLIC: the app loads it
 *
 * /dev/api/* use the console's auth (`x-webhook-secret`, fails closed); writes
 * also need the operator's name (`x-admin-actor`), recorded as `setBy`.
 *
 * Uploaded images are kept in Redis (production refuses to boot without a real
 * one), content-addressed, so every node can serve them and a restart keeps
 * them. They expire MEDIA_TTL_SECONDS after the last override that used them.
 */

const crypto = require('crypto');
const { isDevAuthorized } = require('./devApi');
const { sanitizeActor } = require('./adminProxy');

const MEDIA_PREFIX = '/media/skins/';
const MEDIA_KEY = (id) => `skins:media:${id}`;
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const MEDIA_TTL_SECONDS = 90 * 24 * 3600;
const MEDIA_CACHE_MAX = 24;
const JSON_MAX_BYTES = 64 * 1024;
const MAX_DURATION_MINUTES = 43200; // 30 days
const IMAGE_KEYS = ['table_skin', 'card_skin', 'background_skin'];
const TOKEN_KEYS = ['table_theme', 'card_back_style', 'card_face_style', 'background_style'];
const TOKEN_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const MEDIA_ID_RE = /^([a-f0-9]{32})\.(png|jpg|webp)$/;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** The image type from its first bytes (never the client's word), or null. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** Reads a request body up to `max` bytes; rejects with `.status` 413 beyond it. */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        const err = new Error('payload too large');
        err.status = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
  });
}

/**
 * Where the app can reach this server. PUBLIC_URL wins; else the console
 * page's own origin (the browser sends `Origin` on these POSTs) when it names
 * this host; else the forwarded proto + host.
 */
function publicOrigin(req, configured) {
  if (configured) return String(configured).replace(/\/+$/, '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      const u = new URL(origin);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.host === host) return u.origin;
    } catch {
      // fall through
    }
  }
  const proto = String(
    req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http')
  )
    .split(',')[0]
    .trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

/**
 * @param {object} deps
 * @param {object} deps.redis            ioredis client (or the in-memory fallback)
 * @param {object} deps.socketHandlers   owns the override state
 * @param {() => (string|null)} deps.devSecret
 * @param {string|null} [deps.publicUrl] PUBLIC_URL
 * @param {object} [deps.logger]
 */
function createSkinOverrideApi({
  redis,
  socketHandlers,
  devSecret,
  publicUrl = null,
  logger = null,
}) {
  const cache = new Map(); // id → { buf, type }, newest last

  function remember(id, entry) {
    cache.delete(id);
    cache.set(id, entry);
    while (cache.size > MEDIA_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function storeMedia(buf) {
    const ext = sniffImage(buf);
    if (!ext) return null;
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
    await redis.setex(MEDIA_KEY(id), MEDIA_TTL_SECONDS, buf.toString('base64'));
    remember(id, { buf, type: TYPES[ext] });
    return `${id}.${ext}`;
  }

  async function loadMedia(id, ext) {
    const hit = cache.get(id);
    if (hit) {
      remember(id, hit);
      return hit;
    }
    const b64 = await redis.get(MEDIA_KEY(id));
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    if (sniffImage(buf) !== ext) return null;
    const entry = { buf, type: TYPES[ext] };
    remember(id, entry);
    return entry;
  }

  /** Our own media referenced by an override live as long as it does (+TTL). */
  async function touchMedia(skins) {
    for (const key of IMAGE_KEYS) {
      const url = skins[key];
      const m =
        typeof url === 'string'
          ? url.match(/\/media\/skins\/([a-f0-9]{32})\.(?:png|jpg|webp)$/)
          : null;
      if (m) {
        try {
          await redis.pexpire(MEDIA_KEY(m[1]), MEDIA_TTL_SECONDS * 1000);
        } catch {
          // best effort: a lapsed image keeps whatever the app shows
        }
      }
    }
  }

  /** Validates a console `skins` map: known token shapes, http(s) images. */
  function cleanSkins(input) {
    const out = {};
    const errors = {};
    if (!input || typeof input !== 'object') return { out, errors };
    for (const key of TOKEN_KEYS) {
      const v = input[key];
      if (v == null || v === '') continue;
      if (typeof v !== 'string' || !TOKEN_RE.test(v)) errors[key] = ['Not a known look.'];
      else out[key] = v;
    }
    for (const key of IMAGE_KEYS) {
      const v = input[key];
      if (v == null || v === '') continue;
      let ok = false;
      try {
        const u = new URL(String(v));
        ok = (u.protocol === 'https:' || u.protocol === 'http:') && String(v).length <= 1024;
      } catch {
        ok = false;
      }
      if (ok) out[key] = String(v);
      else errors[key] = ['Not an image address this server can hand out.'];
    }
    return { out, errors };
  }

  function actorOf(req) {
    return sanitizeActor(req.headers['x-admin-actor']);
  }

  async function handle(req, res) {
    const url = req.url.split('?')[0];

    // Public: the app (and the console's preview) load the stored images.
    if (url.startsWith(MEDIA_PREFIX)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
        return;
      }
      const m = url.slice(MEDIA_PREFIX.length).match(MEDIA_ID_RE);
      const entry = m ? await loadMedia(m[1], m[2]) : null;
      if (!entry) {
        sendJson(res, 404, { success: false, error: 'Not Found' });
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', entry.type);
      res.setHeader('Content-Length', String(entry.buf.length));
      // Content-addressed: the bytes behind a name never change.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(req.method === 'HEAD' ? undefined : entry.buf);
      return;
    }

    if (!isDevAuthorized(req, devSecret())) {
      sendJson(res, 401, { success: false, error: 'Unauthorized' });
      return;
    }

    if (url === '/dev/api/skin-override' && req.method === 'GET') {
      const list = socketHandlers.listRoomsForAdmin();
      sendJson(res, 200, {
        success: true,
        data: { rooms: list.rooms, global: list.global || null },
      });
      return;
    }

    const actor = actorOf(req);
    if (!actor) {
      sendJson(res, 400, {
        success: false,
        code: 'ACTOR_REQUIRED',
        message: 'Say who is acting (operator name) before changing anything.',
      });
      return;
    }

    if (url === '/dev/api/skin-media' && req.method === 'POST') {
      const buf = await readBody(req, MEDIA_MAX_BYTES);
      const id = await storeMedia(buf);
      if (!id) {
        sendJson(res, 422, {
          success: false,
          message: 'That is not a PNG, JPEG or WebP image.',
          errors: { file: ['Use a PNG, JPEG or WebP image.'] },
        });
        return;
      }
      const mediaUrl = `${publicOrigin(req, publicUrl)}${MEDIA_PREFIX}${id}`;
      logger?.info?.('[DEV] skin media stored', { id, bytes: buf.length, actor });
      sendJson(res, 200, { success: true, data: { url: mediaUrl } });
      return;
    }

    if (url === '/dev/api/skin-override' && req.method === 'POST') {
      let data;
      try {
        data = JSON.parse((await readBody(req, JSON_MAX_BYTES)).toString('utf8') || '{}');
      } catch (e) {
        if (e.status === 413) throw e;
        sendJson(res, 400, { success: false, message: 'Malformed JSON' });
        return;
      }
      const scope = data.scope === 'global' ? 'global' : data.scope === 'room' ? 'room' : null;
      if (!scope) {
        sendJson(res, 422, {
          success: false,
          message: 'Pick one table or every table.',
          errors: { scope: ['Required.'] },
        });
        return;
      }
      const roomId = typeof data.roomId === 'string' ? data.roomId.trim() : '';
      if (scope === 'room' && !roomId) {
        sendJson(res, 422, {
          success: false,
          message: 'Pick a table.',
          errors: { room_id: ['Pick a table.'] },
        });
        return;
      }

      if (data.action === 'clear') {
        const result = await socketHandlers.clearSkinOverride({ scope, roomId });
        logger?.info?.('[DEV] skin override cleared', {
          scope,
          roomId: roomId || null,
          actor,
          success: result.success,
        });
        sendJson(
          res,
          result.success ? 200 : 422,
          result.success
            ? { success: true, data: result }
            : { success: false, message: result.error || 'Not cleared' }
        );
        return;
      }

      const { out: skins, errors } = cleanSkins(data.skins);
      if (Object.keys(errors).length) {
        sendJson(res, 422, { success: false, message: 'Check the highlighted looks.', errors });
        return;
      }
      if (!Object.keys(skins).length) {
        sendJson(res, 422, {
          success: false,
          message: 'Change at least one thing.',
          errors: { skins: ['Nothing to apply.'] },
        });
        return;
      }
      const payload = { scope, skins, setBy: actor };
      if (scope === 'room') payload.roomId = roomId;
      const mins = Number(data.durationMinutes);
      if (scope === 'global' && data.durationMinutes != null && data.durationMinutes !== '') {
        if (!Number.isInteger(mins) || mins < 1 || mins > MAX_DURATION_MINUTES) {
          sendJson(res, 422, {
            success: false,
            message: 'Duration is 1 minute to 30 days.',
            errors: { duration_minutes: ['1 to 43200 minutes.'] },
          });
          return;
        }
        payload.durationMs = mins * 60 * 1000;
      }
      const result = await socketHandlers.setSkinOverride(payload);
      if (result.success) await touchMedia(skins);
      logger?.info?.('[DEV] skin override set', {
        scope,
        roomId: roomId || null,
        skins,
        actor,
        success: result.success,
      });
      sendJson(
        res,
        result.success ? 200 : 422,
        result.success
          ? { success: true, data: result }
          : { success: false, message: result.error || 'Not applied' }
      );
      return;
    }

    sendJson(res, 404, { success: false, error: 'Not Found' });
  }

  return {
    /** Serves the request; never throws (errors become JSON). */
    async handle(req, res) {
      try {
        await handle(req, res);
      } catch (e) {
        if (e && e.status === 413) {
          sendJson(res, 413, {
            success: false,
            message: `Too large (max ${Math.round(MEDIA_MAX_BYTES / 1048576)} MB).`,
          });
          return;
        }
        logger?.error?.('[DEV] skin override api failed', { error: e?.message });
        if (!res.headersSent)
          sendJson(res, 500, { success: false, message: 'Internal Server Error' });
      }
    },
  };
}

/** Whether `url` belongs to this module. */
function isSkinOverrideApiPath(url) {
  const path = String(url || '').split('?')[0];
  return (
    path === '/dev/api/skin-override' ||
    path === '/dev/api/skin-media' ||
    path.startsWith(MEDIA_PREFIX)
  );
}

module.exports = {
  createSkinOverrideApi,
  isSkinOverrideApiPath,
  sniffImage,
  publicOrigin,
  MEDIA_MAX_BYTES,
};
