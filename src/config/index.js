/**
 * Server Configuration
 * Centralizes all configuration settings with environment variable support
 */

require('dotenv').config();

const optionalInt = (name) => {
  if (process.env[name] === undefined || process.env[name] === '') return undefined;
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : undefined;
};

const intWithDefault = (name, fallback) => optionalInt(name) ?? fallback;

const config = {
  // Server configuration
  server: {
    port: parseInt(process.env.PORT, 10) || 8080,
    environment: process.env.NODE_ENV || 'development',
    host: process.env.HOST || '0.0.0.0',
  },

  // Socket.IO configuration
  socketIO: {
    cors: (() => {
      // A wildcard origin cannot be combined with credentials (browsers reject it,
      // and it is unsafe). Allow a comma-separated allowlist via CORS_ORIGIN; only
      // enable credentials when explicit origins are configured.
      const raw = process.env.CORS_ORIGIN || '*';
      const isWildcard = raw === '*';
      const origin = isWildcard
        ? '*'
        : raw
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean);
      return {
        origin,
        methods: ['GET', 'POST'],
        credentials: !isWildcard,
      };
    })(),
    pingTimeout: parseInt(process.env.PING_TIMEOUT, 10) || 60000,
    pingInterval: parseInt(process.env.PING_INTERVAL, 10) || 25000,
  },

  // Game configuration
  game: {
    maxPlayersPerRoom: parseInt(process.env.MAX_PLAYERS_PER_ROOM, 10) || 2,
    minPlayersToStart: parseInt(process.env.MIN_PLAYERS_TO_START, 10) || 2,
    inactivityTimeout: parseInt(process.env.INACTIVITY_TIMEOUT, 10) || 1800000, // 30 minutes
    roomCleanupInterval: parseInt(process.env.ROOM_CLEANUP_INTERVAL, 10) || 300000, // 5 minutes
    // Official rules in mobile/rules.md do not define a Classic opening meld
    // minimum. Operators may enable a house rule with MIN_POINTS_TO_GO_DOWN.
    minPointsToGoDown:
      process.env.MIN_POINTS_TO_GO_DOWN === undefined
        ? 0
        : parseInt(process.env.MIN_POINTS_TO_GO_DOWN, 10) || 0,
    // #11 default match target when the backend omits targetScore in sync-room.
    // 0 = single round; the wlive PRO default is 1000.
    targetScore:
      process.env.TARGET_SCORE === undefined
        ? 1000
        : parseInt(process.env.TARGET_SCORE, 10) || 0,
    // #11 multi-round: how long the round-over board stays up before the SERVER
    // deals the next round. Ops-level default; a room may override it per-room
    // via sync-room (`nextRoundDelayMs`). See SocketHandlers.NEXT_ROUND_DELAY_MS
    // for why the effective value is clamped.
    nextRoundDelayMs: intWithDefault('NEXT_ROUND_DELAY_MS', 25000),
    // Restart resilience (deploy without ending live games). After a restart
    // every restored in-progress room is HELD — no turn timer, no bot move, no
    // next-round deal — until one of its humans rejoins or this window elapses,
    // so nobody is auto-played / struck for a deploy they did not cause. Covers
    // the supervisor restart + the client's reconnect backoff with margin.
    restartHoldMs: intWithDefault('RESTART_HOLD_MS', 60000),
    // When the hold is released the interrupted turn resumes with the time it
    // had left at shutdown, but never less than this, so a returning player is
    // not handed a 1-second turn.
    restartMinTurnMs: intWithDefault('RESTART_MIN_TURN_MS', 10000),
    // Upper bound on the final all-rooms snapshot at shutdown. Past it the
    // process exits anyway (each room still has its last per-action snapshot).
    restartSnapshotTimeoutMs: intWithDefault('RESTART_SNAPSHOT_TIMEOUT_MS', 5000),
  },

  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableConsole: process.env.LOG_CONSOLE !== 'false',
    enableFile: process.env.LOG_FILE === 'true',
    logDirectory: process.env.LOG_DIR || './logs',
  },

  // Per-game log capture (dev console → Game Logs). Every log line the server
  // can attribute to a room is ALSO kept in a per-room ring buffer so one
  // game's full timeline can be pulled after the fact
  // (GET /dev/api/rooms/<roomId>/logs). Entries outlive the room: a finished
  // game stays readable for `retentionMs` after its last line (default 2h).
  // See src/observability/GameLogStore.js.
  gameLog: {
    enabled: process.env.GAME_LOG_ENABLED !== 'false',
    // Capture level for the per-room buffer, independent of LOG_LEVEL: the
    // console can stay at `info` while a game's own log keeps `debug` lines.
    level: process.env.GAME_LOG_LEVEL || 'debug',
    retentionMs: intWithDefault('GAME_LOG_RETENTION_MS', 2 * 60 * 60 * 1000),
    maxEntriesPerRoom: intWithDefault('GAME_LOG_MAX_ENTRIES_PER_ROOM', 4000),
    maxTotalEntries: intWithDefault('GAME_LOG_MAX_TOTAL_ENTRIES', 400000),
    // JSONL file sink so a game's log survives a restart. Follows LOG_FILE
    // unless GAME_LOG_FILE is set explicitly.
    fileEnabled:
      process.env.GAME_LOG_FILE === undefined
        ? process.env.LOG_FILE === 'true'
        : process.env.GAME_LOG_FILE === 'true',
    fileDirectory: process.env.GAME_LOG_DIR || `${process.env.LOG_DIR || './logs'}/games`,
  },

  // Server-side bot worker. The worker runs in a child process so a bot strategy
  // crash cannot bring down the realtime socket process.
  bot: {
    enabled: process.env.BOT_COORDINATOR_ENABLED !== 'false',
    turnDelayMs: optionalInt('BOT_TURN_DELAY_MS'),
    // "Thinking" pause before the FIRST action of a bot's turn.
    turnDelayMinMs: intWithDefault('BOT_TURN_DELAY_MIN_MS', 1200),
    turnDelayMaxMs: intWithDefault('BOT_TURN_DELAY_MAX_MS', 2200),
    // Pause between CHAINED actions inside the same turn (meld -> meld ->
    // discard). This used to be dead config — the handler's broadcast re-entered
    // the coordinator and re-armed the full turn delay, so a 5-action turn cost
    // 6-11s. Chained actions now genuinely use these.
    followUpDelayMinMs: intWithDefault('BOT_FOLLOW_UP_DELAY_MIN_MS', 600),
    followUpDelayMaxMs: intWithDefault('BOT_FOLLOW_UP_DELAY_MAX_MS', 900),
    // ...but actions the client ANIMATES (meld / add / pile take / well take)
    // need the animation window to clear first: the online coordinator fires
    // those flights without a queue, so an overlapping second flight makes the
    // first completion clear the in-progress flag early and the meld area
    // repaints mid-air. A 3-card meld costs ~1.13s at the "slow" speed.
    animatedFollowUpDelayMinMs: intWithDefault('BOT_ANIMATED_FOLLOW_UP_DELAY_MIN_MS', 1150),
    animatedFollowUpDelayMaxMs: intWithDefault('BOT_ANIMATED_FOLLOW_UP_DELAY_MAX_MS', 1450),
    retryDelayMs: intWithDefault('BOT_RETRY_DELAY_MS', 600),
    recoveryDelayMs: intWithDefault('BOT_RECOVERY_DELAY_MS', 5000),
    workerCount: optionalInt('BOT_WORKER_COUNT'),
    // decide() is synchronous pure JS over <=22 cards, so this is a hang
    // detector for a wedged worker, not a latency budget. Every timeout costs a
    // full retry cycle of dead air, so keep it tight.
    decisionTimeoutMs: intWithDefault('BOT_DECISION_TIMEOUT_MS', 250),
    workerRestartDelayMs: intWithDefault('BOT_WORKER_RESTART_DELAY_MS', 1000),
  },

  // Backend API base URL, used to notify the backend when a room ends so it can
  // be removed from the lobby listing immediately (#3). e.g. http://localhost:8000
  backend: {
    url: process.env.BACKEND_URL || null,
    webhookSecret: process.env.WEBHOOK_SECRET || null,
  },

  // Per-room HOST heartbeat (lobby/WAITING rooms only). The server pings the host
  // socket every `intervalMs`; the host pongs. After `maxMisses` consecutive
  // missed pongs (~intervalMs × maxMisses ≈ 60s) the stuck lobby room is killed
  // (host swiped/killed the app, no leave/cancel REST ever fired). Distinct from
  // the global backend app-heartbeat below. See brazilia_host_heartbeat_contract.md.
  hostHeartbeat: {
    enabled: process.env.HOST_HEARTBEAT_ENABLED !== 'false',
    intervalMs: intWithDefault('HOST_HEARTBEAT_INTERVAL_MS', 10000),
    maxMisses: intWithDefault('HOST_HEARTBEAT_MAX_MISSES', 6),
  },

  // Socket handshake authentication. When `required` is true, every connection
  // must present a valid backend bearer token (verified via the backend
  // `/api/me` endpoint); the server then trusts the resolved user id instead of
  // the client-supplied playerId — closing seat impersonation. Default OFF for
  // backward compatibility: enable only after clients ship the token in the
  // handshake (coordinated deploy). Verification reuses /api/me, so a banned
  // user's token is rejected at the socket layer too.
  auth: {
    required: process.env.SOCKET_AUTH_REQUIRED === 'true',
    backendUrl: process.env.BACKEND_URL || null,
    verifyTimeoutMs: parseInt(process.env.SOCKET_AUTH_TIMEOUT_MS, 10) || 5000,
  },

  // Redis (persistence + reconnection). When neither url nor host is set the
  // server falls back to a non-durable in-memory store (single instance only).
  redis: {
    url: process.env.REDIS_URL || null,
    host: process.env.REDIS_HOST || null,
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || null,
    // Multi-node (PTW-43, Phase 1). When true the Socket.IO Redis adapter is
    // attached so room broadcasts fan out across nodes. Default OFF —
    // single-instance stays the safe default until the room-owner lease
    // (Phase 2) and soak test (Phase 6) land. See docs/DEPLOY_TOPOLOGY.md.
    // Enabling without a real Redis is a config error (validateConfig).
    adapterEnabled: process.env.REDIS_ADAPTER_ENABLED === 'true',
    // Connect timeout (ms) for the adapter pub/sub clients at boot. Exceeding
    // it is fatal: the adapter is fail-fast, never silently single-node.
    adapterConnectTimeoutMs: parseInt(process.env.REDIS_ADAPTER_CONNECT_TIMEOUT_MS, 10) || 10000,
  },

  // Cluster identity (PTW-43). Stable per-node id used for room-owner leases
  // and structured logs. Pin via NODE_ID for deterministic logs; otherwise a
  // hostname:pid:rand id is derived at boot in index.js.
  cluster: {
    nodeId: process.env.NODE_ID || null,
    // Per-room owner lease TTL (ms) and renewal cadence (Phase 2). The owner
    // node renews well within the TTL; if it dies the lease expires and another
    // node can take over.
    ownerLeaseTtlMs: parseInt(process.env.ROOM_OWNER_LEASE_TTL_MS, 10) || 15000,
    ownerLeaseRenewMs: parseInt(process.env.ROOM_OWNER_LEASE_RENEW_MS, 10) || 5000,
  },

  // Security
  security: {
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000, // 1 minute
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
    },
    webhookSecret: process.env.WEBHOOK_SECRET || null,
  },

  // Partner outbound webhook relay
  partnerWebhook: {
    url: process.env.PARTNER_WEBHOOK_URL || null,
    secret: process.env.PARTNER_WEBHOOK_SECRET || null,
    timeoutMs: parseInt(process.env.PARTNER_WEBHOOK_TIMEOUT_MS, 10) || 5000,
    retries: parseInt(process.env.PARTNER_WEBHOOK_RETRIES, 10) || 3,
    backoffMs: parseInt(process.env.PARTNER_WEBHOOK_RETRY_BACKOFF_MS, 10) || 500,
    outboxTtlSeconds: parseInt(process.env.PARTNER_WEBHOOK_OUTBOX_TTL_SECONDS, 10) || 86400,
    events: (
      process.env.PARTNER_WEBHOOK_EVENTS ||
      'game.completed,game.started,turn.completed,meld.played,card.drawn,player.status'
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  },
};

// Validate required configuration
const validateConfig = () => {
  const required = [];

  if (!config.server.port) {
    required.push('PORT');
  }

  // D2: in production a real, durable Redis is mandatory. The in-memory fallback
  // (redisClient.js) is single-instance only and silently drops every live game
  // on restart or scale-out. Refuse to boot rather than degrade invisibly.
  if (!config.redis.url && !config.redis.host) {
    required.push('REDIS_URL or REDIS_HOST');
  }

  if (required.length > 0) {
    throw new Error(`Missing required configuration: ${required.join(', ')}`);
  }
};

// The Redis adapter (multi-node fan-out) is meaningless without a real, shared
// Redis. Enforce in every environment, not just production: enabling the flag
// against the in-memory fallback would give a false sense of multi-node safety.
const validateAdapterConfig = () => {
  if (config.redis.adapterEnabled && !config.redis.url && !config.redis.host) {
    throw new Error(
      'REDIS_ADAPTER_ENABLED=true requires a real Redis (set REDIS_URL or REDIS_HOST). ' +
        'The in-memory fallback cannot fan out across nodes.'
    );
  }
};

validateAdapterConfig();

// Run validation in production
if (config.server.environment === 'production') {
  validateConfig();
}

module.exports = config;
