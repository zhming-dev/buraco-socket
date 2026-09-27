/**
 * Dev console → WLive admin API proxy: `/dev/api/admin/<path>` is forwarded to
 * `${WLIVE_ADMIN_API_BASE}/api/buraco/admin/<path>` (wlive-api, Laravel).
 *
 * The Buraco admin pages of the dev console (Overrides, Skins, Stickers,
 * Review, Settings) talk to wlive-api's `buraco.admin-proxy` surface. That
 * surface is never browser-facing: it wants the shared `x-buraco-admin-secret`
 * (wlive-api BURACO_ADMIN_PROXY_SECRET) and `x-admin-actor` (who is acting).
 * This socket holds that secret; the browser only ever holds the dev console's
 * own secret.
 *
 * Rules:
 * - Console auth is the dev console's: the `x-webhook-secret` header, fail
 *   closed when WEBHOOK_SECRET is unset (same rule as every /dev/api call).
 * - Only the admin paths the console uses are forwarded (method + path
 *   allowlist; ids are digits). The target host is fixed by config, so a
 *   request can never be pointed anywhere else.
 * - Request bodies are streamed through unparsed (multipart uploads for skin
 *   artwork and stickers keep their boundary), with a size cap.
 * - Only a curated header set goes upstream: never the console's secret,
 *   cookies or authorization. The actor name is sanitized to printable ASCII
 *   and required for every write.
 * - Status codes and JSON bodies come back as they are. A non-JSON answer (an
 *   HTML error page, a redirect) becomes a JSON error; the upstream secret is
 *   redacted from anything that comes back, and never logged.
 * - Timeout → 504, unreachable → 502, unconfigured → 501 with a clear message.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { isDevAuthorized } = require('./devApi');

const PREFIX = '/dev/api/admin';
const UPSTREAM_PREFIX = '/api/buraco/admin/';

/**
 * The admin endpoints the console uses (wlive-api routes/buraco.php, admin
 * group), as [method, sub-path pattern]. Sub-paths are matched RAW (not
 * URL-decoded): only lowercase words, dashes, slashes and digit ids pass, so
 * `..`, `%2e`, `%2f` or a doubled slash can never reach the upstream.
 */
const ROUTES = [
  // Live tables + skin overrides (the socket owns the override state)
  ['GET', /^rooms$/],
  ['GET', /^skin-override$/],
  ['POST', /^skin-override$/],
  ['DELETE', /^skin-override$/],
  ['GET', /^skin-tokens$/],
  // Skin catalog (multipart writes)
  ['GET', /^skins$/],
  ['POST', /^skins$/],
  ['GET', /^skins\/\d{1,18}$/],
  ['POST', /^skins\/\d{1,18}$/],
  ['DELETE', /^skins\/\d{1,18}$/],
  // Chat sticker packs + their assets (multipart writes)
  ['GET', /^sticker-packs$/],
  ['POST', /^sticker-packs$/],
  ['POST', /^sticker-packs\/\d{1,18}$/],
  ['DELETE', /^sticker-packs\/\d{1,18}$/],
  ['POST', /^sticker-packs\/\d{1,18}\/assets$/],
  ['POST', /^sticker-packs\/\d{1,18}\/assets\/\d{1,18}$/],
  ['DELETE', /^sticker-packs\/\d{1,18}\/assets\/\d{1,18}$/],
  // Leaderboard anti-collusion review
  ['GET', /^collusion-flags$/],
  ['GET', /^collusion-flags\/\d{1,18}$/],
  ['POST', /^collusion-flags\/\d{1,18}\/review$/],
  ['GET', /^users\/\d{1,18}\/opponents$/],
  ['GET', /^leaderboard$/],
  // Buraco settings (bet limits, broadcast thresholds)
  ['GET', /^settings$/],
  ['PUT', /^settings$/],
];

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 40 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_LENGTH = 2048;
const ACTOR_MAX = 48;
const HEALTH_TIMEOUT_MS = 5000;

/**
 * The operator's name as it may travel in a header: printable ASCII letters,
 * digits and ` ._@+-`, whitespace collapsed, at most 48 characters.
 * @param {unknown} value
 * @returns {string} '' when nothing usable is left
 */
function sanitizeActor(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 ._@+-]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, ACTOR_MAX)
    .trim();
}

/**
 * Parses the configured base URL. Null for anything that is not a plain
 * http(s) URL (credentials inside the URL are refused too).
 * @param {string|null|undefined} raw
 */
function parseBase(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || null,
    basePath: url.pathname.replace(/\/+$/, ''),
    origin: url.origin,
  };
}

/**
 * Matches a sub-path (after `/dev/api/admin/`) against the allowlist.
 * @returns {{ok: true} | {ok: false, status: 404} | {ok: false, status: 405, allow: string[]}}
 */
function matchRoute(method, subPath) {
  const allow = [];
  for (const [m, pattern] of ROUTES) {
    if (pattern.test(subPath)) {
      if (m === method) return { ok: true };
      allow.push(m);
    }
  }
  if (allow.length) return { ok: false, status: 405, allow };
  return { ok: false, status: 404 };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, code, message, extraHeaders) {
  sendJson(res, statusCode, { success: false, error: { code, message } }, extraHeaders);
}

function requestIdOf(req) {
  const given = req.headers && req.headers['x-request-id'];
  if (typeof given === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(given)) return given;
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function proxyError(status, code, message) {
  const err = new Error(message);
  err.proxyStatus = status;
  err.proxyCode = code;
  return err;
}

/**
 * Builds the `/dev/api/admin/*` handler.
 *
 * @param {object} options
 * @param {string|null} [options.baseUrl]        WLIVE_ADMIN_API_BASE, e.g. https://api.example.com
 * @param {string|null} [options.secret]         WLIVE_ADMIN_SECRET (= wlive-api BURACO_ADMIN_PROXY_SECRET)
 * @param {number} [options.timeoutMs]           upstream timeout (default 30 s)
 * @param {number} [options.maxBodyBytes]        request body cap (default 40 MB)
 * @param {number} [options.maxResponseBytes]    upstream response cap (default 8 MB)
 * @param {string|null|(() => string|null)} options.devSecret  the dev console secret (WEBHOOK_SECRET)
 * @param {{info: Function, warn: Function, debug?: Function}} [options.logger]
 */
function createDevAdminProxy(options = {}) {
  const base = parseBase(options.baseUrl);
  const secret =
    typeof options.secret === 'string' && options.secret.trim() ? options.secret.trim() : null;
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const maxBodyBytes = Math.max(1024, Number(options.maxBodyBytes) || DEFAULT_MAX_BODY_BYTES);
  const maxResponseBytes = Math.max(
    1024,
    Number(options.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES
  );
  const devSecret =
    typeof options.devSecret === 'function' ? options.devSecret : () => options.devSecret;
  const logger = options.logger || require('../utils/logger');
  const configured = Boolean(base && secret);
  const maxUploadMb = Math.round((maxBodyBytes / 1048576) * 10) / 10;

  function unconfiguredMessage() {
    const missing = [];
    if (!base) {
      missing.push(
        options.baseUrl
          ? 'WLIVE_ADMIN_API_BASE (not a valid http(s) base URL)'
          : 'WLIVE_ADMIN_API_BASE'
      );
    }
    if (!secret) missing.push('WLIVE_ADMIN_SECRET');
    return (
      `The Buraco admin API is not configured on this socket server: set ${missing.join(' and ')} ` +
      '(the wlive-api base URL and its BURACO_ADMIN_PROXY_SECRET), then restart the socket.'
    );
  }

  /** Never let the upstream secret out, whatever the upstream echoes. */
  function redact(text) {
    const s = String(text == null ? '' : text);
    if (!secret || !s.includes(secret)) return s;
    return s.split(secret).join('[redacted]');
  }

  function log(level, message, data) {
    try {
      const fn = logger && typeof logger[level] === 'function' ? logger[level] : null;
      if (fn) fn.call(logger, redact(message), data);
    } catch {
      /* logging never breaks the proxy */
    }
  }

  /**
   * One upstream call.
   * @returns {{promise: Promise<{status:number, headers:object, body:Buffer}>, abort: () => void}}
   *   The promise rejects with an Error carrying `.proxyStatus` / `.proxyCode`.
   */
  function forward({ method, subPath, query, headers, body, limitMs }) {
    let upstream = null;
    let settle = null;
    let resolveRef = null;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      resolveRef = resolve;
      settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      const fail = (err) => settle(reject, err);

      const mod = base.protocol === 'https:' ? https : http;
      try {
        upstream = mod.request({
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port || undefined,
          method,
          path: `${base.basePath}${UPSTREAM_PREFIX}${subPath}${query ? `?${query}` : ''}`,
          headers,
          agent: false,
        });
      } catch (error) {
        fail(
          proxyError(
            502,
            'UPSTREAM_ERROR',
            `Could not build the wlive-api request (${error.code || 'invalid'})`
          )
        );
        return;
      }

      // Idle timer: while a body streams up it restarts on every chunk (a slow
      // but moving upload never times out); once the request is fully sent it
      // restarts once more and then bounds how long wlive-api takes to answer.
      const waitMs = limitMs || timeoutMs;
      let sending = true;
      const arm = () => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const secs = Math.round(waitMs / 100) / 10;
          const err = sending
            ? proxyError(504, 'UPLOAD_STALLED', `The upload stalled for ${secs}s`)
            : proxyError(504, 'UPSTREAM_TIMEOUT', `wlive-api did not answer within ${secs}s`);
          fail(err);
          upstream.destroy();
        }, waitMs);
      };
      arm();
      upstream.on('finish', () => {
        sending = false;
        arm();
      });

      upstream.on('error', (error) => {
        fail(
          proxyError(
            502,
            'UPSTREAM_UNREACHABLE',
            `wlive-api is unreachable (${(error && error.code) || 'connection failed'})`
          )
        );
      });

      upstream.on('response', (up) => {
        const chunks = [];
        let size = 0;
        up.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            fail(
              proxyError(502, 'UPSTREAM_TOO_LARGE', 'wlive-api sent an unexpectedly large response')
            );
            up.destroy();
            upstream.destroy();
            return;
          }
          chunks.push(chunk);
        });
        up.on('end', () =>
          settle(resolve, {
            status: up.statusCode || 502,
            headers: up.headers,
            body: Buffer.concat(chunks),
          })
        );
        up.on('error', () =>
          fail(proxyError(502, 'UPSTREAM_BROKEN', 'wlive-api broke off its response'))
        );
      });

      if (body) {
        let seen = 0;
        let overflow = false;
        body.on('data', (chunk) => {
          seen += chunk.length;
          if (sending) arm();
          if (seen > maxBodyBytes && !overflow) {
            overflow = true;
            fail(
              proxyError(413, 'PAYLOAD_TOO_LARGE', `The upload is larger than ${maxUploadMb} MB`)
            );
            body.unpipe(upstream);
            body.resume(); // drain the rest, the answer is already decided
            upstream.destroy();
          }
        });
        body.pipe(upstream);
      } else {
        upstream.end();
      }
    });
    return {
      promise,
      // Resolves the call with null (the caller has nobody left to answer).
      abort: () => {
        if (settle && resolveRef) settle(resolveRef, null);
        if (upstream) upstream.destroy();
      },
    };
  }

  /** GET /dev/api/admin/_health — local: is the proxy set up, does wlive-api answer? */
  async function health(res) {
    const info = {
      configured,
      target: base ? base.origin : null,
      timeoutMs,
      maxUploadBytes: maxBodyBytes,
    };
    if (!configured) {
      sendJson(res, 200, {
        success: true,
        data: { ...info, reachable: false, message: unconfiguredMessage() },
      });
      return;
    }
    const started = Date.now();
    try {
      const out = await forward({
        method: 'GET',
        subPath: 'skin-tokens',
        query: '',
        headers: {
          accept: 'application/json',
          'x-buraco-admin-secret': secret,
          'x-admin-actor': 'dev-console',
          'user-agent': 'brazilia-dev-console',
        },
        body: null,
        limitMs: Math.min(timeoutMs, HEALTH_TIMEOUT_MS),
      }).promise;
      let message = null;
      if (out.status === 401) {
        message =
          'wlive-api refused the admin secret — WLIVE_ADMIN_SECRET must equal its BURACO_ADMIN_PROXY_SECRET';
      } else if (out.status >= 400) {
        message = `wlive-api answered ${out.status}`;
      }
      sendJson(res, 200, {
        success: true,
        data: {
          ...info,
          reachable: out.status < 400,
          status: out.status,
          latencyMs: Date.now() - started,
          message,
        },
      });
    } catch (error) {
      sendJson(res, 200, {
        success: true,
        data: {
          ...info,
          reachable: false,
          status: null,
          latencyMs: Date.now() - started,
          message: redact(error.message),
        },
      });
    }
  }

  /**
   * The request handler. Always answers, never throws.
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   */
  async function handle(req, res) {
    const started = Date.now();
    const method = String(req.method || 'GET').toUpperCase();
    const rawUrl = String(req.url || '');
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const query = qIndex === -1 ? '' : rawUrl.slice(qIndex + 1);
    const drain = () => {
      if (typeof req.resume === 'function') req.resume();
    };

    try {
      if (!isDevAuthorized(req, devSecret())) {
        drain();
        sendError(
          res,
          401,
          'UNAUTHORIZED',
          devSecret() ? 'Unauthorized' : 'Dev console disabled: set WEBHOOK_SECRET'
        );
        return;
      }

      if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
        drain();
        sendError(res, 404, 'NOT_FOUND', 'Not Found');
        return;
      }
      const subPath = pathname.slice(PREFIX.length + 1);

      if (subPath === '_health' && method === 'GET') {
        drain();
        await health(res);
        return;
      }

      const route = matchRoute(method, subPath);
      if (!route.ok) {
        drain();
        if (route.status === 405) {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', `${method} is not allowed on ${subPath}`, {
            Allow: route.allow.join(', '),
          });
        } else {
          sendError(res, 404, 'NOT_FOUND', 'Not an admin endpoint this console proxies');
        }
        return;
      }

      if (!configured) {
        drain();
        sendError(res, 501, 'ADMIN_PROXY_NOT_CONFIGURED', unconfiguredMessage());
        return;
      }

      if (query.length > MAX_QUERY_LENGTH || /[\s#]/.test(query)) {
        drain();
        sendError(res, 400, 'BAD_QUERY', 'Query string rejected');
        return;
      }

      const actorName = sanitizeActor(req.headers['x-admin-actor']);
      if (MUTATING.has(method) && !actorName) {
        drain();
        sendError(
          res,
          400,
          'ACTOR_REQUIRED',
          'Enter your name in the console first — it is recorded as who made the change.'
        );
        return;
      }

      const declared = req.headers['content-length'];
      const declaredLength = declared === undefined ? null : Number(declared);
      if (declaredLength !== null && declaredLength > maxBodyBytes) {
        drain();
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', `The upload is larger than ${maxUploadMb} MB`);
        return;
      }

      const requestId = requestIdOf(req);
      const headers = {
        accept: 'application/json',
        'x-buraco-admin-secret': secret,
        'x-admin-actor': actorName ? `${actorName} (dev console)` : 'dev-console',
        'x-request-id': requestId,
        'user-agent': 'brazilia-dev-console',
      };
      const hasBody =
        method !== 'GET' &&
        ((declaredLength !== null && declaredLength > 0) ||
          req.headers['transfer-encoding'] !== undefined);
      if (hasBody) {
        // Content-Type carries the multipart boundary — it must survive verbatim.
        if (typeof req.headers['content-type'] === 'string')
          headers['content-type'] = req.headers['content-type'];
        if (declaredLength !== null) headers['content-length'] = String(declaredLength);
      } else {
        drain();
      }

      const call = forward({ method, subPath, query, headers, body: hasBody ? req : null });
      // The console went away before wlive-api answered: stop the upstream call.
      res.on('close', () => {
        if (!res.writableEnded) call.abort();
      });

      let out;
      try {
        out = await call.promise;
      } catch (error) {
        const status = error.proxyStatus || 502;
        log(
          status >= 500 ? 'warn' : 'info',
          `[DEV_ADMIN] ${method} ${subPath} failed: ${error.message}`,
          {
            requestId,
            actor: actorName || null,
            status,
            ms: Date.now() - started,
          }
        );
        sendError(res, status, error.proxyCode || 'UPSTREAM_ERROR', redact(error.message), {
          'x-request-id': requestId,
        });
        return;
      }
      if (!out) return; // aborted: the console is gone

      const contentType = String(out.headers['content-type'] || '');
      log(
        MUTATING.has(method) ? 'info' : 'debug',
        `[DEV_ADMIN] ${method} ${subPath} → ${out.status}`,
        {
          requestId,
          actor: actorName || null,
          status: out.status,
          ms: Date.now() - started,
        }
      );

      if (out.status === 204 || (out.status < 300 && out.body.length === 0)) {
        res.statusCode = out.status;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('x-request-id', requestId);
        res.end();
        return;
      }

      if (!/\bjson\b/i.test(contentType) || (out.status >= 300 && out.status < 400)) {
        sendError(
          res,
          out.status >= 400 ? out.status : 502,
          'UPSTREAM_NOT_JSON',
          out.status >= 300 && out.status < 400
            ? `wlive-api answered with a redirect (${out.status}) instead of JSON`
            : `wlive-api answered ${out.status} without a JSON body${contentType ? ` (${contentType.split(';')[0].trim()})` : ''}`,
          { 'x-request-id': requestId }
        );
        return;
      }

      res.statusCode = out.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('x-request-id', requestId);
      res.end(redact(out.body.toString('utf8')));
    } catch (error) {
      log('warn', `[DEV_ADMIN] ${method} ${pathname} crashed: ${error && error.message}`);
      sendError(res, 500, 'PROXY_ERROR', 'Internal Server Error');
    }
  }

  return {
    handle,
    configured,
    target: base ? base.origin : null,
    timeoutMs,
    maxBodyBytes,
  };
}

/** True when a request path belongs to the admin proxy. */
function isAdminProxyPath(url) {
  const pathname = String(url || '').split('?')[0];
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

module.exports = {
  createDevAdminProxy,
  isAdminProxyPath,
  sanitizeActor,
  matchRoute,
  ROUTES,
  PREFIX,
};
