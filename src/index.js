/**
 * Main Server Entry Point
 * Brazilia Game Server with Socket.IO
 */

const { Server } = require('socket.io');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { GameService } = require('./services');
const MatchmakingQueue = require('./services/MatchmakingService');
const SocketHandlers = require('./handlers/SocketHandlers');
const FailureManager = require('./managers/FailureManager');
const RoomOwnerLease = require('./managers/RoomOwnerLease');
const os = require('os');
const crypto = require('crypto');
const { createRedisClient, createAdapterClients } = require('./utils/redisClient');
const InMemoryRedis = require('./utils/InMemoryRedis');
const { SocketEvents } = require('./constants');
const { ErrorHandler, rateLimiter, createSocketAuth } = require('./middleware');

/** Reads a JSON request body (1 MB cap); rejects on malformed JSON. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** JSON response helper for the raw http handlers. */
function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

const logger = require('./utils/logger');
const PartnerWebhookRelay = require('./integrations/PartnerWebhookRelay');
const { BotCoordinator } = require('./bots');
const metrics = require('./observability/metrics');
const OccupancyMonitor = require('./observability/OccupancyMonitor');

class BraziliaServer {
  constructor() {
    this.config = config;
    this.io = null;
    this.gameService = null;
    this.socketHandlers = null;
    this.failureManager = null;
    this.redisClient = null;
    this.partnerWebhookRelay = null;
    this.botCoordinator = null;
    this.adapterClients = null;
    this.roomOwnerLease = null;
    this.occupancyMonitor = null;
    this.isShuttingDown = false;
    // Stable per-node identity for room-owner leases and structured logs
    // (PTW-43). Pin via NODE_ID, else derive a hostname:pid:rand id at boot.
    this.nodeId =
      this.config.cluster.nodeId ||
      `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
  }

  /**
   * Initialize and start the server
   */
  async start() {
    try {
      logger.info('Starting Brazilia Game Server...');
      logger.info(`Environment: ${this.config.server.environment}`);
      logger.info(`Port: ${this.config.server.port}`);

      const server = http.createServer((req, res) => {
        const requestId = req.headers['x-request-id'] || null;

        // Observability scrape endpoints (PTW-81). Prometheus-text `/metrics` for
        // any scraper (Prometheus / Grafana Agent / Datadog / CloudWatch agent),
        // and a JSON `/health` for liveness + a metrics snapshot. Both are plain
        // GETs with no secrets in the body; restrict exposure at the network/LB
        // layer (internal-only) as usual for a metrics port.
        if (req.method === 'GET' && req.url.startsWith('/metrics')) {
          const body = metrics.renderProm();
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
          res.end(body);
          return;
        }

        if (req.method === 'GET' && req.url.startsWith('/health')) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              status: 'ok',
              nodeId: this.nodeId,
              uptime: process.uptime(),
              metrics: metrics.snapshot(),
            })
          );
          return;
        }

        // ---------------------------------------------------------------------------
        // Dev dashboard (operator tool). GET /dev serves the single-file admin
        // page; /dev/api/* are its secret-guarded read endpoints. The page itself
        // is a static shell with no secrets — every API call must carry the
        // webhook secret (x-webhook-secret header or ?secret= query).
        // ---------------------------------------------------------------------------

        const devAuthorized = () => {
          if (!this.config.security.webhookSecret) return true; // unset (local dev)
          const header = req.headers['x-webhook-secret'];
          if (header === this.config.security.webhookSecret) return true;
          try {
            const query = new URL(req.url, 'http://localhost').searchParams;
            return query.get('secret') === this.config.security.webhookSecret;
          } catch {
            return false;
          }
        };

        if (req.method === 'GET' && (req.url === '/dev' || req.url.startsWith('/dev?'))) {
          try {
            if (!this._devAdminHtml) {
              this._devAdminHtml = fs.readFileSync(
                path.join(__dirname, 'dev', 'admin.html'),
                'utf8'
              );
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(this._devAdminHtml);
          } catch (e) {
            logger.error('[DEV] failed to serve admin page', { error: e.message });
            res.statusCode = 500;
            res.end('admin page missing');
          }
          return;
        }

        // Static art for the dev console's 1:1 table (court-card faces copied
        // from the mobile SDK, downscaled). No secrets involved; the allowlist
        // regex keeps this from ever serving anything outside src/dev/assets.
        const devAsset = req.method === 'GET' && req.url.match(/^\/dev\/assets\/([a-z0-9_]+\/)?([a-z0-9_]+\.(png|jpg|svg))(?:\?|$)/);
        if (devAsset) {
          const rel = path.join(devAsset[1] || '', devAsset[2]);
          const file = path.join(__dirname, 'dev', 'assets', rel);
          fs.readFile(file, (err, buf) => {
            if (err) {
              sendJson(res, 404, { error: 'Not Found' });
              return;
            }
            res.statusCode = 200;
            res.setHeader(
              'Content-Type',
              devAsset[3] === 'png' ? 'image/png' : devAsset[3] === 'jpg' ? 'image/jpeg' : 'image/svg+xml'
            );
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.end(buf);
          });
          return;
        }

        if (req.method === 'GET' && req.url.startsWith('/dev/api/status')) {
          if (!devAuthorized()) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
          const listing = this.socketHandlers.listRoomsForDev();
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              nodeId: this.nodeId,
              pid: process.pid,
              uptimeSeconds: Math.round(process.uptime()),
              environment: this.config.server.environment,
              shuttingDown: this.isShuttingDown,
              stats: listing.stats,
              development: listing.development,
              gameLog: logger.gameLogStore.stats(),
            })
          );
          return;
        }

        // Per-game logs (dev console → Game Logs). Logs outlive the room for
        // GAME_LOG_RETENTION_MS (default 2h), so a finished game is still readable.
        //   GET /dev/api/logs                          → rooms that have a log
        //   GET /dev/api/rooms/<roomId>/logs           → JSON page
        //       ?since=<seq>  live-tail cursor (entries after seq)
        //       &level=error|warn|info|debug  minimum level
        //       &q=<text>     substring filter   &limit=<n>   &tail=1 (last n)
        //       &narrative=1  only [GAME]/[ROOM_LIFECYCLE] events + warn/error
        //   GET /dev/api/rooms/<roomId>/logs.txt       → plain text (download)
        // Must precede the /dev/api/rooms/<roomId> detail route below.
        if (req.method === 'GET' && req.url.startsWith('/dev/api/logs')) {
          if (!devAuthorized()) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return;
          }
          sendJson(res, 200, this.socketHandlers.listRoomLogsForDev());
          return;
        }

        const roomLogsMatch =
          req.method === 'GET' && req.url.match(/^\/dev\/api\/rooms\/([^/?]+)\/logs(\.txt)?(?:\?|$)/);
        if (roomLogsMatch) {
          if (!devAuthorized()) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return;
          }
          const roomId = decodeURIComponent(roomLogsMatch[1]);
          const query = new URL(req.url, 'http://localhost').searchParams;
          const opts = {
            since: query.get('since'),
            level: query.get('level'),
            q: query.get('q'),
            limit: query.get('limit'),
            tail: ['1', 'true'].includes(query.get('tail')),
            narrative: ['1', 'true'].includes(query.get('narrative')),
          };
          if (roomLogsMatch[2]) {
            const text = logger.gameLogStore.renderText(roomId, { level: opts.level, q: opts.q });
            if (text === null) {
              sendJson(res, 404, { success: false, error: 'No logs for room' });
              return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="game-${roomId.replace(/[^A-Za-z0-9._-]/g, '_')}.log"`
            );
            res.end(text);
            return;
          }
          const result = this.socketHandlers.getRoomLogsForDev(roomId, opts);
          sendJson(res, result.success ? 200 : 404, result);
          return;
        }

        if (req.method === 'GET' && req.url.startsWith('/dev/api/rooms')) {
          if (!devAuthorized()) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
          // /dev/api/rooms/<roomId> → detail; bare /dev/api/rooms → roster.
          const match = req.url.match(/^\/dev\/api\/rooms\/([^/?]+)/);
          const result = match
            ? this.socketHandlers.getRoomDevDetail(decodeURIComponent(match[1]))
            : this.socketHandlers.listRoomsForDev();
          res.statusCode = result.success ? 200 : 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === 'POST' && ['/webhooks/start-game', '/webhooks/abort-start'].includes(req.url.split('?')[0])) {
          (async () => {
            try {
              if (this.config.security.webhookSecret && req.headers['x-webhook-secret'] !== this.config.security.webhookSecret) {
                sendJson(res, 401, { success: false, error: 'Unauthorized' });
                return;
              }
              const data = await readJsonBody(req);
              if (!data.roomId) {
                sendJson(res, 400, { success: false, error: 'roomId required' });
                return;
              }
              const result = req.url.split('?')[0] === '/webhooks/abort-start'
                ? await this.socketHandlers.abortStartFromBackend(data)
                : await this.socketHandlers.triggerStartGame(data.roomId, data);
              sendJson(res, result.success ? 200 : 400, result);
            } catch (error) {
              logger.error('[WEBHOOK] start transition failed', { requestId, error: error.message });
              sendJson(res, 500, { success: false, error: 'Internal Server Error' });
            }
          })();
          return;
        }

        // ── Admin skin override + live room listing (webhook-secret guarded) ──
        // POST /webhooks/skin-override { action: 'set'|'clear', scope: 'room'|'global',
        //   roomId?, skins?, durationMs?|expiresAt?, setBy? }   GET → status
        // GET  /webhooks/admin-rooms → every live room with seats, watchers, skins
        if (
          req.url.startsWith('/webhooks/skin-override') ||
          req.url.startsWith('/webhooks/admin-rooms')
        ) {
          const secret = req.headers['x-webhook-secret'];
          if (
            this.config.security.webhookSecret &&
            secret !== this.config.security.webhookSecret
          ) {
            logger.warn('[WEBHOOK] Unauthorized admin webhook', {
              source: 'webhook',
              event: 'skin_override',
              requestId,
            });
            sendJson(res, 401, { error: 'Unauthorized' });
            return;
          }
          const route = req.url.split('?')[0];
          (async () => {
            try {
              if (route === '/webhooks/admin-rooms' && req.method === 'GET') {
                sendJson(res, 200, this.socketHandlers.listRoomsForAdmin());
                return;
              }
              if (route === '/webhooks/skin-override' && req.method === 'GET') {
                sendJson(res, 200, this.socketHandlers.getSkinOverrideStatus());
                return;
              }
              if (route === '/webhooks/skin-override' && req.method === 'POST') {
                const data = await readJsonBody(req);
                const result =
                  data.action === 'clear'
                    ? await this.socketHandlers.clearSkinOverride(data)
                    : await this.socketHandlers.setSkinOverride(data);
                logger.info('[WEBHOOK] skin-override processed', {
                  source: 'webhook',
                  event: 'skin_override',
                  action: data.action === 'clear' ? 'clear' : 'set',
                  scope: data.scope,
                  roomId: data?.roomId ? String(data.roomId) : null,
                  requestId,
                  success: result.success,
                });
                sendJson(res, result.success ? 200 : 400, result);
                return;
              }
              sendJson(res, 404, { error: 'Not Found' });
            } catch (e) {
              logger.error('[WEBHOOK] admin webhook failed', {
                source: 'webhook',
                event: 'skin_override',
                requestId,
                error: e.message,
              });
              sendJson(res, 500, { error: 'Internal Server Error' });
            }
          })();
          return;
        }

        if (req.method === 'POST' && req.url.startsWith('/webhooks/sync-room')) {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const secret = req.headers['x-webhook-secret'];
              if (
                this.config.security.webhookSecret &&
                secret !== this.config.security.webhookSecret
              ) {
                logger.warn('[WEBHOOK] Unauthorized sync-room webhook', {
                  source: 'webhook',
                  event: 'sync_room',
                  requestId,
                });
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              const data = JSON.parse(body || '{}');
              const result = this.socketHandlers.syncRoomFromBackend(data);

              logger.info('[WEBHOOK] sync-room processed', {
                source: 'webhook',
                event: 'sync_room',
                roomId: data?.roomId ? String(data.roomId) : null,
                requestId,
                success: result.success,
              });

              res.statusCode = result.success ? 200 : 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (e) {
              logger.error('[WEBHOOK] sync-room failed', {
                source: 'webhook',
                event: 'sync_room',
                requestId,
                error: e.message,
              });
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url.startsWith('/webhooks/room-runtime')) {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const secret = req.headers['x-webhook-secret'];
              if (
                this.config.security.webhookSecret &&
                secret !== this.config.security.webhookSecret
              ) {
                logger.warn('[WEBHOOK] Unauthorized room-runtime webhook', {
                  source: 'webhook',
                  event: 'room_runtime',
                  requestId,
                });
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              const data = JSON.parse(body || '{}');
              const result = this.socketHandlers.getRoomRuntimeSnapshot(data);

              logger.info('[WEBHOOK] room-runtime processed', {
                source: 'webhook',
                event: 'room_runtime',
                roomId: data?.roomId ? String(data.roomId) : null,
                requestId,
                success: result.success,
                exists: result.exists ?? null,
                playerCount: result.playerCount ?? null,
              });

              res.statusCode = result.success ? 200 : 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (e) {
              logger.error('[WEBHOOK] room-runtime failed', {
                source: 'webhook',
                event: 'room_runtime',
                requestId,
                error: e.message,
              });
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url.startsWith('/webhooks/cancel-room')) {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const secret = req.headers['x-webhook-secret'];
              if (
                this.config.security.webhookSecret &&
                secret !== this.config.security.webhookSecret
              ) {
                logger.warn('[WEBHOOK] Unauthorized cancel-room webhook', {
                  source: 'webhook',
                  event: 'cancel_room',
                  requestId,
                });
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              const data = JSON.parse(body || '{}');
              const result = this.socketHandlers.cancelRoomFromBackend(data);

              logger.info('[WEBHOOK] cancel-room processed', {
                source: 'webhook',
                event: 'cancel_room',
                roomId: data?.roomId ? String(data.roomId) : null,
                requestId,
                success: result.success,
              });

              res.statusCode = result.success ? 200 : 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (e) {
              logger.error('[WEBHOOK] cancel-room failed', {
                source: 'webhook',
                event: 'cancel_room',
                requestId,
                error: e.message,
              });
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url.startsWith('/webhooks/invite-bot')) {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const secret = req.headers['x-webhook-secret'];
              if (
                this.config.security.webhookSecret &&
                secret !== this.config.security.webhookSecret
              ) {
                logger.warn('[WEBHOOK] Unauthorized invite-bot webhook', {
                  source: 'webhook',
                  event: 'invite_bot',
                  requestId,
                });
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              const data = JSON.parse(body || '{}');
              const result = this.socketHandlers.inviteBotToRoom(data);

              logger.info('[WEBHOOK] invite-bot processed', {
                source: 'webhook',
                event: 'invite_bot',
                roomId: data?.roomId ? String(data.roomId) : null,
                requestId,
                success: result.success,
                playerId: result.playerId || null,
              });

              res.statusCode = result.success ? 200 : 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (e) {
              logger.error('[WEBHOOK] invite-bot failed', {
                source: 'webhook',
                event: 'invite_bot',
                requestId,
                error: e.message,
              });
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
          });
          return;
        }

        // Ops/development broadcast (maintenance / restart). Fans the notice out
        // to EVERY connected socket (global, not room-scoped) so clients stop
        // their active game/lobby session. Body:
        //   { maintenance_mode: true }                        — game under maintenance
        //   { restart_server: true, message?: '...' }         — imminent restart
        // The operator (or a deploy script) curls this right before taking the
        // server down; no rooms are mutated server-side (the restart does that).
        if (req.method === 'POST' && req.url.startsWith('/webhooks/development')) {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const secret = req.headers['x-webhook-secret'];
              if (
                this.config.security.webhookSecret &&
                secret !== this.config.security.webhookSecret
              ) {
                logger.warn('[WEBHOOK] Unauthorized development webhook', {
                  source: 'webhook',
                  event: 'development',
                  requestId,
                });
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              const data = JSON.parse(body || '{}');
              const result = this.socketHandlers.broadcastDevelopmentNotice(data);

              logger.info('[WEBHOOK] development processed', {
                source: 'webhook',
                event: 'development',
                requestId,
                success: result.success,
                maintenanceMode: result.maintenance_mode ?? null,
                restartServer: result.restart_server ?? null,
              });

              res.statusCode = result.success ? 200 : 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (e) {
              logger.error('[WEBHOOK] development failed', {
                source: 'webhook',
                event: 'development',
                requestId,
                error: e.message,
              });
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
          });
          return;
        }

        // Dev dashboard restart trigger. Announces restart_server to every
        // connected socket (clients stop + route out), then — unless
        // { announce_only: true } — gracefully shuts THIS process down after
        // shutdown_after_ms (default 3s, clamp 0.5–60s) via SIGTERM so the
        // supervisor (pm2/systemd/docker) restarts it. Bare `node index.js`
        // just exits; restart it manually.
        //
        // { keep_sessions: true } is the DEPLOY variant: no restart_server
        // broadcast (that flag makes clients leave the table), only the graceful
        // SIGTERM — the shutdown drain snapshots every room and emits
        // `server_restarting`, and the next boot resumes each game when its
        // players rejoin. See docs/RESTART_RESILIENCE.md.
        if (req.method === 'POST' && req.url.startsWith('/webhooks/dev-restart')) {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const secret = req.headers['x-webhook-secret'];
              if (
                this.config.security.webhookSecret &&
                secret !== this.config.security.webhookSecret
              ) {
                logger.warn('[WEBHOOK] Unauthorized dev-restart webhook', {
                  source: 'webhook',
                  event: 'dev_restart',
                  requestId,
                });
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              const data = JSON.parse(body || '{}');
              const announceOnly = data.announce_only === true || data.announceOnly === true;
              const keepSessions = data.keep_sessions === true || data.keepSessions === true;
              const rawDelay = Number(data.shutdown_after_ms ?? data.shutdownAfterMs);
              const shutdownInMs = Math.min(Math.max(rawDelay || 3000, 500), 60000);

              if (keepSessions && announceOnly) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: false, error: 'keep_sessions has nothing to announce; drop announce_only' }));
                return;
              }

              if (!keepSessions) {
                const result = this.socketHandlers.broadcastDevelopmentNotice({
                  restart_server: true,
                  message: typeof data.message === 'string' ? data.message : undefined,
                });
                if (!result.success) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify(result));
                  return;
                }
              }

              if (!announceOnly) {
                logger.warn(`[WEBHOOK] dev-restart: shutting down in ${shutdownInMs}ms`, {
                  source: 'webhook',
                  event: 'dev_restart',
                  requestId,
                });
                setTimeout(() => process.kill(process.pid, 'SIGTERM'), shutdownInMs);
              }

              logger.info('[WEBHOOK] dev-restart processed', {
                source: 'webhook',
                event: 'dev_restart',
                requestId,
                announceOnly,
                keepSessions,
                shutdownInMs: announceOnly ? null : shutdownInMs,
              });

              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  success: true,
                  announced: !keepSessions,
                  announceOnly,
                  keepSessions,
                  shutdownInMs: announceOnly ? null : shutdownInMs,
                })
              );
            } catch (e) {
              logger.error('[WEBHOOK] dev-restart failed', {
                source: 'webhook',
                event: 'dev_restart',
                requestId,
                error: e.message,
              });
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
          });
          return;
        }

        // Dev-only hand surgery: REPLACE a target player's hand with the
        // requested cards (pulled from deck / target's own hand / wells) and
        // re-broadcast game_state_update to the room. Same engine as the
        // `dev_change_cards` socket event — see SocketHandlers.changePlayerCards
        // for the full payload contract. Body:
        //   { roomId, target_user, change_cards: [{suit, rank} | {cardId}] }
        // Dev console "Close game": void a room in ANY phase (lobby, mid-round,
        // between rounds) with no result. Everyone at the table gets room_closed
        // (with the optional message), the room is deleted and the backend gets
        // room-closed { reason: 'admin_closed' } so it de-lists / refunds.
        // Body: { roomId, message?: string, reason?: string }
        if (req.method === 'POST' && req.url.startsWith('/webhooks/dev-close-room')) {
          (async () => {
            try {
              if (this.config.security.webhookSecret && req.headers['x-webhook-secret'] !== this.config.security.webhookSecret) {
                logger.warn('[WEBHOOK] Unauthorized dev-close-room webhook', {
                  source: 'webhook',
                  event: 'dev_close_room',
                  requestId,
                });
                sendJson(res, 401, { success: false, error: 'Unauthorized' });
                return;
              }
              const data = await readJsonBody(req);
              const result = this.socketHandlers.closeRoomFromDev(data);
              logger.info('[WEBHOOK] dev-close-room processed', {
                source: 'webhook',
                event: 'dev_close_room',
                requestId,
                roomId: data?.roomId ? String(data.roomId) : null,
                success: result.success,
                alreadyClosed: result.alreadyClosed === true,
              });
              sendJson(res, result.success ? 200 : 400, result);
            } catch (error) {
              logger.error('[WEBHOOK] dev-close-room failed', { requestId, error: error.message });
              sendJson(res, 500, { success: false, error: 'Internal Server Error' });
            }
          })();
          return;
        }

        // Dev: swap two physical cards between the deck / a well / any hand.
        if (req.method === 'POST' && req.url.startsWith('/webhooks/dev-swap-cards')) {
          (async () => {
            try {
              if (this.config.security.webhookSecret && req.headers['x-webhook-secret'] !== this.config.security.webhookSecret) {
                sendJson(res, 401, { success: false, error: 'Unauthorized' });
                return;
              }
              const data = await readJsonBody(req);
              const result = this.socketHandlers.swapPlayerCards(data);
              sendJson(res, result.success ? 200 : 400, result);
            } catch (error) {
              logger.error('[WEBHOOK] dev-swap-cards failed', { requestId, error: error.message });
              sendJson(res, 500, { success: false, error: 'Internal Server Error' });
            }
          })();
          return;
        }

        if (req.method === 'POST' && req.url.startsWith('/webhooks/dev-change-cards')) {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const secret = req.headers['x-webhook-secret'];
              if (
                this.config.security.webhookSecret &&
                secret !== this.config.security.webhookSecret
              ) {
                logger.warn('[WEBHOOK] Unauthorized dev-change-cards webhook', {
                  source: 'webhook',
                  event: 'dev_change_cards',
                  requestId,
                });
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              const data = JSON.parse(body || '{}');
              const result = this.socketHandlers.changePlayerCards(data);

              logger.info('[WEBHOOK] dev-change-cards processed', {
                source: 'webhook',
                event: 'dev_change_cards',
                requestId,
                success: result.success,
                roomId: data?.roomId ? String(data.roomId) : null,
              });

              res.statusCode = result.success ? 200 : 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (e) {
              logger.error('[WEBHOOK] dev-change-cards failed', {
                source: 'webhook',
                event: 'dev_change_cards',
                requestId,
                error: e.message,
              });
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
          });
          return;
        }

        // Social DM realtime fan-out (PTW-50). The backend POSTs here on Message
        // create; we emit the full message payload to the recipient's (and
        // sender's other) authenticated sockets via their per-user rooms. With the
        // Redis adapter on, `io.to(room).emit` fans out cross-node, so the webhook
        // may land on any instance regardless of where the user is connected.
        if (req.method === 'POST' && req.url.startsWith('/webhooks/direct-message')) {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const secret = req.headers['x-webhook-secret'];
              if (
                this.config.security.webhookSecret &&
                secret !== this.config.security.webhookSecret
              ) {
                logger.warn('[WEBHOOK] Unauthorized direct-message webhook', {
                  source: 'webhook',
                  event: 'direct_message',
                  requestId,
                });
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              const data = JSON.parse(body || '{}');
              const result = this.socketHandlers.emitDirectMessage(data);

              logger.info('[WEBHOOK] direct-message processed', {
                source: 'webhook',
                event: 'direct_message',
                recipientId: data?.recipientId != null ? String(data.recipientId) : null,
                senderId: data?.senderId != null ? String(data.senderId) : null,
                messageId: data?.message?.id != null ? String(data.message.id) : null,
                requestId,
                success: result.success,
                delivered: result.delivered ?? null,
              });

              res.statusCode = result.success ? 200 : 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (e) {
              logger.error('[WEBHOOK] direct-message failed', {
                source: 'webhook',
                event: 'direct_message',
                requestId,
                error: e.message,
              });
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
          });
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
      });

      this.io = new Server(server, {
        cors: this.config.socketIO.cors,
        pingTimeout: this.config.socketIO.pingTimeout,
        pingInterval: this.config.socketIO.pingInterval,
        maxHttpBufferSize: 1e6, // 1MB - Explicitly set to handle large game state payloads
        transports: ['websocket', 'polling'], // Fallback to polling if websocket fails
      });

      // Multi-node broadcast fan-out (PTW-43, Phase 1). OFF by default: a single
      // instance keeps the in-memory adapter and behaves exactly as before. When
      // REDIS_ADAPTER_ENABLED=true, attach the Redis adapter and FAIL-FAST if the
      // pub/sub clients can't connect — never boot silently single-node when
      // operators asked for multi-node. NOTE: the adapter only fans out
      // broadcasts; it does NOT make room mutation multi-node-safe on its own.
      // Replica count must stay 1 until the room-owner lease (Phase 2) + soak
      // test (Phase 6) land. See docs/DEPLOY_TOPOLOGY.md.
      if (this.config.redis.adapterEnabled) {
        const { createAdapter } = require('@socket.io/redis-adapter');
        const { pubClient, subClient, ready } = createAdapterClients();
        await ready();
        this.io.adapter(createAdapter(pubClient, subClient));
        this.adapterClients = { pubClient, subClient };
        logger.info(`✓ Redis adapter ENABLED (multi-node fan-out) — nodeId=${this.nodeId}`);
      } else {
        logger.info(`Single-node mode (Redis adapter disabled) — nodeId=${this.nodeId}`);
      }

      // Initialize game service
      this.gameService = new GameService();

      // Redis-backed store for failure management / reconnection. Uses a real
      // Redis when configured, else an in-memory fallback (S-C10).
      this.redisClient = createRedisClient();

      // Redis-fallback-in-prod tripwire (PTW-81). The config boot guard already
      // refuses to start in production without a real Redis, so this should be
      // impossible — but if any future change lets the in-memory fallback through
      // in production, surface it loudly (gauge=1 + alert log) instead of silently
      // degrading to a single-instance, non-durable store.
      if (
        this.config.server.environment === 'production' &&
        this.redisClient instanceof InMemoryRedis
      ) {
        metrics.setGauge('brazilia_redis_fallback_in_prod', 1);
        metrics.increment('buraco_redis_fallback_in_prod_total');
        metrics.alert('redis_fallback_in_prod', {
          detail: 'In-memory Redis fallback active while NODE_ENV=production',
        });
      } else {
        metrics.setGauge('brazilia_redis_fallback_in_prod', 0);
      }

      // Initialize failure manager
      this.failureManager = new FailureManager(this.io, this.redisClient, this.gameService, logger);
      // The room-owner lease is a MULTI-NODE construct: it decides which replica
      // drives a room's turn timer and bots. Building it while the Redis adapter is
      // off made _ownershipEnabled() true on a single node, and since join_room /
      // start_game / deal_cards are not ownership-wrapped, ownedRoomIds was still
      // empty at the first deal — so _startTurnTimer bailed out and every match ran
      // its first turn with no clock, no expiry and no anti-freeze backstop.
      // Single-node keeps it null; every ownership call site already has a correct
      // non-cluster branch. See docs/DEPLOY_TOPOLOGY.md (PTW-43).
      this.roomOwnerLease = this.config.redis.adapterEnabled
        ? new RoomOwnerLease(this.redisClient, this.nodeId, {
            ttlMs: this.config.cluster.ownerLeaseTtlMs,
            logger,
          })
        : null;
      if (!this.roomOwnerLease) {
        logger.info('[ROOM_OWNER] Single-node mode: room-owner lease disabled');
      }

      // Load persisted game states if available
      await this.failureManager.loadPersistedGames();

      // Initialize matchmaking queue
      this.matchmakingQueue = new MatchmakingQueue(this.gameService);

      // Initialize socket handlers
      this.partnerWebhookRelay = new PartnerWebhookRelay(
        this.config.partnerWebhook,
        this.redisClient
      );
      await this.partnerWebhookRelay.recoverPending();

      this.socketHandlers = new SocketHandlers(
        this.io,
        this.gameService,
        this.matchmakingQueue,
        this.failureManager,
        this.partnerWebhookRelay,
        {
          roomOwnerLease: this.roomOwnerLease,
          nodeId: this.nodeId,
          renewMs: this.config.cluster.ownerLeaseRenewMs,
        }
      );

      this.botCoordinator = new BotCoordinator({
        gameService: this.gameService,
        socketHandlers: this.socketHandlers,
        logger,
        config: this.config,
      });
      this.socketHandlers.botCoordinator = this.botCoordinator;
      // Admin-wide skin override survives restarts (until its own expiry).
      await this.socketHandlers.restoreGlobalSkinOverride();
      // Single bot/turn engine: grace-expiry bot takeovers are routed through the
      // canonical BotCoordinator instead of FailureManager's old in-manager
      // draw/discard duplicate (P1-9).
      this.failureManager.botCoordinator = this.botCoordinator;
      this.botCoordinator.start();

      // Restart resilience: loadPersistedGames() (above) rehydrated the room DATA
      // but no turn timers / bot drivers / grace timers run for them yet. Resume
      // each restored in-progress game so a server restart continues the prior
      // session instead of freezing it. Best-effort; never blocks boot.
      this.socketHandlers
        .resumePersistedRooms()
        .catch((err) => logger.warn(`[STARTUP] resumePersistedRooms failed: ${err.message}`));

      // On every (re)start all in-memory game instances are gone. Tell the backend
      // to close any rooms it still thinks are 'ongoing' so the lobby never shows
      // phantom games. Best-effort: if BACKEND_URL isn't configured, skip silently.
      this._sweepOrphanedRoomsOnStartup();

      // Setup matchmaking listeners
      this.socketHandlers.setupMatchmakingListeners();

      // Ghost-occupancy drift monitor (PTW-81): periodically reconcile each active
      // room's seated humans against live socket occupancy and surface sustained
      // divergence (the room-listing-desync class) as a gauge + alert.
      this.occupancyMonitor = new OccupancyMonitor(
        { io: this.io, gameService: this.gameService, metrics },
        {
          intervalMs: this.config.game.roomCleanupInterval
            ? Math.min(this.config.game.roomCleanupInterval, 30000)
            : 30000,
        }
      );
      this.occupancyMonitor.start();

      // Per-game log retention sweeper (+ file flusher when GAME_LOG_FILE=true).
      if (this.config.gameLog.enabled) {
        logger.gameLogStore.start();
        const { retentionMs, fileEnabled, fileDirectory } = this.config.gameLog;
        logger.info(
          `✓ Per-game logs enabled (retention ${Math.round(retentionMs / 60000)}m, ` +
            `level ${this.config.gameLog.level}` +
            (fileEnabled ? `, files in ${fileDirectory})` : ', memory only)')
        );
      }

      // Setup middleware
      this._setupMiddleware();

      // Setup connection handler
      this.io.on(SocketEvents.CONNECTION, (socket) => {
        this.socketHandlers.handleConnection(socket);
      });

      // Setup error handlers
      this.io.on(SocketEvents.ERROR, (error) => {
        logger.error('Socket.IO server error:', error);
      });

      server.listen(this.config.server.port, this.config.server.host, () => {
        logger.info(`✓ Server running on ${this.config.server.host}:${this.config.server.port}`);
      });
      logger.info('✓ Game service initialized');
      logger.info('✓ Matchmaking service initialized');
      logger.info('✓ Failure manager initialized');
      logger.info('✓ Socket handlers registered');
      logger.info('✓ Bot coordinator initialized');
      logger.info('Server ready to accept connections');

      // Setup graceful shutdown
      this._setupGracefulShutdown();
    } catch (error) {
      logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  /**
   * Setup Socket.IO middleware
   * @private
   */
  _setupMiddleware() {
    // Handshake authentication: verify the backend bearer token and bind the
    // connection to the server-resolved user id (anti-impersonation). Gated by
    // config.auth.required; in legacy mode it is a no-op for tokenless clients.
    this.io.use(createSocketAuth(config.auth));
    if (config.auth.required) {
      logger.info('✓ Socket handshake authentication ENFORCED');
    }

    // Rate limiting middleware
    this.io.use(rateLimiter.middleware());

    // Error handling middleware
    this.io.use((socket, next) => {
      socket.on(SocketEvents.ERROR, (error) => {
        ErrorHandler.handleSocketError(socket, error);
      });
      next();
    });

    logger.info('✓ Middleware configured');
  }

  /**
   * Setup graceful shutdown handlers
   * @private
   */
  _setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) {
        logger.warn(`${signal} received while shutdown is already in progress`);
        return;
      }
      this.isShuttingDown = true;
      logger.info(`${signal} received, shutting down gracefully...`);

      try {
        // Stop the rate-limiter cleanup interval so it does not escape teardown
        // (P1-12). Safe even if start failed before middleware setup.
        if (rateLimiter && typeof rateLimiter.shutdown === 'function') {
          rateLimiter.shutdown();
          logger.info('✓ Rate limiter cleaned up');
        }

        if (this.occupancyMonitor) {
          this.occupancyMonitor.stop();
          logger.info('✓ Occupancy monitor stopped');
        }

        // RESTART DRAIN (deploy resilience — see docs/RESTART_RESILIENCE.md).
        // Order matters:
        //   1. stop the bots, so no bot move lands between snapshot and exit;
        //   2. flip the socket layer into drain mode and tell every client this
        //      is a restart (keep the session, auto-reconnect, rejoin) — from here
        //      a socket closing is NOT a player leaving;
        //   3. one final, AWAITED snapshot of every live room, taken while the
        //      turn timers / intermission deadlines are still intact (the
        //      per-action snapshot is fire-and-forget and gameService.shutdown()
        //      below wipes awaitingNextRound/nextRoundAt in disposeTimers()).
        // Only then are the sockets closed and Redis quit. The next boot restores
        // these rooms and holds them until a player rejoins (resumePersistedRooms).
        if (this.botCoordinator) {
          this.botCoordinator.shutdown();
          logger.info('✓ Bot coordinator cleaned up');
        }

        if (this.socketHandlers?.beginRestartDrain) {
          const notified = this.socketHandlers.beginRestartDrain();
          logger.info(`✓ Restart drain started (${notified} socket(s) notified)`);
        }

        if (this.failureManager?.persistAllGames) {
          const snap = await this.failureManager.persistAllGames({
            timeoutMs: this.config.game.restartSnapshotTimeoutMs,
          });
          logger.info(
            `✓ Final game snapshot: ${snap.persisted}/${snap.total} room(s)` +
              (snap.timedOut ? ' (TIMED OUT — per-action snapshots remain)' : '')
          );
        }

        // Flush pending per-game log lines to disk before the process goes.
        await logger.gameLogStore.stop();
        logger.info('✓ Per-game logs flushed');

        if (this.socketHandlers?._releaseOwnedRooms) {
          await this.socketHandlers._releaseOwnedRooms();
          logger.info('✓ Room ownership leases released');
        }

        // Close Socket.IO server
        if (this.io) {
          await new Promise((resolve) => {
            this.io.close(resolve);
          });
          logger.info('✓ Socket.IO server closed');
        }

        // Cleanup game service
        if (this.gameService) {
          this.gameService.shutdown();

          if (this.failureManager) {
            this.failureManager.dispose();
            logger.info('✓ Failure manager cleaned up');
          }

          if (this.redisClient && typeof this.redisClient.quit === 'function') {
            await this.redisClient.quit();
            logger.info('✓ Failure storage cleaned up');
          }

          // Quit the adapter pub/sub clients (PTW-43). Best-effort: never block
          // shutdown on a slow Redis.
          if (this.adapterClients) {
            await Promise.allSettled([
              this.adapterClients.pubClient.quit(),
              this.adapterClients.subClient.quit(),
            ]);
            logger.info('✓ Redis adapter clients cleaned up');
          }

          // Cleanup matchmaking
          if (this.matchmakingQueue) {
            this.matchmakingQueue.shutdown();
            logger.info('✓ Matchmaking service cleaned up');
          }
          logger.info('✓ Game service cleaned up');
        }

        logger.info('Server shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions.
    // Do NOT shut the whole process down: a stray throw in one room's timer/bot
    // callback must not terminate every other active game (S-C7). Log and keep
    // serving; a process manager (pm2/systemd) can restart on real fatal states.
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception (kept alive):', error);
    });

    // Handle unhandled promise rejections — log only, do not exit (S-C7).
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection (kept alive) at:', promise, 'reason:', reason);
    });
  }

  /**
   * On startup, in-memory game state that was NOT rehydrated from the durable
   * store is gone. Notify the backend to sweep every 'ongoing'/'open' room it
   * still tracks EXCEPT the ones this node successfully restored, so no phantom
   * rooms linger (PTW-255 #3). The backend cancels each swept room and refunds
   * any pending bet (idempotent on its side).
   *
   * `activeRoomIds` are the rooms that survived loadPersistedGames() — recoverable
   * games that can continue, which the backend must KEEP. An empty list (nothing
   * survived, e.g. wiped in-memory Redis) sweeps ALL rooms. Best-effort: failures
   * are logged but never crash boot.
   */
  _sweepOrphanedRoomsOnStartup() {
    // KNOWN LIMITATION (1-socket/2-backend co-deploy): on a cold start the rooms this
    // node lost are not in memory, so we have no per-room `backendBaseUrl` to route
    // by and can only sweep the single configured default backend. A second backend's
    // orphans would NOT be swept here. The documented REQUIRED deploy is one socket
    // per backend (each with its own BACKEND_URL); a shared-socket co-deploy must
    // accept that this startup sweep only covers config.backend.url and rely on each
    // backend's own deadline-keyed cleanup command to reap its orphans.
    const backendUrl = this.config.backend && this.config.backend.url;
    if (!backendUrl || typeof fetch !== 'function') return;
    const headers = { 'Content-Type': 'application/json' };
    const secret = this.config.backend && this.config.backend.webhookSecret;
    if (secret) headers['x-webhook-secret'] = secret;
    const activeRoomIds = this.gameService
      ? Array.from(this.gameService.rooms.keys()).map((id) => String(id))
      : [];
    fetch(`${backendUrl.replace(/\/$/, '')}/api/webhooks/startup-room-sweep`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'server_restart', nodeId: this.nodeId || null, activeRoomIds }),
    })
      .then((res) => {
        if (!res.ok) {
          logger.warn(`[STARTUP] startup-room-sweep returned HTTP ${res.status}`);
        } else {
          logger.info(
            `[STARTUP] startup-room-sweep completed — orphaned rooms closed (kept ${activeRoomIds.length} restored)`
          );
        }
      })
      .catch((err) =>
        logger.warn(`[STARTUP] startup-room-sweep webhook failed: ${err.message}`)
      );
  }

  /**
   * Get server statistics
   * @returns {Object}
   */
  getStats() {
    return {
      server: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      },
      game: this.gameService.getStats(),
      matchmaking: this.matchmakingQueue ? this.matchmakingQueue.getStatus() : null,
      sockets: {
        connected: this.io.sockets.sockets.size,
      },
    };
  }
}

// Create and start server instance
const server = new BraziliaServer();
server.start();

// Export for testing
module.exports = BraziliaServer;
