/**
 * Socket Event Handlers
 * Handles all Socket.IO events for the game
 */

const { SocketEvents, MatchmakingEvents, GameRoomStatus } = require('../constants');
const config = require('../config');
const { ActionHandlers } = require('../handlers');
const { ErrorHandler, rateLimiter } = require('../middleware');
const logger = require('../utils/logger');
const GameValidator = require('../validators/GameValidator');
const { Card } = require('../models/Deck');
const PlayerSession = require('../models/PlayerSession');
const metrics = require('../observability/metrics');
const { randomBytes } = require('crypto');
const { startBackendAttempt, abortBackendAttempt } = require('../services/BackendStartAttempt');

const ROOM_OWNER_ACTION_EVENT = '__brazilia_room_owner_action';

// Shown only when a viewer genuinely arrived without a name. Treated as a
// PLACEHOLDER everywhere, never as data: it must never overwrite a real name,
// and never be persisted onto a seat (see _addSpectator / handleClaimSeat).
const SPECTATOR_FALLBACK_NAME = 'Spectator';

// Display names are shown in every viewer's roster, so they are bounded like any
// other user-supplied text that reaches other people's screens. Matches the cap
// the chat sender resolver already applies.
const SPECTATOR_NAME_MAX = 32;

class SocketHandlers {
  // Upper bound for waiting on the clients' DEAL_ANIMATION_COMPLETE before
  // starting the first turn timer anyway. Comfortably longer than the client's
  // REFERENCE opening sequence (the 1v1 deal ~8s + setup ~1s + the first-turn
  // "undian" ~3.7s ≈ 13s; a client on the "fast" setting runs the same
  // sequence in ~7s) so it only acts as a safety net for a slow/old/backgrounded
  // client, never as the normal path. The normal path is every seated,
  // connected human reporting in — see _startFirstTurnTimerIfDealAcked.
  static get DEAL_ANIMATION_FALLBACK_MS() {
    return 18000;
  }

  static get MAX_CONSECUTIVE_INACTIVE_TURNS() {
    return 5;
  }

  /**
   * Offline strikes a player may collect in a ROUND before the match is called.
   * One strike per turn that comes around while they are disconnected and the
   * system resolves it without them.
   */
  static get MAX_OFFLINE_STRIKES() {
    return 4;
  }

  // R1 anti-freeze watchdog for an "Off" (unlimited) turn timer. "Off" hides the
  // countdown, but the turn must still be GUARANTEED to advance so an
  // un-completable turn or an unresponsive seat can never freeze the whole table
  // (every advance safety net — auto-play, force-advance, inactivity forfeit —
  // otherwise lived only inside the timer-expiry path, which "Off" never armed).
  // A connected seat gets a long silent bound so deliberate play is not cut
  // short; a disconnected seat gets a short one so a dead seat can't stall a live
  // game.
  static get UNLIMITED_TURN_WATCHDOG_MS() {
    return 120000; // 2 min
  }

  static get DISCONNECT_TURN_WATCHDOG_MS() {
    return 30000; // 30s — mirrors the reconnect grace window
  }

  // Pre-game (WAITING) seat-hold window: when a player drops before the game
  // starts, their seat is held this long so a swipe-killed host that reopens
  // rejoins the SAME room (joinRoom reconnect path) instead of finding it deleted
  // and getting "Room is not ready" (A1). Mirrors FailureManager's 30s grace.
  static get WAITING_GRACE_MS() {
    return 30000;
  }

  /**
   * The longest `handleGetGameState` will wait behind an in-flight `join_room`
   * before answering anyway.
   *
   * The join normally settles in microseconds-to-milliseconds (in-memory room,
   * a couple of Redis round trips). The ONE slow branch is
   * `_rebuildRoomFromBackend`, which calls Node's `fetch` — and Node's fetch has
   * no default timeout at all, so a stalled backend would otherwise hang the
   * deferred state request forever. 2 s is far beyond any healthy join and still
   * comfortably inside the client's 6 s resume-probe window, so a capped answer
   * (even an error) reaches the client in time for it to retry rather than
   * conclude the socket is dead.
   */
  static get JOIN_WAIT_CAP_MS() {
    return 2000;
  }

  // How often the socket tells the backend which rooms are genuinely alive (have
  // ≥1 connected human). The backend bumps those rooms' updated_at; rooms that
  // stop heartbeating go stale and become eligible for the age-based reaper. This
  // liveness signal is what makes the backend's force-detach safe (B2).
  static get HEARTBEAT_MS() {
    return 60000;
  }

  /**
   * How long one heartbeat POST may take before it is abandoned. Node's fetch has
   * NO default timeout: without this a backend that accepts the connection and
   * then stalls leaves the request hanging forever, and the beat is silently lost.
   */
  static get HEARTBEAT_TIMEOUT_MS() {
    return parseInt(process.env.BURACO_HEARTBEAT_TIMEOUT_MS, 10) || 10000;
  }

  /**
   * Extra attempts per beat. The backend hides any room whose last heartbeat is
   * older than its freshness window, so a LOST beat is not a lost log line — it
   * is every live room vanishing from the lobby at once. One retry turns a
   * transient 502/reset from a user-visible outage into a non-event.
   */
  static get HEARTBEAT_MAX_RETRIES() {
    return parseInt(process.env.BURACO_HEARTBEAT_MAX_RETRIES, 10) || 1;
  }

  /** Pause before a retry. Read at call time so tests can drive it to 0. */
  static get HEARTBEAT_RETRY_DELAY_MS() {
    const raw = process.env.BURACO_HEARTBEAT_RETRY_DELAY_MS;
    return raw === undefined ? 3000 : parseInt(raw, 10) || 0;
  }

  constructor(
    io,
    gameService,
    matchmakingQueue = null,
    failureManager = null,
    partnerWebhookRelay = null,
    ownership = {}
  ) {
    this.io = io;
    this.gameService = gameService;
    this.matchmakingQueue = matchmakingQueue;
    this.failureManager = failureManager;
    this.roomSpectators = new Map();
    // Admin-wide skin override: { skins, expiresAt, setBy, setAt } or null.
    this.globalSkinOverride = null;
    this._globalSkinOverrideTimer = null;
    this.partnerWebhookRelay = partnerWebhookRelay;
    this.spectatorSocketToRoom = new Map();
    this.botCoordinator = null;
    this.roomOwnerLease = ownership.roomOwnerLease || null;
    this.nodeId = ownership.nodeId || null;
    this.ownerLeaseRenewMs = ownership.renewMs || config.cluster.ownerLeaseRenewMs;
    this.ownedRoomIds = new Set();
    this.ownerRenewTimers = new Map();
    this._ownerActionListenerRegistered = false;
    // Graceful-restart drain (deploy). While true, socket closures are the
    // process shutting down on purpose — not players leaving — and
    // handleDisconnect must not enter grace / broadcast / notify the backend.
    // See beginRestartDrain().
    this.restartDraining = false;
    // socketId -> last chat send timestamp (ms). Light per-socket throttle so the
    // in-game chat can't be spammed; uses its own clock (not the game action
    // rate limiter) so a chatty player never trips the "too many actions" guard.
    this._lastChatAt = new Map();

    // socketId -> a promise that settles when that socket's in-flight
    // `join_room` has finished. `handleJoinRoom` is async and awaits Redis
    // (FailureManager.handlePlayerConnection / clearGraceForReconnect), and
    // Socket.IO does NOT wait for one handler before delivering the next packet
    // — so a client that emits `join_room` and then `get_game_state` back to
    // back (which is exactly what the Flutter client's reconnect does, in that
    // deliberate order) has its state request run DURING the join's awaits,
    // while the seat is still bound to the socket it just lost. See
    // `handleGetGameState`.
    this._pendingJoins = new Map();
    // Room/player scope also serializes retries arriving on a replacement socket.
    this._pendingSeatClaims = new Map();
    this._seatMutations = new Map();
    // A timed-out refund may still commit at the API. Never admit that same
    // reservation again until its rejection has been reconciled.
    this._unresolvedSeatRejections = new Map();

    // `${roomId}:${playerId}` -> setTimeout id. Pending pre-game seat-hold leaves
    // (A1): a WAITING-phase disconnect schedules the real leave/teardown here and
    // a reconnect within the grace window cancels it.
    this._waitingGraceTimers = new Map();
    this._pendingBackendLeaves = new Map();

    // roomId -> { reason, backendBaseUrl }. Stashed just before a room is deleted
    // so the onRoomDeleted → _notifyBackendRoomClosed hook (which only receives a
    // roomId) can still forward the kill `reason` and the room's per-backend
    // callback base URL after the room object is gone. Consumed (deleted) on read.
    this._roomCloseContext = new Map();

    // Whenever the realtime layer tears a room down (empty, host left, abandoned,
    // inactivity sweep, game over), tell the backend to delist it.
    if (this.gameService) {
      this.gameService.onRoomDeleted = (roomId, everHadPlayers, backendBaseUrl = null) => {
        // Read ownership BEFORE _stopOwningRoom clears it: only the node that
        // owned the room may drop its Redis snapshot (see the purge below).
        const ownedHere = !this._ownershipEnabled() || this.ownedRoomIds.has(String(roomId));
        this._stopOwningRoom(roomId, 'room_deleted');
        this.botCoordinator?.unregisterRoom(roomId);
        // P1-10: drop spectator bookkeeping for the deleted room so the
        // roomSpectators / spectatorSocketToRoom maps don't leak entries for
        // rooms that no longer exist.
        this._clearRoomSpectators(roomId);
        // Drop the Redis snapshot too. It is rewritten after every action and
        // only expires with its 2h TTL, so without this a deleted room came back
        // as a zombie on the next restart within that window (loadPersistedGames
        // also refuses ended snapshots now — this is the other half). Owner-only:
        // a node dropping a passive read-copy, or one whose lease has moved on,
        // must NOT erase the state another node is still playing from — that
        // snapshot is exactly what cross-node rehydration reads.
        if (ownedHere) {
          this.failureManager?.removePersistedGame?.(roomId)?.catch?.((err) =>
            logger.warn(`[ROOM_DELETE] Failed to purge persisted state for ${roomId}: ${err.message}`)
          );
        }
        // Notify the backend when the room ever had players OR this was an
        // INTENTIONAL kill (host-gone): a host who swiped the app away in the
        // ~1s window between REST-create and socket-join never set everHadPlayers,
        // yet that un-joined phantom lobby is EXACTLY what the kill must delist
        // (and refund). The presence of a stashed close-context marks the kill.
        // disposeTimers() (called by _deleteRoom) already cleared the heartbeat
        // interval, so no _stopHostHeartbeat is needed here. backendBaseUrl was
        // captured before disposal so the webhook routes to the right backend.
        const intentionalKill = this._roomCloseContext.has(String(roomId));
        if (everHadPlayers || intentionalKill) {
          this._notifyBackendRoomClosed(roomId, null, backendBaseUrl);
        }
      };

      // Emit ROOM_CLOSED to any sockets still in a room that GameService is about
      // to delete via its OWN teardown paths (the 30-min inactivity sweep, the
      // in-progress all-humans-gone reaper). GameService holds no io reference, so
      // without this hook those deletions silently strand idle players/spectators
      // in a room the backend has already closed. The explicit kill/cancel paths
      // emit ROOM_CLOSED themselves, so they do NOT route through here.
      this.gameService.onRoomClosing = (roomId, reason) => {
        this.io.to(roomId).emit(SocketEvents.ROOM_CLOSED, {
          reason: reason || 'closed',
          message: 'Room ditutup',
          timestamp: Date.now(),
        });
      };
    }

    this._registerOwnerActionListener();

    if (this.failureManager) {
      this.failureManager.ensureRoomOwnerForMutation = (roomId) =>
        this._ensureRoomOwner(roomId);

      // PTW-235 / Bug4a: let the failure manager pause the active turn timer
      // while a disconnected human is within grace, and resume it (with the
      // time that was left) on reconnect — so a returning player's turn is
      // never auto-played/skipped out from under them.
      this.failureManager.turnTimerControl = {
        pause: (room) => this._pauseTurnTimerForGrace(room),
        resume: (room) => this._resumeTurnTimerAfterGrace(room),
      };

      // A3: when a disconnected human's grace expires and they are replaced by a
      // bot, detach that user from the backend lobby/link immediately so they are
      // not left trapped pointing at a room they no longer occupy, and so the
      // lobby occupancy reflects reality. `inProgress` tells the backend NOT to
      // close the room (bots — and possibly other humans — are still playing).
      this.failureManager.notifyBackendSeatVacated = (roomId, playerId, room) => {
        this._notifyBackendPlayerLeft(roomId, playerId, true, room?.getPlayer(playerId), room);
        this._notifyBackendPlayerCount(roomId, room?.players?.size ?? 0);
      };
    }

    this._startBackendHeartbeat();
  }

  _ownershipEnabled() {
    return Boolean(this.roomOwnerLease);
  }

  _registerOwnerActionListener() {
    if (!this._ownershipEnabled() || this._ownerActionListenerRegistered) return;
    if (!this.io || typeof this.io.on !== 'function') return;

    this.io.on(ROOM_OWNER_ACTION_EVENT, async (payload = {}, ack) => {
      const respond = (response) => {
        if (typeof ack === 'function') ack(response);
        return response;
      };

      try {
        const roomId = payload.roomId == null ? null : String(payload.roomId);
        if (!roomId || !payload.handlerName) {
          return respond({ success: false, error: 'Invalid owner action payload' });
        }
        if (payload.targetOwnerId && payload.targetOwnerId !== this.nodeId) {
          return respond({ success: false, ignored: true, error: 'Not target owner' });
        }

        const ownership = await this._ensureRoomOwner(roomId, { acquire: false });
        if (!ownership.owned) {
          return respond({ success: false, ignored: true, owner: ownership.owner || null });
        }

        const room = this.gameService.getRoom(roomId);
        if (!room) {
          return respond({ success: false, error: 'Owner has no room runtime' });
        }

        const previousPlayerId = this.gameService.socketToPlayer.get(payload.socketId);
        if (payload.playerId) {
          this.gameService.socketToPlayer.set(payload.socketId, String(payload.playerId));
        }
        let result;
        try {
          const forwardedSocket = this._createForwardedSocket(payload.socketId);
          result = logger.runWithRoom(roomId, () =>
            this._invokeForwardedOwnerAction(
              payload.handlerName,
              forwardedSocket,
              payload.data || {}
            )
          );
        } finally {
          if (previousPlayerId) {
            this.gameService.socketToPlayer.set(payload.socketId, previousPlayerId);
          } else {
            this.gameService.socketToPlayer.delete(payload.socketId);
          }
        }
        return respond(result || { success: true });
      } catch (error) {
        logger.error(`[ROOM_OWNER] Forwarded action failed: ${error.message}`, error);
        return respond({ success: false, error: error.message });
      }
    });

    this._ownerActionListenerRegistered = true;
  }

  async _ensureRoomOwner(roomId, options = {}) {
    if (!this._ownershipEnabled()) return { owned: true, owner: this.nodeId || 'local' };

    const normalizedRoomId = String(roomId);
    const acquire = options.acquire !== false;

    if (this.ownedRoomIds.has(normalizedRoomId)) {
      const renewed = await this.roomOwnerLease.renew(normalizedRoomId);
      if (renewed) return { owned: true, owner: this.nodeId };
      this._stopOwningRoom(normalizedRoomId, 'lease_lost');
    }

    if (acquire) {
      const acquired = await this.roomOwnerLease.acquire(normalizedRoomId);
      if (acquired) {
        this._startOwningRoom(normalizedRoomId);
        await this._recoverOwnedRoomRuntime(normalizedRoomId);
        return { owned: true, owner: this.nodeId };
      }
    }

    const owner = await this.roomOwnerLease.getOwner(normalizedRoomId);
    const localRoom = this.gameService.getRoom(normalizedRoomId);
    if (localRoom) this._stopTurnTimer(localRoom);
    this.botCoordinator?.unregisterRoom(normalizedRoomId);
    return { owned: false, owner };
  }

  _startOwningRoom(roomId) {
    const normalizedRoomId = String(roomId);
    this.ownedRoomIds.add(normalizedRoomId);
    if (this.ownerRenewTimers.has(normalizedRoomId)) return;

    const timer = setInterval(async () => {
      try {
        const renewed = await this.roomOwnerLease.renew(normalizedRoomId);
        if (!renewed) {
          this._stopOwningRoom(normalizedRoomId, 'renew_failed');
        }
      } catch (error) {
        logger.error(`[ROOM_OWNER] Renew failed for ${normalizedRoomId}: ${error.message}`);
        this._stopOwningRoom(normalizedRoomId, 'renew_error');
      }
    }, this.ownerLeaseRenewMs);
    timer.unref?.();
    this.ownerRenewTimers.set(normalizedRoomId, timer);
  }

  _stopOwningRoom(roomId, reason = 'stopped') {
    const normalizedRoomId = String(roomId);
    const wasOwned = this.ownedRoomIds.has(normalizedRoomId);
    this.ownedRoomIds.delete(normalizedRoomId);
    const timer = this.ownerRenewTimers.get(normalizedRoomId);
    if (timer) {
      clearInterval(timer);
      this.ownerRenewTimers.delete(normalizedRoomId);
    }
    const room = this.gameService?.getRoom?.(normalizedRoomId);
    if (room) this._stopTurnTimer(room);
    this.botCoordinator?.unregisterRoom(normalizedRoomId);
    if (wasOwned || timer) {
      logger.info(
        `[ROOM_OWNER] Node ${this.nodeId || 'local'} stopped owning ${normalizedRoomId} (${reason})`
      );
    }
  }

  async _recoverOwnedRoomRuntime(roomId) {
    let room = this.gameService.getRoom(roomId);
    if (!room && this.failureManager?.restorePersistedRoom) {
      room = await this.failureManager.restorePersistedRoom(roomId);
    }
    if (!room) return null;

    if (
      room.isInProgress?.() &&
      room.cardsDealt &&
      !room.awaitingDealAnimation &&
      !room.turnTimerTickHandle
    ) {
      this._startTurnTimer(room);
    } else if (room.isInProgress?.()) {
      this.botCoordinator?.onRoomStateChanged(room);
    } else if (room.awaitingNextRound) {
      // #11 multi-round: the room was mid-intermission when this node lost/gained
      // it. The timer handle did not survive, only the persisted deadline — re-arm
      // off the REMAINING time, or the match is stuck in FINISHED forever.
      this._scheduleNextRound(room, this._remainingNextRoundMs(room));
    }
    return room;
  }

  /**
   * Boot resume (server restart resilience). loadPersistedGames() rehydrates the
   * room DATA into memory on (re)start, but the turn timers, bot registry, and
   * grace timers are all in-memory — they are gone after a restart, so every
   * restored game would sit frozen ("the session is lost") until a human happens
   * to reconnect. Walk every restored in-progress room and restart its runtime:
   *   1. re-register bot seats (the BotCoordinator registry is wiped on restart),
   *   2. re-arm grace→bot expiry for seats persisted mid-grace (so a player who
   *      never returns after the restart is still replaced by a bot),
   *   3. re-arm the turn timer / hand the room to the BotCoordinator
   *      (_recoverOwnedRoomRuntime).
   * Under cluster ownership we only resume rooms this node can lease; single-node
   * (the default, replicas=1) resumes everything restored. Per-room failures are
   * logged and never abort the rest of the resume.
   */
  async resumePersistedRooms() {
    const rooms = this.gameService?.rooms;
    if (!rooms || rooms.size === 0) return 0;
    let resumed = 0;
    for (const roomId of Array.from(rooms.keys())) {
      try {
        // Scoped per room so every line (and every timer re-armed here) lands
        // in that game's log.
        const didResume = await logger.runWithRoom(roomId, () =>
          this._resumePersistedRoom(roomId)
        );
        if (didResume) resumed += 1;
      } catch (err) {
        logger.warn(`[RESUME] Failed to resume room ${roomId}: ${err.message}`);
      }
    }
    if (resumed > 0) {
      logger.warn(`[RESUME] Resumed ${resumed} persisted in-progress room(s) after restart`);
    }
    return resumed;
  }

  /**
   * Resume ONE persisted room after a restart (see resumePersistedRooms).
   * @param {string} roomId
   * @returns {Promise<boolean>} true when the room's runtime was re-armed
   */
  async _resumePersistedRoom(roomId) {
    const room = this.gameService.getRoom(roomId);
    // #11 multi-round: also resume rooms parked in the round-over
    // intermission. They are FINISHED, so the isInProgress() gate alone
    // skipped them and a restart during the round-over card silently lost the
    // match (no timer re-armed, and the room then sat until GameService's
    // 1-hour FINISHED sweep).
    if (!room) return false;
    if (!room.isInProgress?.() && !room.awaitingNextRound) {
      // A restored LOBBY (single-node): its seats point at sockets that died
      // with the old process. Treat each human like a pre-game drop — seat
      // held, then the normal waiting-leave (host-gone kills the lobby) — but
      // over the restart window, not the 30s network grace, so a lobby is not
      // torn down while its players are still reconnecting.
      if (room.status === GameRoomStatus.WAITING && !this._ownershipEnabled()) {
        const holdMs = Math.max(SocketHandlers.WAITING_GRACE_MS, Number(config.game.restartHoldMs) || 60000);
        let held = 0;
        for (const player of room.getPlayers?.() || []) {
          if (!player || player.isBot === true) continue;
          player.socketId = null;
          if (typeof player.disconnect === 'function') player.disconnect();
          this._scheduleWaitingLeave(room.roomId, player.playerId, holdMs);
          held += 1;
        }
        if (held > 0) {
          logger.warn(`[RESUME] Lobby ${room.roomId}: ${held} seat(s) held ${holdMs}ms for reconnect after restart`);
        }
      }
      return false;
    }

    if (this._ownershipEnabled()) {
      // Acquiring the lease already runs _recoverOwnedRoomRuntime for owned
      // rooms; skip rooms another live node owns.
      const ownership = await this._ensureRoomOwner(roomId, { acquire: true });
      if (!ownership?.owned) return false;
    }

    // SINGLE-NODE (the documented production topology): the restart severed
    // every socket, so no human of this room is connected to this process yet.
    // Mark every human seat as awaiting reconnect and HOLD the room — no turn
    // timer, no bot move, no next-round deal — until one of them rejoins or the
    // hold expires. Kicking the runtime at boot instead meant: the current turn
    // ran out against an empty chair (auto-play / offline strike for a deploy
    // the player never caused), bots played into a table nobody was watching,
    // and an intermission re-deal fired into "no humans connected" and settled
    // the match. Under cluster ownership the humans may be live on another node
    // and the runtime resumed on the lease above; that path is unchanged.
    if (!this._ownershipEnabled()) {
      this.failureManager?.rearmGraceTimers?.(room, { allHumanSeats: true });
      this._holdRoomForRestart(room);
      return true;
    }

    if (room.awaitingNextRound) {
      // Nothing below applies to an intermission (no turn in flight, no
      // mid-turn grace): just re-arm the deal and move on.
      this._scheduleNextRound(room, this._remainingNextRoundMs(room));
      return true;
    }

    // Bot registry is in-memory → re-register every bot seat so the
    // coordinator knows which seats it must drive after the restart.
    this._reregisterRoomBots(room);

    // Re-arm grace→bot for seats that were mid-grace at persist time so a
    // player who never reconnects post-restart is still replaced.
    this.failureManager?.rearmGraceTimers?.(room);
    return true;
  }

  /** Bot registry is in-memory: re-register every bot seat of a restored room. */
  _reregisterRoomBots(room) {
    for (const player of room?.getPlayers?.() || []) {
      if (player && (player.isBot || player.status === 'bot')) {
        this.botCoordinator?.registerBot(room.roomId, player.playerId);
      }
    }
  }

  /**
   * Deploy-restart hold. Park a restored room with NO runtime until a human
   * rejoins (_releaseRestartHold from the join_room reconnect path) or
   * config.game.restartHoldMs elapses. Idempotent per room.
   * @param {import('../models/GameRoom')} room
   */
  _holdRoomForRestart(room) {
    if (!room || room.restartHold) return;
    const holdMs = Math.max(1000, Number(config.game.restartHoldMs) || 60000);
    room.restartHold = {
      since: Date.now(),
      untilMs: Date.now() + holdMs,
      remainingTurnMs: room.restoredTurnRemainingMs,
    };
    room.restartHoldHandle = setTimeout(
      logger.bindRoom(room.roomId, () => {
        room.restartHoldHandle = null;
        this._releaseRestartHold(room, 'hold_expired');
      }),
      holdMs
    );
    room.restartHoldHandle.unref?.();
    metrics.increment('buraco_restart_hold_total');
    this._logRoomLifecycle('restart_hold_started', {
      roomId: room.roomId,
      holdMs,
      awaitingNextRound: room.awaitingNextRound === true,
      currentTurn: room.currentTurn,
      remainingTurnMs: room.restoredTurnRemainingMs,
    });
    logger.warn(
      `[RESUME] Room ${room.roomId} held for up to ${holdMs}ms after restart — runtime resumes when a player rejoins`
    );
  }

  /**
   * Release a deploy-restart hold and start the room's runtime exactly where
   * the previous process left it: the interrupted turn gets the time it had
   * left at shutdown (floored at config.game.restartMinTurnMs), an intermission
   * gets its remaining countdown, bots are re-registered. No-op when the room is
   * not held. Safe to call from the join path for every rejoin.
   * @param {import('../models/GameRoom')} room
   * @param {string} reason
   * @returns {boolean} true when a hold was actually released
   */
  _releaseRestartHold(room, reason = 'released') {
    if (!room || !room.restartHold) return false;
    const hold = room.restartHold;
    room.restartHold = null;
    if (room.restartHoldHandle) {
      clearTimeout(room.restartHoldHandle);
      room.restartHoldHandle = null;
    }
    const heldMs = Date.now() - hold.since;
    this._logRoomLifecycle('restart_hold_released', {
      roomId: room.roomId,
      reason,
      heldMs,
      status: room.status,
      awaitingNextRound: room.awaitingNextRound === true,
    });
    logger.warn(`[RESUME] Room ${room.roomId} hold released (${reason}) after ${heldMs}ms`);

    if (room.awaitingNextRound) {
      this._scheduleNextRound(room, this._remainingNextRoundMs(room));
      return true;
    }
    if (!room.isInProgress?.()) return true;

    this._reregisterRoomBots(room);
    if (room.cardsDealt && !room.awaitingDealAnimation && !room.turnTimerTickHandle) {
      const minTurnMs = Math.max(1000, Number(config.game.restartMinTurnMs) || 10000);
      const remaining =
        Number.isFinite(hold.remainingTurnMs) && hold.remainingTurnMs > 0
          ? Math.max(hold.remainingTurnMs, minTurnMs)
          : undefined;
      this._startTurnTimer(room, remaining);
    } else {
      this.botCoordinator?.onRoomStateChanged(room);
    }
    return true;
  }

  /**
   * Graceful-restart drain, called by index.js at the top of shutdown BEFORE
   * any socket is closed. Flips handleDisconnect into drain mode (socket
   * closures are not player leaves) and tells every client the disconnect
   * that follows is a deploy: keep the session, auto-reconnect, rejoin.
   * @param {{message?: string}} [options]
   * @returns {number} sockets notified
   */
  beginRestartDrain({ message } = {}) {
    if (this.restartDraining) return 0;
    this.restartDraining = true;
    const payload = {
      resume: true,
      holdMs: Number(config.game.restartHoldMs) || 60000,
      timestamp: new Date().toISOString(),
    };
    if (typeof message === 'string' && message.trim()) payload.message = message.trim().slice(0, 300);
    let notified = 0;
    try {
      notified = this.io?.sockets?.sockets?.size || 0;
      this.io?.emit?.(SocketEvents.SERVER_RESTARTING, payload);
    } catch (error) {
      logger.warn(`[SHUTDOWN] server_restarting broadcast failed: ${error.message}`);
    }
    logger.warn(`[SHUTDOWN] Restart drain started — ${notified} socket(s) notified, disconnects are not player leaves`);
    return notified;
  }

  /**
   * Cross-node room rehydration for join (PTW-90, Phase 3).
   *
   * When a player lands on a node that does not hold the room in memory — the
   * normal case after the owner node crashed and the load balancer routed the
   * player/reconnect elsewhere — read the room's persisted runtime from Redis
   * (written by FailureManager.persistGameState after every action) and
   * reconstruct it locally. Then attempt controlled owner re-election:
   *   - If the previous owner's lease has expired (it crashed and stopped
   *     renewing), this node wins the lease and `_recoverOwnedRoomRuntime`
   *     restarts the turn timer / bot engine so the room resumes deterministically.
   *   - If the lease is still held by a live owner elsewhere, the acquire fails
   *     and we keep a passive read-copy (no timers): this node forwards mutations
   *     to the owner and relays broadcasts via the Redis adapter.
   *
   * Returns the rehydrated room, or null when no persisted state exists (the
   * room genuinely was never synced) so the caller falls back to rejecting.
   */
  async _rehydrateRoomForJoin(roomId, requestId = null) {
    if (!this.failureManager?.restorePersistedRoom) return null;

    let room;
    try {
      room = await this.failureManager.restorePersistedRoom(roomId);
    } catch (error) {
      logger.error(`[JOIN_ROOM] Rehydrate failed for ${roomId}: ${error.message}`);
      return null;
    }
    if (!room) return null;

    let ownership = { owned: false, owner: null };
    try {
      if (this._ownershipEnabled()) {
        // acquire:true → take over the lease iff the old owner's lease expired,
        // and `_recoverOwnedRoomRuntime` restarts runtime on a successful acquire.
        ownership = await this._ensureRoomOwner(roomId, { acquire: true });
      } else {
        // Single-node (no lease registry): restart the room runtime directly.
        await this._recoverOwnedRoomRuntime(roomId);
        ownership = { owned: true, owner: this.nodeId || 'local' };
      }
    } catch (error) {
      logger.error(`[JOIN_ROOM] Ownership takeover failed for ${roomId}: ${error.message}`);
    }

    this._logRoomLifecycle('room_rehydrated_for_join', {
      roomId,
      requestId,
      owned: ownership.owned,
      owner: ownership.owner || null,
      nodeId: this.nodeId || null,
    });
    logger.warn(
      `[JOIN_ROOM] Rehydrated room ${roomId} from persisted state ` +
        `(owner=${ownership.owned ? `self:${this.nodeId || 'local'}` : ownership.owner || 'remote'})`
    );

    // Self-heal: a room that FINISHED before this node lost it is rehydrated with
    // resultReported=false (that flag is not persisted) and its lastRoundEndPayload
    // restored. The settlement game-result webhook is fire-and-forget and can be
    // lost across a restart, leaving the backend stuck IN_PROGRESS — it keeps
    // LISTING the finished room, so players tap it and loop back into GAME_ENDED.
    // Re-fire the settlement now (idempotent on the socket via resultReported AND
    // on the backend via settled_at) so it settles + delists. backendBaseUrl is
    // restored from the persisted state above, so it routes to the right backend.
    if (room.hasEnded && room.hasEnded()) {
      const endWinnerId =
        room.winnerId != null
          ? room.winnerId
          : room.lastRoundEndPayload && room.lastRoundEndPayload.winnerId;
      this._notifyBackendGameResult(room, endWinnerId);
    }
    return room;
  }

  async _releaseOwnedRooms() {
    if (!this._ownershipEnabled()) return;
    const roomIds = Array.from(this.ownedRoomIds);
    for (const roomId of roomIds) {
      this._stopOwningRoom(roomId, 'shutdown');
      try {
        await this.roomOwnerLease.release(roomId);
      } catch (error) {
        logger.warn(`[ROOM_OWNER] Release failed for ${roomId}: ${error.message}`);
      }
    }
  }

  _createForwardedSocket(socketId) {
    return {
      id: socketId,
      handshake: { headers: {} },
      data: {},
      join: () => {},
      leave: () => {},
      emit: (event, payload) => this.io.to(socketId).emit(event, payload),
      to: (roomId) => {
        const target = this.io.to(roomId);
        if (typeof target.except === 'function') {
          return {
            emit: (event, payload) => target.except(socketId).emit(event, payload),
          };
        }
        return target;
      },
    };
  }

  _invokeForwardedOwnerAction(handlerName, socket, data) {
    const allowed = new Set([
      'handleDrawCard',
      'handlePlayMeld',
      'handleDiscardCard',
      'handleGoDown',
      'handleAddToMeld',
      'handlePickUpPile',
      'handleTakePozzetto',
      'handleUndoMeld',
    ]);
    if (!allowed.has(handlerName) || typeof this[handlerName] !== 'function') {
      return { success: false, error: `Unsupported owner action: ${handlerName}` };
    }
    this[handlerName](socket, data);
    return { success: true };
  }

  _emitNotOwner(socket, roomId, ownerNodeId) {
    socket.emit(SocketEvents.ERROR, {
      ...ErrorHandler.createErrorResponse('Room action must be handled by the room owner node'),
      code: 'ROOM_NOT_OWNER',
      roomId,
      ownerNodeId: ownerNodeId || null,
      nodeId: this.nodeId || null,
    });
  }

  async _forwardMutationToOwner(socket, room, handlerName, data, ownerNodeId, playerId = null) {
    if (!this.io || typeof this.io.serverSideEmitWithAck !== 'function') {
      this._emitNotOwner(socket, room.roomId, ownerNodeId);
      return { success: false, error: 'Server-side forwarding unavailable' };
    }

    const responses = await this.io.serverSideEmitWithAck(ROOM_OWNER_ACTION_EVENT, {
      roomId: room.roomId,
      targetOwnerId: ownerNodeId || null,
      handlerName,
      socketId: socket.id,
      playerId,
      data,
      requestedByNodeId: this.nodeId || null,
    });
    const handled = (responses || []).find((response) => response && response.success);
    if (handled) return handled;

    const errorResponse = (responses || []).find((response) => response && !response.ignored);
    this._emitNotOwner(socket, room.roomId, ownerNodeId);
    return errorResponse || { success: false, error: 'Owner did not handle action' };
  }

  async _runOwnedSocketMutation(socket, data, handlerName) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(playerId);
    if (!room) {
      this[handlerName](socket, data);
      return { success: false, error: 'Not in a room' };
    }

    const ownership = await this._ensureRoomOwner(room.roomId);
    if (ownership.owned) {
      this[handlerName](socket, data);
      return { success: true };
    }

    return this._forwardMutationToOwner(socket, room, handlerName, data, ownership.owner, playerId);
  }

  _emitPartnerWebhook(eventName, payload = {}) {
    if (!this.partnerWebhookRelay) return;
    if (eventName === 'game.started') {
      const room = this.gameService.getRoom(payload.roomId);
      if (room?.startAttemptId) payload = { ...payload, attemptId: room.startAttemptId };
    }
    this.partnerWebhookRelay.dispatch(eventName, payload);
  }

  _persistRoomState(room) {
    if (!room || !this.failureManager?.persistGameState) return;
    this.failureManager.persistGameState(room).catch((error) => {
      logger.error('[STATE_PERSIST] failed', {
        source: 'socket',
        roomId: room.roomId,
        error: error.message,
      });
    });
  }

  _logRoomLifecycle(event, payload = {}) {
    logger.info(`[ROOM_LIFECYCLE] ${event}`, {
      source: 'socket',
      event,
      ...payload,
    });
  }

  /**
   * One structured line per GAME-LEVEL fact (deal, draw, discard, meld, take,
   * timeout, round end, seat comes/goes). This is the human-readable spine of a
   * room's per-game log: the dev console renders `[GAME]` lines as sentences
   * with card chips, and `?q=[GAME]` on the logs API gives the bare narrative
   * without the protocol chatter. Cards travel as `{suit, rank, cardId}`.
   * @param {GameRoom} room
   * @param {string} type
   * @param {object} [payload]
   */
  _gameEvent(room, type, payload = {}) {
    if (!room) return;
    logger.info(`[GAME] ${type}`, { roomId: room.roomId, game: type, ...payload });
  }

  /** Compact card for _gameEvent payloads. */
  _briefCard(card) {
    if (!card) return null;
    return { suit: card.suit, rank: card.rank, cardId: card.cardId ?? card.instanceId ?? null };
  }

  _briefCards(cards) {
    return Array.isArray(cards) ? cards.map((c) => this._briefCard(c)).filter(Boolean) : [];
  }

  _extractTurnTimeLimitSeconds(data = {}) {
    const raw = data.turnTimeLimitSeconds ?? data.turnTimeLimit;
    if (raw === undefined || raw === null || raw === '') return null;

    const seconds = Math.round(Number(raw));
    if (!Number.isFinite(seconds)) return null;

    // 0 (or any non-positive value) means "Off" = NO turn limit (unlimited turn),
    // NOT 5 seconds. Distinct from `null` (field absent → caller keeps the default).
    if (seconds <= 0) return 0;

    // Positive values are clamped to keep rooms playable and avoid multi-hour timers.
    return Math.min(600, Math.max(5, seconds));
  }

  _extractMaxPlayers(data = {}) {
    const raw = data.maxPlayers ?? data.max_players;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) return null;
    return value;
  }

  _findRoomControlledBySocket(socketId) {
    for (const room of this.gameService.rooms.values()) {
      if (room.ownerControllerSocketId === socketId) {
        return room;
      }
    }
    return null;
  }

  _resolveWaitingRoomControl(socket, data = {}) {
    const mappedPlayerId = this.gameService.getPlayerIdBySocket(socket.id);
    const playerId =
      mappedPlayerId ||
      (socket.data?.authenticated && socket.data.userId != null
        ? String(socket.data.userId)
        : null);
    const roomId =
      data.roomId ||
      data.gameId ||
      (playerId ? this.gameService.getPlayerRoom(playerId)?.roomId : null);
    let room = roomId ? this.gameService.getRoom(roomId) : null;
    if (!room) {
      room = this._findRoomControlledBySocket(socket.id);
    }
    const isHostPlayer = Boolean(playerId && String(room?.hostPlayerId) === String(playerId) &&
      this._socketOwnsSeat(socket, room?.getPlayer(playerId)));
    const isOwnerController = Boolean(room?.ownerControllerSocketId === socket.id);
    return { playerId, room, isHostPlayer, isOwnerController };
  }

  /**
   * Apply the Brazilia-pro room settings carried in a sync-room (or start-game)
   * payload: #11 target score (default from config.game when omitted), the
   * option, and the chat toggle. Idempotent — safe to call on every sync.
   * @param {import('../models/GameRoom')} room
   * @param {Object} data sync-room payload
   */
  _applyRoomSettings(room, data = {}) {
    // Apply a config DEFAULT only the FIRST time a room is configured. On later
    // (possibly partial) syncs an OMITTED field is left UNCHANGED — so a room
    // deliberately set to single-round (targetScore=0) is never
    // reverted to the default by a sync that simply doesn't carry the field
    // (e.g. _rebuildRoomFromBackend). An explicitly-present value always wins,
    // including an explicit 0 / false. (chatEnabled was already revert-safe.)
    const firstConfigure = !room._settingsInitialized;

    // #11 target score: 0 = single round; otherwise the match ends when a side's
    // cumulative total reaches it.
    if (data.targetScore !== undefined && data.targetScore !== null && data.targetScore !== '') {
      const ts = Number(data.targetScore);
      if (Number.isFinite(ts) && ts >= 0) room.targetScore = Math.round(ts);
    } else if (firstConfigure && (!Number.isFinite(Number(room.targetScore)) || room.targetScore === 0)) {
      // Omitted on the first configure and still at the constructor sentinel —
      // seed the config default so a PRO room is multi-round by default.
      room.targetScore = config.game.targetScore;
    }

    // #11 multi-round: optional per-room intermission length. Same present-vs-
    // omitted discipline as targetScore, so a partial re-sync never reverts a
    // deliberate value. null/0 means "use the server default".
    if (data.nextRoundDelayMs !== undefined && data.nextRoundDelayMs !== null && data.nextRoundDelayMs !== '') {
      const ms = Number(data.nextRoundDelayMs);
      if (Number.isFinite(ms) && ms >= 0) room.nextRoundDelayMs = ms > 0 ? Math.round(ms) : null;
    }

    const asBool = (v) => {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 0 || v === '0') return false;
      return undefined;
    };

    const chat = asBool(data.chatEnabled);
    if (chat !== undefined) room.chatEnabled = chat;

    if (data.bet !== undefined && data.bet !== null && data.bet !== '') {
      const bet = Number(data.bet);
      if (Number.isFinite(bet) && bet >= 0) room.bet = Math.round(bet);
    }

    // #11 resilience: a socket restart mid-match (re)creates a fresh room object
    // whose cumulativeTeamScores Map is empty. ONLY on the FIRST configure of
    // such a room, seed the running cumulative from the backend snapshot
    // (data.cumulativeTeamScores) BEFORE startGame so the match resumes its total
    // (and the 75-pt@1000 rule, which reads cumulative, stays correct). NEVER
    // overwrite a live in-memory total on a normal in-place re-deal — that total
    // is the source of truth and the backend snapshot may lag a round behind.
    if (firstConfigure && data.cumulativeTeamScores && typeof data.cumulativeTeamScores === 'object') {
      if (!(room.cumulativeTeamScores instanceof Map)) room.cumulativeTeamScores = new Map();
      for (const [teamId, total] of Object.entries(data.cumulativeTeamScores)) {
        const n = Number(total);
        if (Number.isFinite(n)) room.cumulativeTeamScores.set(String(teamId), Math.round(n));
      }
    }

    room._settingsInitialized = true;
  }

  _applyTurnTimeLimit(room, data = {}, options = {}) {
    const nextLimit = this._extractTurnTimeLimitSeconds(data);
    // Only skip when the field is ABSENT (null). nextLimit === 0 is a valid value
    // ("Off" = no limit) and MUST be applied — don't treat it as falsy/no-op.
    if (nextLimit === null) return false;

    const previousLimit = room.turnTimeLimit;
    room.turnTimeLimit = nextLimit;
    // nextLimit === 0 => unlimited: clear the remaining-time tracking.
    room.turnTimeRemaining = nextLimit === 0
      ? 0
      : (room.turnTimerDeadline
        ? Math.min(room.getTurnTimeRemaining(), nextLimit)
        : nextLimit);

    logger.info(`[TURN_TIMER] Room ${room.roomId} turn limit ${previousLimit}s -> ${nextLimit}s`);

    if (
      options.restartActiveTimer &&
      room.isInProgress() &&
      room.cardsDealt &&
      room.turnTimerTickHandle
    ) {
      this._startTurnTimer(room);
    }

    return true;
  }

  _getRoomSpectators(roomId) {
    if (!this.roomSpectators.has(roomId)) {
      this.roomSpectators.set(roomId, new Map());
    }
    return this.roomSpectators.get(roomId);
  }

  /**
   * The display identity to register a viewer under: what this request carries
   * first, then whatever their join already established for this socket, and
   * only then the neutral placeholder. Never returns the placeholder over a
   * known name.
   * @param {Socket} socket
   * @param {string} roomId
   * @param {Object} [data] raw event payload
   * @returns {{name: string, avatarUrl: (string|null)}}
   */
  _resolveSpectatorIdentity(socket, roomId, data) {
    const known = (this.roomSpectators.get(roomId) || new Map()).get(socket.id) || null;
    const sent = this._sanitizeChatText(data && data.playerName, SPECTATOR_NAME_MAX);
    const stored =
      known && known.spectatorName !== SPECTATOR_FALLBACK_NAME ? known.spectatorName : '';
    return {
      name: sent || stored || SPECTATOR_FALLBACK_NAME,
      avatarUrl:
        (data && (data.avatarUrl || data.photoUrl || data.avatar)) ||
        (known && known.avatarUrl) ||
        null,
    };
  }

  _addSpectator(socket, roomId, spectatorId, spectatorName, avatarUrl = null) {
    const spectators = this._getRoomSpectators(roomId);
    // Anti-impersonation: the spectator JOIN path is exempt from the seat identity
    // check (a viewer takes no seat), but a spectator can later `claim_seat` and
    // become a write-capable player bound to THIS id. For an authenticated
    // handshake, bind to the SERVER-VERIFIED user id, never the client-supplied
    // one — otherwise socket(userId=A) could join as spectator with playerId 'B'
    // and sit down as B. Legacy/unauthenticated connections keep the client id.
    const verifiedId =
      socket.data && socket.data.authenticated && socket.data.userId !== undefined
        ? String(socket.data.userId)
        : null;
    // MERGE, never clobber. Registering a spectator is not a one-shot event:
    // every viewer client fires `get_game_state` moments after joining and again
    // on each resync, and that path has no identity of its own to offer. It used
    // to re-register this same socket under the literal 'Spectator' with no
    // face, wiping what the join had already established and broadcasting the
    // downgrade to the whole room — the reported "the list just says Spectator".
    // A later registration may only ever ADD detail, never subtract it.
    const existing = spectators.get(socket.id) || null;
    // Bounded and stripped, exactly like a chat sender's name. This is the one
    // chokepoint every registration path goes through — the join, both
    // seat-to-stands moves, and the get_game_state resolver — and the value ends
    // up BROADCAST to everyone in the room on `spectators_changed` and rendered
    // in their roster. Unbounded, a client could push a megabyte of control
    // characters at every other player in the room, and the merge above would
    // make it STICK: before merging, the next get_game_state happened to clobber
    // it back to the placeholder, which limited the damage by accident.
    const offered = this._sanitizeChatText(spectatorName, SPECTATOR_NAME_MAX);
    const knownName =
      existing && existing.spectatorName !== SPECTATOR_FALLBACK_NAME
        ? existing.spectatorName
        : '';
    const resolvedId = verifiedId || spectatorId || existing?.spectatorId || `spectator_${socket.id}`;
    // A profile refresh preserves the registration used by in-flight claims.
    // Leaving and registering again creates a new object, invalidating old work.
    const registration = existing?.spectatorId === resolvedId ? existing : {};
    spectators.set(socket.id, Object.assign(registration, {
      spectatorId: resolvedId,
      spectatorName:
        (offered !== SPECTATOR_FALLBACK_NAME ? offered : '') ||
        knownName ||
        SPECTATOR_FALLBACK_NAME,
      avatarUrl: avatarUrl || (existing && existing.avatarUrl) || null,
    }));
    this.spectatorSocketToRoom.set(socket.id, roomId);
  }

  _removeSpectatorBySocket(socketId) {
    const roomId = this.spectatorSocketToRoom.get(socketId);
    if (!roomId) return null;

    const spectators = this.roomSpectators.get(roomId);
    if (spectators) {
      spectators.delete(socketId);
      if (spectators.size === 0) {
        this.roomSpectators.delete(roomId);
      }
    }

    this.spectatorSocketToRoom.delete(socketId);
    return roomId;
  }

  /**
   * Remove all spectator bookkeeping for a room (P1-10). Called when a room is
   * deleted so neither roomSpectators nor spectatorSocketToRoom retains stale
   * entries for a room that no longer exists.
   * @param {string} roomId
   */
  _clearRoomSpectators(roomId) {
    const spectators = this.roomSpectators.get(roomId);
    if (!spectators) return;
    for (const socketId of spectators.keys()) {
      this.spectatorSocketToRoom.delete(socketId);
    }
    this.roomSpectators.delete(roomId);
  }

  _sendStateToSpectator(socket, room, spectatorId, spectatorName, options = {}) {
    const { includeGameStarted = false } = options;
    const deadPileCounts = Array.isArray(room.deadPiles)
      ? room.deadPiles.map((pile) => (Array.isArray(pile) ? pile.length : 0))
      : [];
    const pozzettosAvailable = deadPileCounts.some((count) => count > 0);
    const pozzettosCardCount = deadPileCounts.reduce((sum, count) => sum + count, 0);

    const otherPlayersHandCounts = {};
    room.getPlayers().forEach((p) => {
      const hand = room.playerHands.get(p.playerId) || [];
      otherPlayersHandCounts[p.playerIndex] = hand.length;
    });

    const playerMelds = {};
    room.getPlayers().forEach((p) => {
      playerMelds[p.playerIndex] = room.playerMelds.get(p.playerId) || [];
    });
    const playerMeldOrders = this._serializePlayerMeldOrders(room);

    if (includeGameStarted && room.isInProgress() && room.cardsDealt) {
      socket.emit(SocketEvents.GAME_STARTED, {
        ...this._serializeRoomGameSettings(room),
        players: room.getPlayers().map((p) => this._serializePlayer(p)),
        yourPlayerIndex: -1,
        currentPlayerIndex: this._announcedTurnIndex(room),
        ruleset: room.ruleset,
        professionalWellMode: room.professionalWellMode,
        hostId: room.hostPlayerId || null,
        turnTimeLimitSeconds: room.turnTimeLimit,
        timestamp: new Date().toISOString(),
        cardsDealt: room.cardsDealt || false,
        ...this._skinsPayloadFields(room),
        isSpectator: true,
        spectatorId,
        spectatorName,
      });
    }

    socket.emit(SocketEvents.GAME_STATE_UPDATE, {
      ...this._serializeRoomGameSettings(room),
      yourPlayerIndex: -1,
      currentPlayerIndex: room.currentTurn,
      phase: 'playing',
      // Full seat+bot roster on every state builder so the list is consistent
      // across all clients/views, not just GAME_STARTED (PTW-233).
      players: room.getPlayers().map((p) => this._serializePlayer(p)),
      turnTimeRemaining: room.getTurnTimeRemaining(),
      turnTimeLimit: room.turnTimeLimit,
      turnTimeLimitSeconds: room.turnTimeLimit,
      ruleset: room.ruleset,
      professionalWellMode: room.professionalWellMode,
      yourHand: [],
      otherPlayersHandCounts,
      discardPile: room.discardPile.map((card) => this._serializeCard(card)),
      deckCount: room.deck?.count || 0,
      pozzettosAvailable,
      pozzettosCardCount,
      deadPileCounts,
      // Across-the-table well takes this round. Informational for the clients'
      // HUD (no rule gates on it), and it cannot be derived from deadPileCounts
      // (a stock promotion also consumes a pile without anyone taking it).
      wellsTakenThisRound: room.wellsTakenThisRound || 0,
      playerMelds,
      playerMeldOrders,
      hasDrawnCard: room.hasDrawnCard,
      mustMeldCard: room.mustMeldCard ? this._serializeCard(room.mustMeldCard) : null,
      drawnCardRestriction: Array.from(room.drawnCardThisTurnRestriction || []),
      meldedThisTurn: room.meldedThisTurn || false,
      // Spectators never discard, so they hold no anti ping-pong lock. Sent
      // explicitly rather than omitted: the client reads an ABSENT key as "the
      // server didn't say" and keeps whatever it had.
      discardLock: null,
      // NO `playerScores` here. GameRoom.getPlayerScores() returns
      // room.lastRoundScores — the PREVIOUS round's per-seat BREAKDOWN OBJECTS,
      // which startGame() never clears — while the client types the field as
      // Map<int,int> and coerces anything non-numeric to 0. Shipping it on a
      // live state frame therefore zeroed every seat's score on every frame
      // from round 2 onward. The authoritative per-seat breakdown belongs on
      // the round-end / GAME_ENDED payload, and an ABSENT key is read as "the
      // server said nothing", which is exactly right here.
      // Per-meld isBuraco/clean verdicts. A spectator arriving mid-round has no
      // history to derive them from, so without this the badges and the brazilia
      // markers are simply absent from their board.
      melds: room.serializeMelds(),
      ...this._skinsPayloadFields(room),
      timestamp: new Date().toISOString(),
      cardsDealt: room.cardsDealt || false,
      hostId: room.hostPlayerId || null,
      isSpectator: true,
      spectatorId,
      spectatorName,
    });
  }

  /**
   * ANTI PING-PONG lock for one recipient, or null.
   *
   * `cardId` is the load-bearing field and the ONLY one the client matches on:
   * the lock binds the card that was actually taken, and a rank+suit key would
   * also freeze the twin in a two-deck shoe. It round-trips because every Card
   * carries a server-minted `cardId` (see Deck.js) which BuracoCard.fromJson
   * adopts as its instanceId. suit/rank ride along for logs and for a client
   * that wants to name the card in a toast.
   *
   * `turnsLeft` is the expiry the SERVER owns: the client never ticks it (its
   * _nextTurn does not run online), so a lock that omitted it would look
   * permanent to a reconnecting client.
   * @param {GameRoom} room
   * @param {string} playerId
   * @returns {{cardId:*,suit:string,rank:string,turnsLeft:number}|null}
   */
  /**
   * Tell every client that `playerId` just collected a pozzetto.
   *
   * The clients ANIMATE off this event (fly the well into the hand, with sound)
   * and flip their local team well flags from it. Three of the five places a pot
   * can be taken used to skip it and only re-arm the turn timer — PLAY_MELD,
   * GO_DOWN and ADD_TO_MELD, i.e. every take that happens because a MELD emptied
   * the hand, which is the common way a well is collected. Those clients saw
   * eleven cards appear out of nowhere on the next state update, silently.
   * @param {GameRoom} room
   * @param {Object} result the action result carrying `broadcast.pozzettoTaken`
   */
  /**
   * Emit POZZETTO_TAKEN ahead of the state update that reflects it.
   *
   * ORDER IS LOAD-BEARING, and having it backwards produced three separate
   * reported symptoms. The client animates the well flying into the hand and
   * applies the new state only when that flight LANDS. When the state update
   * arrived first it had already emptied the pile and refilled the hand, so:
   *
   *   * the taker watched card BACKS fly onto a hand that was already full
   *   * the flight kept animating over cards that had visibly arrived
   *   * worst: the client resolves the taken pile as "the first non-empty one",
   *     so once the state update had cleared the real one, POZZETTO_TAKEN
   *     emptied the SURVIVING well instead — the reported "pozzetto hilang,
   *     muncul lagi pas player melakukan aksi", where the next action's state
   *     update quietly rebuilt it.
   *
   * A round end supersedes all of it: there is no board left to animate onto.
   * @private
   * @param {import('../models/GameRoom')} room
   * @param {Object} result
   */
  _broadcastPozzettoBeforeState(room, result) {
    if (result.roundEnded || !result.broadcast?.pozzettoTaken) return;
    this._broadcastPozzettoTaken(room, result);
  }

  _broadcastPozzettoTaken(room, result) {
    if (!result?.broadcast?.pozzettoTaken) return;
    this.io.to(room.roomId).emit(SocketEvents.POZZETTO_TAKEN, {
      type: 'pozzetto_taken',
      playerIndex: result.broadcast.playerIndex,
      cardCount: result.broadcast.pozzettoTaken,
      timestamp: new Date().toISOString(),
    });
  }

  _serializeDiscardLock(room, playerId) {
    const lock = room.discardLocks && room.discardLocks.get(playerId);
    if (!lock) return null;
    return {
      // The full SET the lock holds; `cardId` stays for older clients.
      cardIds: (lock.cardIds && lock.cardIds.length ? lock.cardIds : [lock.cardId]).filter(
        (id) => id !== null && id !== undefined
      ),
      cardId: lock.cardId ?? null,
      suit: lock.suit,
      rank: lock.rank,
      turnsLeft: Number.isFinite(lock.turnsLeft) ? lock.turnsLeft : 0,
    };
  }

  /**
   * Normalize a card-like object to a serializable JSON form
   * @param {Object|Card} card
   * @returns {Object}
   */
  _serializeCard(card) {
    try {
      if (!card) return null;

      // If card has toJSON method, use it
      if (card && typeof card.toJSON === 'function') {
        return card.toJSON();
      }

      // Otherwise, manually serialize
      const suit = card.suit;
      const rank = card.rank;
      const cardId = card.cardId ?? card.instanceId ?? card.id ?? null;
      const isJoker = rank === 'joker' || suit === 'joker';

      return {
        ...(cardId !== null && cardId !== undefined ? { cardId, instanceId: cardId } : {}),
        suit,
        rank,
        isJoker,
      };
    } catch (error) {
      logger.error(`[_serializeCard] Error serializing card: ${error.message}`, error);
      // Return a safe fallback
      return { suit: 'hearts', rank: 'A', isJoker: false };
    }
  }

  /**
   * Serialize each seat's meld creation order. The client merges partner melds
   * into one team row, so the per-owner meld arrays alone cannot preserve the
   * table's left-to-right order.
   *
   * @param {GameRoom} room
   * @returns {Object<string, number[]>}
   */
  _serializePlayerMeldOrders(room) {
    const result = {};
    room.getPlayers().forEach((player) => {
      result[player.playerIndex] = [
        ...(room.playerMeldOrders?.get(player.playerId) || []),
      ];
    });
    return result;
  }

  /** All host-selected room details shown by the in-game info panel. */
  _serializeRoomGameSettings(room) {
    // Match ledger. It used to ride ONLY the round-end frame, so anyone who was
    // not listening at that exact moment had no source for it — most visibly a
    // SPECTATOR, whose board then showed 0 for a match already past 1000, with
    // no sign of the deductions. Sent with every state frame instead, alongside
    // the targetScore it is measured against.
    //
    // Omitted rather than sent empty when no round has been banked yet: the
    // client treats an ABSENT key as "the server said nothing" and keeps what it
    // has, while an empty object would read as an authoritative all-zero and
    // wipe a total it already knew.
    const cumulative = ActionHandlers._serializeCumulativeTeamScores(room);
    // Per-team ROUND state (well banked / how many / minimum-meld charge). Same
    // reasoning as the ledger above: all three existed only as live events, so a
    // reconnect or a late join had no source for them. The well flags are the
    // load-bearing pair — the client gates its OWN discard legality on them
    // (canDiscardReason's mustTakeWell), so a stale copy makes it refuse a legal
    // closing discard outright, and its scoreboard estimate loses the +100.
    // Omitted rather than sent empty when the room has no seats, so an absent
    // key still reads as "the server said nothing" instead of an all-zero.
    const teamRound = ActionHandlers.serializeTeamRoundState(room);
    return {
      ...(Object.keys(cumulative).length ? { cumulativeTeamScores: cumulative } : {}),
      ...(Object.keys(teamRound.teamHasPickedDeadPile).length ? teamRound : {}),
      roomName: room.name || null,
      ruleset: room.ruleset,
      professionalWellMode: room.professionalWellMode,
      turnTimeLimit: room.turnTimeLimit,
      turnTimeLimitSeconds: room.turnTimeLimit,
      targetScore: room.targetScore,
      // #11 multi-round: the effective intermission length, so the client renders
      // a real countdown between rounds instead of guessing one.
      nextRoundDelayMs: this._nextRoundDelayMs(room),
      chatEnabled: Boolean(room.chatEnabled),
      visibility: room.visibility || 'public',
      hasPassword: Boolean(room.hasPassword),
      bet: Number(room.bet) || 0,
    };
  }

  _serializePlayer(player) {
    return {
      playerId: player.playerId,
      playerName: player.playerName,
      playerIndex: player.playerIndex,
      avatarUrl: player.avatarUrl || null,
      isBot: player.isBot === true,
      botLevel: player.isBot === true ? player.botLevel || 'normal' : undefined,
    };
  }

  /**
   * Broadcast the authoritative full lobby roster (all seats + bots) to every
   * client in the room, regardless of game phase. Used after seat/bot mutations
   * during the WAITING phase so a non-owner joiner always holds the complete
   * player list instead of a partial snapshot (PTW-233).
   *
   * Emitted as a PLAYER_JOINED carrying both the legacy single playerId/
   * playerName/playerIndex fields (a representative seat — the message parser
   * casts these non-null) and the full `players` array. Clients that understand
   * `players` rebuild their entire roster from it; older clients ignore it.
   * @param {import('../models/GameRoom')} room
   * @param {Object} [representative] seat to advertise in the legacy fields
   */
  _broadcastLobbyPlayers(room, representative = null) {
    if (!room || typeof room.getPlayers !== 'function') return;
    this.io.to(room.roomId).emit(
      SocketEvents.PLAYER_JOINED,
      this._lobbyPlayersPayload(room, representative)
    );
    this._queueSeatLayoutSync(room);
    this._persistLobbyRoster(room);
  }

  _persistLobbyRoster(room) {
    if (room?.status !== GameRoomStatus.WAITING || this.gameService.getRoom(room.roomId) !== room) return;
    if (this._ownershipEnabled() && !this.ownedRoomIds.has(String(room.roomId))) return;
    this._persistRoomState(room);
  }

  _lobbyPlayersPayload(room, representative = null) {
    const seated = room.getPlayers();
    const head = representative || seated[0] || null;
    return {
      playerId: head ? head.playerId : '',
      playerName: head ? head.playerName : '',
      playerIndex: head ? head.playerIndex : -1,
      isBot: head ? head.isBot === true : false,
      players: seated.map((p) => this._serializePlayer(p)),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Ensure an incoming card-like value becomes a Card instance
   * @param {Object|Card} card
   * @returns {Card}
   */
  _ensureCardInstance(card) {
    if (card && typeof card.toJSON === 'function') return card;
    return new Card(card.suit, card.rank, card.cardId ?? card.instanceId ?? card.id ?? null);
  }

  /**
   * Handle new socket connection
   * @param {Socket} socket
   */
  handleConnection(socket) {
    logger.info(`Player connected: ${socket.id}`);

    // Bind authenticated sockets to a per-user room so the backend can fan out
    // user-scoped events (social DMs) to every device a user has connected,
    // independent of any game room. Socket.IO auto-removes the socket from this
    // room on disconnect, so no manual cleanup is needed (PTW-50).
    if (socket.data?.authenticated && socket.data.userId != null) {
      socket.join(this.constructor.userRoom(socket.data.userId));
    }

    // Register all event handlers
    this.registerEventHandlers(socket);

    // Handle disconnection. Socket.IO hands the REASON to this listener and the
    // old code threw it away, which made every production disconnect look
    // identical in the logs. The reason is the whole diagnosis: 'ping timeout'
    // means the server never got a pong (a real network stall),
    // 'transport close'/'transport error' means the network went away underneath
    // us, and 'client namespace disconnect' means the CLIENT closed the socket
    // on purpose — i.e. our own resume-probe bounce or a leaveRoom, not a
    // network fault at all. Without it there is no way to tell a flaky network
    // from a client that is disconnecting itself.
    socket.on(SocketEvents.DISCONNECT, (reason) =>
      logger.runWithRoom(this._roomIdForSocketEvent(socket, null), () =>
        this.handleDisconnect(socket, reason)
      )
    );
  }

  /**
   * Per-user Socket.IO room name. Authenticated sockets join this on connect so
   * user-scoped fan-out (e.g. social DMs) can target every device a user has
   * online without going through a game room.
   * @param {string|number} userId
   * @returns {string}
   */
  static userRoom(userId) {
    return `user:${userId}`;
  }

  /**
   * Fan a freshly-created direct message out to the recipient's (and the
   * sender's other) authenticated sockets. Driven by the backend
   * `/webhooks/direct-message` webhook on Message create so mobile can append in
   * realtime and drop its 5s poll (PTW-50). Best-effort: clients that are offline
   * simply re-fetch history on next open.
   *
   * @param {{recipientId: string|number, senderId?: string|number, message: object}} data
   * @returns {{success: boolean, delivered?: number, error?: string}}
   */
  emitDirectMessage(data) {
    const recipientId = data?.recipientId;
    const message = data?.message;
    if (recipientId == null || !message || typeof message !== 'object') {
      return { success: false, error: 'recipientId and message are required' };
    }

    // Echo to the sender's OTHER devices too (multi-device read consistency), but
    // never deliver back to the originating connection — the sender already has
    // the message from the POST /messages response. We can't suppress a single
    // socket on a fan-out by room, so emitting to the sender's room is acceptable:
    // the sending device de-dupes by message id on append.
    const targets = new Set([this.constructor.userRoom(recipientId)]);
    if (data.senderId != null && String(data.senderId) !== String(recipientId)) {
      targets.add(this.constructor.userRoom(data.senderId));
    }

    let delivered = 0;
    for (const room of targets) {
      const size = this.io.sockets.adapter.rooms.get(room)?.size || 0;
      delivered += size;
      this.io.to(room).emit(SocketEvents.DIRECT_MESSAGE, message);
    }

    return { success: true, delivered };
  }

  /**
   * Allowed `reason` buckets for the stuck-animation watchdog metric. Anything
   * else is folded into `other` so client-supplied strings can't blow up label
   * cardinality on the metrics backend (PTW-81).
   */
  static get ANIM_WATCHDOG_REASONS() {
    return new Set([
      'deal',
      'draw',
      'discard',
      'meld',
      'take_pile',
      'pozzetto',
      'turn',
      'generic',
    ]);
  }

  /**
   * Handle a stuck-UI animation-flag watchdog report from a client. The mobile
   * watchdog force-clears an animation flag that overstayed its safety window and
   * tells the server so prod can alert on a spike (a rising rate points at a
   * client-side animation deadlock). Observability only — no game state changes,
   * no response emitted. Payload: { reason?: string }.
   * @param {Socket} socket
   * @param {{reason?: string}} [data]
   */
  handleAnimWatchdog(socket, data) {
    const raw = typeof data?.reason === 'string' ? data.reason.toLowerCase().trim() : '';
    const reason = this.constructor.ANIM_WATCHDOG_REASONS.has(raw) ? raw : 'other';
    metrics.increment('buraco_stuck_anim_watchdog_total', { reason });
    logger.warn('[ANIM_WATCHDOG] client stuck-animation watchdog fired', {
      socketId: socket.id,
      reason,
    });
  }

  /**
   * Compose a per-event flood guard with the standard error wrapper. The
   * connection-level rate limiter only runs once at handshake, so hot game
   * actions need a per-event cap to stop a connected client spamming the
   * authoritative server. On flood we emit an error and drop the event (no
   * disconnect) — the cap is far above human play speed, so legit play is never
   * affected.
   * @param {Socket} socket
   * @param {Function} handler
   * @returns {Function}
   */
  /**
   * Remember a socket's in-flight `join_room` so a state request that arrives
   * during its awaits can wait for it instead of being answered against a seat
   * the join has not re-bound yet.
   *
   * The returned promise NEVER rejects: `ErrorHandler.wrap` already owns the
   * original promise's rejection, and a second derived promise rejecting here
   * would be an unhandled rejection.
   *
   * @param {string} socketId
   * @param {Promise} joinPromise
   * @returns {Promise} the original promise, so the caller still awaits the join
   */
  _trackPendingJoin(socketId, joinPromise) {
    const settled = Promise.resolve(joinPromise).then(
      () => {},
      () => {}
    );
    this._pendingJoins.set(socketId, settled);
    settled.then(() => {
      if (this._pendingJoins.get(socketId) === settled) {
        this._pendingJoins.delete(socketId);
      }
    });
    return joinPromise;
  }

  _actionGuard(socket, handler) {
    return this._wrapSocketEvent(socket, (...args) => {
      if (!rateLimiter.checkActionLimit(socket.id)) {
        socket.emit(SocketEvents.ERROR, {
          success: false,
          error: 'Too many actions, slow down',
          code: 'RATE_LIMITED',
        });
        return undefined;
      }
      return handler(...args);
    });
  }

  /**
   * ErrorHandler.wrap plus the per-game log context: the handler (and every
   * await / timer it spawns) runs with the socket's room as the ambient room,
   * so its log lines land in that game's log. See logger.runWithRoom.
   * @param {Socket} socket
   * @param {Function} handler
   * @returns {Function}
   */
  _wrapSocketEvent(socket, handler) {
    return ErrorHandler.wrap(socket, (...args) =>
      logger.runWithRoom(this._roomIdForSocketEvent(socket, args[0]), () => handler(...args))
    );
  }

  /**
   * Best-effort room attribution for an incoming socket event: the payload's
   * roomId (join/claim before the socket is seated), else the seated player's
   * room, else the spectator binding. Never throws — this only tags logs.
   * @param {Socket} socket
   * @param {*} data  the event payload (may be a callback or undefined)
   * @returns {string|null}
   */
  _roomIdForSocketEvent(socket, data) {
    try {
      if (data && typeof data === 'object') {
        const claimed = data.roomId ?? data.room_id;
        if (claimed !== null && claimed !== undefined && claimed !== '') return String(claimed);
      }
      const playerId = this.gameService.getPlayerIdBySocket(socket.id);
      const room = playerId ? this.gameService.getPlayerRoom(playerId) : null;
      if (room) return String(room.roomId);
      const spectating = this.spectatorSocketToRoom?.get(socket.id);
      return spectating ? String(spectating) : null;
    } catch {
      return null;
    }
  }

  /**
   * Anti-impersonation check for connection→seat binding points. Returns true if
   * the claimed playerId is allowed for this socket: always true for legacy /
   * unauthenticated connections; for an authenticated handshake the claimed id
   * must equal the server-verified user id (a null/absent claim is allowed —
   * nothing to impersonate). Bots are created server-side and never reach here.
   * @param {Socket} socket
   * @param {string|number|null|undefined} claimedPlayerId
   * @returns {boolean}
   */
  _assertSocketIdentity(socket, claimedPlayerId) {
    if (!socket.data || !socket.data.authenticated) return true;
    if (claimedPlayerId === null || claimedPlayerId === undefined) return true;
    return String(claimedPlayerId) === String(socket.data.userId);
  }

  /**
   * A full state snapshot contains the receiver's real hand, so the requested
   * playerId must belong to this socket. Authenticated sockets are bound to the
   * verified user id; legacy sockets are bound to the PlayerSession socketId.
   * @param {Socket} socket
   * @param {PlayerSession} player
   * @returns {boolean}
   */
  _assertSocketCanViewPlayerState(socket, player) {
    if (!socket || !player) return false;
    if (socket.data?.authenticated) {
      return String(player.playerId) === String(socket.data.userId);
    }
    return player.socketId === socket.id;
  }

  /**
   * Register all event handlers for a socket
   * @param {Socket} socket
   */
  registerEventHandlers(socket) {
    // Game events
    socket.on(
      SocketEvents.JOIN_ROOM,
      this._wrapSocketEvent(socket, (data) =>
        this._trackPendingJoin(socket.id, this.handleJoinRoom(socket, data))
      )
    );

    socket.on(
      SocketEvents.START_GAME,
      this._wrapSocketEvent(socket, (data) => this.handleStartGame(socket, data))
    );

    socket.on(
      SocketEvents.START_NEXT_ROUND,
      this._wrapSocketEvent(socket, () => this.handleStartNextRound(socket))
    );

    socket.on(
      SocketEvents.DEAL_CARDS,
      this._wrapSocketEvent(socket, (data) => this.handleDealCards(socket, data))
    );

    socket.on(
      SocketEvents.DEAL_ANIMATION_COMPLETE,
      this._wrapSocketEvent(socket, (data) => this.handleDealAnimationComplete(socket, data))
    );

    socket.on(
      SocketEvents.LEAVE_ROOM,
      this._wrapSocketEvent(socket, () => this.handleLeaveRoom(socket))
    );

    // Host heartbeat pong (lobby/WAITING rooms). The host replies to the
    // server's periodic ping; a valid pong resets the room's missed counter so
    // the room is not killed. Anti-spoof: only the room's current host counts.
    socket.on(
      SocketEvents.HOST_HEARTBEAT_PONG,
      this._wrapSocketEvent(socket, (data) => this.handleHostHeartbeatPong(socket, data))
    );

    // Client telemetry: stuck-UI animation-flag watchdog fired on a client. Pure
    // observability — increments a counter, never touches game state (PTW-81).
    // Flood-guarded so a misbehaving client can't spam the metric.
    socket.on(
      SocketEvents.CLIENT_ANIM_WATCHDOG,
      this._actionGuard(socket, (data) => this.handleAnimWatchdog(socket, data))
    );

    // Dev-only hand surgery (requires the webhook secret in `secret`). See
    // changePlayerCards() for the payload contract. NOT flood-guarded: it is an
    // operator tool, and the secret check already rejects clients outright.
    socket.on(
      SocketEvents.DEV_CHANGE_CARDS,
      this._wrapSocketEvent(socket, (data) => this.handleDevChangeCards(socket, data))
    );

    socket.on(
      SocketEvents.INVITE_BOT,
      this._wrapSocketEvent(socket, (data) => this.handleInviteBot(socket, data))
    );

    socket.on(
      SocketEvents.REMOVE_BOT,
      this._wrapSocketEvent(socket, (data) => this.handleRemoveBot(socket, data))
    );

    // Items 7/B: voluntary "replace my seat with a bot" / "take back" are REMOVED
    // (handlers + registration deleted). They reassigned room.hostPlayerId to a
    // bot, breaking host-immutability (host = creator, never transferred). A human
    // seat is never converted to a bot; absence is handled by the disconnect →
    // inactivity-forfeit flow (Item 8).

    socket.on(
      'switch_team',
      this._wrapSocketEvent(socket, (data) => this.handleSwitchTeam(socket, data))
    );

    // Lobby seat swap (2v2): move into an empty seat, or ask another player to
    // swap (target accepts/declines). Host seat is fixed — never swapped.
    socket.on(
      'claim_seat',
      this._wrapSocketEvent(socket, (data) => this.handleClaimSeat(socket, data))
    );
    socket.on(
      'request_swap',
      this._wrapSocketEvent(socket, (data) => this.handleRequestSwap(socket, data))
    );
    socket.on(
      'respond_swap',
      this._wrapSocketEvent(socket, (data) => this.handleRespondSwap(socket, data))
    );
    socket.on(
      'cancel_swap',
      this._wrapSocketEvent(socket, (data) => this.handleCancelSwap(socket, data))
    );

    // Lobby seat invite: a seated player/host invites a SPECTATOR into an empty
    // seat (spectator accepts/declines, then claims via claim_seat).
    socket.on(
      'invite_to_seat',
      this._wrapSocketEvent(socket, (data) => this.handleInviteToSeat(socket, data))
    );
    socket.on(
      'respond_seat_invite',
      this._wrapSocketEvent(socket, (data) => this.handleRespondSeatInvite(socket, data))
    );
    socket.on(
      'cancel_seat_invite',
      this._wrapSocketEvent(socket, (data) => this.handleCancelSeatInvite(socket, data))
    );
    // Host force-swap (no approval): host swaps/moves two lobby seats outright.
    socket.on(
      'host_swap_seats',
      this._wrapSocketEvent(socket, (data) => this.handleHostSwapSeats(socket, data))
    );
    // Lobby leave-seat: a seated NON-host player stands up and becomes a
    // spectator of the same room (WAITING-phase only).
    socket.on(
      'leave_seat',
      this._wrapSocketEvent(socket, () => this.handleLeaveSeat(socket))
    );
    // Host kick: host forces another participant out of their seat (→ spectator)
    // or out of the room entirely (WAITING-phase only).
    socket.on(
      'host_kick',
      this._wrapSocketEvent(socket, (data) => this.handleHostKick(socket, data))
    );

    socket.on(
      'get_game_state',
      this._actionGuard(socket, (data) => this.handleGetGameState(socket, data))
    );

    socket.on(
      SocketEvents.DRAW_CARD,
      this._actionGuard(socket, (data) =>
        this._runOwnedSocketMutation(socket, data, 'handleDrawCard')
      )
    );

    socket.on(
      SocketEvents.PLAY_MELD,
      this._actionGuard(socket, (data) =>
        this._runOwnedSocketMutation(socket, data, 'handlePlayMeld')
      )
    );

    socket.on(
      SocketEvents.DISCARD_CARD,
      this._actionGuard(socket, (data) =>
        this._runOwnedSocketMutation(socket, data, 'handleDiscardCard')
      )
    );

    // Matchmaking events
    if (this.matchmakingQueue) {
      socket.on(
        MatchmakingEvents.JOIN_QUEUE,
        this._wrapSocketEvent(socket, (data) => this.handleJoinMatchmaking(socket, data))
      );

      socket.on(
        MatchmakingEvents.LEAVE_QUEUE,
        this._wrapSocketEvent(socket, () => this.handleLeaveMatchmaking(socket))
      );

      socket.on(
        MatchmakingEvents.GET_STATUS,
        this._wrapSocketEvent(socket, () => this.handleGetMatchmakingStatus(socket))
      );
    }

    socket.on(
      SocketEvents.GO_DOWN,
      this._actionGuard(socket, (data) =>
        this._runOwnedSocketMutation(socket, data, 'handleGoDown')
      )
    );

    socket.on(
      SocketEvents.ADD_TO_MELD,
      this._actionGuard(socket, (data) =>
        this._runOwnedSocketMutation(socket, data, 'handleAddToMeld')
      )
    );

    socket.on(
      SocketEvents.PICK_UP_PILE,
      this._actionGuard(socket, (data) =>
        this._runOwnedSocketMutation(socket, data, 'handlePickUpPile')
      )
    );

    socket.on(
      SocketEvents.TAKE_POZZETTO,
      this._actionGuard(socket, (data) =>
        this._runOwnedSocketMutation(socket, data, 'handleTakePozzetto')
      )
    );

    socket.on(
      SocketEvents.UNDO_MELD,
      this._actionGuard(socket, (data) =>
        this._runOwnedSocketMutation(socket, data, 'handleUndoMeld')
      )
    );

    // In-game chat (socket-only). NOT wrapped in _actionGuard: chat has its own
    // light throttle in the handler, and must never surface the game-action
    // "too many actions" error to a player who is just talking.
    socket.on(
      SocketEvents.SEND_CHAT_MESSAGE,
      this._wrapSocketEvent(socket, (data) => this.handleChatMessage(socket, data))
    );

    socket.on(
      SocketEvents.GET_CHAT_HISTORY,
      this._wrapSocketEvent(socket, (data) => this.handleGetChatHistory(socket, data))
    );
  }

  /**
   * Handle deal cards request (Host only)
   * @param {Socket} socket
   * @param {Object} data
   */
  handleDealCards(socket, data) {
    const control = this._resolveWaitingRoomControl(socket, data);
    const playerId = control.playerId || control.room?.ownerControllerPlayerId || null;
    const room = control.room;

    if (!room) {
      logger.warn(`[DEAL_CARDS] Room not found for socket ${socket.id}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Room not found'));
      return;
    }

    if (!playerId) {
      logger.warn(`[DEAL_CARDS] Player/controller id not found for socket ${socket.id}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Owner player id not found'));
      return;
    }

    const player = room.getPlayer(playerId);
    if (!player && !control.isOwnerController) {
      logger.warn(`[DEAL_CARDS] Player ${playerId} not found in room`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Player not in room'));
      return;
    }

    // Only host can deal
    if (!control.isHostPlayer && !control.isOwnerController) {
      logger.warn(
        `[DEAL_CARDS] Non-host ${playerId} attempted to deal cards (host: ${room.hostPlayerId})`
      );
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('Only the host can deal cards')
      );
      return;
    }

    // Check if game is in progress
    if (!room.isInProgress()) {
      logger.warn(`[DEAL_CARDS] Game not in progress in room ${room.roomId}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Game not started'));
      return;
    }

    // Check if already dealt
    if (room.cardsDealt) {
      logger.warn(`[DEAL_CARDS] Cards already dealt in room ${room.roomId}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Cards already dealt'));
      return;
    }

    const dealReason = control.isOwnerController
      ? `owner controller ${playerId}`
      : `host ${playerId}`;
    const result = this._dealCardsForRoom(room, dealReason);
    if (!result.success) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse(result.error || 'Failed to deal cards')
      );
    }
  }

  /**
   * The turn index a GAME_STARTED may honestly announce.
   *
   * `startGame()` resets `currentTurn` to 0 and the REAL starter is only picked
   * by `runFirstTurnDraw()`, which runs with the deal — so every GAME_STARTED
   * that goes out ahead of the deal (the opening start, the backend webhook, and
   * every multi-round re-deal) was announcing a placeholder **0** as the player
   * to act. Clients apply it, so seat 0 was marked "to move" for the whole
   * intermission and deal of every round; at a table whose host keeps winning,
   * that reads exactly like "the winner of the previous round always starts",
   * which is what it was reported as. -1 says "not decided yet" and is ignored
   * by the client's `applyServerTurnIndex` guard, including on already-shipped
   * builds. The undealt announcement is followed a moment later by the dealt
   * state update, which carries the drawn starter and the reveal that animates it.
   * @param {import('../models/GameRoom')} room
   * @returns {number}
   */
  _announcedTurnIndex(room) {
    return room && room.cardsDealt ? room.currentTurn : -1;
  }

  _dealCardsForRoom(room, reason) {
    if (!room) {
      return { success: false, error: 'Room not found' };
    }
    if (!room.isInProgress || !room.isInProgress()) {
      return { success: false, error: 'Game not started' };
    }
    if (room.cardsDealt) {
      return { success: true, alreadyDealt: true };
    }

    try {
      logger.info(`[DEAL_CARDS] Starting to deal cards for room ${room.roomId} (${reason})`);

      if (!room.dealCards()) {
        logger.warn(`[DEAL_CARDS] dealCards() returned false for room ${room.roomId}`);
        return { success: false, error: 'Cards already dealt' };
      }

      // Who plays first. Round 1 of a match is decided by the high-card draw —
      // it sets room.currentTurn and records the drawn cards on
      // room.firstTurnDraw so clients can animate the reveal, and the ceremony
      // cards go back into the deck so the count is unchanged.
      //
      // Round 2 onward does NOT draw (2026-08-27): the side that is ahead starts,
      // and startTurnWithRoundLeader leaves firstTurnDraw null so no reveal
      // plays. Level sides are the one case that still falls back to the draw.
      //
      // Non-fatal either way: if it throws, fall back to the default index-0 start.
      try {
        if ((room.roundNumber || 1) > 1) {
          room.startTurnWithRoundLeader();
        } else {
          room.runFirstTurnDraw();
        }
      } catch (drawErr) {
        logger.error(
          `[DEAL_CARDS] First-turn draw failed for room ${room.roomId}: ${drawErr.message}`,
          drawErr
        );
      }

      logger.info(
        `[DEAL_CARDS] ✓ Cards dealt successfully in room ${room.roomId}. Now cardsDealt=${room.cardsDealt}`
      );
      this._gameEvent(room, 'deal', {
        reason,
        round: room.roundNumber || 1,
        firstTurn: room.currentTurn,
        deck: room.deck?.count ?? null,
        wells: Array.isArray(room.deadPiles) ? room.deadPiles.map((pile) => pile.length) : [],
        seats: room.getPlayers().map((p) => ({
          seat: p.playerIndex,
          playerId: p.playerId,
          name: p.playerName,
          cards: (room.playerHands.get(p.playerId) || []).length,
        })),
      });
      logger.info(
        `[DEAL_CARDS] Deck count: ${room.deck?.count}, Pozzetto piles: ${room.deadPiles?.length}`
      );

      // Set this before broadcasting state. The state sender has a timer watchdog,
      // and it must not start the turn clock while clients are still animating deal.
      room.awaitingDealAnimation = true;
      // Fresh deal, fresh roll-call: which seats have finished animating it.
      room.dealAnimationAcks = new Set();
      if (room.dealAnimationFallbackHandle) clearTimeout(room.dealAnimationFallbackHandle);
      room.dealAnimationFallbackHandle = setTimeout(() => {
        room.dealAnimationFallbackHandle = null;
        this._startFirstTurnTimerAfterDeal(room, 'fallback');
      }, this.constructor.DEAL_ANIMATION_FALLBACK_MS);

      this._sendGameStateUpdate(room);
      this._notifyBackendCardsDealt(room.roomId);
      logger.info(`[DEAL_CARDS] Game state update sent to all players in room ${room.roomId}`);
      return { success: true, cardsDealt: true };
    } catch (error) {
      logger.error(`[DEAL_CARDS] Error dealing cards: ${error.message}`, error);
      logger.error(`[DEAL_CARDS] Error stack: ${error.stack}`);
      return { success: false, error: `Failed to deal cards: ${error.message}` };
    }
  }

  _autoDealAfterStart(room, reason) {
    if (!room || room.cardsDealt !== false) {
      return { success: true, alreadyDealt: true };
    }
    return this._dealCardsForRoom(room, reason);
  }

  /**
   * A client finished playing its initial deal animation.
   *
   * The first turn's timer starts once EVERY seated, connected human has said
   * so (or DEAL_ANIMATION_FALLBACK_MS gives up waiting), so the visible
   * countdown begins after the deal rather than behind it — on every device,
   * not just the quickest one. Clients run the ceremony at their own animation
   * SPEED setting (the SDK's "fast" is roughly half the reference length), so
   * "first report wins" would start a slower client's clock while its own deal
   * was still on screen.
   *
   * A spectator's report never stands in for a seat's. The owner controller of
   * a board-watch room is the one exception: its shared display IS the table
   * every seat is looking at, so its report stands for all of them.
   * @param {Socket} socket
   */
  handleDealAnimationComplete(socket, data = {}) {
    const playerId =
      this.gameService.getPlayerIdBySocket(socket.id) ||
      (socket.data?.authenticated && socket.data.userId != null
        ? String(socket.data.userId)
        : null);
    const controlledRoom = this._findRoomControlledBySocket(socket.id);
    const roomId = data.roomId || data.gameId || null;
    const room =
      (playerId ? this.gameService.getPlayerRoom(playerId) || this.gameService.getRoom(roomId) : null) ||
      controlledRoom ||
      this.gameService.getRoom(this.spectatorSocketToRoom.get(socket.id));
    if (!room || !room.awaitingDealAnimation) return;

    const seat = playerId && typeof room.getPlayer === 'function' ? room.getPlayer(playerId) : null;
    if (seat) {
      if (!(room.dealAnimationAcks instanceof Set)) room.dealAnimationAcks = new Set();
      room.dealAnimationAcks.add(String(seat.playerId));
      this._startFirstTurnTimerIfDealAcked(room, `player ${playerId}`, { explicitAck: true });
      return;
    }
    if (controlledRoom && controlledRoom === room) {
      this._startFirstTurnTimerAfterDeal(
        room,
        `owner controller ${room.ownerControllerPlayerId || socket.id}`
      );
      return;
    }
    this._startFirstTurnTimerIfDealAcked(room, `spectator ${socket.id}`, { explicitAck: true });
  }

  /**
   * Seated HUMAN players whose client has not yet reported
   * `deal_animation_complete` for the current deal and could still do so. A bot
   * never reports and an offline seat cannot, so neither holds the first turn.
   * @param {import('../models/GameRoom')} room
   * @returns {import('../models/PlayerSession')[]}
   */
  _dealAnimationPendingSeats(room) {
    const acks = room.dealAnimationAcks instanceof Set ? room.dealAnimationAcks : new Set();
    const players = typeof room.getPlayers === 'function' ? room.getPlayers() : [];
    return players.filter((p) => !p.isBot && p.isConnected !== false && !acks.has(String(p.playerId)));
  }

  /**
   * Start the first-turn timer once nobody is left to wait for. Called on every
   * deal-animation report and whenever a seat drops mid-deal (a seat that is
   * gone cannot report, and the others should not wait out the fallback for
   * it).
   *
   * Without an explicit report (`explicitAck` false — the disconnect sweep)
   * this only acts if SOMEONE reported: a table nobody finished the deal on is
   * left to the fallback, exactly as before.
   * @param {import('../models/GameRoom')} room
   * @param {string} reason
   * @param {{explicitAck?: boolean}} [options]
   * @returns {boolean} whether this call started the timer
   */
  _startFirstTurnTimerIfDealAcked(room, reason, { explicitAck = false } = {}) {
    if (!room || !room.awaitingDealAnimation) return false;
    const pending = this._dealAnimationPendingSeats(room);
    if (pending.length > 0) {
      logger.info(
        `[DEAL_CARDS] Deal animation report (${reason}) in room ${room.roomId}; still waiting on ${pending
          .map((p) => p.playerId)
          .join(', ')}`
      );
      return false;
    }
    const ackCount = room.dealAnimationAcks instanceof Set ? room.dealAnimationAcks.size : 0;
    if (!explicitAck && ackCount === 0) return false;
    this._startFirstTurnTimerAfterDeal(room, reason);
    return true;
  }

  /**
   * Start the first turn timer exactly once after dealing. Guarded by
   * room.awaitingDealAnimation so the earliest of {the last seat's
   * animation-complete (see _startFirstTurnTimerIfDealAcked), the owner
   * controller's report, the fallback timeout} wins and later ones are ignored.
   * Any real turn start (_stopTurnTimer) also drops the gate, so a seat that
   * acts before its slower opponent has finished animating cannot have its
   * clock restarted by a late report.
   * @param {import('../models/GameRoom')} room
   * @param {string} reason
   */
  _startFirstTurnTimerAfterDeal(room, reason) {
    if (!room || !room.awaitingDealAnimation) return;
    if (!room.isInProgress || !room.isInProgress()) return;
    room.awaitingDealAnimation = false;
    if (room.dealAnimationFallbackHandle) {
      clearTimeout(room.dealAnimationFallbackHandle);
      room.dealAnimationFallbackHandle = null;
    }
    logger.info(`[DEAL_CARDS] Starting first turn timer for room ${room.roomId} (${reason})`);
    this._startTurnTimer(room);
    // The first-turn "undian" reveal has now played; drop its data so a later
    // reconnect/resume (which replays a fresh state snapshot) does NOT animate
    // the draw again — it should only ever show once, at the start of the game.
    room.firstTurnDraw = null;
  }

  /**
   * Handle join room event
   * @param {Socket} socket
   * @param {Object} data
   */
  _serializeSeatMutation(key, work) {
    const previous = this._seatMutations.get(key);
    const operation = previous ? previous.catch(() => {}).then(work) : work();
    const settled = Promise.resolve(operation);
    this._seatMutations.set(key, settled);
    settled.finally(() => {
      if (this._seatMutations.get(key) === settled) this._seatMutations.delete(key);
    }).catch(() => {});
    return settled;
  }

  handleJoinRoom(socket, data) {
    const joinEpoch = (socket._roomJoinEpoch || 0) + 1;
    socket._roomJoinEpoch = joinEpoch;
    if (data?.isSpectator || data?.roomId == null || data?.playerId == null) {
      return this._handleJoinRoom(socket, data, joinEpoch);
    }
    const key = `${data.roomId}:${data.playerId}`;
    return this._serializeSeatMutation(key, () => this._handleJoinRoom(socket, data, joinEpoch, key));
  }

  async _handleJoinRoom(socket, data, joinEpoch = socket._roomJoinEpoch, seatMutationKey = null) {
    const joinIsCurrent = () => socket.connected !== false && socket._roomJoinEpoch === joinEpoch;
    if (!joinIsCurrent()) return;
    const { playerId, playerName, roomId, isSpectator = false } = data;
    const avatarUrl = data?.avatarUrl || data?.photoUrl || data?.avatar || null;
    const normalizedRoomId = roomId === null || roomId === undefined ? roomId : String(roomId);
    const requestId = data?.requestId || socket.handshake?.headers?.['x-request-id'] || null;

    // Anti-impersonation: when the handshake is authenticated, the claimed seat
    // must belong to the verified user. Rejecting here is enough because every
    // later action resolves the player from the server-side socket→player map
    // bound at this join. Legacy/unauthenticated connections are unaffected.
    //
    // Spectators are EXEMPT: they take no seat (no socket→player binding) and
    // are read-only, so there is no seat to impersonate. They also present a
    // synthetic `spectator_<ts>` id that never equals the verified userId, which
    // would otherwise fail this check and reject every authenticated viewer.
    if (!isSpectator && !this._assertSocketIdentity(socket, playerId)) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('Player identity mismatch')
      );
      this._logRoomLifecycle('identity_mismatch', {
        roomId: normalizedRoomId,
        playerId: playerId || null,
        socketId: socket.id,
        requestId,
      });
      return;
    }

    if (isSpectator) {
      if (!normalizedRoomId) {
        socket.emit(
          SocketEvents.ERROR,
          ErrorHandler.createErrorResponse('roomId required for spectator mode')
        );
        return;
      }

      // Mirror the player join path: a spectator may land on a node that does
      // not hold this room in memory (cross-node), or on a fresh node after a
      // restart. Rehydrate from persisted Redis state, then rebuild from the
      // backend record, before giving up — otherwise a still-live game returns
      // "Room not found" to viewers only (players already get these fallbacks).
      let room = this.gameService.getRoom(normalizedRoomId);
      if (!room) {
        room = await this._rehydrateRoomForJoin(normalizedRoomId, requestId);
      }
      if (!room) {
        room = await this._rebuildRoomFromBackend(normalizedRoomId, requestId);
      }
      if (!room) {
        socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Room not found'));
        return;
      }

      const spectatorIdentity = socket.data?.authenticated && socket.data.userId != null
        ? String(socket.data.userId) : playerId;
      if (room.seatConnectionProtocol === 1 && (!socket.data?.authenticated || socket.data.userId == null)) {
        socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Authentication required to join this room'));
        return;
      }
      if (room.seatConnectionProtocol !== 1 && spectatorIdentity != null && room.getPlayer(spectatorIdentity)) {
        // The transport may remember spectator intent from a REST stand-up
        // whose socket leave was lost. Let verified normal admission reconcile
        // that existing seat; never register one identity in both roles.
        const key = `${room.roomId}:${spectatorIdentity}`;
        const resume = () => this._handleJoinRoom(socket, { ...data, playerId: spectatorIdentity, isSpectator: false }, joinEpoch, key);
        return seatMutationKey === key ? resume() : this._serializeSeatMutation(key, resume);
      }
      if (room.seatConnectionProtocol === 1) {
        const member = room.getPlayer(spectatorIdentity);
        const memberSocket = member?.socketId;
        const memberVersion = member?.apiSeatReservationVersion;
        let participant;
        try {
          participant = await this._seatBackendRequest(room, 'room-participant', {
            roomId: String(room.roomId), playerId: String(spectatorIdentity),
          });
        } catch (err) {
          if (joinIsCurrent()) socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Could not verify room access. Please retry.'));
          return;
        }
        if (!joinIsCurrent() || this.gameService.getRoom(room.roomId) !== room) return;
        if (participant.authorized !== true || String(participant.playerId) !== String(spectatorIdentity)) {
          socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Please join the room before watching'));
          return;
        }
        if ((member && room.status === GameRoomStatus.WAITING) ||
            (participant.isSpectator === false && (room.status === GameRoomStatus.WAITING || room.getPlayer(spectatorIdentity)))) {
          const key = `${room.roomId}:${spectatorIdentity}`;
          const resume = () => this._handleJoinRoom(socket, { ...data, playerId: spectatorIdentity, isSpectator: false }, joinEpoch, key);
          // A role can change while REST replies are in flight. An internal
          // fallback already owns this actor queue; waiting on itself deadlocks.
          return seatMutationKey === key ? resume() : this._serializeSeatMutation(key, resume);
        }
        if (participant.isSpectator === true && member && room.isInProgress() &&
            room.getPlayer(spectatorIdentity) === member && member.socketId === memberSocket &&
            member.apiSeatReservationVersion === memberVersion && memberVersion === participant.reservationVersion) {
          // A REST forfeit can beat its socket leave. Revoke the old connection
          // without changing live hand/index data or settling the match twice.
          if (this.gameService.getPlayerIdBySocket(memberSocket) === spectatorIdentity) {
            this.gameService.socketToPlayer.delete(memberSocket);
          }
          member.disconnect();
          member.socketId = null;
        }
        if (this.gameService.getPlayerIdBySocket(socket.id) === spectatorIdentity) {
          socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Your room role changed. Please reconnect.'));
          return;
        }
      }
      if (spectatorIdentity != null && !await this._reconcileSpectatorRoomSwitch(socket, room, spectatorIdentity)) {
        socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Please leave your current room before joining another'));
        return;
      }
      if (!joinIsCurrent() || this.gameService.getRoom(room.roomId) !== room) return;

      const oldSpectatorRoom = this.spectatorSocketToRoom.get(socket.id);
      if (oldSpectatorRoom && oldSpectatorRoom !== room.roomId) {
        this._removeSpectatorBySocket(socket.id);
        socket.leave(oldSpectatorRoom);
        this._broadcastSpectatorsChanged(oldSpectatorRoom);
      }
      socket.join(room.roomId);
      this._addSpectator(socket, room.roomId, spectatorIdentity, playerName, avatarUrl);
      this._broadcastSpectatorsChanged(room.roomId);

      // A spectator joining a lobby room is still a "join" — keep the host
      // heartbeat running (idempotent; no-op once in progress / disabled).
      this._ensureHostHeartbeat(room);

      logger.info(`[JOIN_ROOM] ✓ Spectator ${playerId || socket.id} joined room ${room.roomId}`);
      this._logRoomLifecycle('spectator_joined', {
        roomId: room.roomId,
        playerId: playerId || null,
        socketId: socket.id,
        requestId,
      });

      socket.emit(
        SocketEvents.PLAYER_JOINED,
        ErrorHandler.createSuccessResponse({
          roomId: room.roomId,
          isSpectator: true,
          spectatorId: spectatorIdentity || `spectator_${socket.id}`,
          spectatorName: playerName || SPECTATOR_FALLBACK_NAME,
          players: room.getPlayers().map((p) => this._serializePlayer(p)),
        })
      );

      // The game already ENDED (e.g. inactivity forfeit) but the room lingers in
      // the finished-grace window. Show the RESULT to the (re)joining viewer
      // instead of a fresh game_started snapshot — otherwise the board looks like
      // it "restarted" but nobody can act.
      if (room.hasEnded && room.hasEnded() && room.lastRoundEndPayload) {
        socket.emit(SocketEvents.GAME_ENDED, this._roundEndReplayPayload(room));
        logger.info(`[JOIN_ROOM] Spectator ${playerId || socket.id} joined FINISHED room ${room.roomId} — replayed GAME_ENDED (no restart).`);
        return;
      }

      this._sendStateToSpectator(
        socket,
        room,
        spectatorIdentity || `spectator_${socket.id}`,
        playerName || SPECTATOR_FALLBACK_NAME,
        { includeGameStarted: true }
      );
      return;
    }

    logger.info(
      `Player ${playerId} (${playerName}) requesting to join room ${normalizedRoomId || 'auto'}`
    );
    this._logRoomLifecycle('join_requested', {
      roomId: normalizedRoomId || null,
      playerId,
      socketId: socket.id,
      requestId,
    });

    // Mark player as active
    this.gameService.markPlayerActive(playerId);

    let room;
    if (normalizedRoomId) {
      room = this.gameService.getRoom(normalizedRoomId);
      if (!room) {
        // Cross-node failover (PTW-90, Phase 3): the room is not in THIS node's
        // memory. Before rejecting, try to rehydrate it from the persisted state
        // the owner node writes to Redis (FailureManager.persistGameState). This
        // lets a surviving node serve a room whose owner node crashed instead of
        // freezing it. The old `join_rejected_room_not_synced` behavior depended
        // on sticky sessions keeping every player on the room's owner node.
        room = await this._rehydrateRoomForJoin(normalizedRoomId, requestId);
      }
      if (!room) {
        // Last resort before rejecting: the backend may still hold this room as
        // OPEN even though this socket node lost it (restart, or a WAITING
        // grace-delete that raced the reopen). Rebuild it from the backend record
        // so the join succeeds instead of dead-ending on "Room is not ready" (A2).
        room = await this._rebuildRoomFromBackend(normalizedRoomId, requestId);
      }
      if (!room) {
        logger.warn(
          `[JOIN_ROOM] Room ${normalizedRoomId} not found in memory, persisted state, or backend; refusing implicit creation`
        );
        this._logRoomLifecycle('join_rejected_room_not_synced', {
          roomId: normalizedRoomId,
          playerId,
          socketId: socket.id,
          requestId,
        });
        socket.emit(
          SocketEvents.ERROR,
          ErrorHandler.createErrorResponse(
            'Room is not ready on realtime server. Please retry shortly.'
          )
        );
        return;
      }
    } else {
      room = this.gameService.findOrCreateRoom();
    }

    if (!room) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('Failed to find or create room')
      );
      return;
    }

    const targetRoom = room;
    if (!joinIsCurrent()) return;
    if (targetRoom.seatConnectionProtocol === 1 && (!socket.data?.authenticated || socket.data.userId == null)) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Authentication required to join this room'));
      return;
    }
    if (targetRoom.seatConnectionProtocol === 1 && targetRoom.isInProgress()) {
      const member = targetRoom.getPlayer(playerId);
      const memberSocket = member?.socketId;
      const memberVersion = member?.apiSeatReservationVersion;
      let participant;
      try {
        participant = await this._seatBackendRequest(targetRoom, 'room-participant', {
          roomId: String(targetRoom.roomId), playerId: String(playerId),
        });
      } catch (err) {
        if (joinIsCurrent()) socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Could not verify room access. Please retry.'));
        return;
      }
      if (!joinIsCurrent() || this.gameService.getRoom(targetRoom.roomId) !== targetRoom ||
          targetRoom.getPlayer(playerId) !== member || member?.socketId !== memberSocket ||
          member?.apiSeatReservationVersion !== memberVersion) return;
      if (participant.authorized !== true || String(participant.playerId) !== String(playerId)) {
        socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Please join the room before watching'));
        return;
      }
      if (participant.isSpectator === true) {
        return this._handleJoinRoom(socket, { ...data, isSpectator: true }, joinEpoch, seatMutationKey);
      }
    }
    let verifiedSeatReservation = null;

    // An older client clears its spectator flag before claim_seat succeeds.
    // Reconnecting after losing that claim must not silently occupy a different
    // seat. Let the API reservation decide whether an unseated user may join.
    if ((targetRoom.seatReservationProtocol === 1 || targetRoom.seatLayoutProtocol === 1 || targetRoom.seatConnectionProtocol === 1) &&
        this._backendUrlForRoom(targetRoom.roomId) && targetRoom.status === GameRoomStatus.WAITING &&
        !targetRoom.awaitingNextRound) {
      const memberBeforeVerification = targetRoom.getPlayer(playerId);
      const socketBeforeVerification = memberBeforeVerification?.socketId;
      const versionBeforeVerification = memberBeforeVerification?.apiSeatReservationVersion;
      if (!memberBeforeVerification || targetRoom.seatLayoutProtocol === 1 || targetRoom.seatConnectionProtocol === 1) {
        let reservation;
        try {
          reservation = await this._fetchSeatReservation(targetRoom, playerId);
          reservation = await this._reconcileSeatRejection(targetRoom, playerId, reservation);
        } catch (err) {
          socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Could not verify your seat. Please retry.'));
          return;
        }
        if (!joinIsCurrent() || this.gameService.getRoom(targetRoom.roomId) !== targetRoom ||
            targetRoom.status !== GameRoomStatus.WAITING || targetRoom.awaitingNextRound) return;
        if (targetRoom.getPlayer(playerId) !== memberBeforeVerification ||
            memberBeforeVerification?.socketId !== socketBeforeVerification ||
            memberBeforeVerification?.apiSeatReservationVersion !== versionBeforeVerification) {
          socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Your seat changed. Please retry.'));
          return;
        }
        // An explicit claim queued during this lookup owns the desired chair.
        // Yield to it instead of auto-seating the reconnect in another chair.
        // Awaiting it here would deadlock the actor's mutation queue.
        if (this._pendingSeatClaims.has(`${targetRoom.roomId}:${playerId}`)) return;
        if (reservation?.isSpectator === false && Number.isInteger(reservation.reservationVersion)) {
          try {
            reservation = await this._activateSeatConnection(socket, targetRoom, playerId, reservation);
          } catch (err) {
            socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Could not verify your seat connection. Please retry.'));
            return;
          }
          if (!joinIsCurrent() || this.gameService.getRoom(targetRoom.roomId) !== targetRoom ||
              this._seatsLocked(targetRoom) || targetRoom.getPlayer(playerId) !== memberBeforeVerification ||
              memberBeforeVerification?.socketId !== socketBeforeVerification ||
              memberBeforeVerification?.apiSeatReservationVersion !== versionBeforeVerification ||
              this._pendingSeatClaims.has(`${targetRoom.roomId}:${playerId}`)) return;
        }
        if (!reservation || reservation.isSpectator) {
          if (memberBeforeVerification) {
            if (reservation?.isSpectator !== true || String(targetRoom.hostPlayerId) === String(playerId)) {
              socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Your seat reservation changed. Please rejoin.'));
              return;
            }
            // REST stand-up may have succeeded while its socket leave was
            // lost. Reconcile that proven spectator locally, without another
            // refund/leave webhook or a permanent reconnect error loop.
            this._cancelWaitingLeave(targetRoom.roomId, playerId);
            this.gameService._rebindSeatSocket(memberBeforeVerification, socket.id);
            this.handleLeaveSeat(socket, { preserveJoinIntent: true });
          }
          await this._handleJoinRoom(socket, { ...data, isSpectator: true }, joinEpoch, seatMutationKey);
          if (!joinIsCurrent() || targetRoom.getPlayer(playerId) ||
              this.spectatorSocketToRoom.get(socket.id) !== targetRoom.roomId) return;
          socket.emit('kicked', { toSpectator: true, reason: 'seat_taken', timestamp: new Date().toISOString() });
          return;
        }
        if (!Number.isInteger(reservation.reservationVersion) || reservation.reservationVersion < 0) {
          socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Could not verify your seat reservation. Please retry.'));
          return;
        }
        verifiedSeatReservation = reservation;
      }
    }

    // The game already ENDED (e.g. inactivity forfeit) but the room lingers in
    // the finished-grace window. A player rejoining now must see the RESULT — not
    // be reconnected into a fresh game_started snapshot (which looks like the game
    // "restarted" but nobody can move) nor trigger a re-deal. Replay the stored
    // terminal payload and stop.
    //
    // #11 multi-round: EXCLUDE the intermission. A room between rounds is also
    // FINISHED, but returning here fires BEFORE gameService.joinRoom() rebinds
    // player.socketId / socketToPlayer — so the rejoiner keeps a stale socket
    // handle and round N+1's per-seat `yourHand` frame is emitted into the void.
    // They would sit at an empty table for the rest of the match. Fall through to
    // the normal reconnect and replay the round card afterwards instead.
    if (targetRoom && targetRoom.hasEnded && targetRoom.hasEnded() && !targetRoom.awaitingNextRound) {
      socket.join(targetRoom.roomId);
      // Via _roundEndReplayPayload, not a raw spread: this branch is the
      // no-intermission one, so the helper is what guarantees a stale
      // nextRoundInMs/nextRoundAt left over from the last round-end stamp is
      // stripped instead of telling the rejoiner to wait for a deal that is not
      // coming.
      const endedPayload = targetRoom.lastRoundEndPayload
        ? this._roundEndReplayPayload(targetRoom)
        : { type: 'game_ended', matchEnded: true };
      socket.emit(SocketEvents.GAME_ENDED, endedPayload);
      logger.info(`[JOIN_ROOM] Player ${playerId} rejoined FINISHED room ${targetRoom.roomId} — replayed GAME_ENDED (no restart).`);
      return;
    }

    if (this.failureManager && targetRoom && targetRoom.isInProgress() && data?.previousSocketId) {
      const recovery = await this.failureManager.handlePlayerConnection(socket, {
        userId: playerId,
        roomId: targetRoom.roomId,
        previousSocketId: data.previousSocketId,
        userName: playerName,
      });

      if (recovery?.success && recovery?.isReconnection) {
        socket.join(targetRoom.roomId);
        this.gameService.socketToPlayer.set(socket.id, playerId);
        this.gameService.playerToRoom.set(playerId, targetRoom.roomId);

        this._logRoomLifecycle('player_reconnected_via_failure_manager', {
          roomId: targetRoom.roomId,
          playerId,
          socketId: socket.id,
          previousSocketId: data.previousSocketId,
          requestId,
        });

        this._sendInitialGameState(targetRoom);
        return;
      }
    }

    if (targetRoom.players.size === 0) {
      if (
        data?.ruleset === 'professional' ||
        data?.ruleset === 'classic' ||
        data?.ruleset === 'classicWithNoJoker'
      ) {
        targetRoom.ruleset = data.ruleset;
      } else if (
        data?.gameMode === 'professional' ||
        data?.gameMode === 'classic' ||
        data?.gameMode === 'classicWithNoJoker'
      ) {
        targetRoom.ruleset = data.gameMode;
      }

      if (data?.professionalWellMode === 'direct' || data?.professionalWellMode === 'indirect') {
        targetRoom.professionalWellMode = data.professionalWellMode;
      }
    }
    // Snapshot the seat BEFORE joinRoom rebinds it. `joinRoom` reports
    // `reconnected: true` for ANY rejoin by a seated player — including one from
    // the socket that already holds the seat, which is not a reconnect at all.
    // See `sameSocketRefresh` below.
    const seatBeforeJoin = targetRoom.getPlayer(playerId);
    const seatSocketBeforeJoin = seatBeforeJoin ? seatBeforeJoin.socketId : null;
    const seatStatusBeforeJoin = seatBeforeJoin ? seatBeforeJoin.status : null;

    const reservedSeat = Number.isInteger(verifiedSeatReservation?.playerIndex)
      ? verifiedSeatReservation.playerIndex : null;
    if (!seatBeforeJoin && verifiedSeatReservation && targetRoom.seatLayoutProtocol === 1 && reservedSeat == null) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Could not verify your reserved seat. Please retry.'));
      return;
    }
    const previousRoom = this.gameService.getPlayerRoom(playerId);
    let releasedSeatProof = null;
    if (verifiedSeatReservation && previousRoom && previousRoom !== targetRoom &&
        previousRoom.status === GameRoomStatus.WAITING && previousRoom.backendManaged) {
      releasedSeatProof = await this._verifyReleasedRoomSeat(socket, targetRoom, previousRoom, playerId, verifiedSeatReservation);
      if (!joinIsCurrent() || this.gameService.getRoom(targetRoom.roomId) !== targetRoom || this._seatsLocked(targetRoom)) return;
    }
    const result = this.gameService.joinRoom(targetRoom.roomId, playerId, playerName, socket.id, avatarUrl, reservedSeat, releasedSeatProof);

    if (result.success) {
      if (result.previousRoom && result.previousPlayer) {
        this._broadcastRoomSwitchDeparture(result.previousRoom, result.previousPlayer);
      }
      if (verifiedSeatReservation) {
        result.player.apiSeatReservationVersion = verifiedSeatReservation.reservationVersion;
      }
      socket.join(targetRoom.roomId);
      const previousSpectatorRoomId = this._removeSpectatorBySocket(socket.id);
      if (previousSpectatorRoomId) this._broadcastSpectatorsChanged(previousSpectatorRoomId);

      // Reconnected within the pre-game grace window → cancel the pending
      // seat-hold leave so the held seat stays (A1).
      this._cancelWaitingLeave(targetRoom.roomId, playerId);

      // Start (idempotent) the lobby host heartbeat now that a player is in the
      // room. No-op once the game is in progress or if disabled.
      this._ensureHostHeartbeat(targetRoom);
      // If the joiner IS the host, clear any misses accrued while its socket was
      // gone (swipe-and-return): _ensureHostHeartbeat early-returns when a handle
      // already exists, so without this a host reconnecting near the kill window
      // could be killed on the very tick it returns.
      this._noteHostHeartbeatPresence(targetRoom, playerId);

      if (result.reconnected) {
        socket.emit(SocketEvents.PLAYER_JOINED, ErrorHandler.createSuccessResponse({
          ...this._lobbyPlayersPayload(targetRoom, result.player),
          roomId: targetRoom.roomId,
          isSpectator: false,
        }));
        // A REFRESH, NOT A RECONNECT.
        //
        // The seat was already bound to THIS socket and was not in grace, so
        // nothing was ever lost. This is the shape of every `resyncOnResume`:
        // the client re-emits `join_room` whenever the app comes back to the
        // foreground, because `socket.connected` can lie about a half-open
        // socket — and on Android/iOS `resumed` fires for a notification-shade
        // pull, a permission dialog, an app-switcher peek, a call banner. Every
        // one of those used to be announced to the whole table as
        // PLAYER_RECONNECTED (so the other clients cleared and re-set the seat's
        // disconnected flag), spend a Redis get/del/setex + a full state persist
        // in clearGraceForReconnect, and fire a `player.status` webhook — for a
        // player who never went anywhere. THAT is the "keeps reconnecting" the
        // table sees on a perfectly healthy link.
        //
        // The state resync below still runs: the client asked to be re-synced
        // and answering it is the whole point. Only the *reconnect ceremony* is
        // suppressed.
        const sameSocketRefresh =
          seatSocketBeforeJoin === socket.id &&
          seatStatusBeforeJoin !== 'grace_period' &&
          seatStatusBeforeJoin !== 'disconnected';

        // Release the grace record even though this client sent no
        // previousSocketId — the branch above (which needs one) is unreachable
        // from the shipped Flutter client, so without this a player who returned
        // inside the window kept a `grace_period` stamp and had their seat
        // bot-converted by the expiry timer while they sat looking at it.
        if (
          !sameSocketRefresh &&
          this.failureManager &&
          (targetRoom.isInProgress() || targetRoom.awaitingNextRound)
        ) {
          await this.failureManager.clearGraceForReconnect(
            playerId,
            targetRoom.roomId,
            targetRoom,
            result.player
          );
        }

        // First human back after a deploy restart: the room was HELD with no
        // runtime (see _holdRoomForRestart). Their seat is connected again
        // (clearGraceForReconnect above), so resume the interrupted turn /
        // intermission now — before the state frame below, which then carries
        // the live turnTimeRemaining.
        if (!sameSocketRefresh) this._releaseRestartHold(targetRoom, 'player_rejoined');

        if (!sameSocketRefresh) {
          const reconnectedPayload = {
            playerId,
            playerName,
            playerIndex: result.player.playerIndex,
            timestamp: new Date().toISOString(),
          };

          socket.emit(SocketEvents.PLAYER_RECONNECTED, reconnectedPayload);
          socket.to(targetRoom.roomId).emit(SocketEvents.PLAYER_RECONNECTED, reconnectedPayload);
          this._emitPartnerWebhook('player.status', {
            roomId: targetRoom.roomId,
            playerId,
            playerName,
            status: 'reconnected',
          });
          logger.info(`[JOIN_ROOM] ✓ Player ${playerId} reconnected to room ${targetRoom.roomId}`);
          this._gameEvent(targetRoom, 'reconnect', {
            playerId,
            seat: targetRoom.getPlayer(playerId)?.playerIndex ?? null,
          });
        } else {
          logger.info(
            `[JOIN_ROOM] ↻ Player ${playerId} refreshed room ${targetRoom.roomId} on the SAME socket ${socket.id} — resync only, no reconnect announced`
          );
        }

        // The shipped lobby rebuilds its seats from PLAYER_JOINED, not
        // PLAYER_RECONNECTED or an undealt game_state_update. A DC must replay
        // that roster even when the returning player already owns a seat.
        if (targetRoom.status === GameRoomStatus.WAITING) {
          this._broadcastLobbyPlayers(targetRoom, result.player);
          this._broadcastSpectatorsChanged(targetRoom.roomId);
        }

        // Re-sync full game state for all players to avoid divergence
        this._sendInitialGameState(targetRoom);
        // #11 multi-round: their socket is rebound now, so replay the round-over
        // card LAST (after the state frame) — otherwise the state resync would be
        // the final frame and the client would drop back to a playable-looking
        // board it cannot act on. Sent with the REMAINING countdown, not the
        // original one.
        this._replayIntermissionCard(socket, targetRoom);
        return;
      }

      logger.info(
        `[JOIN_ROOM] ✓ Player ${playerId} joined room ${targetRoom.roomId} as player ${result.player.playerIndex}. Room size: ${targetRoom.players.size}/${targetRoom.maxPlayers}`
      );
      this._logRoomLifecycle('player_joined', {
        roomId: targetRoom.roomId,
        playerId,
        socketId: socket.id,
        playerIndex: result.player.playerIndex,
        playerCount: targetRoom.players.size,
        maxPlayers: targetRoom.maxPlayers,
        requestId,
      });

      // Notify the player
      socket.emit(
        SocketEvents.PLAYER_JOINED,
        ErrorHandler.createSuccessResponse({
          playerId,
          playerName,
          playerIndex: result.player.playerIndex,
          roomId: targetRoom.roomId,
          isSpectator: false,
          players: targetRoom.getPlayers().map((p) => this._serializePlayer(p)),
        })
      );

      // Notify others in the room. Include the FULL authoritative seat+bot list
      // (not just the single joiner) so every client — including non-owner
      // joiners still in the WAITING phase — rebuilds the complete lobby roster.
      // Without this a joiner only ever saw a partial snapshot and the list
      // rendered empty (PTW-233).
      socket.to(targetRoom.roomId).emit(SocketEvents.PLAYER_JOINED, {
        playerId,
        playerName,
        playerIndex: result.player.playerIndex,
        isBot: result.player.isBot === true,
        players: targetRoom.getPlayers().map((p) => this._serializePlayer(p)),
        timestamp: new Date().toISOString(),
      });

      // Authoritative full-roster re-broadcast to the ENTIRE room (io.to, not the
      // perishable socket.to delta above) so EVERY existing member converges on
      // the same seat list — fixes earlier joiners missing later joiners. Also
      // refresh the spectator roster so seated + spectator views stay in sync.
      this._broadcastLobbyPlayers(targetRoom);
      this._broadcastSpectatorsChanged(targetRoom.roomId);

      // If game started, notify all players
      if (result.gameStarted) {
        logger.info(
          `[GAME_STARTED] Room ${targetRoom.roomId} is full. Starting game with ${targetRoom.players.size} players. Current turn: ${targetRoom.currentTurn}`
        );
        this._logRoomLifecycle('game_started_auto_full_room', {
          roomId: targetRoom.roomId,
          playerCount: targetRoom.players.size,
          maxPlayers: targetRoom.maxPlayers,
          requestId,
        });

        // Send personalized game_started message to each player
        targetRoom.getPlayers().forEach((player) => {
          if (player.isBot === true) return;
          const playerSocket = this.io.sockets.sockets.get(player.socketId);
          if (playerSocket) {
            logger.info(
              `[GAME_STARTED] Sending game_started to player ${player.playerId} (index: ${player.playerIndex})`
            );
            playerSocket.emit(SocketEvents.GAME_STARTED, {
              ...this._serializeRoomGameSettings(targetRoom),
              players: targetRoom.getPlayers().map((p) => this._serializePlayer(p)),
              yourPlayerIndex: player.playerIndex,
              currentPlayerIndex: this._announcedTurnIndex(targetRoom),
              ruleset: targetRoom.ruleset,
              professionalWellMode: targetRoom.professionalWellMode,
              hostId: targetRoom.hostPlayerId || null,
              turnTimeLimitSeconds: targetRoom.turnTimeLimit,
              timestamp: new Date().toISOString(),
              cardsDealt: targetRoom.cardsDealt || false,
            });
          }
        });

        // Send initial game state to each player
        this._sendInitialGameState(targetRoom);
        this._emitPartnerWebhook('game.started', {
          roomId: targetRoom.roomId,
          players: targetRoom.getPlayers().map((p) => this._serializePlayer(p)),
          currentPlayerIndex: targetRoom.currentTurn,
        });
      }
    } else {
      logger.error(`[JOIN_ROOM] ✗ Player ${playerId} failed to join: ${result.error}`);
      if (result.rosterChanged) this._broadcastSeatChanged(targetRoom);
      if (verifiedSeatReservation && !seatBeforeJoin &&
          ['Room is full', 'No available seat for player', 'Invalid reserved seat', 'Player is already in another active room'].includes(result.error)) {
        await this._rejectReservedJoin(socket, data, targetRoom, verifiedSeatReservation, seatMutationKey);
        return;
      }
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(result.error));
    }
  }

  async _rejectReservedJoin(socket, data, room, reservation, seatMutationKey = null) {
    const joinEpoch = socket._roomJoinEpoch;
    const isCurrent = () => socket.connected !== false && socket._roomJoinEpoch === joinEpoch &&
      this.gameService.getRoom(room.roomId) === room && !room.getPlayer(data.playerId);
    if (!isCurrent()) return;
    try {
      const released = await this._releaseSeatReservation(room, data.playerId, reservation.reservationVersion);
      if (!isCurrent()) return;
      if (released.success !== true || released.isSpectator !== true) {
        this._swapFail(socket, 'not_allowed', 'Your seat reservation changed. Please retry.');
        return;
      }
      // Refund only the rejected destination. A socket still playing elsewhere
      // must retain that role instead of becoming a spectator of two rooms.
      const oldRoom = this.gameService.getPlayerRoom(data.playerId);
      if (oldRoom && oldRoom !== room && oldRoom.getPlayer(data.playerId)?.socketId === socket.id) {
        this._swapFail(socket, 'not_allowed', 'Please leave your current room before joining another');
        return;
      }
      await this._handleJoinRoom(socket, { ...data, isSpectator: true }, joinEpoch, seatMutationKey);
      if (!isCurrent() || this.spectatorSocketToRoom.get(socket.id) !== room.roomId) return;
      socket.emit('kicked', { toSpectator: true, reason: 'seat_taken', timestamp: new Date().toISOString() });
      this._swapFail(socket, 'seat_taken', 'That seat is taken. You are still a spectator.', reservation.playerIndex);
    } catch (err) {
      if (isCurrent()) this._swapFail(socket, 'not_allowed', 'Could not release the seat reservation. Please retry.');
    }
  }

  _broadcastRoomSwitchDeparture(room, player) {
    this._cancelWaitingLeave(room.roomId, player.playerId);
    this._clearPendingFor(room, player.playerId);
    this._clearInvitesFor(room, player.playerId);
    this.io.sockets.sockets.get(player.socketId)?.leave(room.roomId);
    this.io.to(room.roomId).emit(SocketEvents.PLAYER_LEFT, {
      playerId: player.playerId, playerName: player.playerName, playerIndex: player.playerIndex,
      timestamp: new Date().toISOString(),
    });
    if (this.gameService.getRoom(room.roomId) === room) this._broadcastSeatChanged(room);
  }

  async _reconcileSpectatorRoomSwitch(socket, targetRoom, playerId) {
    const joinEpoch = socket._roomJoinEpoch;
    const previousRoom = this.gameService.getPlayerRoom(playerId);
    const player = previousRoom?.getPlayer(playerId);
    if (!player || previousRoom === targetRoom) return true;
    const sameSocket = player.socketId === socket.id;
    if (!previousRoom.backendManaged || this._seatsLocked(previousRoom) ||
        String(previousRoom.hostPlayerId) === String(playerId) || !this._backendUrlForRoom(previousRoom.roomId)) return !sameSocket;
    const proof = { room: previousRoom, player, socketId: player.socketId, reservationVersion: player.apiSeatReservationVersion };
    try {
      const snapshot = await this._seatBackendRequest(previousRoom, 'room-fetch', { roomId: String(previousRoom.roomId) });
      if (snapshot.exists !== true || snapshot.status !== 'open') return !sameSocket;
      const previousReservation = (snapshot.players || []).find((entry) => String(entry.playerId) === String(playerId));
      if (previousReservation && previousReservation.isSpectator !== true) return !sameSocket;
      if (socket.connected === false || socket._roomJoinEpoch !== joinEpoch || this.gameService.getRoom(targetRoom.roomId) !== targetRoom ||
          this.gameService.getRoom(previousRoom.roomId) !== previousRoom ||
          this.gameService.getPlayerRoom(playerId) !== previousRoom ||
          !this.gameService.canReleaseWaitingSeat(previousRoom, playerId, proof)) return false;
      this.gameService.leaveRoom(playerId);
      this._broadcastRoomSwitchDeparture(previousRoom, player);
      return true;
    } catch (err) {
      return !sameSocket;
    }
  }

  async _verifyReleasedRoomSeat(socket, targetRoom, previousRoom, playerId, reservation, desiredSeat = reservation.playerIndex) {
    const player = previousRoom.getPlayer(playerId);
    if (!player || this._seatsLocked(previousRoom) || String(previousRoom.hostPlayerId) === String(playerId) ||
        !this._backendUrlForRoom(previousRoom.roomId) || targetRoom.getPlayerByIndex(desiredSeat)) return null;
    const proof = { room: previousRoom, player, socketId: player.socketId, reservationVersion: player.apiSeatReservationVersion };
    try {
      const snapshot = await this._seatBackendRequest(previousRoom, 'room-fetch', { roomId: String(previousRoom.roomId) });
      // exists:false also represents in-progress rooms in this API. It is NOT
      // evidence that their seat was released.
      if (snapshot.exists !== true || snapshot.status !== 'open') return null;
      const previousReservation = (snapshot.players || []).find((entry) => String(entry.playerId) === String(playerId));
      if (previousReservation && previousReservation.isSpectator !== true) return null;
      const currentReservation = await this._fetchSeatReservation(targetRoom, playerId);
      if (!currentReservation || currentReservation.isSpectator !== false ||
          currentReservation.reservationVersion !== reservation.reservationVersion ||
          currentReservation.playerIndex !== reservation.playerIndex || socket.connected === false ||
          this.gameService.getRoom(previousRoom.roomId) !== previousRoom || this._seatsLocked(previousRoom) ||
          previousRoom.getPlayer(playerId) !== player || player.socketId !== proof.socketId ||
          player.apiSeatReservationVersion !== proof.reservationVersion) return null;
      return proof;
    } catch (err) {
      return null;
    }
  }

  /**
   * Invite a server-side bot into a room from a player/spectator socket.
   * @param {Socket} socket
   * @param {Object} data
   */
  handleInviteBot(socket, data = {}) {
    const control = this._resolveWaitingRoomControl(socket, data);
    const playerId = control.playerId;
    const spectatorRoomId = this.spectatorSocketToRoom.get(socket.id);
    const roomId =
      data.roomId ||
      (control.room ? control.room.roomId : spectatorRoomId);
    const room = control.room || (roomId ? this.gameService.getRoom(roomId) : null);

    if (!room) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Room not found'));
      return;
    }

    if (!control.isHostPlayer && !control.isOwnerController) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('Only the room owner can invite a bot')
      );
      return;
    }

    if (!playerId && !control.isOwnerController) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse(
          'Invite bot from spectator/media owner must use the backend webhook'
        )
      );
      return;
    }

    const result = this.inviteBotToRoom({
      ...data,
      roomId: room.roomId,
      invitedBy: playerId || room.ownerControllerPlayerId || data.ownerId || data.spectatorId || null,
    });

    if (!result.success) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(result.error));
      return;
    }

    socket.emit(SocketEvents.BOT_INVITED, result);
  }

  /**
   * Add a server-side bot to a room without a socket context. Used by both the
   * socket event and backend webhook path.
   * @param {Object} data
   * @returns {Object}
   */
  inviteBotToRoom(data = {}) {
    return logger.runWithRoom(data?.roomId, () => this._inviteBotToRoomImpl(data));
  }

  _inviteBotToRoomImpl(data = {}) {
    const roomId = data.roomId === null || data.roomId === undefined ? null : String(data.roomId);
    if (!roomId) {
      return { success: false, error: 'roomId required' };
    }

    // A bot cannot be seated at a STAKED table. A bot escrows nothing, and the
    // backend derives the pot from the seats that actually escrowed, so a paid
    // room containing one is broken in both directions:
    //   human beats bot -> payingPlayers is 1, the pot is just the human's own
    //     stake, the losing stake is 0 and so is the bonus: you risk 10,000,
    //     you win, and you get exactly your 10,000 back. No upside at all.
    //   bot beats human -> the winning seat resolves to no paying user, the
    //     backend refuses to pay out and 500s, the socket burns its 5 retries,
    //     and the stale-room reaper eventually voids the match and refunds.
    // So it is a table you can neither win nor lose. Today this is only
    // ACCIDENTALLY safe: the shipped app has no call site for invite_bot and
    // wlive-api never seeds bots over sync-room. That is one UI button away
    // from being a live money bug, so refuse it here — this is the single choke
    // point both the socket event and the backend sync path funnel through.
    // Allowing funded bots would mean giving them a real escrowing account on
    // the backend first; until that exists, the honest answer is no.
    const targetRoom = this.gameService.getRoom(roomId);
    if (targetRoom && Number(targetRoom.bet) > 0) {
      return { success: false, error: 'Bots cannot be added to a staked room' };
    }

    const result = this.gameService.addBotToRoom(roomId, {
      botId: data.botId,
      botName: data.botName || data.playerName,
      playerIndex: Number.isInteger(data.playerIndex) ? data.playerIndex : data.seatIndex,
      botLevel: data.botLevel || data.level || 'normal',
    });

    if (!result.success) {
      return result;
    }

    const room = result.room;
    const bot = result.player;
    this.botCoordinator?.registerBot(room.roomId, bot.playerId);

    const payload = {
      success: true,
      roomId: room.roomId,
      playerId: bot.playerId,
      playerName: bot.playerName,
      playerIndex: bot.playerIndex,
      isBot: true,
      botLevel: bot.botLevel,
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers,
      invitedBy: data.invitedBy || null,
      timestamp: new Date().toISOString(),
    };

    this.io.to(room.roomId).emit(SocketEvents.BOT_INVITED, payload);
    this.io.to(room.roomId).emit(SocketEvents.PLAYER_JOINED, {
      playerId: bot.playerId,
      playerName: bot.playerName,
      playerIndex: bot.playerIndex,
      isBot: true,
      // Full authoritative seat+bot list so a waiting joiner sees the bot added
      // to the lobby immediately, not just an incremental single entry (PTW-233).
      players: room.getPlayers().map((p) => this._serializePlayer(p)),
      timestamp: payload.timestamp,
    });

    this._logRoomLifecycle('bot_invited', {
      roomId: room.roomId,
      playerId: bot.playerId,
      playerIndex: bot.playerIndex,
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers,
    });

    if (data.suppressStateBroadcast !== true && room.isInProgress()) {
      this._sendInitialGameState(room);
    }

    this._notifyBackendPlayerCount(room.roomId, room.players.size);

    if (data.autoStart === true && room.players.size >= room.maxPlayers) {
      return {
        ...payload,
        startResult: this.triggerStartGame(room.roomId, data),
      };
    }

    return payload;
  }

  /**
   * Handle remove_bot event — host removes a bot from the room.
   * @param {Socket} socket
   * @param {Object} data
   */
  handleRemoveBot(socket, data = {}) {
    const control = this._resolveWaitingRoomControl(socket, data);
    const room = control.room;

    if (!room) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Room not found'));
      return;
    }

    if (!control.isHostPlayer && !control.isOwnerController) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Only the room owner can remove a bot'));
      return;
    }

    // Seats are frozen once a match is live — including the round-over
    // intermission, which is FINISHED but NOT over. This was the one seat-count
    // mutation without the guard, so a host could drop a bot between rounds and
    // the next scheduled deal would then see players.size !== maxPlayers and end
    // the whole match with _abortNextRound('seat_missing').
    if (this._seatsLocked(room)) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('Cannot remove a bot while a game is in progress')
      );
      return;
    }

    const botId = data.botId;
    if (!botId) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('botId is required'));
      return;
    }

    const bot = room.getPlayer(botId);
    if (!bot || !bot.isBot) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Bot not found in room'));
      return;
    }

    room.removePlayer(botId);
    this.gameService.playerToRoom.delete(botId);
    this.gameService.socketToPlayer.delete(bot.socketId);
    this.botCoordinator?.unregisterBot(room.roomId, botId);
    if (room.replacedHostBotId === botId) {
      room.replacedHostBotId = null;
    }

    this.io.to(room.roomId).emit(SocketEvents.BOT_REMOVED, {
      playerId: botId,
      playerIndex: bot.playerIndex,
      timestamp: new Date().toISOString(),
    });
    this.io.to(room.roomId).emit(SocketEvents.PLAYER_LEFT, {
      playerId: botId,
      playerIndex: bot.playerIndex,
      timestamp: new Date().toISOString(),
    });
    // Re-broadcast the full authoritative roster so every waiting client drops
    // the removed bot from its seat list, not just the owner (PTW-233).
    this._broadcastLobbyPlayers(room);
    // Seat freed — resync occupancy so the lobby count drops the bot (PTW-255 #1).
    this._notifyBackendPlayerCount(room.roomId, room.players.size);
  }

  /**
   * Handle start game request
   * @param {Socket} socket
   * @param {Object} data
   */
  handleStartGame(socket, data) {
    const { roomId } = data;
    const requestId = data?.requestId || socket.handshake?.headers?.['x-request-id'] || null;

    // Resolve control the same way deal/replace-with-bot do. An owner who
    // replaced their OWN seat with a bot is no longer a seated player — the
    // socket→player map no longer resolves them — but they still control the
    // room via ownerControllerSocketId and must still be able to start it.
    const control = this._resolveWaitingRoomControl(socket, data);
    const playerId = control.playerId;
    const room = control.room;
    const isOwnerController = control.isOwnerController;

    if (!playerId && !isOwnerController) {
      return;
    }

    // Mark player as active (owner-controller has no seated player to mark).
    if (playerId) {
      this.gameService.markPlayerActive(playerId);
    }

    if (!room) {
      this._logRoomLifecycle('start_rejected_room_not_found', {
        roomId: roomId || null,
        playerId,
        socketId: socket.id,
        requestId,
      });
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Room not found'));
      return;
    }

    // Seated-player + host authorization only applies to an actual seated
    // player. The owner-controller delegated their seat to a bot, so they bypass
    // these checks — their authority is proven by ownerControllerSocketId.
    if (!isOwnerController) {
      const player = room.getPlayer(playerId);
      if (!player) {
        socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Player not in room'));
        return;
      }

      // Only verified join/reconnect may rebind a seat. An old authenticated
      // socket must not take it back by sending start_game after reconnect.
      if (!this._socketOwnsSeat(socket, player)) {
        socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Please rejoin before starting the game'));
        return;
      }

      // Only host can start
      if (room.hostPlayerId && room.hostPlayerId !== playerId) {
        socket.emit(
          SocketEvents.ERROR,
          ErrorHandler.createErrorResponse('Only the host can start the game')
        );
        return;
      }
    }

    if (room.startAttemptProtocol === 1 && room.status === GameRoomStatus.WAITING) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Please start the room through the lobby API'));
      return;
    }

    // Check if room is full
    if (!room.canStart()) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse(
          `Cannot start game: Room is not full (${room.players.size}/${room.maxPlayers} players)`
        )
      );
      return;
    }

    // #11 multi-round: the SERVER owns the cadence between rounds. A client
    // start_game racing the scheduled deal (the currently-shipped Flutter
    // auto-next-round workaround fires one every 10s) must be a NO-OP, not a
    // second deal — dealing twice would reshuffle mid-animation and desync every
    // hand. Making it a no-op is also what lets the two deploys ship in any
    // order: the old client's workaround simply stops mattering.
    if (room.awaitingNextRound) {
      logger.info(
        `[START_GAME] Ignoring start from ${playerId}: room ${room.roomId} already has a server-scheduled next round.`
      );
      this._logRoomLifecycle('start_ignored_next_round_pending', {
        roomId: room.roomId,
        playerId,
        socketId: socket.id,
        requestId,
        nextRoundAt: room.nextRoundAt,
      });
      return;
    }

    // A SETTLED MATCH IS NOT RESTARTABLE. The room survives its own end for a
    // 60s reconnect grace (FINISHED_ROOM_GRACE_MS) and the normal end path does
    // not detach player sockets, so a host client could emit start_game into a
    // finished room. startGame() is the per-ROUND reset — it deliberately keeps
    // cumulativeTeamScores — and nothing clears matchResultReported, so the
    // "new" match would begin already at or past target AND its terminal
    // settlement webhook would be swallowed by the per-match latch. That is the
    // money path.
    //
    // The guard is on the MATCH, not on the room's status. A room that merely
    // finished a ROUND is FINISHED on paper and its re-deal is legitimate —
    // that is how round N+1 is dealt, whether the local scheduler or wlive's
    // /webhooks/start-game drives the cadence. Only a settled MATCH is refused,
    // and `matchResultReported` is the exact latch that would swallow the next
    // settlement (lastRoundEndPayload.matchEnded covers a terminal end whose
    // webhook never fired).
    if (room.hasEnded && room.hasEnded() && this._matchIsSettled(room)) {
      logger.warn(
        `[START_GAME] Refusing to re-deal FINISHED room ${room.roomId} for ${playerId}: the match is settled.`
      );
      this._logRoomLifecycle('start_rejected_match_finished', {
        roomId: room.roomId,
        playerId,
        socketId: socket.id,
        requestId,
      });
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('This match is already finished')
      );
      return;
    }

    // Check if already started
    if (room.isInProgress()) {
      // Lobby phase is over → stop the host heartbeat if it somehow survived.
      this._stopHostHeartbeat(room);
      logger.info(`[START_GAME] Game already in progress in room ${room.roomId}. Sending state.`);
      this._logRoomLifecycle('start_idempotent_already_in_progress', {
        roomId: room.roomId,
        playerId,
        socketId: socket.id,
        requestId,
      });
      if (room.cardsDealt === false) {
        this._autoDealAfterStart(room, `idempotent start by ${playerId}`);
      } else {
        this._sendInitialGameState(room);
      }
      return;
    }

    this._applyTurnTimeLimit(room, data);

    try {
      // Force start (requires at least 2 players)
      if (room.startGame(true)) {
        // Lobby phase over → stop the host heartbeat; in-game grace/bot logic
        // now owns disconnects.
        this._stopHostHeartbeat(room);
        logger.info(
          `[START_GAME] Game manually started by player ${playerId} in room ${room.roomId}`
        );
        this._logRoomLifecycle('game_started_manual', {
          roomId: room.roomId,
          playerId,
          socketId: socket.id,
          requestId,
          playerCount: room.players.size,
          maxPlayers: room.maxPlayers,
        });

        // Notify all players
        room.getPlayers().forEach((p) => {
          if (p.isBot === true) return;
          const playerSocket = this.io.sockets.sockets.get(p.socketId);
          if (playerSocket) {
            playerSocket.emit(SocketEvents.GAME_STARTED, {
              ...this._serializeRoomGameSettings(room),
              players: room.getPlayers().map((mp) => this._serializePlayer(mp)),
              yourPlayerIndex: p.playerIndex,
              currentPlayerIndex: this._announcedTurnIndex(room),
              ...this._skinsPayloadFields(room),
              cardsDealt: room.cardsDealt || false,
              hostId: room.hostPlayerId || null,
              turnTimeLimitSeconds: room.turnTimeLimit,
              timestamp: new Date().toISOString(),
            });
          } else {
            logger.warn(
              `[START_GAME] Socket not found for player ${p.playerId} (socketId: ${p.socketId})`
            );
          }
        });

        const dealResult = this._autoDealAfterStart(room, `manual start by ${playerId}`);
        if (!dealResult.success) {
          socket.emit(
            SocketEvents.ERROR,
            ErrorHandler.createErrorResponse(dealResult.error || 'Failed to deal cards')
          );
          this._sendInitialGameState(room);
        }
        this._emitPartnerWebhook('game.started', {
          roomId: room.roomId,
          players: room.getPlayers().map((p) => this._serializePlayer(p)),
          currentPlayerIndex: room.currentTurn,
        });
      } else {
        logger.warn(
          `[START_GAME] Failed to start game in room ${room.roomId}. Players: ${room.players.size}`
        );
        socket.emit(
          SocketEvents.ERROR,
          ErrorHandler.createErrorResponse('Cannot start game (need at least 2 players)')
        );
      }
    } catch (error) {
      logger.error(`[START_GAME] Error starting game: ${error.message}`, error);
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse(`Failed to start game: ${error.message}`)
      );
    }
  }

  /**
   * Trigger start game without a socket context (webhook)
   * @param {string} roomId
   * @param {Object} options - Optional start configuration
   * @returns {Object}
   */
  triggerStartGame(roomId, options = {}) {
    const id = roomId == null ? roomId : String(roomId);
    return logger.runWithRoom(id, () => {
      if (options.attemptId != null || this.gameService.getRoom(id)?.startAttemptProtocol === 1) {
        return startBackendAttempt(this, id, options);
      }
      return this._triggerStartGameNow(roomId, options);
    });
  }

  abortStartFromBackend(data = {}) {
    return logger.runWithRoom(data.roomId, () =>
      abortBackendAttempt(this, String(data.roomId || ''), data.attemptId)
    );
  }

  _triggerStartGameNow(roomId, options = {}) {
    return logger.runWithRoom(roomId, () => this._triggerStartGameNowImpl(roomId, options));
  }

  _triggerStartGameNowImpl(roomId, options = {}) {
    const skins = options.skins || {};
    const normalizedRoomId = roomId === null || roomId === undefined ? roomId : String(roomId);
    let room = this.gameService.getRoom(normalizedRoomId);
    if (!room) {
      // Room doesn't exist in memory yet, create it
      // This can happen if webhook is called before any player joins via socket
      logger.info(`[TRIGGER_START_GAME] Room ${normalizedRoomId} not found in memory, creating it`);
      room = this.gameService.createRoom(normalizedRoomId);
      if (!room) {
        logger.warn(`[TRIGGER_START_GAME] Failed to create room: ${normalizedRoomId}`);
        return { success: false, error: 'Failed to create room' };
      }
    }

    this._logRoomLifecycle('start_triggered_by_webhook', {
      roomId: normalizedRoomId,
      source: 'webhook',
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers,
    });

    // Save skins to room if provided
    if (Object.keys(skins).length > 0) {
      room.skins = skins;
    }

    // #11 multi-round: same race as handleStartGame. wlive's
    // finalizeIntermediateRound also POSTs /webhooks/start-game after each round,
    // so without this the backend trigger and the local scheduler would both deal
    // round N+1. Report success so the backend does not retry.
    if (room.awaitingNextRound) {
      logger.info(
        `[TRIGGER_START_GAME] Ignoring webhook start for ${normalizedRoomId}: a next round is already scheduled.`
      );
      return { success: true, nextRoundPending: true, nextRoundAt: room.nextRoundAt || null };
    }

    // Same settled-match guard as handleStartGame — the backend trigger must not
    // be a back door into re-dealing a room whose escrow has already settled.
    if (room.hasEnded && room.hasEnded() && this._matchIsSettled(room)) {
      logger.warn(
        `[TRIGGER_START_GAME] Refusing to re-deal FINISHED room ${normalizedRoomId}: the match is settled.`
      );
      return { success: false, error: 'match already finished' };
    }

    if (room.isInProgress()) {
      // Lobby phase is over → stop the host heartbeat if it somehow survived.
      this._stopHostHeartbeat(room);
      logger.info(
        `[TRIGGER_START_GAME] Game already in progress in room ${normalizedRoomId}. Sending state.`
      );
      if (room.cardsDealt === false) {
        this._autoDealAfterStart(room, 'idempotent webhook start');
      } else {
        this._sendInitialGameState(room);
      }
      return { success: true, alreadyStarted: true, cardsDealt: room.cardsDealt || false };
    }

    // The API's occupancy may lag a lobby disconnect/grace expiry. Validate
    // actual seats before dealing, just as the socket start path does.
    if (!room.canStart()) {
      this._logRoomLifecycle('start_rejected_incomplete_roster', {
        roomId: normalizedRoomId,
        playerCount: room.players.size,
        maxPlayers: room.maxPlayers,
        seats: room.getPlayers().map((player) => player.playerIndex),
      });
      return {
        success: false,
        error: `Cannot start game: Room needs ${room.maxPlayers} valid occupied seats (${room.players.size} players)`,
      };
    }

    this._applyTurnTimeLimit(room, options);

    try {
      if (room.startGame(true)) {
        // Game is in progress now — the in-game grace/reconnect + bot-takeover
        // logic owns disconnects; stop the lobby host heartbeat.
        this._stopHostHeartbeat(room);
        logger.info(`[TRIGGER_START_GAME] Game manually started via API in room ${room.roomId}`);

        const announceStart = () => {
        room.getPlayers().forEach((p) => {
          if (p.isBot === true) return;
          const playerSocket = this.io.sockets.sockets.get(p.socketId);
          if (playerSocket) {
            playerSocket.emit(SocketEvents.GAME_STARTED, {
              ...this._serializeRoomGameSettings(room),
              players: room.getPlayers().map((mp) => this._serializePlayer(mp)),
              yourPlayerIndex: p.playerIndex,
              currentPlayerIndex: this._announcedTurnIndex(room),
              ...this._skinsPayloadFields(room),
              cardsDealt: room.cardsDealt || false,
              hostId: room.hostPlayerId || null,
              turnTimeLimitSeconds: room.turnTimeLimit,
              timestamp: new Date().toISOString(),
            });
            logger.info(
              `[TRIGGER_START_GAME] Emitted GAME_STARTED to player ${p.playerId} (socketId: ${p.socketId})`
            );
          } else {
            logger.warn(
              `[TRIGGER_START_GAME] Socket not found for player ${p.playerId} (socketId: ${p.socketId})`
            );
          }
        });

        if (room.ownerControllerSocketId) {
          const ownerSocket = this.io.sockets.sockets.get(room.ownerControllerSocketId);
          if (ownerSocket) {
            this._sendStateToSpectator(
              ownerSocket,
              room,
              room.ownerControllerPlayerId || 'owner-controller',
              'Owner',
              { includeGameStarted: true }
            );
          }
        }

        };
        if (!options.deferStartAnnouncement) announceStart();

        const dealResult = this._autoDealAfterStart(room, 'webhook start');
        if (!dealResult.success) {
          if (!options.deferStartAnnouncement) this._sendInitialGameState(room);
          return { success: false, error: dealResult.error || 'Failed to deal cards' };
        }
        if (options.deferStartAnnouncement) {
          announceStart();
          this._sendInitialGameState(room);
        }
        this._emitPartnerWebhook('game.started', {
          roomId: room.roomId,
          players: room.getPlayers().map((p) => this._serializePlayer(p)),
          currentPlayerIndex: room.currentTurn,
          source: 'webhook',
        });
        return { success: true, cardsDealt: room.cardsDealt || false };
      } else {
        logger.warn(
          `[TRIGGER_START_GAME] Failed to start game in room ${normalizedRoomId}. Players: ${room.players.size}`
        );
        return { success: false, error: 'Cannot start game (need at least 2 players)' };
      }
    } catch (error) {
      logger.error(`[TRIGGER_START_GAME] Error starting game: ${error.message}`, error);
      return { success: false, error: `Failed to start game: ${error.message}` };
    }
  }

  syncRoomFromBackend(data = {}) {
    return logger.runWithRoom(data?.roomId, () => this._syncRoomFromBackendImpl(data));
  }

  _syncRoomFromBackendImpl(data = {}) {
    const normalizedRoomId =
      data?.roomId === null || data?.roomId === undefined ? data?.roomId : String(data.roomId);
    if (!normalizedRoomId) {
      return { success: false, error: 'roomId required' };
    }

    const syncedMaxPlayers = this._extractMaxPlayers(data);
    // Seat COUNT is part of the running match's contract, not a lobby setting.
    // maxPlayers decides even/odd teaming, turn rotation modulus, and the
    // "is the table full?" precondition the next-round scheduler enforces — and
    // cumulativeTeamScores is keyed on exactly that teaming. A sync arriving
    // mid-match (heartbeat, a host settings edit, a re-sync after a backend
    // restart) used to rewrite it through BOTH writers below: a 2-seat live match
    // re-synced with max_players=4 became players.size(2) !== maxPlayers(4), and
    // the next scheduled round answered that with _abortNextRound('seat_missing')
    // — a terminal end to a healthy match nobody left. Freeze it while a match is
    // live OR mid-intermission; every other synced field stays applicable.
    // Passing null keeps GameService.createRoom's own maxPlayers write out too.
    const seatsFrozen = this._seatsLocked(this.gameService.getRoom?.(normalizedRoomId));
    const room = this.gameService.createRoom(
      normalizedRoomId,
      seatsFrozen ? null : syncedMaxPlayers
    );

    // Snapshot the client-visible lobby settings BEFORE applying this sync so we
    // can tell a real host-driven settings edit from a no-op re-sync (join /
    // heartbeat / normal sync) and only broadcast ROOM_SETTINGS_CHANGED on the
    // former. Captured here, compared after every field has been applied.
    const settingsBefore = this._roomSettingsSnapshot(room);

    if (syncedMaxPlayers != null && !seatsFrozen) {
      room.maxPlayers = Math.max(syncedMaxPlayers, room.players.size);
    } else if (syncedMaxPlayers != null && syncedMaxPlayers !== room.maxPlayers) {
      logger.warn(
        `[SYNC_ROOM] Ignoring maxPlayers ${syncedMaxPlayers} for room ${room.roomId}: ` +
          `a match is in progress at ${room.maxPlayers} seats.`
      );
    }

    if (
      data.ruleset === 'professional' ||
      data.ruleset === 'classic' ||
      data.ruleset === 'classicWithNoJoker'
    ) {
      room.ruleset = data.ruleset;
    }

    if (data.professionalWellMode === 'direct' || data.professionalWellMode === 'indirect') {
      room.professionalWellMode = data.professionalWellMode;
    }

    // Lobby visibility + password gate, mirrored from the host's settings edit.
    // The socket never receives the raw/hashed password — only `hasPassword`,
    // an explicit backend boolean (or, when visibility flips public, false).
    if (data.visibility === 'public' || data.visibility === 'private') {
      room.visibility = data.visibility;
    }
    const syncedHasPassword = this._coerceSyncBool(data.hasPassword);
    if (syncedHasPassword !== undefined) {
      room.hasPassword = syncedHasPassword;
    } else if (room.visibility === 'public') {
      // A public room is never gated; the backend clears the password on going
      // public, so reflect that even if it omits an explicit hasPassword flag.
      room.hasPassword = false;
    }

    // New PRO room settings (Brazilia-pro revision). All optional; the backend
    // sends them in the sync-room payload. See brazilia_pro_settings_contract.md.
    this._applyRoomSettings(room, data);

    // Turn timer from sync-room (start-game also applies it). Honors
    // turnTimeLimitSeconds; clamps to a sane range. No-op when absent.
    this._applyTurnTimeLimit(room, data, { restartActiveTimer: true });

    // The BACKEND is authoritative for who the host is (wlive's host_user_id).
    // Always trust it — even if the socket previously guessed a host from the
    // FIRST JOINER (GameService.joinRoom / the spectator-sit fallback) before the
    // real host connected. Without this, a joiner stays the socket-host, so THEIR
    // leave wrongly kills the room for everyone while the REAL host's leave does
    // nothing (the room stays listed). A waiting Brazilia lobby never migrates its
    // host (host-leave ends the room), so there is no legitimate socket-side host
    // to protect against a stale sync here.
    if (data.hostPlayerId) {
      room.hostPlayerId = String(data.hostPlayerId);
    }
    // Mark the room backend-owned so the first-joiner host fallbacks never
    // reassign the host away from what the backend synced.
    room.backendManaged = true;
    // Opt in only when the owning backend supports versioned seat rejection.
    // Other apps can share this socket server without implementing that API.
    if (data.seatReservationProtocol === 1) room.seatReservationProtocol = 1;
    if (data.seatConnectionProtocol === 1) room.seatConnectionProtocol = 1;
    if (data.seatLayoutProtocol === 1) room.seatLayoutProtocol = 1;
    if (data.startAttemptProtocol === 1) room.startAttemptProtocol = 1;

    // Routing (1 socket → 2 backends): each backend may send its own callback
    // base URL so room-closed/left/count webhooks go back to the right app. When
    // absent the helpers fall back to config.backend.url (single-backend deploy).
    if (typeof data.backendUrl === 'string' && data.backendUrl.length > 0) {
      room.backendBaseUrl = data.backendUrl;
    }
    if (room.restoreWaitingHostSeat?.()) this._broadcastSeatChanged(room);

    if (typeof data.name === 'string' && data.name.length > 0) {
      room.name = data.name;
    }

    if (data.skins && typeof data.skins === 'object') {
      room.skins = data.skins;
    }

    const botSpecs = Array.isArray(data.bots)
      ? data.bots
      : Array.from({ length: Math.max(0, Number(data.botCount || 0)) }, (_, index) => ({
        botName: `Bot ${index + 1}`,
      }));

    const addedBots = [];
    botSpecs.forEach((botSpec) => {
      if (room.players.size >= room.maxPlayers) return;
      const botResult = this.inviteBotToRoom({
        ...botSpec,
        roomId: normalizedRoomId,
        autoStart: false,
        suppressStateBroadcast: true,
        invitedBy: data.hostPlayerId || 'backend',
      });
      if (botResult.success) {
        addedBots.push({
          playerId: botResult.playerId,
          playerIndex: botResult.playerIndex,
          playerName: botResult.playerName,
        });
      }
    });

    this._logRoomLifecycle('room_synced_from_backend', {
      source: 'webhook',
      roomId: normalizedRoomId,
      maxPlayers: room.maxPlayers,
      playerCount: room.players.size,
      hostPlayerId: room.hostPlayerId || null,
      status: data.status || null,
    });

    if (addedBots.length > 0) {
      this._sendInitialGameState(room);
      // Bots filled seats from the backend sync — resync occupancy so the lobby
      // reflects the bot-occupied seats in its count (PTW-255 #1).
      this._notifyBackendPlayerCount(room.roomId, room.players.size);
    }

    const startResult =
      data.autoStart === true && room.players.size >= room.maxPlayers
        ? this.triggerStartGame(room.roomId, data)
        : null;

    // Start (idempotent) the lobby host heartbeat for the freshly-synced room.
    // No-op if it just auto-started above (status → inProgress) or if disabled.
    this._ensureHostHeartbeat(room);
    this._queueSeatLayoutSync(room);

    // Tell connected lobby clients when (and only when) a host actually changed
    // a client-visible setting. Runs after autoStart so a sync that started the
    // match (status → inProgress) is skipped by the WAITING guard below.
    this._broadcastRoomSettingsChange(room, settingsBefore);

    return {
      success: true,
      roomId: room.roomId,
      maxPlayers: room.maxPlayers,
      playerCount: room.players.size,
      addedBots,
      startResult,
    };
  }

  /**
   * Coerce a loosely-typed sync flag (bool / 'true'/'false' / 1/0 / '1'/'0') to
   * a boolean, returning undefined when absent/unrecognized so callers can leave
   * the field unchanged.
   * @param {*} v
   * @returns {boolean|undefined}
   */
  _coerceSyncBool(v) {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    return undefined;
  }

  /**
   * Snapshot the client-visible lobby settings used for ROOM_SETTINGS_CHANGED
   * change detection. Keep this set in sync with the emit payload's trigger
   * fields (targetScore, turnTimeLimitSeconds, professionalWellMode,
   * chatEnabled, visibility, name).
   * @param {import('../models/GameRoom')} room
   */
  _roomSettingsSnapshot(room) {
    return {
      name: room?.name ?? null,
      visibility: room?.visibility ?? null,
      targetScore: room?.targetScore,
      turnTimeLimitSeconds: room?.turnTimeLimit,
      professionalWellMode: room?.professionalWellMode,
      chatEnabled: room?.chatEnabled,
    };
  }

  /**
   * Emit ROOM_SETTINGS_CHANGED to a WAITING (lobby) room iff one of its
   * client-visible settings actually changed versus `before`. No-op for
   * in-progress/finished rooms and for no-op re-syncs (join/heartbeat/normal
   * sync) so the lobby doesn't get spammed.
   * @param {import('../models/GameRoom')} room
   * @param {ReturnType<SocketHandlers['_roomSettingsSnapshot']>} before
   */
  // ─── Admin skin override ──────────────────────────────────────────────────
  // The server decides which skins a table shows (see SocketEvents.SKINS_UPDATED).
  // Precedence: per-game override → global override (timed) → room owner skins
  // → none. A per-game override lives on the room object, so it ends with the
  // game (a new room starts from the players' own skins again); the global one
  // carries an expiry and is persisted so a restart neither loses nor revives
  // it past its deadline.

  /** Skins keys an override may carry; anything else is dropped. */
  static get SKIN_OVERRIDE_KEYS() {
    return ['table_skin', 'card_skin', 'table_theme', 'card_back_style', 'card_face_style'];
  }

  /** Normalises an admin skins object to the allowed keys (non-empty strings only). */
  _sanitizeOverrideSkins(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const key of SocketHandlers.SKIN_OVERRIDE_KEYS) {
      const value = input[key];
      if (typeof value === 'string' && value.trim().length > 0 && value.length <= 1024) {
        out[key] = value.trim();
      }
    }
    return out;
  }

  /** The active global override, dropping it (lazily) once it has expired. */
  _activeGlobalSkinOverride() {
    const g = this.globalSkinOverride;
    if (!g) return null;
    if (g.expiresAt && Date.parse(g.expiresAt) <= Date.now()) {
      this._expireGlobalSkinOverride();
      return null;
    }
    return g;
  }

  /**
   * The skins a room shows right now and where they come from.
   * @returns {{skins: Object, source: string, expiresAt: (string|null)}}
   */
  _effectiveSkins(room) {
    // An override is composed OVER the owner's skins: the admin changes only
    // the slots they set (a table-only override leaves the owner's card back
    // in place) — no slot the admin never touched should visibly change.
    const owner = room?.skins && typeof room.skins === 'object' ? room.skins : {};
    if (room?.skinOverride?.skins && Object.keys(room.skinOverride.skins).length > 0) {
      return { skins: { ...owner, ...room.skinOverride.skins }, source: 'admin_room', expiresAt: null };
    }
    const global = this._activeGlobalSkinOverride();
    if (global && Object.keys(global.skins || {}).length > 0) {
      return { skins: { ...owner, ...global.skins }, source: 'admin_global', expiresAt: global.expiresAt || null };
    }
    if (room?.skins && typeof room.skins === 'object' && Object.keys(room.skins).length > 0) {
      return { skins: { ...room.skins }, source: 'owner', expiresAt: null };
    }
    return { skins: {}, source: 'none', expiresAt: null };
  }

  /** The three skin fields every state payload carries. */
  _skinsPayloadFields(room) {
    const eff = this._effectiveSkins(room);
    return { skins: eff.skins, skinsSource: eff.source, skinsExpiresAt: eff.expiresAt };
  }

  /** Emits SKINS_UPDATED for `room` to its players and its spectators. */
  _broadcastSkinsUpdated(room, reason = 'changed') {
    if (!room) return;
    const payload = {
      roomId: room.roomId,
      ...this._skinsPayloadFields(room),
      reason,
      timestamp: new Date().toISOString(),
    };
    this.io.to(room.roomId).emit(SocketEvents.SKINS_UPDATED, payload);
    // Spectators that never joined the io room (older join paths) get their own
    // copy; ones that did are skipped so nobody receives it twice.
    const specs = this.roomSpectators.get(room.roomId);
    if (specs) {
      const members = this.io.sockets?.adapter?.rooms?.get?.(room.roomId);
      for (const socketId of specs.keys()) {
        if (members && members.has(socketId)) continue;
        const socket = this.io.sockets?.sockets?.get?.(socketId);
        if (socket) socket.emit(SocketEvents.SKINS_UPDATED, payload);
      }
    }
    this._logRoomLifecycle('skins_updated', {
      source: 'admin',
      roomId: room.roomId,
      skinsSource: payload.skinsSource,
      reason,
    });
  }

  /** Every room the server knows, for admin fan-out and listings. */
  _allRooms() {
    const rooms = this.gameService?.rooms;
    if (rooms instanceof Map) return Array.from(rooms.values());
    if (typeof this.gameService?.getAllRooms === 'function') return this.gameService.getAllRooms();
    return [];
  }

  /**
   * Sets an override.
   * - `{ scope: 'room', roomId, skins, setBy? }` — this game only.
   * - `{ scope: 'global', skins, durationMs? | expiresAt?, setBy? }` — every
   *   room, until the deadline (no deadline = until cleared).
   * Broadcasts to every affected room immediately, in-progress games included.
   */
  async setSkinOverride(data = {}) {
    const scope = data.scope === 'global' ? 'global' : data.scope === 'room' ? 'room' : null;
    if (!scope) return { success: false, error: "scope must be 'room' or 'global'" };
    const skins = this._sanitizeOverrideSkins(data.skins);
    if (Object.keys(skins).length === 0) {
      return {
        success: false,
        error: `skins must carry at least one of ${SocketHandlers.SKIN_OVERRIDE_KEYS.join(', ')}`,
      };
    }
    const setBy = typeof data.setBy === 'string' ? data.setBy.slice(0, 120) : null;
    const setAt = new Date().toISOString();

    if (scope === 'room') {
      const roomId = data.roomId === null || data.roomId === undefined ? '' : String(data.roomId);
      if (!roomId) return { success: false, error: 'roomId required' };
      const room = this.gameService.getRoom(roomId);
      if (!room) return { success: false, error: 'room not found' };
      room.skinOverride = { skins, setBy, setAt };
      this._broadcastSkinsUpdated(room, 'admin_room_set');
      await this._persistRoomQuietly(room);
      return { success: true, scope, roomId, skins, expiresAt: null };
    }

    let expiresAt = null;
    if (Number.isFinite(Number(data.durationMs)) && Number(data.durationMs) > 0) {
      expiresAt = new Date(Date.now() + Number(data.durationMs)).toISOString();
    } else if (typeof data.expiresAt === 'string' && Number.isFinite(Date.parse(data.expiresAt))) {
      if (Date.parse(data.expiresAt) <= Date.now()) {
        return { success: false, error: 'expiresAt is in the past' };
      }
      expiresAt = new Date(Date.parse(data.expiresAt)).toISOString();
    }
    this.globalSkinOverride = { skins, expiresAt, setBy, setAt };
    this._armGlobalSkinOverrideTimer();
    await this._persistGlobalSkinOverride();
    for (const room of this._allRooms()) this._broadcastSkinsUpdated(room, 'admin_global_set');
    return { success: true, scope, skins, expiresAt };
  }

  /**
   * Clears an override: `{ scope: 'room', roomId }` or `{ scope: 'global' }`.
   * Affected rooms fall back to the next source and are told at once.
   */
  async clearSkinOverride(data = {}) {
    const scope = data.scope === 'global' ? 'global' : data.scope === 'room' ? 'room' : null;
    if (!scope) return { success: false, error: "scope must be 'room' or 'global'" };
    if (scope === 'room') {
      const roomId = data.roomId === null || data.roomId === undefined ? '' : String(data.roomId);
      if (!roomId) return { success: false, error: 'roomId required' };
      const room = this.gameService.getRoom(roomId);
      if (!room) return { success: false, error: 'room not found' };
      const had = Boolean(room.skinOverride);
      room.skinOverride = null;
      if (had) {
        this._broadcastSkinsUpdated(room, 'admin_room_cleared');
        await this._persistRoomQuietly(room);
      }
      return { success: true, scope, roomId, cleared: had };
    }
    const had = Boolean(this.globalSkinOverride);
    this.globalSkinOverride = null;
    this._armGlobalSkinOverrideTimer();
    await this._persistGlobalSkinOverride();
    if (had) {
      for (const room of this._allRooms()) this._broadcastSkinsUpdated(room, 'admin_global_cleared');
    }
    return { success: true, scope, cleared: had };
  }

  /** The global override plus every room-level one, for the admin console. */
  getSkinOverrideStatus() {
    const global = this._activeGlobalSkinOverride();
    const rooms = [];
    for (const room of this._allRooms()) {
      if (room.skinOverride) {
        rooms.push({ roomId: room.roomId, status: room.status, ...room.skinOverride });
      }
    }
    return { success: true, global: global ? { ...global } : null, rooms };
  }

  /** Live rooms as the admin console lists them: seats, watchers, skins in force. */
  listRoomsForAdmin() {
    const rooms = this._allRooms().map((room) => {
      const players = room.getPlayers().map((p) => ({
        playerId: String(p.playerId),
        playerName: p.playerName ?? p.name ?? null,
        playerIndex: p.playerIndex,
        isBot: p.isBot === true,
        isConnected: p.isConnected !== false,
        avatarUrl: p.avatarUrl || p.photoUrl || null,
      }));
      const eff = this._effectiveSkins(room);
      return {
        roomId: room.roomId,
        name: room.name ?? null,
        status: room.status,
        maxPlayers: room.maxPlayers,
        playerCount: players.length,
        spectatorCount: this.roomSpectators.get(room.roomId)?.size ?? 0,
        hostPlayerId: room.hostPlayerId || null,
        bet: room.bet ?? 0,
        ruleset: room.ruleset ?? null,
        backendUrl: room.backendBaseUrl || null,
        players,
        skins: eff.skins,
        skinsSource: eff.source,
        skinsExpiresAt: eff.expiresAt,
        skinOverride: room.skinOverride ? { ...room.skinOverride } : null,
        createdAt: room.createdAt?.toISOString?.() || null,
        gameStartedAt: room.gameStartedAt?.toISOString?.() || null,
      };
    });
    return { success: true, rooms, global: this._activeGlobalSkinOverride() };
  }

  /** (Re)arms the timer that clears the global override at its deadline. */
  _armGlobalSkinOverrideTimer() {
    if (this._globalSkinOverrideTimer) {
      clearTimeout(this._globalSkinOverrideTimer);
      this._globalSkinOverrideTimer = null;
    }
    const g = this.globalSkinOverride;
    if (!g || !g.expiresAt) return;
    const remaining = Date.parse(g.expiresAt) - Date.now();
    // setTimeout caps at 2^31-1 ms; longer deadlines re-arm when they fire.
    const wait = Math.max(0, Math.min(remaining, 2147483647));
    this._globalSkinOverrideTimer = setTimeout(() => {
      this._globalSkinOverrideTimer = null;
      if (!this.globalSkinOverride) return;
      if (Date.parse(this.globalSkinOverride.expiresAt) - Date.now() > 0) {
        this._armGlobalSkinOverrideTimer();
        return;
      }
      this._expireGlobalSkinOverride();
    }, wait);
    this._globalSkinOverrideTimer.unref?.();
  }

  /** Drops an expired global override and tells every room to revert. */
  _expireGlobalSkinOverride() {
    if (!this.globalSkinOverride) return;
    this.globalSkinOverride = null;
    if (this._globalSkinOverrideTimer) {
      clearTimeout(this._globalSkinOverrideTimer);
      this._globalSkinOverrideTimer = null;
    }
    this._persistGlobalSkinOverride().catch?.(() => {});
    for (const room of this._allRooms()) this._broadcastSkinsUpdated(room, 'admin_global_expired');
  }

  async _persistRoomQuietly(room) {
    if (!this.failureManager?.persistGameState) return;
    try {
      await this.failureManager.persistGameState(room);
    } catch (err) {
      logger.warn(`[SKINS] room persistence failed: ${err.message}`);
    }
  }

  async _persistGlobalSkinOverride() {
    if (!this.failureManager?.persistGlobalSkinOverride) return;
    try {
      await this.failureManager.persistGlobalSkinOverride(this.globalSkinOverride);
    } catch (err) {
      logger.warn(`[SKINS] global override persistence failed: ${err.message}`);
    }
  }

  /** Startup: reloads the persisted global override (if it has not expired). */
  async restoreGlobalSkinOverride() {
    if (!this.failureManager?.loadGlobalSkinOverride) return null;
    try {
      const state = await this.failureManager.loadGlobalSkinOverride();
      if (state && state.skins && (!state.expiresAt || Date.parse(state.expiresAt) > Date.now())) {
        this.globalSkinOverride = {
          skins: this._sanitizeOverrideSkins(state.skins),
          expiresAt: state.expiresAt || null,
          setBy: state.setBy || null,
          setAt: state.setAt || new Date().toISOString(),
        };
        this._armGlobalSkinOverrideTimer();
        logger.info('[SKINS] global override restored', {
          expiresAt: this.globalSkinOverride.expiresAt,
        });
      }
    } catch (err) {
      logger.warn(`[SKINS] global override restore failed: ${err.message}`);
    }
    return this.globalSkinOverride;
  }

  _broadcastRoomSettingsChange(room, before) {
    if (!room || room.status !== GameRoomStatus.WAITING) return;
    const after = this._roomSettingsSnapshot(room);
    const changed = Object.keys(after).some((key) => after[key] !== before[key]);
    if (!changed) return;

    this.io.to(room.roomId).emit(SocketEvents.ROOM_SETTINGS_CHANGED, {
      roomId: room.roomId,
      name: room.name ?? null,
      visibility: room.visibility ?? null,
      targetScore: room.targetScore,
      turnTimeLimitSeconds: room.turnTimeLimit,
      professionalWellMode: room.professionalWellMode,
      chatEnabled: Boolean(room.chatEnabled),
      hasPassword: Boolean(room.hasPassword),
    });
  }

  getRoomRuntimeSnapshot(data = {}) {
    return logger.runWithRoom(data?.roomId, () => this._getRoomRuntimeSnapshotImpl(data));
  }

  _getRoomRuntimeSnapshotImpl(data = {}) {
    const normalizedRoomId =
      data?.roomId === null || data?.roomId === undefined ? data?.roomId : String(data.roomId);

    if (!normalizedRoomId) {
      return { success: false, error: 'roomId required' };
    }

    const room = this.gameService.getRoom(normalizedRoomId);
    if (!room) {
      this._logRoomLifecycle('runtime_snapshot_room_missing', {
        source: 'webhook',
        roomId: normalizedRoomId,
      });

      return {
        success: true,
        roomId: normalizedRoomId,
        exists: false,
        hostPlayerId: null,
        hostConnected: false,
        playerCount: 0,
        playerIds: [],
      };
    }

    const players = room.getPlayers();

    // Authoritative host-presence signal for the backend reapers. Derived from the
    // SAME live-socket lookup the host heartbeat uses (hostPlayerId → seat socketId →
    // io.sockets.sockets.get), NOT from the optimistic seat-model `isConnected` flag,
    // which only flips false at transport pingTimeout (~60s) and so reports a dead
    // host as connected for up to a minute. Backend reapers MUST key on `hostConnected`
    // rather than cross-referencing hostPlayerId against players[].isConnected.
    const hostPlayer = room.hostPlayerId ? room.players.get(room.hostPlayerId) : null;
    const hostConnected = Boolean(
      hostPlayer?.socketId && this.io.sockets.sockets.get(hostPlayer.socketId)
    );

    const payload = {
      success: true,
      roomId: room.roomId,
      exists: true,
      status: room.status,
      maxPlayers: room.maxPlayers,
      turnTimeLimitSeconds: room.turnTimeLimit,
      hostPlayerId: room.hostPlayerId || null,
      hostConnected,
      startAttemptProtocol: 1,
      playerCount: players.length,
      playerIds: players.map((player) => String(player.playerId)),
      players: players.map((player) => ({
        playerId: String(player.playerId),
        playerIndex: player.playerIndex,
        isConnected: player.isConnected,
        isBot: player.isBot === true,
      })),
      spectatorCount: this.roomSpectators.get(room.roomId)?.size ?? 0,
      ...this._skinsPayloadFields(room),
      skinOverride: room.skinOverride ? { ...room.skinOverride } : null,
    };

    this._logRoomLifecycle('runtime_snapshot_generated', {
      source: 'webhook',
      roomId: room.roomId,
      playerCount: players.length,
      maxPlayers: room.maxPlayers,
    });

    return payload;
  }

  cancelRoomFromBackend(data = {}) {
    return logger.runWithRoom(data?.roomId, () => this._cancelRoomFromBackendImpl(data));
  }

  _cancelRoomFromBackendImpl(data = {}) {
    const normalizedRoomId =
      data?.roomId === null || data?.roomId === undefined ? data?.roomId : String(data.roomId);
    if (!normalizedRoomId) {
      return { success: false, error: 'roomId required' };
    }

    const room = this.gameService.getRoom(normalizedRoomId);
    if (!room) {
      this._logRoomLifecycle('cancel_room_missing_runtime', {
        source: 'webhook',
        roomId: normalizedRoomId,
        reason: data.reason || null,
      });

      return { success: true, roomId: normalizedRoomId, alreadyClosed: true };
    }

    this._stopHostHeartbeat(room);

    const reason = data.reason || 'backend_cancelled';
    this.io.to(room.roomId).emit(SocketEvents.ROOM_CLOSED, {
      reason,
      timestamp: new Date().toISOString(),
    });

    room.getPlayers().forEach((player) => {
      const playerSocket = this.io.sockets.sockets.get(player.socketId);
      if (playerSocket) playerSocket.leave(room.roomId);
    });

    const spectators = this.roomSpectators.get(room.roomId);
    if (spectators) {
      for (const spectatorSocketId of spectators.keys()) {
        const spectatorSocket = this.io.sockets.sockets.get(spectatorSocketId);
        if (spectatorSocket) spectatorSocket.leave(room.roomId);
        this.spectatorSocketToRoom.delete(spectatorSocketId);
      }
      this.roomSpectators.delete(room.roomId);
    }

    this.gameService.deleteRoom(room.roomId);
    this._logRoomLifecycle('room_cancelled_by_backend', {
      source: 'webhook',
      roomId: room.roomId,
      reason,
    });

    return { success: true, roomId: room.roomId, reason };
  }

  /**
   * Ops/development broadcast (global, not room-scoped). Fans a maintenance /
   * restart notice out to EVERY connected socket so clients stop their active
   * game/lobby session. Triggered via POST /webhooks/development.
   *
   * Body: { maintenance_mode?: bool, restart_server?: bool, message?: string }.
   * Accepts camelCase variants for convenience. At least one flag must be true —
   * a pure "everything off" broadcast is meaningless (clients only stop on a
   * flag) and is rejected so a typo'd call fails loudly instead of silently
   * no-oping to every player in the world.
   */
  broadcastDevelopmentNotice(data = {}) {
    const hasMaintenanceKey =
      data.maintenance_mode !== undefined || data.maintenanceMode !== undefined;
    const hasRestartKey =
      data.restart_server !== undefined || data.restartServer !== undefined;
    const maintenanceMode = data.maintenance_mode === true || data.maintenanceMode === true;
    const restartServer = data.restart_server === true || data.restartServer === true;

    // A payload with NO flag keys at all is almost certainly a typo'd call —
    // reject it so it fails loudly instead of silently no-oping to every
    // player. Explicit all-false flags ARE valid (the maintenance-OFF toggle).
    if (!hasMaintenanceKey && !hasRestartKey) {
      return {
        success: false,
        error: 'Nothing to broadcast: include maintenance_mode and/or restart_server',
      };
    }

    const payload = {
      maintenance_mode: maintenanceMode,
      restart_server: restartServer,
      timestamp: new Date().toISOString(),
    };
    const message = typeof data.message === 'string' ? data.message.trim().slice(0, 300) : '';
    if (message) {
      payload.message = message;
    }

    this.io.emit(SocketEvents.DEVELOPMENT, payload);
    // Remember the last ops notice so the dev dashboard can show the current
    // maintenance/restart state (the broadcast itself is fire-and-forget).
    this.lastDevelopmentNotice = { ...payload, at: new Date().toISOString() };

    logger.info('[DEVELOPMENT] broadcast sent', {
      source: 'webhook',
      event: 'development',
      maintenanceMode,
      restartServer,
      hasMessage: Boolean(message),
    });

    return { success: true, ...payload };
  }

  /**
   * Dev dashboard reads (GET /dev/api/*, webhook-secret guarded). Read-only
   * views over the live room set: a compact roster for the room list, and a
   * full detail (including every seat's actual cards — this is an operator
   * tool behind the secret, not a player-facing surface).
   */
  listRoomsForDev() {
    const rooms = this.gameService.getActiveRooms
      ? this.gameService.getActiveRooms()
      : Array.from(this.gameService.rooms?.values?.() || []);
    return {
      success: true,
      stats: this.gameService.getStats ? this.gameService.getStats() : undefined,
      development: this.lastDevelopmentNotice || null,
      rooms: rooms.map((room) => ({
        roomId: room.roomId,
        name: room.name || null,
        status: room.status,
        maxPlayers: room.maxPlayers,
        playerCount: room.getPlayers().length,
        humanCount: room.getPlayers().filter((p) => !p.isBot).length,
        botCount: room.getPlayers().filter((p) => p.isBot).length,
        seats: room.getPlayers().map((p) => ({
          seat: p.playerIndex,
          name: p.playerName,
          isBot: p.isBot === true,
          connected: p.isConnected !== false,
        })),
        inProgress: room.isInProgress ? room.isInProgress() : false,
        cardsDealt: !!room.cardsDealt,
        currentTurn: room.currentTurn ?? null,
        deckCount: room.deck?.count ?? null,
        deadPileCounts: Array.isArray(room.deadPiles)
          ? room.deadPiles.map((pile) => (Array.isArray(pile) ? pile.length : 0))
          : [],
        awaitingNextRound: room.awaitingNextRound === true,
        turnTimeLimit: room.turnTimeLimit ?? null,
      })),
    };
  }

  /**
   * Per-game log listing for the dev console: every room that still has a log
   * (live OR finished — logs outlive the room for the configured retention),
   * newest activity first, flagged with whether the room is still in memory.
   */
  listRoomLogsForDev() {
    const rows = logger.gameLogStore.list().map((row) => ({
      ...row,
      ...this._roomLivenessForDev(row.roomId),
    }));
    return {
      success: true,
      rooms: rows,
      retentionMs: logger.gameLogStore.retentionMs,
      stats: logger.gameLogStore.stats(),
    };
  }

  /**
   * One room's log page (see GameLogStore.get for the cursor / filter opts).
   * Secret-guarded at the HTTP layer.
   * @param {string} roomId
   * @param {object} [opts]
   */
  getRoomLogsForDev(roomId, opts = {}) {
    const result = logger.gameLogStore.get(String(roomId || ''), opts);
    if (!result.success) return result;
    return { ...result, ...this._roomLivenessForDev(result.roomId) };
  }

  /**
   * `live` = the match is still being played. A FINISHED room lingers in
   * memory for the cleanup grace, so "room exists" alone would call a settled
   * game live. `roomStatus` is the raw status (null once the room is gone).
   * @private
   */
  _roomLivenessForDev(roomId) {
    const room = this.gameService.getRoom(roomId);
    if (!room) return { live: false, roomStatus: null };
    const inPlay = room.isInProgress?.() === true || room.awaitingNextRound === true;
    return { live: inPlay || room.status === GameRoomStatus.WAITING, roomStatus: room.status };
  }

  /**
   * Full dev detail for one room: seats with their REAL hands, meld group
   * counts, the discard pile, wells and scores. Secret-guarded at the HTTP
   * layer — never expose this to players.
   * @param {string} roomId
   */
  getRoomDevDetail(roomId) {
    const room = this.gameService.getRoom(String(roomId || ''));
    if (!room) {
      return { success: false, error: 'Room not found' };
    }

    const playerScores = room.getPlayerScores ? room.getPlayerScores() : {};
    const serializeMeld = (playerId, meld, idx) => {
      const cards = Array.isArray(meld) ? meld : [];
      let flags = null;
      try {
        flags = ActionHandlers._meldFlags(room, playerId, cards, idx);
      } catch {
        flags = null; // a malformed meld must not break the whole read
      }
      return {
        index: idx,
        cards: cards.map((card) => this._serializeCard(card)),
        isBuraco: flags?.isBuraco === true,
        clean: flags?.clean === true,
        grade: flags?.grade ?? null,
      };
    };
    const serializePile = (pile) =>
      Array.isArray(pile) ? pile.map((card) => this._serializeCard(card)) : [];
    const players = room.getPlayers().map((p) => {
      const melds = room.playerMelds.get(p.playerId) || [];
      const meldsOut = Array.isArray(melds)
        ? melds.map((meld, idx) => serializeMeld(p.playerId, meld, idx))
        : [];
      return {
        playerId: p.playerId,
        playerName: p.playerName,
        playerIndex: p.playerIndex,
        team: ActionHandlers._teamId(p.playerIndex),
        isBot: p.isBot === true,
        isConnected: p.isConnected !== false,
        isHost: room.hostPlayerId != null && String(room.hostPlayerId) === String(p.playerId),
        socketId: p.socketId || null,
        hand: (room.playerHands.get(p.playerId) || []).map((card) => this._serializeCard(card)),
        meldGroups: meldsOut.length,
        melds: meldsOut,
        wellsTaken: room.playerDeadPileCount?.get?.(p.playerId) || 0,
        discardLock: this._serializeDiscardLock(room, p.playerId),
        score: playerScores?.[p.playerId] ?? null,
      };
    });

    const lastRound = room.lastRoundEndPayload || null;
    const teamTotals = (scores) =>
      Object.fromEntries(
        Object.entries(scores || {}).map(([team, score]) => [
          team,
          score && typeof score === 'object' ? (score.total ?? null) : score,
        ])
      );
    const lastRoundSummary = lastRound && {
      winnerIndex: lastRound.winnerIndex ?? null,
      batidaType: lastRound.batidaType ?? null,
      winningTeam: lastRound.winningTeam ?? null,
      teamScores: teamTotals(lastRound.teamScores),
      matchEnded: lastRound.matchEnded !== false,
    };

    return {
      success: true,
      roomId: room.roomId,
      name: room.name || null,
      status: room.status,
      maxPlayers: room.maxPlayers,
      ruleset: room.ruleset,
      hostPlayerId: room.hostPlayerId ?? null,
      cardsDealt: !!room.cardsDealt,
      inProgress: room.isInProgress ? room.isInProgress() : false,
      currentTurn: room.currentTurn ?? null,
      turnTimeRemaining: room.getTurnTimeRemaining ? room.getTurnTimeRemaining() : null,
      turnTimeLimit: room.turnTimeLimit ?? null,
      hasDrawnCard: room.hasDrawnCard === true,
      meldedThisTurn: room.meldedThisTurn === true,
      // The current player's turn obligations, for the table view.
      mustMeldCard: room.mustMeldCard ? this._serializeCard(room.mustMeldCard) : null,
      drawnCardRestriction: Array.from(room.drawnCardThisTurnRestriction || []),
      roundNumber: room.roundNumber || 0,
      targetScore: room.targetScore ?? 0,
      nextRoundAt: room.nextRoundAt ? new Date(room.nextRoundAt).toISOString() : null,
      lastRound: lastRoundSummary || null,
      spectatorCount: this.roomSpectators.get(room.roomId)?.size || 0,
      awaitingNextRound: room.awaitingNextRound === true,
      wellsTakenThisRound: room.wellsTakenThisRound || 0,
      deckCount: room.deck?.count ?? 0,
      deadPileCounts: Array.isArray(room.deadPiles)
        ? room.deadPiles.map((pile) => (Array.isArray(pile) ? pile.length : 0))
        : [],
      // Full free-card pools (secret-guarded dev read): what a change-cards
      // request may draw from, so the console can flag availability BEFORE
      // the operator submits.
      deck: (room.deck?.cards || []).map((card) => this._serializeCard(card)),
      deadPiles: Array.isArray(room.deadPiles) ? room.deadPiles.map(serializePile) : [],
      discardPile: room.discardPile.map((card) => this._serializeCard(card)),
      players,
      playerScores: room.getPlayerScores ? room.getPlayerScores() : {},
      teamScores: room.cumulativeTeamScores
        ? Object.fromEntries(room.cumulativeTeamScores)
        : {},
    };
  }

  /**
   * Dev-only hand surgery: REPLACE a target player's whole hand with the
   * requested cards. The requested instances are pulled (in this order) from
   * the draw deck, the target's own current hand, then the wells — NEVER from
   * another player's hand, a meld, or the discard pile (stealing those would
   * corrupt visible state). The target's old cards go back to the bottom of
   * the deck, then a fresh personalized game_state_update is pushed to the
   * room so every client reconciles immediately.
   *
   * Body (socket event `dev_change_cards` or POST /webhooks/dev-change-cards):
   *   {
   *     roomId: '...',                     // required
   *     target_user: 'playerId' | 2,       // player id OR seat index (`seat` also accepted)
   *     change_cards: [                    // required, non-empty
   *       { suit: 'hearts', rank: 'A' },   // by suit+rank (joker: { rank: 'joker' })
   *       { cardId: 123 },                 // or by exact physical instance id
   *     ],
   *   }
   *
   * Two-deck world: each suit+rank exists at most twice (4 jokers). A request
   * is rejected ATOMICALLY (no partial mutation) when any card is unavailable,
   * with the offenders listed in `missing`.
   *
   * @param {object} data
   * @returns {{success: boolean, error?: string, missing?: Array, hand?: Array}}
   */
  changePlayerCards(data = {}) {
    return logger.runWithRoom(data?.roomId, () => this._changePlayerCardsImpl(data));
  }

  _changePlayerCardsImpl(data = {}) {
    const roomId = data.roomId === null || data.roomId === undefined ? null : String(data.roomId);
    if (!roomId) {
      return { success: false, error: 'roomId required' };
    }

    const room = this.gameService.getRoom(roomId);
    if (!room) {
      return { success: false, error: 'Room not found' };
    }
    if (!room.isInProgress || !room.isInProgress()) {
      return { success: false, error: 'Game is not in progress' };
    }
    if (!room.cardsDealt || !room.deck) {
      return { success: false, error: 'Cards have not been dealt yet' };
    }

    // Resolve the target seat: `target_user`/`targetUser` may be a playerId or
    // a seat index; `seat`/`playerIndex` are explicit seat aliases.
    const rawTarget = data.target_user ?? data.targetUser ?? data.seat ?? data.playerIndex;
    if (rawTarget === null || rawTarget === undefined) {
      return { success: false, error: 'target_user (playerId or seat index) required' };
    }
    const players = room.getPlayers();
    let player = players.find((p) => String(p.playerId) === String(rawTarget));
    if (!player && /^\d+$/.test(String(rawTarget))) {
      player = room.getPlayerByIndex(Number(rawTarget));
    }
    if (!player) {
      return { success: false, error: `Target player not found in room ${roomId}` };
    }

    const rawCards = data.change_cards ?? data.changeCards;
    if (!Array.isArray(rawCards) || rawCards.length === 0) {
      return { success: false, error: 'change_cards must be a non-empty array' };
    }
    if (rawCards.length > 40) {
      return { success: false, error: 'change_cards is capped at 40 entries (sanity guard)' };
    }

    // Normalize each request to either an exact-instance lookup or a
    // suit+rank lookup. Jokers match on rank alone (their suit is 'joker').
    const requests = [];
    for (const entry of rawCards) {
      if (!entry || typeof entry !== 'object') {
        return { success: false, error: 'each change_cards entry must be an object' };
      }
      const cardId = entry.cardId ?? entry.instanceId;
      if (cardId !== null && cardId !== undefined) {
        const parsed = Number(cardId);
        if (!Number.isFinite(parsed)) {
          return { success: false, error: `invalid cardId: ${cardId}` };
        }
        requests.push({ cardId: parsed });
        continue;
      }
      const suit = String(entry.suit ?? '').toLowerCase();
      const rank = String(entry.rank ?? '').toUpperCase();
      if (!rank) {
        return { success: false, error: 'each change_cards entry needs cardId or suit+rank' };
      }
      requests.push({ suit, rank, isJoker: rank === 'JOKER' });
    }

    // Candidate pools, searched in order. `targetHand` participates both as a
    // source (a requested card the target already holds stays theirs) and as
    // the thing being replaced.
    const targetHand = room.playerHands.get(player.playerId) || [];
    const pools = [room.deck.cards, targetHand];
    if (Array.isArray(room.deadPiles)) {
      pools.push(...room.deadPiles.filter((pile) => Array.isArray(pile)));
    }

    // Pass 1 (no mutation): find an unused instance for every request.
    const used = new Set();
    const missing = [];
    const matches = requests.map((req) => {
      for (const pool of pools) {
        for (const card of pool) {
          if (used.has(card)) continue;
          const hit =
            req.cardId !== undefined
              ? card.cardId === req.cardId
              : req.isJoker
                ? card.isJoker
                : card.suit === req.suit && card.rank === req.rank;
          if (hit) {
            used.add(card);
            return card;
          }
        }
      }
      missing.push(req.cardId !== undefined ? { cardId: req.cardId } : { suit: req.suit, rank: req.rank });
      return null;
    });

    if (missing.length > 0) {
      // Card conservation: a hand can only be rebuilt from cards that are
      // genuinely free (draw deck, the wells, or the target's own hand). Say
      // WHERE each refused card sits so the operator sees why, instead of a
      // vague "not available".
      const located = missing.map((m) => ({ ...m, where: this._locateCardInstances(room, m, player) }));
      return {
        success: false,
        error:
          'Requested cards are not free (only the deck, the wells and the target\'s own hand can be used): ' +
          located
            .map((m) => {
              const label = m.cardId !== undefined ? `#${m.cardId}` : `${m.rank}${m.suit ? ` of ${m.suit}` : ''}`;
              return m.where.length ? `${label} (${m.where.join(', ')})` : `${label} (no copy left)`;
            })
            .join('; '),
        missing: located,
      };
    }

    // Pass 2 (apply): pull each matched instance out of its pool, return the
    // target's leftovers to the deck bottom, install the new hand in request
    // order (predictable ordering makes a scripted dev scenario reproducible).
    for (const card of matches) {
      for (const pool of pools) {
        const idx = pool.indexOf(card);
        if (idx !== -1) {
          pool.splice(idx, 1);
          break;
        }
      }
    }
    // Whatever is left of the old hand (cards not requested back) goes to the
    // bottom of the deck (deck.draw() takes from the top/front).
    room.deck.cards.push(...targetHand);
    room.playerHands.set(player.playerId, matches.slice());

    this._sendGameStateUpdate(room);

    logger.info('[DEV_CHANGE_CARDS] hand replaced', {
      roomId,
      playerId: player.playerId,
      playerIndex: player.playerIndex,
      requested: matches.length,
      deckCount: room.deck.count,
    });

    return {
      success: true,
      roomId,
      targetPlayerId: player.playerId,
      targetSeat: player.playerIndex,
      hand: matches.map((card) => card.toJSON()),
      deckCount: room.deck.count,
    };
  }

  /**
   * Dev-only: SWAP two physical cards wherever they sit among the free zones —
   * the draw deck, a well, or any player's hand. Both instances trade places
   * (same index in each container), so every card stays in the game exactly
   * once and no zone changes size. A card on the table (a meld) or in the
   * discard pile is refused: moving those would rewrite visible history.
   *
   * Body: { roomId, a: { cardId }, b: { cardId } }  (POST /webhooks/dev-swap-cards)
   * @param {object} data
   * @returns {{success: boolean, error?: string, a?: object, b?: object}}
   */
  swapPlayerCards(data = {}) {
    return logger.runWithRoom(data?.roomId, () => this._swapPlayerCardsImpl(data));
  }

  _swapPlayerCardsImpl(data = {}) {
    const roomId = data.roomId === null || data.roomId === undefined ? null : String(data.roomId);
    if (!roomId) return { success: false, error: 'roomId required' };
    const room = this.gameService.getRoom(roomId);
    if (!room) return { success: false, error: 'Room not found' };
    if (!room.isInProgress || !room.isInProgress()) return { success: false, error: 'Game is not in progress' };
    if (!room.cardsDealt || !room.deck) return { success: false, error: 'Cards have not been dealt yet' };

    const idOf = (entry) => {
      const raw = entry && typeof entry === 'object' ? (entry.cardId ?? entry.instanceId) : entry;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const aId = idOf(data.a);
    const bId = idOf(data.b);
    if (aId === null || bId === null) return { success: false, error: 'a.cardId and b.cardId required' };
    if (aId === bId) return { success: false, error: 'Pick two different cards' };

    // Free containers only: [label, array]. Hands are keyed by seat for the log.
    const containers = [{ where: 'deck', cards: room.deck.cards }];
    (room.deadPiles || []).forEach((pile, i) => {
      if (Array.isArray(pile)) containers.push({ where: `well ${i + 1}`, cards: pile });
    });
    for (const p of room.getPlayers()) {
      containers.push({ where: `seat ${p.playerIndex} hand`, cards: room.playerHands.get(p.playerId) || [], playerId: p.playerId, seat: p.playerIndex });
    }
    const locate = (cardId) => {
      for (const c of containers) {
        const idx = c.cards.findIndex((card) => card.cardId === cardId);
        if (idx !== -1) return { ...c, idx, card: c.cards[idx] };
      }
      return null;
    };
    const a = locate(aId);
    const b = locate(bId);
    if (!a || !b) {
      const missing = [];
      if (!a) missing.push({ cardId: aId, where: this._locateCardInstances(room, { cardId: aId }, { playerId: null }) });
      if (!b) missing.push({ cardId: bId, where: this._locateCardInstances(room, { cardId: bId }, { playerId: null }) });
      return {
        success: false,
        error:
          'Only cards in the deck, a well or a hand can be swapped: ' +
          missing.map((m) => `#${m.cardId} (${m.where.length ? m.where.join(', ') : 'not in the game'})`).join('; '),
        missing,
      };
    }

    // Trade places in one step — no intermediate state where a card is missing.
    a.cards[a.idx] = b.card;
    b.cards[b.idx] = a.card;

    this._sendGameStateUpdate(room);
    const brief = (loc) => ({
      cardId: loc.card.cardId,
      suit: loc.card.suit,
      rank: loc.card.rank,
      from: loc.where,
      playerId: loc.playerId ?? null,
      seat: loc.seat ?? null,
    });
    logger.info('[DEV_CHANGE_CARDS] cards swapped', {
      roomId,
      swap: true,
      a: brief(a),
      b: brief(b),
      deckCount: room.deck.count,
    });
    return { success: true, roomId, a: brief(a), b: brief(b), deckCount: room.deck.count };
  }

  /**
   * Where every instance of a requested card currently sits, for the
   * change-cards rejection message. Only the places a dev replace may NOT
   * touch are reported (other hands, melds, discard pile); free copies were
   * already consumed by the match pass.
   * @private
   * @param {GameRoom} room
   * @param {{cardId?: number, suit?: string, rank?: string}} req
   * @param {PlayerSession} target
   * @returns {string[]} e.g. ['seat 1 hand', 'seat 0 meld', 'discard pile']
   */
  _locateCardInstances(room, req, target) {
    const isJoker = String(req.rank || '').toUpperCase() === 'JOKER';
    const hit = (card) =>
      req.cardId !== undefined
        ? card.cardId === req.cardId
        : isJoker
          ? card.isJoker
          : card.suit === req.suit && card.rank === req.rank;
    const where = [];
    for (const p of room.getPlayers()) {
      if (p.playerId !== target.playerId) {
        const hand = room.playerHands.get(p.playerId) || [];
        where.push(...hand.filter(hit).map(() => `seat ${p.playerIndex} hand`));
      }
      const melds = room.playerMelds.get(p.playerId) || [];
      for (const meld of melds) {
        if (Array.isArray(meld)) where.push(...meld.filter(hit).map(() => `seat ${p.playerIndex} meld`));
      }
    }
    where.push(...(room.discardPile || []).filter(hit).map(() => 'discard pile'));
    return where;
  }

  /**
   * Socket.IO route for changePlayerCards. Dev convenience: lets the operator
   * shoot a room directly from any socket.io console (Postman, websocat, a
   * script) without standing up an HTTP call — but it MUST carry the webhook
   * secret in `secret`, otherwise any connected client could stack its own
   * hand. Result is acked back on DEV_CHANGE_CARDS_RESULT (success or error).
   * @param {Socket} socket
   * @param {object} data changePlayerCards() body + { secret }
   */
  handleDevChangeCards(socket, data) {
    if (config.security.webhookSecret && data?.secret !== config.security.webhookSecret) {
      logger.warn('[DEV_CHANGE_CARDS] rejected: bad or missing secret', {
        socketId: socket.id,
        roomId: data?.roomId ? String(data.roomId) : null,
      });
      socket.emit(SocketEvents.DEV_CHANGE_CARDS_RESULT, {
        success: false,
        error: 'Unauthorized: secret required',
      });
      return;
    }

    const result = this.changePlayerCards(data);
    socket.emit(SocketEvents.DEV_CHANGE_CARDS_RESULT, result);
  }

  _recordManualAction(room, playerId) {
    if (!room || !playerId) return;
    room.turnHadManualAction = true;
    this._resetInactiveCounter(room, playerId);
  }

  _resetInactiveCounter(room, playerId) {
    if (!room || !playerId) return;
    if (!room.consecutiveInactiveTurns) {
      room.consecutiveInactiveTurns = new Map();
    }
    room.consecutiveInactiveTurns.set(playerId, 0);
  }

  /**
   * Charge an OFFLINE STRIKE when a turn comes around and its owner is not
   * there. Replaces the old "5 consecutive turns without a manual action"
   * forfeit, which counted IDLENESS and reset the moment the player did
   * anything — so someone could drop out, come back for one move, drop out
   * again, and never accrue.
   *
   * Now: the strike is charged for being ABSENT while the system resolves your
   * turn, coming back online does NOT clear it, and the count is per ROUND.
   * A connected player who simply idles no longer ends the match — their turn is
   * still auto-played, so the round keeps moving and finishes on its own.
   *
   * @returns {boolean} true when the match was ended here
   */
  _handleInactiveTurnExpiry(room, player) {
    if (!room || !player) return false;
    if (!room.offlineStrikes) room.offlineStrikes = new Map();

    // Present and playing: nothing to charge.
    if (player.isConnected !== false) return false;
    // A BOT seat is never "absent", even when it carries the disconnected flag of
    // the human it took over from. Charging it would forfeit a match that is
    // being played perfectly well on its behalf.
    if (player.isBot === true || player.status === 'bot') return false;

    const strikes = (room.offlineStrikes.get(player.playerId) || 0) + 1;
    room.offlineStrikes.set(player.playerId, strikes);

    logger.warn(
      `[TURN_TIMER] Player ${player.playerId} offline strike ${strikes}/${SocketHandlers.MAX_OFFLINE_STRIKES} ` +
        `in room ${room.roomId}`
    );

    if (strikes < SocketHandlers.MAX_OFFLINE_STRIKES) return false;

    this._handlePlayerForfeit(null, room, player.playerId, player, {
      reason: 'offline_forfeit',
      inactiveTurns: strikes,
      offlineStrikes: strikes,
    });
    return true;
  }

  /**
   * Handle leave room event
   * @param {Socket} socket
   */
  handleLeaveRoom(socket) {
    socket._roomJoinEpoch = (socket._roomJoinEpoch || 0) + 1;
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    if (!playerId) {
      const spectatorRoomId = this.spectatorSocketToRoom.get(socket.id);
      // Void any pending seat invite to this spectator before we drop them.
      if (spectatorRoomId) {
        const specRoom = this.gameService.getRoom(spectatorRoomId);
        const specId = this._spectatorIdBySocket(spectatorRoomId, socket.id);
        if (specRoom && specId) this._clearInvitesFor(specRoom, specId);
      }
      const leftRoomId = this._removeSpectatorBySocket(socket.id);
      if (leftRoomId) {
        socket.leave(leftRoomId);
        this._broadcastSpectatorsChanged(leftRoomId);
        logger.info(`[LEAVE_ROOM] Spectator socket ${socket.id} left room ${leftRoomId}`);
      }
      return;
    }

    const room = this.gameService.getPlayerRoom(playerId);
    const leavingPlayer = room ? room.getPlayer(playerId) : null;
    if (leavingPlayer && !this._socketOwnsSeat(socket, leavingPlayer)) return;
    if (room?._pendingBackendStart) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Room is starting. Please wait.'));
      return;
    }
    logger.info(`[LEAVE_ROOM] Player ${playerId} leaving room ${room?.roomId}`);

    // A player leaving a room whose game already ENDED must NOT re-forfeit,
    // kill-lobby, or re-webhook: the result is already reported and room teardown
    // is already server-scheduled (_scheduleRoomDeletion). Just detach the socket.
    // This keeps room deletion PURELY server-driven even when a client fires
    // leave_room on the post-game-end board exit (the "deleted from mobile not
    // server" bug).
    // #11 multi-round: a room mid-intermission is also FINISHED, but its match is
    // NOT over — swallowing the leave here would carry a ghost seat into round
    // N+1 (and the seat would then fail the "Room is not full" check). Fall
    // through so the forfeit path below settles it properly.
    if (room && room.hasEnded && room.hasEnded() && !room.awaitingNextRound) {
      socket.leave(room.roomId);
      logger.info(`[LEAVE_ROOM] Player ${playerId} left FINISHED room ${room.roomId} — detach only (teardown already scheduled).`);
      return;
    }

    // Void any lobby swap this player was part of (the other side self-heals on
    // the player_left broadcast).
    if (room) this._clearPendingFor(room, playerId);
    // Void any seat invite this player issued.
    if (room) this._clearInvitesFor(room, playerId);

    // Deliberately leaving a game that is in progress is a forfeit: the player who
    // leaves loses and the remaining player(s) win. This is distinct from a socket
    // disconnect (handled elsewhere, which allows reconnection).
    // #11 multi-round: deliberately leaving during the round-over intermission is
    // leaving the MATCH, so it forfeits too — that is what settles the escrow and
    // cancels the pending next round instead of dealing to an empty seat.
    if (room && (room.isInProgress() || room.awaitingNextRound)) {
      this._handleForfeitOnLeave(socket, room, playerId, leavingPlayer);
      return;
    }

    // Host explicitly leaving a LOBBY/WAITING room KILLS the room (contract:
    // "host leave ends the room") instead of migrating the host to another
    // seated player. In-game host leave is the forfeit path above; in-game host
    // disconnect migration (handleDisconnect) is unchanged.
    // #11 multi-round: unreachable for an intermission (the forfeit above already
    // returned), but keep the flag in the guard so a future reorder can't let the
    // host tapping Leave at round-over nuke a live multi-round match.
    if (room && !room.isInProgress() && !room.awaitingNextRound && room.hostPlayerId === playerId) {
      socket.leave(room.roomId);
      this._killLobbyRoomHostGone(room, 'host_left');
      return;
    }

    const result = this.gameService.leaveRoom(playerId);

    if (result.success) {
      if (result.roomDeleted) {
        // Host left, notify everyone and clear sockets
        const { removedPlayers, roomId } = result;
        removedPlayers.forEach((p) => {
          const playerSocket = this.io.sockets.sockets.get(p.socketId);
          if (playerSocket) {
            playerSocket.leave(roomId);
            playerSocket.emit(SocketEvents.ROOM_CLOSED, {
              reason: 'Host left the room',
              timestamp: new Date().toISOString(),
            });
          }
        });
        logger.info(`[LEAVE_ROOM] ✓ Host left room ${roomId}. Room closed and players notified.`);
      } else if (room) {
        socket.leave(room.roomId);
        socket.to(room.roomId).emit(SocketEvents.PLAYER_LEFT, {
          playerId,
          playerIndex: leavingPlayer?.playerIndex,
          playerName: leavingPlayer?.playerName,
          timestamp: new Date().toISOString(),
        });
        this._notifyBackendPlayerLeft(room.roomId, playerId, false, leavingPlayer, room);
        // The seat is EMPTY now, and only the authoritative roster says so.
        // PLAYER_LEFT carries ONE id; clients patch a counter with it and never
        // rebuild their seat grid from it, so the leaver stayed drawn in their
        // chair on every other screen and the seat could not be taken. That is
        // the reported "leave table, seat kaga sinkron" — and it is why leaving
        // via the SEAT button behaved (handleLeaveSeat broadcasts) while leaving
        // the TABLE did not. handleRemoveBot already learned this for bots
        // (PTW-233); a human leaving needs the same answer.
        //
        // Guarded: leaveRoom() deletes a room whose last player just left, and
        // that path does NOT set result.roomDeleted, so `room` can be a corpse.
        if (this.gameService.getRoom(room.roomId)) {
          this._broadcastSeatChanged(room);
        }
        logger.info(
          `[LEAVE_ROOM] ✓ Player ${playerId} left room ${room.roomId}. Remaining players: ${room.players.size}`
        );
        this._gameEvent(room, 'leave', { playerId, remaining: room.players.size });
      }
    } else {
      logger.warn(`[LEAVE_ROOM] ✗ Player ${playerId} failed to leave room`);
    }
  }

  /**
   * A player deliberately left an in-progress game → forfeit.
   * The leaver loses; the remaining player(s) win. Everyone (including the leaver)
   * receives a `game_ended` event whose `reason` tells the client whether the host
   * left (room closes, opponent wins) or the opponent left (room owner wins).
   * @param {Socket} socket
   * @param {import('../models/GameRoom')} room
   * @param {string} leavingPlayerId
   * @param {import('../models/PlayerSession')|null} leavingPlayer
   */
  _handleForfeitOnLeave(socket, room, leavingPlayerId, leavingPlayer) {
    this._handlePlayerForfeit(socket, room, leavingPlayerId, leavingPlayer, {
      reason: room.hostPlayerId === leavingPlayerId ? 'host_left' : 'opponent_left',
    });
  }

  _handlePlayerForfeit(socket, room, leavingPlayerId, leavingPlayer, options = {}) {
    const isHost = room.hostPlayerId === leavingPlayerId;
    const remaining = room.getPlayers().filter((p) => p.playerId !== leavingPlayerId);
    // 2v2: the abandoner's whole team forfeits — the winner must come from the
    // OPPOSING team (even seats {0,2} = team A, odd {1,3} = team B), not simply
    // the first remaining seat (which could be the leaver's own partner). 1v1
    // falls back to the sole remaining player.
    let winner;
    if (room.maxPlayers === 4 && leavingPlayer) {
      const winnerIsEven = leavingPlayer.playerIndex % 2 !== 0;
      winner =
        remaining.find((p) => (p.playerIndex % 2 === 0) === winnerIsEven) ||
        remaining[0] ||
        null;
    } else {
      winner = remaining[0] || null;
    }
    const reason = options.reason || (isHost ? 'host_left' : 'opponent_left');

    room.status = GameRoomStatus.FINISHED;
    room.gameEndedAt = new Date();
    room.winnerId = winner ? winner.playerId : null;
    this._stopTurnTimer(room);
    // #11 multi-round: a forfeit is TERMINAL. If it lands during the round-over
    // intermission, kill the pending deal — otherwise the scheduler would fire
    // afterwards and start a phantom round in a room whose escrow just settled.
    this._cancelNextRound(room, reason);

    const payload = {
      type: 'game_ended',
      winnerIndex: winner ? winner.playerIndex : null,
      winnerId: winner ? winner.playerId : null,
      reason,
      hostLeft: isHost,
      roomClosed: true,
      // #11 multi-round: a forfeit / host_left / opponent_left / abandoned
      // mid-match is TERMINAL — the match is over, no further round is dealt.
      // matchEnded MUST be true so the backend (wlive settleGame) settles the
      // escrow (paid/resolved via the forfeit `reason`) instead of treating an
      // empty/stale matchEnded as a non-terminal round and stranding the pot.
      matchEnded: true,
      // NAME THE WINNING SIDE. A forfeit settles with matchEnded true, and
      // _buildPartnerGameEndData reads these three straight off this payload —
      // so leaving them out made every forfeit settle with
      // matchWinnerId/Index/Team all null, while `teamScores` fell back to the
      // last COMPLETED round (which can show the forfeit LOSER leading) and the
      // only field naming a person was winner_user_id, a single seat. In 2v2
      // that left the winning PARTNER unidentifiable to the payout. Additive:
      // winnerId/winnerIndex keep their meaning.
      matchWinnerId: winner ? winner.playerId : null,
      matchWinnerIndex: winner ? winner.playerIndex : null,
      matchWinnerTeam: winner ? ActionHandlers._teamId(winner.playerIndex) : null,
      winningTeam: winner ? ActionHandlers._teamId(winner.playerIndex) : null,
      // The round `teamScores` a consumer may fall back to describes the last
      // COMPLETED round, not the abandoned one. Say which.
      roundNumber: room.roundNumber,
      forfeitedBy: leavingPlayer ? leavingPlayer.playerIndex : null,
      forfeitedByName: leavingPlayer ? leavingPlayer.playerName : null,
      inactiveTurns: options.inactiveTurns,
      // How many turns came around while this player was absent. Named
      // separately from inactiveTurns so a client can say "left the table for 4
      // turns" rather than "was slow".
      offlineStrikes: options.offlineStrikes,
      timestamp: new Date().toISOString(),
    };
    // Persist as the terminal round-end payload so any reader (reconnect
    // refetch, the backend webhook builder) sees matchEnded=true, not a stale
    // or empty value from an earlier round.
    room.lastRoundEndPayload = payload;

    // Notify everyone still in the room — players AND spectators (they share the
    // socket.io room) ...
    this.io.to(room.roomId).emit(SocketEvents.GAME_ENDED, payload);
    // ... and the leaver themselves (they have not left the socket room yet).
    if (socket) {
      socket.emit(SocketEvents.GAME_ENDED, payload);
    }

    this._persistRoomState(room);
    this._emitPartnerWebhook('game.completed', {
      roomId: room.roomId,
      winnerId: payload.winnerId,
      result: payload,
      // Enriched terminal game.ended `data` (matchEnded=true + reason) so wlive
      // settleGame pays/resolves the escrow on a forfeit instead of re-dealing.
      data: this._buildPartnerGameEndData(room, payload),
    });

    // Detach every player socket.
    room.getPlayers().forEach((p) => {
      const playerSocket = this.io.sockets.sockets.get(p.socketId);
      if (playerSocket) playerSocket.leave(room.roomId);
    });

    // Detach and clear spectators so the room can be fully torn down and no
    // spectator keeps it "alive" (they were already notified via game_ended).
    const spectators = this.roomSpectators.get(room.roomId);
    if (spectators) {
      for (const spectatorSocketId of spectators.keys()) {
        const spectatorSocket = this.io.sockets.sockets.get(spectatorSocketId);
        if (spectatorSocket) spectatorSocket.leave(room.roomId);
        this.spectatorSocketToRoom.delete(spectatorSocketId);
      }
      this.roomSpectators.delete(room.roomId);
    }

    // Report the match result (win/loss/streak + leaderboard) BEFORE teardown,
    // while the room's players are still intact. A deliberate leave forfeits, so
    // the leaver takes the loss and the remaining player(s) the win.
    this._notifyBackendGameResult(room, room.winnerId);

    // De-list from the lobby NOW (route with the room's own backend URL). We
    // can't rely on onRoomDeleted to fire this immediately anymore because the
    // in-memory teardown is now grace-deferred so a reconnecting player can read
    // the terminal result — matching the normal win/lose path. A duplicate
    // room-closed webhook when the deferred delete finally runs is idempotent.
    this._notifyBackendRoomClosed(room.roomId, reason, room.backendBaseUrl || null);
    this._scheduleRoomDeletion(room);

    this._gameEvent(room, 'forfeit', {
      playerId: leavingPlayerId,
      reason,
      winnerSeat: payload.winnerIndex ?? null,
      hostLeft: isHost === true,
    });
    logger.info(
      `[FORFEIT] ${leavingPlayerId} forfeited in-progress room ${room.roomId} (${reason}). ` +
        `Winner index ${payload.winnerIndex} (hostLeft=${isHost}). Room closed.`
    );
  }

  /**
   * Best-effort notification to the backend that a room has ended, so it is
   * removed from the lobby listing immediately instead of waiting for the
   * periodic reconcile job (#3). No-op if BACKEND_URL isn't configured.
   *
   * PER-MATCH ONLY. The body is `{roomId, reason}` — it carries no round
   * dimension, so a consumer can only read it as "this room is finished". NEVER
   * call it on an intermediate round of a target-score match (#11): the backends
   * close/de-list the row and detach every player, which strands the rounds still
   * to be played. The per-ROUND event is `_notifyBackendGameResult`, which does
   * carry `result_id` + `matchEnded`.
   * @param {string} roomId
   */
  _notifyBackendRoomClosed(roomId, reason = null, backendBaseUrl = null) {
    // Pull (and consume) any stashed close context for this room — the
    // onRoomDeleted hook calls us with only a roomId after the room is gone.
    const ctx = this._roomCloseContext.get(String(roomId));
    if (ctx) this._roomCloseContext.delete(String(roomId));

    // Routing (1 socket → 2 backends): prefer the room's own callback base URL
    // (set from sync-room `backendUrl`), else fall back to the configured backend.
    const backendUrl =
      backendBaseUrl || ctx?.backendBaseUrl || (config.backend && config.backend.url);
    if (!backendUrl || typeof fetch !== 'function') return;
    const effectiveReason = reason || ctx?.reason || null;
    const headers = { 'Content-Type': 'application/json' };
    if (config.backend.webhookSecret) headers['x-webhook-secret'] = config.backend.webhookSecret;
    // Body is additive: { roomId, reason } — backends ignore unknown fields and a
    // null reason is harmless for callers that don't carry one.
    fetch(`${backendUrl.replace(/\/$/, '')}/api/webhooks/room-closed`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ roomId: String(roomId), reason: effectiveReason }),
    }).catch((err) =>
      logger.warn(`[LEAVE_ROOM] backend room-closed webhook failed: ${err.message}`)
    );
  }

  /**
   * Socket -> backend webhook: report a finished match so the backend updates
   * each player's win/loss/streak/games-played and the global leaderboard.
   * `playerId` IS the backend users.id (the client sends `user.id.toString()`);
   * bots use synthetic non-numeric ids and are excluded. Idempotent per room via
   * `room.resultReported` (per ROUND) and `room.matchResultReported` (per MATCH)
   * so a normal end + a forfeit can't double-count.
   * Best-effort, no-op if BACKEND_URL isn't configured.
   * @param {object} room
   * @param {string|number|null} winnerId  winning player's playerId
   */
  _notifyBackendGameResult(room, winnerId) {
    if (!room) return;

    // #11 multi-round enrichment: the backend orchestrates rounds and settles the
    // pot ONCE at match end. Pull the round + cumulative outcome from the
    // round_ended payload (_finalizeWith) and the running cumulative Map so the
    // backend can decide pay-now vs deal-next-round.
    //
    // Read BEFORE the double-fire guard: whether this is a ROUND report or the
    // TERMINAL match report now decides both what the guard latches on and the
    // dedupe id (below).
    const payload = room.lastRoundEndPayload || {};
    const matchEnded = payload.matchEnded === true;
    // Captured before the latches are set, because the `result_id` below needs to
    // know whether a ROUND report already went out under THIS deal.
    const roundAlreadyReported = room.resultReported === true;

    // Socket-side double-fire guard: a normal end racing a forfeit, a retry, or a
    // restart can re-enter here. Count the suppressed attempts so prod can alert
    // on a spike (the backend ProcessedGameResult idempotency is the second line
    // of defense; a divergence between the two points at a retry storm) (PTW-81).
    //
    // MONEY PATH — the latch is per REPORT KIND, not per room. `resultReported`
    // is cleared by startGame(), i.e. only when round N+1 is actually DEALT, so
    // throughout the ~10s intermission it is still latched from round N. A single
    // room-wide boolean therefore swallowed the TERMINAL report for every way a
    // match can end in that window — leave_room (which now forfeits mid-
    // intermission instead of detaching), the scheduler's terminal aborts, and an
    // inactivity forfeit — and real payouts / win-loss rows were silently
    // dropped. A round result may fire once per deal; the terminal result may
    // fire once per match, even when a round result for the same deal already
    // went out.
    if (matchEnded ? room.matchResultReported === true : roundAlreadyReported) {
      metrics.increment('buraco_game_result_double_fire_total');
      return;
    }
    const backendUrl = (room && room.backendBaseUrl) || (config.backend && config.backend.url);
    if (!backendUrl || typeof fetch !== 'function') return;

    const playerUserIds = room
      .getPlayers()
      .filter((p) => !p.isBot)
      .map((p) => parseInt(p.playerId, 10))
      .filter((id) => Number.isInteger(id));
    if (playerUserIds.length === 0) return;

    room.resultReported = true;
    if (matchEnded) room.matchResultReported = true;

    const w = parseInt(winnerId, 10);
    const winnerUserId =
      Number.isInteger(w) && playerUserIds.includes(w) ? w : null;

    const { matchId, resultId: roundResultId } = this._matchResultIds(room);
    // ...and clearing the latch alone is NOT enough: it would only move the drop
    // one hop downstream. `result_id` is roomId:gameStartedAt and gameStartedAt
    // advances only on a DEAL, so a terminal report raised during the
    // intermission carries round N's id verbatim and the backend's
    // ProcessedGameResult idempotency swallows it — the payout is lost exactly as
    // before. Mint a distinct `:final` id in precisely that case. Every flow that
    // reports once (a clean match end, a mid-round forfeit, a single-round game)
    // still sends the id it sends today, byte for byte.
    const resultId =
      matchEnded && roundAlreadyReported ? `${roundResultId}:final` : roundResultId;

    const cumulativeTeamScores = this._serializeTeamScoreMap(room.cumulativeTeamScores);
    const targetScore = Number.isFinite(Number(room.targetScore)) ? Math.round(Number(room.targetScore)) : 0;

    // On a TERMINAL match _finalizeWith overwrites winnerId with the cumulative
    // leader and stashes the round-out player under roundWinnerId; on an
    // intermediate round only winnerId is set (it IS the round winner).
    const asUserId = (id) => {
      const n = parseInt(id, 10);
      return Number.isInteger(n) ? n : null;
    };
    const roundWinnerId = asUserId(payload.roundWinnerId != null ? payload.roundWinnerId : payload.winnerId);
    const roundWinnerIndex = payload.roundWinnerIndex != null ? payload.roundWinnerIndex : payload.winnerIndex;

    // wlive resolves the Room by the realtime room id (== wlive's server-side
    // game id). There is no separate `code`/serverGameId stored on the room, so
    // both keys fall back to room.roomId; the fallbacks are future-proofing if a
    // distinct code/serverGameId is ever synced onto the room.
    const roomId = String((room && (room.roomId || room.code)) || '');
    const serverGameId = String(
      (room && (room.serverGameId || room.server_game_id || room.roomId)) || ''
    );

    const body = {
      match_id: matchId,
      result_id: resultId,
      winner_user_id: winnerUserId,
      player_user_ids: playerUserIds,
      // wlive settleGame needs the Room handle (roomId/server_game_id) + the FULL
      // enriched game.ended `data` it consumes. Buraco-Project's GameResultController
      // still reads ONLY the top-level match_id/winner_user_id/player_user_ids — these
      // additions are purely additive and unknown fields are ignored there.
      roomId,
      server_game_id: serverGameId,
      matchEnded,
      targetScore,
      cumulativeTeamScores,
      teamScores: payload.teamScores || room.lastTeamScores || null,
      roundWinnerId,
      roundWinnerIndex: roundWinnerIndex != null ? roundWinnerIndex : null,
      // The enriched game.ended payload settleGame consumes: seat-based fields
      // (winnerIndex, winningTeam, reason, playerScores, teamScores) from the raw
      // round_ended/forfeit payload, normalized over the multi-round fields
      // (matchEnded, targetScore, serialized cumulativeTeamScores, result_id,
      // roundWinner*, matchWinner*, reason) from _buildPartnerGameEndData. The
      // builder wins on overlap so serialization/ids are consistent, and it
      // guarantees data.result_id + data.matchEnded on EVERY round (and
      // data.reason + matchEnded:true on a forfeit).
      // `result_id` is re-stamped LAST: the builder recomputes it from
      // gameStartedAt and so cannot know about the `:final` id minted above for a
      // terminal report raised during an intermission. Leaving the builder's copy
      // would ship a body whose top-level result_id and data.result_id disagree —
      // and a reader that dedupes on data.result_id would drop the settlement for
      // the same reason the socket used to. Identical to the builder's value on
      // every other path.
      data: { ...payload, ...this._buildPartnerGameEndData(room, payload), result_id: resultId },
    };
    if (matchEnded) {
      body.matchWinnerId = asUserId(payload.matchWinnerId);
      body.matchWinnerIndex = payload.matchWinnerIndex != null ? payload.matchWinnerIndex : null;
      body.matchWinnerTeam = payload.matchWinnerTeam || null;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (config.backend.webhookSecret) headers['x-webhook-secret'] = config.backend.webhookSecret;
    const url = `${backendUrl.replace(/\/$/, '')}/api/webhooks/game-result`;
    const payloadJson = JSON.stringify(body);
    const MAX_ATTEMPTS = 5;

    // §6.2 room-stuck-after-finish: this single POST is the ONLY thing that flips
    // the wlive room to 'finished' (settleGame -> finalizeGame). A transient wlive
    // 5xx/timeout/deploy used to be swallowed by a bare .catch(log), permanently
    // stranding the room in_progress. Retry with capped exponential backoff so a
    // brief outage self-heals; the backend endpoint is idempotent
    // (ProcessedGameResult), so re-sends are safe, and the payload is captured up
    // front so a re-deal cannot mutate an in-flight retry. If every attempt fails
    // (extended outage) the wlive CleanupStaleRooms settlement-lost reaper is the
    // final backstop. resultReported stays latched (above) throughout so a racing
    // normal-end/forfeit can't double-fire during the retries.
    const onFail = (attempt, reason) => {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        metrics.increment('buraco_game_result_retry_exhausted_total');
        logger.error(
          `[GAME_ENDED] backend game-result webhook gave up after ${MAX_ATTEMPTS} attempts (${reason}); ` +
          `room ${room.roomId} left for the wlive settlement-lost reaper`
        );
        return;
      }
      const delayMs = Math.min(30000, 1000 * 2 ** attempt);
      logger.warn(
        `[GAME_ENDED] backend game-result webhook failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}: ${reason}); retrying in ${delayMs}ms`
      );
      setTimeout(() => send(attempt + 1), delayMs);
    };
    const send = (attempt) => {
      fetch(url, { method: 'POST', headers, body: payloadJson })
        .then((res) => {
          if (res && res.ok) return;
          onFail(attempt, `status ${res && res.status}`);
        })
        .catch((err) => onFail(attempt, err.message));
    };
    send(0);
  }

  /**
   * Serialize a cumulative team-score Map (teamId -> total) to a plain
   * {teamA, teamB, ...} object for the backend webhook. Accepts a Map or an
   * already-plain object (FailureManager rehydration / sync-room seed) and is a
   * no-op-safe empty object when absent.
   * @private
   * @param {Map<string,number>|Object|undefined} scores
   * @returns {Object}
   */
  _serializeTeamScoreMap(scores) {
    const out = {};
    if (!scores) return out;
    if (scores instanceof Map) {
      for (const [teamId, total] of scores) out[teamId] = total;
    } else if (typeof scores === 'object') {
      for (const [teamId, total] of Object.entries(scores)) out[teamId] = total;
    }
    return out;
  }

  /**
   * Compute the stable per-MATCH id and the distinct per-ROUND id used for
   * backend idempotency. createdAt is set once when the room is built and
   * PERSISTS across rounds (identifies the MATCH); gameStartedAt is reset by
   * every re-deal (identifies a ROUND). Pure — never mutates the room.
   * @private
   * @param {object} room
   * @returns {{matchId: string, resultId: string}}
   */
  _matchResultIds(room) {
    const matchStartStamp =
      (room.createdAt && room.createdAt.getTime && room.createdAt.getTime()) ||
      (room.gameStartedAt && room.gameStartedAt.getTime && room.gameStartedAt.getTime()) ||
      0;
    const roundStamp =
      (room.gameStartedAt && room.gameStartedAt.getTime && room.gameStartedAt.getTime()) ||
      matchStartStamp;
    return {
      matchId: `${room.roomId}:${matchStartStamp}`,
      resultId: `${room.roomId}:${roundStamp}`,
    };
  }

  /**
   * #11 multi-round: build the enriched `game.ended` event `data` for the
   * partner webhook (PartnerWebhookRelay → PARTNER_WEBHOOK_URL → wlive-api
   * POST /api/brazilia/webhook). wlive's `GameService::settleGame` reads THIS
   * object (the `data` field of the `game.ended` event) to decide pay-now vs
   * deal-next-round, so it must carry the SAME multi-round fields the
   * Buraco-Project `/api/webhooks/game-result` body carries: matchEnded,
   * targetScore, cumulativeTeamScores, teamScores, roundWinner*, matchWinner*
   * (only at match end), reason (forfeit), and result_id/match_id.
   * @private
   * @param {object} room
   * @param {object} roundEnded  the round_ended / forfeit game_ended payload
   * @returns {Object}
   */
  _buildPartnerGameEndData(room, roundEnded) {
    const payload = roundEnded || room.lastRoundEndPayload || {};
    const { matchId, resultId } = this._matchResultIds(room);
    const targetScore = Number.isFinite(Number(room.targetScore))
      ? Math.round(Number(room.targetScore))
      : 0;
    const matchEnded = payload.matchEnded === true;
    const data = {
      match_id: matchId,
      result_id: resultId,
      matchEnded,
      targetScore,
      cumulativeTeamScores: this._serializeTeamScoreMap(room.cumulativeTeamScores),
      teamScores: payload.teamScores || room.lastTeamScores || null,
      winnerId: payload.winnerId != null ? payload.winnerId : null,
      winnerIndex: payload.winnerIndex != null ? payload.winnerIndex : null,
      roundWinnerId:
        payload.roundWinnerId != null
          ? payload.roundWinnerId
          : payload.winnerId != null
            ? payload.winnerId
            : null,
      roundWinnerIndex:
        payload.roundWinnerIndex != null
          ? payload.roundWinnerIndex
          : payload.winnerIndex != null
            ? payload.winnerIndex
            : null,
    };
    if (matchEnded) {
      data.matchWinnerId = payload.matchWinnerId != null ? payload.matchWinnerId : null;
      data.matchWinnerIndex = payload.matchWinnerIndex != null ? payload.matchWinnerIndex : null;
      data.matchWinnerTeam = payload.matchWinnerTeam || null;
    }
    // Forfeit/host_left/opponent_left/abandoned: surface the reason at the top
    // of `data` so wlive's settleGame routes the winner via the forfeit path.
    if (payload.reason != null) data.reason = payload.reason;
    return data;
  }

  /**
   * Best-effort notification to the backend that a SINGLE player left a room that
   * still exists (lobby leave / pre-game disconnect). The backend detaches just
   * that user and recomputes the room's player count — so the lobby never shows a
   * phantom occupied slot. Full room teardown uses _notifyBackendRoomClosed.
   * No-op if BACKEND_URL isn't configured.
   * @param {string} roomId
   * @param {string} playerId
   */
  /**
   * Resolve the backend callback base URL for a room: prefer the room's own
   * `backendBaseUrl` (set from sync-room `backendUrl`) so a single socket can
   * serve two backends, else fall back to the configured default.
   * @private
   * @param {string} roomId
   * @returns {string|null}
   */
  _backendUrlForRoom(roomId) {
    const room = this.gameService?.getRoom?.(roomId);
    return (room && room.backendBaseUrl) || (config.backend && config.backend.url) || null;
  }

  _notifyBackendPlayerLeft(roomId, playerId, inProgress = false, departingPlayer = null, departingRoom = null) {
    const room = departingRoom || this.gameService.getRoom(roomId);
    const backendBaseUrl = room?.backendBaseUrl || this._backendUrlForRoom(roomId);
    if (!backendBaseUrl || typeof fetch !== 'function') return;
    const reservationVersion = departingPlayer?.apiSeatReservationVersion;
    // An unbound legacy runtime cannot authorize releasing a modern allocation.
    if ((room?.seatLayoutProtocol === 1 || room?.seatConnectionProtocol === 1) &&
        !Number.isInteger(reservationVersion)) return;
    const pendingOperation = room?._seatLayoutSync?.operation;
    const sent = pendingOperation?.body.players.find((player) => String(player.playerId) === String(playerId));
    const operation = sent && pendingOperation.members.get(String(playerId)) === departingPlayer &&
      sent.reservationVersion === reservationVersion ? pendingOperation : null;
    const key = `${roomId}:${playerId}:${reservationVersion}:${departingPlayer?.socketId || ''}`;
    let job = this._pendingBackendLeaves.get(key);
    if (!job) {
      job = {
        room: { backendBaseUrl }, operation, running: null,
        body: { roomId: String(roomId), playerId: String(playerId), inProgress: inProgress === true,
          ...(Number.isInteger(reservationVersion) ? { reservationVersion } : {}) },
      };
      this._pendingBackendLeaves.set(key, job);
    }
    this._startBackendHeartbeat();
    return this._runBackendPlayerLeft(key, job);
  }

  _runBackendPlayerLeft(key, job) {
    if (job.running) return job.running;
    job.running = Promise.resolve().then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          if (job.operation) {
            // A layout POST may have committed before its ACK was lost. Replay
            // that exact receipt; never borrow a fresh REST generation to leave.
            const result = await this._seatBackendRequest(job.room, 'room-seat-layout', job.operation.body);
            if (result.applied === true) {
              const sent = job.operation.body.players.find((player) => String(player.playerId) === job.body.playerId);
              const applied = result.players?.find((player) => String(player.playerId) === job.body.playerId);
              if (!applied || applied.playerIndex !== sent.seat ||
                  !Number.isInteger(applied.reservationVersion) || applied.reservationVersion < sent.reservationVersion) {
                throw new Error('Missing seat layout receipt for departing player');
              }
              job.body.reservationVersion = applied.reservationVersion;
            }
            job.operation = null;
          }
          const result = await this._seatBackendRequest(job.room, 'room-player-left', job.body);
          if (result.reason === 'room_start_pending') throw new Error('Room start is pending');
          if (result.success !== true) throw new Error('Backend did not acknowledge player leave');
          // A version mismatch is also final: the newer allocation is untouched.
          if (this._pendingBackendLeaves.get(key) === job) this._pendingBackendLeaves.delete(key);
          return;
        } catch (err) {
          if (attempt === 2) logger.warn(`[LEAVE_ROOM] backend player leave pending retry: ${err.message}`);
        }
      }
    }).finally(() => { job.running = null; });
    return job.running;
  }

  /**
   * Best-effort notification to backend that total seat count (humans + bots) changed.
   * Backend updates current_players so the lobby shows the real occupancy.
   * No-op if BACKEND_URL isn't configured.
   * @param {string} roomId
   * @param {number} totalCount  all players including bots
   */
  _notifyBackendPlayerCount(roomId, totalCount) {
    const backendUrl = this._backendUrlForRoom(roomId);
    if (!backendUrl || typeof fetch !== 'function') return;
    const headers = { 'Content-Type': 'application/json' };
    if (config.backend.webhookSecret) headers['x-webhook-secret'] = config.backend.webhookSecret;
    // `spectatorCount` rides along so the lobby can show who is watching, not
    // just who is seated; the backend stores it next to current_players.
    const spectatorCount = this.roomSpectators.get(String(roomId))?.size ?? 0;
    fetch(`${backendUrl.replace(/\/$/, '')}/api/webhooks/room-player-count`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ roomId: String(roomId), playerCount: totalCount, spectatorCount }),
    }).catch((err) =>
      logger.warn(`[BOT] backend room-player-count webhook failed: ${err.message}`)
    );
  }

  /**
   * Best-effort notification to the backend that cards were dealt in runtime.
   * No-op if BACKEND_URL isn't configured.
   * @param {string} roomId
   */
  _notifyBackendCardsDealt(roomId) {
    const backendUrl = this._backendUrlForRoom(roomId);
    if (!backendUrl || typeof fetch !== 'function') return;
    const headers = { 'Content-Type': 'application/json' };
    if (config.backend.webhookSecret) headers['x-webhook-secret'] = config.backend.webhookSecret;
    fetch(`${backendUrl.replace(/\/$/, '')}/api/webhooks/room-cards-dealt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ roomId: String(roomId) }),
    }).catch((err) =>
      logger.warn(`[DEAL_CARDS] backend room-cards-dealt webhook failed: ${err.message}`)
    );
  }

  /**
   * Start the periodic liveness heartbeat to the backend. No-op if BACKEND_URL
   * isn't configured. (Heartbeat = the signal that makes the backend's age-based
   * force-detach safe; see _notifyBackendHeartbeat.)
   * @private
   */
  _startBackendHeartbeat() {
    const backendUrl = config.backend && config.backend.url;
    if ((!backendUrl && this._pendingBackendLeaves.size === 0) || typeof fetch !== 'function') return;
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(
      () => this._notifyBackendHeartbeat(),
      SocketHandlers.HEARTBEAT_MS
    );
    this._heartbeatTimer.unref?.();
  }

  /**
   * Tell the backend which rooms are genuinely alive — those with at least one
   * CONNECTED HUMAN. Bot-only and fully-disconnected rooms are intentionally
   * OMITTED so their backend record goes stale and the age-based reaper can
   * force-detach the ghost links left behind by a crashed socket or a dropped
   * room-closed webhook (B2). A waiting host sitting alone IS a connected human,
   * so their open room stays fresh and is never force-closed out from under them.
   * Best-effort, no-op if BACKEND_URL isn't configured.
   * @private
   */
  _notifyBackendHeartbeat() {
    const defaultBackendUrl = config.backend && config.backend.url;
    if (typeof fetch !== 'function') return;

    for (const [key, job] of this._pendingBackendLeaves) this._runBackendPlayerLeft(key, job);

    // Group live room ids by their owning backend so a true 1-socket/2-backend
    // co-deploy heartbeats EVERY backend's rooms, not just the configured default.
    // A room's `backendBaseUrl` (synced from sync-room `backendUrl`) is the REQUIRED
    // routing invariant; rooms with null fall back to config.backend.url so a
    // single-backend deploy (no backendUrl in sync-room) keeps working unchanged.
    const idsByBackend = new Map();
    const rooms = this.gameService?.getActiveRooms ? this.gameService.getActiveRooms() : [];
    for (const room of rooms) {
      if (room._seatLayoutSync?.dirty && !room._seatLayoutSync.running) {
        this._queueSeatLayoutSync(room);
      }
      const hasConnectedHuman = room
        .getPlayers()
        .some((p) => p.isBot !== true && p.isConnected);
      if (!hasConnectedHuman) continue;
      const backendUrl = room.backendBaseUrl || defaultBackendUrl;
      if (!backendUrl) continue;
      if (!idsByBackend.has(backendUrl)) idsByBackend.set(backendUrl, []);
      idsByBackend.get(backendUrl).push(String(room.roomId));
    }
    if (idsByBackend.size === 0) return;

    const beats = [];
    for (const [backendUrl, activeRoomIds] of idsByBackend) {
      beats.push(this._postHeartbeat(backendUrl, activeRoomIds));
    }
    return Promise.all(beats);
  }

  /**
   * POST one backend's live-room set, retrying a failed beat.
   *
   * A dropped beat is not cosmetic: the backend's listing scopes
   * (`scopeJoinable` and the spectatable-in-progress predicate) BOTH hide any
   * room whose `last_runtime_seen_at` has aged past the freshness window, so
   * losing beats makes the whole lobby flicker in and out for every user at
   * once. Treated accordingly — bounded timeout, then retried.
   * @private
   * @param {string} backendUrl
   * @param {string[]} activeRoomIds
   * @param {number} [attempt]
   * @returns {Promise<void>}
   */
  async _postHeartbeat(backendUrl, activeRoomIds, attempt = 0) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.backend.webhookSecret) headers['x-webhook-secret'] = config.backend.webhookSecret;
    const url = `${backendUrl.replace(/\/$/, '')}/api/webhooks/rooms-heartbeat`;

    try {
      const options = {
        method: 'POST',
        headers,
        body: JSON.stringify({ activeRoomIds }),
      };
      // Older runtimes without AbortSignal.timeout still beat, just unbounded.
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        options.signal = AbortSignal.timeout(SocketHandlers.HEARTBEAT_TIMEOUT_MS);
      }
      const res = await fetch(url, options);
      if (res && res.ok === false) {
        throw new Error(`HTTP ${res.status}`);
      }
      return;
    } catch (err) {
      if (attempt < SocketHandlers.HEARTBEAT_MAX_RETRIES) {
        const delay = SocketHandlers.HEARTBEAT_RETRY_DELAY_MS;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        return this._postHeartbeat(backendUrl, activeRoomIds, attempt + 1);
      }
      logger.warn(
        `[HEARTBEAT] backend rooms-heartbeat webhook failed after ${attempt + 1} attempt(s): ${err.message}`
      );
    }
  }

  /**
   * Last-resort recovery for a join into a room this socket node no longer holds
   * in memory (restart, or a WAITING grace-delete that raced the reopen). Asks the
   * backend for the room's canonical record and, if it is still OPEN, rebuilds the
   * runtime via syncRoomFromBackend so the join succeeds instead of dead-ending on
   * "Room is not ready" (A2). Only OPEN rooms can be rebuilt this way — an
   * in-progress room's runtime lives in Redis (handled by _rehydrateRoomForJoin),
   * not the backend. Returns the rebuilt room or null.
   * @private
   * @param {string} roomId
   * @param {string|null} requestId
   * @returns {Promise<object|null>}
   */
  async _rebuildRoomFromBackend(roomId, requestId = null) {
    // KNOWN LIMITATION (1-socket/2-backend co-deploy): this fires for a room this
    // node no longer holds in memory, so there is no `room.backendBaseUrl` to route
    // by — we cannot know which backend owns an unknown room. We fall back to the
    // configured default backend. In a true multi-backend co-deploy a rebuild can
    // only recover rooms owned by config.backend.url; run one socket per backend (the
    // documented REQUIRED-sync-invariant deploy) so every room's backend is reachable.
    const backendUrl = config.backend && config.backend.url;
    if (!backendUrl || typeof fetch !== 'function') return null;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (config.backend.webhookSecret) headers['x-webhook-secret'] = config.backend.webhookSecret;
      const resp = await fetch(`${backendUrl.replace(/\/$/, '')}/api/webhooks/room-fetch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ roomId: String(roomId) }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data || data.exists !== true || data.status !== 'open') return null;

      const result = this.syncRoomFromBackend(data);
      if (!result || result.success !== true) return null;

      this._logRoomLifecycle('room_rebuilt_from_backend_on_join', {
        roomId: String(roomId),
        requestId,
      });
      logger.warn(`[JOIN_ROOM] Rebuilt room ${roomId} from backend record on join`);
      return this.gameService.getRoom(String(roomId));
    } catch (err) {
      logger.warn(`[JOIN_ROOM] backend rebuild failed for ${roomId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Hold a disconnected pre-game player's seat for a grace window, then run the
   * real leave/teardown if they haven't reconnected (A1). Lets a swipe-killed host
   * reopen and rejoin the same room instead of hitting "Room is not ready".
   * @private
   * @param {string} roomId
   * @param {string} playerId
   */
  _scheduleWaitingLeave(roomId, playerId, delayMs = SocketHandlers.WAITING_GRACE_MS) {
    const key = `${roomId}:${playerId}`;
    const existing = this._waitingGraceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timerId = setTimeout(logger.bindRoom(roomId, () => {
      this._waitingGraceTimers.delete(key);
      const room = this.gameService.getRoom(roomId);
      // Game started, or room already gone → nothing to do. awaitingNextRound
      // covers a timer that was armed in the lobby and only fires after the match
      // is under way (#11 intermission): stripping a seat — or killing the room
      // because the dropper is the host — mid-match must never happen.
      if (!room || room.isInProgress() || room.awaitingNextRound) return;
      if (room._pendingBackendStart) {
        this._scheduleWaitingLeave(roomId, playerId);
        return;
      }
      const player = room.getPlayer(playerId);
      // Reconnected within the window (a live socket re-marked them active) → keep
      // the held seat.
      if (!player || player.isConnected) return;

      // Pre-game host-gone (the grace window expired without the host returning)
      // KILLS the lobby room rather than migrating the host (contract item 5).
      // The host heartbeat is the primary backstop; this aligns the disconnect
      // grace path with it so both end a host-gone lobby the same way.
      if (room.hostPlayerId === playerId) {
        this._killLobbyRoomHostGone(room, 'host_left');
        return;
      }

      const leaveResult = this.gameService.leaveRoom(playerId);
      if (!leaveResult.success) return;

      if (leaveResult.roomDeleted) {
        // Backend close is handled by the gameService.onRoomDeleted hook.
        this.io.to(roomId).emit(SocketEvents.ROOM_CLOSED, {
          reason: 'Room closed',
          timestamp: new Date().toISOString(),
        });
      } else {
        this._notifyBackendPlayerLeft(roomId, playerId, false, player, room);
        this.io.to(roomId).emit(SocketEvents.PLAYER_LEFT, {
          playerId,
          playerIndex: player.playerIndex,
          playerName: player.playerName,
          timestamp: new Date().toISOString(),
        });
        // Same reason as the explicit leave above: the freed seat only reaches
        // the other clients' seat grids through the authoritative roster. This
        // path is the one that strands a seat for MINUTES — nobody pressed
        // anything, so nothing else will come along to correct the picture.
        const liveRoom = this.gameService.getRoom(roomId);
        if (liveRoom) this._broadcastSeatChanged(liveRoom);
      }
      logger.info(
        `[DISCONNECT] ✓ Grace expired: removed ${playerId} from waiting room ${roomId}`
      );
    }), delayMs);
    timerId.unref?.();
    this._waitingGraceTimers.set(key, timerId);
  }

  /**
   * Cancel a pending pre-game seat-hold leave because the player reconnected
   * within the grace window (A1).
   * @private
   * @param {string} roomId
   * @param {string} playerId
   */
  _cancelWaitingLeave(roomId, playerId) {
    const key = `${roomId}:${playerId}`;
    const timerId = this._waitingGraceTimers.get(key);
    if (timerId) {
      clearTimeout(timerId);
      this._waitingGraceTimers.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Host heartbeat (lobby/WAITING rooms only). Kills a stuck lobby room when the
  // host swipes/kills/freezes the app and no leave/cancel REST ever fires. The
  // server pings the host socket every interval; the host pongs. After
  // maxMisses consecutive missed pongs (~60s) the room is killed. Mirrors the
  // per-room interval pattern of ownerRenewTimers (.unref + explicit clear).
  // See brazilia_host_heartbeat_contract.md. ---------------------------------
  /**
   * Start the per-room host heartbeat if eligible. Idempotent: a no-op when
   * disabled, the room is gone, not WAITING, has no host, or already has a live
   * handle. Safe to call after any successful join and at the end of sync-room.
   * @private
   * @param {import('../models/GameRoom')|null|undefined} room
   */
  _ensureHostHeartbeat(room) {
    if (!config.hostHeartbeat || !config.hostHeartbeat.enabled) return;
    if (!room) return;
    if (room.status !== GameRoomStatus.WAITING) return;
    if (!room.hostPlayerId) return;
    if (room.hostHeartbeatHandle) return;

    room.hostHeartbeatMissed = 0;
    const handle = setInterval(
      logger.bindRoom(room.roomId, () => this._hostHeartbeatTick(room)),
      config.hostHeartbeat.intervalMs
    );
    handle.unref?.();
    room.hostHeartbeatHandle = handle;
    logger.info(
      `[HOST_HEARTBEAT] started for room ${room.roomId} (host ${room.hostPlayerId}, interval ${config.hostHeartbeat.intervalMs}ms)`
    );
  }

  /**
   * Stop the per-room host heartbeat and reset its counters. Idempotent.
   * @private
   * @param {import('../models/GameRoom')|null|undefined} room
   */
  _stopHostHeartbeat(room) {
    if (!room) return;
    if (room.hostHeartbeatHandle) {
      clearInterval(room.hostHeartbeatHandle);
      room.hostHeartbeatHandle = null;
      logger.info(`[HOST_HEARTBEAT] stopped for room ${room.roomId}`);
    }
    room.hostHeartbeatMissed = 0;
    room.hostHeartbeatSeq = 0;
    room.hostEverConnected = false;
    room._hostSocketAbsent = false;
  }

  /**
   * Note that the host is present (e.g. just (re)joined): clear accrued misses and
   * mark the host connected so a host reconnecting near the kill window is not
   * killed on the tick it returns. No-op if the joiner is not the room's host.
   * @private
   * @param {import('../models/GameRoom')|null|undefined} room
   * @param {string|number|null} playerId
   */
  _noteHostHeartbeatPresence(room, playerId) {
    if (!room || playerId === null || playerId === undefined) return;
    if (String(playerId) !== String(room.hostPlayerId)) return;
    room.hostHeartbeatMissed = 0;
    room.hostEverConnected = true;
    room._hostSocketAbsent = false;
  }

  /**
   * One heartbeat tick: ping the host socket and count a miss. A pong (handled
   * separately) resets the miss counter. After maxMisses consecutive misses the
   * lobby room is killed. Stops itself if the room is gone or no longer WAITING.
   * @private
   * @param {import('../models/GameRoom')} room
   */
  _hostHeartbeatTick(room) {
    // Always re-read the live room — the passed reference could be stale.
    const liveRoom = this.gameService?.getRoom?.(room.roomId);
    if (!liveRoom || liveRoom.status !== GameRoomStatus.WAITING) {
      this._stopHostHeartbeat(liveRoom || room);
      return;
    }
    if (liveRoom._seatLayoutSync?.dirty && !liveRoom._seatLayoutSync.running) {
      this._queueSeatLayoutSync(liveRoom);
    }

    // Resolve the host socket: hostPlayerId → seat's socketId → live socket.
    const hostPlayer = liveRoom.hostPlayerId
      ? liveRoom.players.get(liveRoom.hostPlayerId)
      : null;
    const hostSocket = hostPlayer?.socketId
      ? this.io.sockets.sockets.get(hostPlayer.socketId)
      : null;

    if (hostSocket) {
      // Host socket is alive. If it just (re)appeared after an absence (or this is
      // the host's first connection), reset the miss counter so misses accrued
      // while it was gone don't carry over and kill a host who just came back.
      if (!liveRoom.hostEverConnected || liveRoom._hostSocketAbsent) {
        liveRoom.hostHeartbeatMissed = 0;
      }
      liveRoom.hostEverConnected = true;
      liveRoom._hostSocketAbsent = false;
      hostSocket.emit(SocketEvents.HOST_HEARTBEAT_PING, {
        roomId: liveRoom.roomId,
        seq: ++liveRoom.hostHeartbeatSeq,
        ts: Date.now(),
      });
    } else {
      liveRoom._hostSocketAbsent = true;
    }

    // Only count misses once the host has actually been present at least once. A
    // never-yet-connected host (room just synced, app still connecting) is owned
    // by the backend activation-deadline cleanup — counting misses here would
    // kill a host who is legitimately mid-connect ~60s after sync.
    if (!liveRoom.hostEverConnected) return;

    liveRoom.hostHeartbeatMissed = (liveRoom.hostHeartbeatMissed || 0) + 1;

    const maxMisses = config.hostHeartbeat.maxMisses;
    if (liveRoom.hostHeartbeatMissed >= maxMisses) {
      this._killLobbyRoomHostGone(liveRoom, 'host_heartbeat_timeout');
    }
  }

  /**
   * Handle a host heartbeat pong. Anti-spoof: the sending socket's bound player
   * must be the room's CURRENT host (same spirit as seat-swap re-validation).
   * A valid pong resets the miss counter and stamps lastHostPongAt.
   * @param {Socket} socket
   * @param {{roomId?: string|number, seq?: number}} [data]
   */
  handleHostHeartbeatPong(socket, data = {}) {
    const roomId =
      data?.roomId === null || data?.roomId === undefined ? null : String(data.roomId);
    if (!roomId) return;
    const room = this.gameService?.getRoom?.(roomId);
    if (!room) return;

    // Resolve the sender's seat identity and confirm it is the room's host.
    const senderPlayerId = this.gameService?.getPlayerIdBySocket?.(socket.id);
    if (!senderPlayerId || String(senderPlayerId) !== String(room.hostPlayerId)) {
      // Non-host (or spoofed) pong — ignore. Only the host keeps the room alive.
      return;
    }

    room.hostHeartbeatMissed = 0;
    room.lastHostPongAt = Date.now();
    // A pong proves the host is alive and foregrounded → refresh its activity so
    // the 30-min inactivity sweep (_cleanupInactiveRooms, keyed on lastActivity)
    // can never reap a ponging lobby host that simply hasn't taken a game action.
    room.players.get(String(senderPlayerId))?.markActive?.();
  }

  /**
   * Kill a stuck lobby room because the host is gone (heartbeat timeout, or an
   * explicit host leave). Mirrors cancelRoomFromBackend's teardown: notify every
   * joiner (players + spectators), detach all sockets, then delete the room —
   * which fires onRoomDeleted → _notifyBackendRoomClosed(roomId, reason) so the
   * backend cancels + refunds + de-lists. Idempotent on an already-gone room.
   * @private
   * @param {import('../models/GameRoom')} room
   * @param {'host_heartbeat_timeout'|'host_left'} reason
   */
  _killLobbyRoomHostGone(room, reason) {
    if (room?._pendingBackendStart) return;
    if (!room) return;
    const roomId = room.roomId;
    // Guard against a double-kill (e.g. heartbeat tick racing an explicit leave):
    // once the room is gone from the service there is nothing left to tear down.
    if (!this.gameService?.getRoom?.(roomId)) return;
    // #11 multi-round: this is a LOBBY teardown — it deletes the room outright,
    // with no result and no settlement. A room between rounds is FINISHED but
    // mid-match, so reaching here would silently destroy a live match and its
    // cumulative score. Every caller is now gated, so this is the backstop.
    if (room.awaitingNextRound) {
      logger.warn(
        `[HOST_HEARTBEAT] refusing to kill room ${roomId} (${reason}): a next round is scheduled (match still live).`
      );
      return;
    }

    const missed = room.hostHeartbeatMissed || 0;
    this._stopHostHeartbeat(room);

    // Reaches players AND spectators — both share the socket.io room.
    this.io.to(roomId).emit(SocketEvents.ROOM_CLOSED, {
      reason,
      message: 'Room sudah diakhiri host',
      timestamp: Date.now(),
    });

    // Detach every player socket.
    room.getPlayers().forEach((player) => {
      const playerSocket = this.io.sockets.sockets.get(player.socketId);
      if (playerSocket) playerSocket.leave(roomId);
    });

    // Detach + clear spectators (same bookkeeping cancelRoomFromBackend uses).
    const spectators = this.roomSpectators.get(roomId);
    if (spectators) {
      for (const spectatorSocketId of spectators.keys()) {
        const spectatorSocket = this.io.sockets.sockets.get(spectatorSocketId);
        if (spectatorSocket) spectatorSocket.leave(roomId);
        this.spectatorSocketToRoom.delete(spectatorSocketId);
      }
      this.roomSpectators.delete(roomId);
    }

    // Stash reason + per-backend URL so the onRoomDeleted hook can forward both
    // to _notifyBackendRoomClosed after the room object is gone.
    this._roomCloseContext.set(String(roomId), {
      reason,
      backendBaseUrl: room.backendBaseUrl || null,
    });

    // deleteRoom → onRoomDeleted → _notifyBackendRoomClosed(roomId) (reads stash).
    this.gameService.deleteRoom(roomId);

    metrics.increment('buraco_host_heartbeat_kill_total', { reason });
    this._logRoomLifecycle('host_heartbeat_kill', { roomId, reason, missed });
    logger.warn(
      `[HOST_HEARTBEAT] killed lobby room ${roomId} (reason=${reason}, missed=${missed})`
    );
  }

  /**
   * Are the seats frozen? Every lobby seat mutation (switch team, claim/leave
   * seat, swap, invite, host kick/re-seat) must be refused while a MATCH is
   * running.
   *
   * "Running" is not the same as IN_PROGRESS. #11 multi-round parks the room in
   * FINISHED for the whole round-over intermission, and these handlers used to
   * gate on isInProgress() alone — so the interstitial silently unlocked all nine
   * of them. A team switch or host re-seat there rewrites playerIndex, i.e. the
   * even/odd team id that cumulativeTeamScores is keyed on: the running match
   * total would be credited to the wrong side for every remaining round.
   * @param {import('../models/GameRoom')} room
   * @returns {boolean}
   */
  _seatsLocked(room) {
    return !!room && (room.status !== GameRoomStatus.WAITING || room.awaitingNextRound === true ||
      !!room._pendingBackendStart);
  }

  _socketOwnsSeat(socket, player) {
    return !!player && socket.connected !== false && player.socketId === socket.id &&
      (this.gameService.getPlayerRoom(player.playerId)?.seatConnectionProtocol !== 1 || socket.data?.authenticated === true) &&
      this._assertSocketIdentity(socket, player.playerId);
  }

  /**
   * Handle switch team request
   * @param {Socket} socket
   * @param {Object} data
   */
  handleSwitchTeam(socket, data) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);

    if (!playerId) return;

    const room = this.gameService.getPlayerRoom(playerId);
    if (!room) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Room not found'));
      return;
    }

    if (this._seatsLocked(room)) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('Cannot switch team while game is in progress')
      );
      return;
    }

    const player = room.getPlayer(playerId);
    if (!this._socketOwnsSeat(socket, player)) return;

    if (String(room.hostPlayerId) === String(playerId) || player.playerIndex === 0) {
      return this._swapFail(socket, 'host_seat', 'The host seat can\'t be moved');
    }

    const currentIdx = player.playerIndex;
    const currentTeam = currentIdx % 2; // 0 or 1
    const targetTeam = currentTeam === 0 ? 1 : 0;

    // Find empty slots for target team
    const usedIndices = room.getPlayers().map((p) => p.playerIndex);
    const maxPlayers = room.maxPlayers;

    let targetIdx = -1;

    // Check possible indices for target team (0, 2 for Team A; 1, 3 for Team B)
    for (let i = targetTeam === 0 ? 2 : 1; i < maxPlayers; i += 2) {
      if (!usedIndices.includes(i)) {
        targetIdx = i;
        break;
      }
    }

    if (targetIdx !== -1) {
      // Found an empty slot! Move player.
      logger.info(
        `[SWITCH_TEAM] Player ${playerId} switching from index ${currentIdx} to ${targetIdx}`
      );
      player.playerIndex = targetIdx;
      this._clearPendingFor(room, playerId);
      this._clearInvitesForSeat(room, targetIdx);
      this._broadcastSeatChanged(room);
    } else {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Target team is full'));
    }
  }

  // ===========================================================================
  // Lobby seat swap (2v2)
  //
  // The Node event loop is single-threaded, so each handler runs to completion
  // without interleaving — seat mutations here are inherently atomic per room.
  // The race surface is therefore STALE STATE, which every handler guards
  // against by re-reading the live room right before it mutates. Host seat is
  // fixed: the host (room.hostPlayerId) can neither initiate nor be a target,
  // and its seat can't be claimed.
  // ===========================================================================

  /** Lazily-created per-room map: targetPlayerId -> pending swap request. */
  _roomPending(room) {
    if (!room._pendingSwaps) room._pendingSwaps = new Map();
    return room._pendingSwaps;
  }

  _clearPending(room, targetPlayerId) {
    const pend = this._roomPending(room);
    const entry = pend.get(targetPlayerId);
    if (entry) {
      clearTimeout(entry.timeout);
      pend.delete(targetPlayerId);
    }
  }

  /** Drop any pending request where [playerId] is the requester OR the target. */
  _clearPendingFor(room, playerId) {
    const pend = this._roomPending(room);
    for (const [targetId, entry] of [...pend.entries()]) {
      if (targetId === playerId || entry.requesterId === playerId) {
        clearTimeout(entry.timeout);
        pend.delete(targetId);
      }
    }
  }

  _socketFor(player) {
    return player && player.socketId
      ? this.io.sockets.sockets.get(player.socketId)
      : null;
  }

  _swapFail(socket, reason, message, seat) {
    const payload = { reason, message, timestamp: new Date().toISOString() };
    if (Number.isInteger(seat)) payload.seat = seat;
    if (!socket) return;
    socket.emit('swap_failed', payload);
    if (reason === 'seat_taken' || reason === 'host_seat') {
      // The competing claim may have completed before this client received the
      // winning roster. Reply with current occupancy as well as the rejection.
      const playerId = this.gameService.getPlayerIdBySocket(socket.id);
      const room = playerId
        ? this.gameService.getPlayerRoom(playerId)
        : this.gameService.getRoom(this.spectatorSocketToRoom.get(socket.id));
      if (room && room.status === GameRoomStatus.WAITING) {
        socket.emit('seat_changed', {
          players: room.getPlayers().map((p) => this._serializePlayer(p)),
          timestamp: new Date().toISOString(),
        });
        socket.emit(SocketEvents.PLAYER_JOINED, this._lobbyPlayersPayload(room));
      }
    }
  }

  /** Authoritative roster broadcast after any seat mutation. */
  _broadcastSeatChanged(room) {
    const seated = room.getPlayers();
    this.io.to(room.roomId).emit('seat_changed', {
      players: seated.map((p) => this._serializePlayer(p)),
      timestamp: new Date().toISOString(),
    });
    // Keep the legacy lobby-roster path fresh too (start gate / older clients).
    this._broadcastLobbyPlayers(room);
  }

  /** Authoritative spectator-roster broadcast after any spectator mutation. */
  _broadcastSpectatorsChanged(roomId) {
    const specs = this.roomSpectators.get(roomId);
    const spectators = specs
      ? Array.from(specs.values()).map((s) => ({
        spectatorId: s.spectatorId,
        spectatorName: s.spectatorName,
        avatarUrl: s.avatarUrl || null,
      }))
      : [];
    this.io.to(roomId).emit('spectators_changed', {
      spectators,
      count: spectators.length,
      timestamp: new Date().toISOString(),
    });
    // The lobby shows the watcher count too; it travels with the seat count.
    const room = this.gameService.getRoom(roomId);
    if (room) this._notifyBackendPlayerCount(roomId, room.players.size);
  }

  _expireSwap(room, targetPlayerId) {
    const pend = this._roomPending(room);
    const entry = pend.get(targetPlayerId);
    if (!entry) return;
    pend.delete(targetPlayerId);
    const requester = room.getPlayer(entry.requesterId);
    const reqSocket = this._socketFor(requester);
    if (reqSocket) {
      reqSocket.emit('swap_responded', {
        accept: false,
        requesterId: entry.requesterId,
        requesterSeat: entry.requesterSeat,
        targetId: targetPlayerId,
        targetSeat: entry.targetSeat,
        reason: 'expired',
        timestamp: new Date().toISOString(),
      });
    }
    const target = room.getPlayer(targetPlayerId);
    const tgtSocket = this._socketFor(target);
    if (tgtSocket) {
      tgtSocket.emit('swap_failed', {
        reason: 'expired',
        message: 'Swap request expired',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Move the requester into an EMPTY non-host seat, OR seat a spectator into an
   * empty non-host seat (WAITING-phase lobby). A seated player keeps their
   * identity and only changes playerIndex; a spectator is converted into a real
   * PlayerSession and removed from the spectator bookkeeping.
   * @param {Socket} socket
   * @param {Object} data { seat }
   */
  handleClaimSeat(socket, data = {}) {
    const roomId = this.spectatorSocketToRoom.get(socket.id);
    const room = roomId ? this.gameService.getRoom(roomId) : null;
    const spectator = this.roomSpectators.get(roomId)?.get(socket.id);
    if ((room?.seatReservationProtocol !== 1 && room?.seatLayoutProtocol !== 1 && room?.seatConnectionProtocol !== 1) || !this._backendUrlForRoom(roomId) || !spectator ||
        this.gameService.getPlayerIdBySocket(socket.id)) {
      return this._claimSeatNow(socket, data);
    }

    const key = `${roomId}:${spectator.spectatorId}`;
    const pending = this._pendingSeatClaims.get(key);
    if (pending) {
      if (pending.socketId === socket.id) return pending.promise;
      // A replacement connection needs its own response once the old attempt
      // settles; otherwise its optimistic seat indicator never gets cleared.
      return pending.promise.then(() => this.handleClaimSeat(socket, data));
    }
    const claim = this._serializeSeatMutation(key,
      () => this._claimReservedSeat(socket, data, room, spectator));
    const entry = { socketId: socket.id, promise: claim };
    this._pendingSeatClaims.set(key, entry);
    claim.finally(() => {
      if (this._pendingSeatClaims.get(key) === entry) this._pendingSeatClaims.delete(key);
    }).catch(() => {});
    return claim;
  }

  async _seatBackendRequest(room, path, body) {
    const backendUrl = room.backendBaseUrl || config.backend.url;
    const headers = { 'Content-Type': 'application/json' };
    if (config.backend.webhookSecret) headers['x-webhook-secret'] = config.backend.webhookSecret;
    const response = await fetch(`${backendUrl.replace(/\/$/, '')}/api/webhooks/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Seat reservation request failed: ${response.status}`);
    return response.json();
  }

  _seatLayoutRoomIsLive(room) {
    return room?.seatLayoutProtocol === 1 && room.status === GameRoomStatus.WAITING &&
      !this._seatsLocked(room) && this.gameService.getRoom(room.roomId) === room &&
      !!this._backendUrlForRoom(room.roomId) && typeof fetch === 'function';
  }

  /** Coalesce lobby changes without blocking the socket's seat mutations. */
  _queueSeatLayoutSync(room) {
    if (!this._seatLayoutRoomIsLive(room)) return;
    const state = room._seatLayoutSync ||= { revision: 0, dirty: false, running: null };
    state.revision += 1;
    state.dirty = true;
    if (state.running) return state.running;
    // Start on the next microtask so a synchronous batch publishes only its
    // final layout. The running promise belongs to this exact room instance.
    state.running = Promise.resolve()
      .then(() => this._syncSeatLayout(room, state))
      .catch((err) => logger.warn(`[SEAT_LAYOUT] room ${room.roomId}: ${err.message}`))
      .finally(() => { state.running = null; });
    return state.running;
  }

  async _syncSeatLayout(room, state) {
    const canWrite = () => this._seatLayoutRoomIsLive(room) &&
      (!this._ownershipEnabled() || this.ownedRoomIds.has(String(room.roomId)));
    let failure = null;
    for (let attempt = 0; attempt < 3 && canWrite(); attempt += 1) {
      try {
        if (!state.operation) {
          const members = new Map(room.getPlayers().map((player) => [String(player.playerId), player]));
          if (![...members.values()].some((player) => player.isBot !== true)) {
            state.dirty = false;
            return;
          }
          const revision = state.revision;
          const snapshot = await this._seatBackendRequest(room, 'room-fetch', { roomId: String(room.roomId) });
          if (!canWrite()) return;
          if (snapshot.exists !== true || snapshot.status !== 'open' || snapshot.seatLayoutProtocol !== 1) return;
          // This response may predate a sit/leave as well as a move. Refetch
          // changed membership or intent instead of declaring a stale no-op clean.
          if (revision !== state.revision || room.getPlayers().some((player) =>
            members.get(String(player.playerId)) !== player)) continue;
          const reservations = new Map((snapshot.players || []).map((player) => [String(player.playerId), player]));
          let unresolved = false;
          const players = room.getPlayers().filter((player) => player.isBot !== true).flatMap((player) => {
            const reservation = reservations.get(String(player.playerId));
            const key = `${room.roomId}:${player.playerId}`;
            if (!reservation || reservation.isSpectator !== false ||
                this._pendingSeatClaims.has(key) || this._unresolvedSeatRejections.has(key) ||
                !Number.isInteger(reservation.reservationVersion) || reservation.reservationVersion < 0 ||
                !Number.isInteger(reservation.playerIndex)) {
              unresolved = true;
              return [];
            }
            // Legacy sessions can establish proof only when API and runtime
            // already agree. A mismatch needs a verified join/claim, never a
            // fresh API version borrowed to authorize an old runtime allocation.
            if (player.apiSeatReservationVersion == null && reservation.playerIndex === player.playerIndex) {
              player.apiSeatReservationVersion = reservation.reservationVersion;
            }
            if (player.apiSeatReservationVersion !== reservation.reservationVersion) {
              unresolved = true;
              return [];
            }
            return [{
              playerId: String(player.playerId),
              reservationVersion: reservation.reservationVersion,
              expectedSeat: reservation.playerIndex,
              seat: player.playerIndex,
            }];
          });
          if (!players.some((player) => player.expectedSeat !== player.seat)) {
            state.dirty = unresolved;
            return;
          }
          state.operation = {
            body: { roomId: String(room.roomId), operationId: randomBytes(16).toString('hex'), players },
            members, revision, unresolved,
          };
        }
        // After a timeout, replay the EXACT operation before fetching another
        // version. Its API receipt distinguishes a committed lost ACK from a
        // new REST allocation. Later moves wait in revision/dirty, not in HTTP.
        const operation = state.operation;
        const result = await this._seatBackendRequest(room, 'room-seat-layout', operation.body);
        if (!canWrite()) return;
        state.operation = null;
        if (result.applied === true) {
          const receipt = new Map((result.players || []).map((player) => [String(player.playerId), player]));
          let acknowledged = true;
          for (const sent of operation.body.players) {
            const member = operation.members.get(sent.playerId);
            const applied = receipt.get(sent.playerId);
            if (room.getPlayer(sent.playerId) === member &&
                member.apiSeatReservationVersion === sent.reservationVersion &&
                applied?.playerIndex === sent.seat && Number.isInteger(applied.reservationVersion) &&
                applied.reservationVersion >= sent.reservationVersion) {
              member.apiSeatReservationVersion = applied.reservationVersion;
            } else {
              acknowledged = false;
            }
          }
          this._persistLobbyRoster(room);
          if (operation.revision === state.revision && !operation.unresolved && acknowledged) {
            state.dirty = false;
            return;
          }
        }
        failure = result.reason || 'layout changed while syncing';
      } catch (err) {
        failure = err.message;
      }
    }
    // Leave dirty after bounded retries; the next roster update/heartbeat
    // retries it. No background loop and no dependency in the room-list API.
    if (failure && canWrite()) logger.warn(`[SEAT_LAYOUT] room ${room.roomId} pending retry: ${failure}`);
  }

  async _fetchSeatReservation(room, playerId) {
    const snapshot = await this._seatBackendRequest(room, 'room-fetch', { roomId: String(room.roomId) });
    if (snapshot.exists !== true || snapshot.status !== 'open') return null;
    return (snapshot.players || []).find((player) => String(player.playerId) === String(playerId)) || null;
  }

  async _activateSeatConnection(socket, room, playerId, reservation) {
    if (room.seatConnectionProtocol !== 1) return reservation;
    if (!socket.data?.authenticated || socket.data.userId == null || !this._assertSocketIdentity(socket, playerId)) {
      throw new Error('Authentication required');
    }
    const body = {
      roomId: String(room.roomId), playerId: String(playerId),
      expectedReservationVersion: reservation.reservationVersion, connectionId: socket.id,
    };
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this._seatBackendRequest(room, 'room-seat-activate', body);
        if (result.activated === true && Number.isInteger(result.reservationVersion) &&
            result.reservationVersion >= 0 && Number.isInteger(result.playerIndex)) {
          return { ...reservation, isSpectator: false, reservationVersion: result.reservationVersion, playerIndex: result.playerIndex };
        }
        if (result.reason === 'not_joined') return { ...reservation, isSpectator: true };
        throw Object.assign(new Error(result.reason || 'Seat activation rejected'), { rejected: true });
      } catch (err) {
        if (err.rejected) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  async _releaseSeatReservation(room, playerId, reservationVersion) {
    const key = `${room.roomId}:${playerId}`;
    const rejection = { room, reservationVersion };
    this._unresolvedSeatRejections.set(key, rejection);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this._seatBackendRequest(room, 'room-seat-claim-rejected', {
          roomId: String(room.roomId),
          playerId: String(playerId),
          reservationVersion,
        });
        if (result.success === true && result.isSpectator === true &&
            this._unresolvedSeatRejections.get(key) === rejection) {
          this._unresolvedSeatRejections.delete(key);
        }
        return result;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async _reconcileSeatRejection(room, playerId, reservation) {
    const key = `${room.roomId}:${playerId}`;
    const pending = this._unresolvedSeatRejections.get(key);
    if (!pending) return reservation;
    if (!reservation || reservation.isSpectator === true ||
        reservation.reservationVersion !== pending.reservationVersion) {
      // A fresh allocation has another generation; an old rejection cannot
      // refund it because the API compares the version while holding its lock.
      this._unresolvedSeatRejections.delete(key);
      return reservation;
    }
    const released = await this._releaseSeatReservation(pending.room, playerId, pending.reservationVersion);
    if (released.success !== true || released.isSpectator !== true) {
      throw new Error('Previous seat rejection is not resolved');
    }
    return { ...reservation, isSpectator: true };
  }

  _canReleasePreviousRoomForSeatClaim(room, playerId, proof) {
    // A completed match retains its roster briefly for result replay. It must
    // not reserve that player's next lobby seat, just as normal joinRoom allows
    // switching away from it. Intermission/start handoffs still own the player.
    return (room?.status === GameRoomStatus.FINISHED && !room.awaitingNextRound &&
      !room._pendingBackendStart) || this.gameService.canReleaseWaitingSeat(room, playerId, proof);
  }

  async _claimReservedSeat(socket, data, room, spectator) {
    const playerId = spectator.spectatorId;
    if (room.getPlayer(playerId)) {
      return this._swapFail(socket, 'not_allowed', 'You already have a seat. Please reconnect.');
    }
    let reservation;
    try {
      reservation = await this._fetchSeatReservation(room, playerId);
      reservation = await this._reconcileSeatRejection(room, playerId, reservation);
      if (reservation?.isSpectator === false && Number.isInteger(reservation.reservationVersion) &&
          socket.connected !== false && this.gameService.getRoom(room.roomId) === room &&
          this.roomSpectators.get(room.roomId)?.get(socket.id) === spectator && !room.getPlayer(playerId)) {
        reservation = await this._activateSeatConnection(socket, room, playerId, reservation);
      }
    } catch (err) {
      this._swapFail(socket, 'not_allowed', 'Could not verify your seat. Please retry.');
      return;
    }

    const stillWatching = () => socket.connected !== false &&
      this.gameService.getRoom(room.roomId) === room &&
      this.spectatorSocketToRoom.get(socket.id) === room.roomId &&
      this.roomSpectators.get(room.roomId)?.get(socket.id) === spectator &&
      !this.gameService.getPlayerIdBySocket(socket.id) && !room.getPlayer(playerId);

    // Another connection for this identity may already own a real runtime seat.
    // Never compensate a stale request by refunding that winning player's stake.
    if (room.getPlayer(playerId)) return;

    const seat = Number(data.seat);
    const hasReservation = reservation?.isSpectator === false &&
      Number.isInteger(reservation.reservationVersion) && reservation.reservationVersion >= 0;
    const otherRoom = this.gameService.getPlayerRoom(playerId);
    let releasedSeatProof = null;
    if (hasReservation && otherRoom && otherRoom !== room && otherRoom.backendManaged &&
        otherRoom.status === GameRoomStatus.WAITING && stillWatching()) {
      releasedSeatProof = await this._verifyReleasedRoomSeat(socket, room, otherRoom, playerId, reservation, seat);
    }
    const previousRoom = this.gameService.getPlayerRoom(playerId);
    const canReleasePreviousRoom = !previousRoom || previousRoom === room ||
      this._canReleasePreviousRoomForSeatClaim(previousRoom, playerId, releasedSeatProof);
    const canClaim = stillWatching() && !this._seatsLocked(room) && canReleasePreviousRoom &&
      Number.isInteger(seat) && seat > 0 && seat < room.maxPlayers &&
      !room.getPlayerByIndex(seat) && !room.isFull();
    if (hasReservation && canClaim) {
      // No await between occupancy validation and the actual seat mutation.
      const result = this._claimSeatNow(socket, data, releasedSeatProof);
      const admitted = room.getPlayer(playerId);
      if (admitted?.socketId === socket.id) {
        admitted.apiSeatReservationVersion = reservation.reservationVersion;
      }
      return result;
    }

    this._logRoomLifecycle('seat_claim_rejected', {
      roomId: room.roomId,
      playerId,
      requestedSeat: seat,
      occupantPlayerId: room.getPlayerByIndex(seat)?.playerId || null,
      previousRoomId: previousRoom?.roomId || null,
      previousRoomStatus: previousRoom?.status || null,
      hasReservation,
      reason: !stillWatching() ? 'stale_claim' : !hasReservation ? 'missing_reservation' :
        this._seatsLocked(room) ? 'room_locked' : !canReleasePreviousRoom ? 'another_active_room' :
          !Number.isInteger(seat) || seat <= 0 || seat >= room.maxPlayers ? 'invalid_seat' :
            room.getPlayerByIndex(seat) ? 'seat_taken' : 'room_full',
    });

    if (hasReservation) {
      try {
        const released = await this._releaseSeatReservation(room, playerId, reservation.reservationVersion);
        // A newer REST attempt owns the reservation now, or the game started.
        // The failed attempt must not demote the newer one in the client either.
        if (released.success !== true || released.isSpectator !== true) {
          if (stillWatching()) {
            this._swapFail(socket, 'not_allowed', 'Your seat reservation changed. Please retry.');
          }
          return;
        }
      } catch (err) {
        logger.warn(`[CLAIM_SEAT] Reservation release failed for ${playerId}: ${err.message}`);
        if (stillWatching()) {
          this._swapFail(socket, 'not_allowed', 'Could not release the seat reservation. Please retry.');
        }
        return;
      }
    }

    if (stillWatching()) {
      // Existing clients understand this spectator transition and clear their
      // optimistic local seat. The reason distinguishes it from a host action.
      socket.emit('kicked', { toSpectator: true, reason: 'seat_taken', timestamp: new Date().toISOString() });
      this._swapFail(socket, 'seat_taken', 'That seat is taken. You are still a spectator.', seat);
      this._broadcastSpectatorsChanged(room.roomId);
    }
  }

  _claimSeatNow(socket, data = {}, releasedSeatProof = null) {
    // A seated player is resolved via the socket→player binding; a spectator has
    // NO such binding (they live only in roomSpectators/spectatorSocketToRoom).
    // Resolve both so a spectator can claim a seat too.
    const seatedPlayerId = this.gameService.getPlayerIdBySocket(socket.id);
    const spectatorRoomId = this.spectatorSocketToRoom.get(socket.id);

    // Prefer the seated-player room; fall back to the spectator's room.
    const room = seatedPlayerId
      ? this.gameService.getPlayerRoom(seatedPlayerId)
      : (spectatorRoomId ? this.gameService.getRoom(spectatorRoomId) : undefined);
    if (!room) return this._swapFail(socket, 'not_allowed', 'Room not found');
    if (this._seatsLocked(room)) {
      return this._swapFail(socket, 'not_allowed', 'Game already started');
    }

    const seat = Number(data.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.maxPlayers) {
      return this._swapFail(socket, 'not_allowed', 'Invalid seat');
    }
    if (seat === 0 && (room.backendManaged || room.hostPlayerId != null)) {
      return this._swapFail(socket, 'host_seat', 'The host seat can\'t be taken', seat);
    }

    // Re-read live seat occupancy right before mutating (single-threaded, but
    // keep the read/decision adjacent so it stays correct under refactors).
    const seatedPlayer = seatedPlayerId ? room.getPlayer(seatedPlayerId) : undefined;

    // ── Path A: caller is already a seated, non-bot player → move their seat. ──
    if (seatedPlayer && !seatedPlayer.isBot) {
      const playerId = seatedPlayerId;
      if (!this._socketOwnsSeat(socket, seatedPlayer)) {
        return this._swapFail(socket, 'not_allowed', 'Please rejoin before moving seats');
      }
      if (String(room.hostPlayerId) === String(playerId) || seatedPlayer.playerIndex === 0) {
        return this._swapFail(socket, 'host_seat', 'The host seat can\'t be moved');
      }
      if (seat === seatedPlayer.playerIndex) return; // already seated there

      const occupant = room.getPlayers().find((p) => p.playerIndex === seat);
      if (occupant && occupant.playerId === room.hostPlayerId) {
        return this._swapFail(socket, 'host_seat', 'The host seat can\'t be taken', seat);
      }
      if (occupant) {
        return this._swapFail(socket, 'seat_taken', 'That seat is taken', seat);
      }

      // The mover's seat is changing — any pending swap involving them is void.
      this._clearPendingFor(room, playerId);
      // A just-filled seat drops any stale invite that targeted it.
      this._clearInvitesForSeat(room, seat);
      logger.info(`[CLAIM_SEAT] ${playerId} ${seatedPlayer.playerIndex} -> ${seat}`);
      seatedPlayer.playerIndex = seat;
      this._broadcastSeatChanged(room);
      return;
    }

    // ── Path B: caller is a spectator of this room → seat them. ──
    const spectators = spectatorRoomId === room.roomId
      ? this.roomSpectators.get(room.roomId)
      : null;
    const spectator = spectators ? spectators.get(socket.id) : null;
    if (!spectator) {
      // Neither a seated player of this room nor a known spectator of it.
      return this._swapFail(socket, 'not_allowed', 'Not in this room');
    }

    const playerId = spectator.spectatorId || `spectator_${socket.id}`;
    // Prefer the real name the client sends on claim_seat; then the stored
    // spectator name; NEVER persist the literal 'Spectator' default onto a SEATED
    // player (bug: the opponent scoreboard chip read "Spectator" instead of the
    // joined player's name). Fall back to a neutral seat label as a last resort.
    const claimedName =
      data && data.playerName ? String(data.playerName).trim() : '';
    const storedName =
      spectator.spectatorName && spectator.spectatorName !== SPECTATOR_FALLBACK_NAME
        ? spectator.spectatorName
        : '';
    const playerName = claimedName || storedName || `Player ${seat + 1}`;

    // A spectator never holds the host seat; never allow taking seat 0 / host.
    const occupant = room.getPlayers().find((p) => p.playerIndex === seat);
    if (occupant && occupant.playerId === room.hostPlayerId) {
      return this._swapFail(socket, 'host_seat', 'The host seat can\'t be taken', seat);
    }
    if (occupant) {
      return this._swapFail(socket, 'seat_taken', 'That seat is taken', seat);
    }
    // Guard the synthetic id colliding with an existing seated player (re-claim).
    if (room.getPlayer(playerId)) {
      return this._swapFail(socket, 'not_allowed', 'Already seated');
    }
    const otherRoom = this.gameService.getPlayerRoom(playerId);
    if (otherRoom && otherRoom !== room && !this._canReleasePreviousRoomForSeatClaim(otherRoom, playerId, releasedSeatProof)) {
      return this._swapFail(socket, 'not_allowed', 'You already have a seat in another room');
    }

    // Convert spectator → seated player. Mirror gameService.joinRoom: build a
    // PlayerSession at the requested seat, register the socket→player bindings,
    // then drop the spectator bookkeeping.
    const session = new PlayerSession({
      playerId,
      playerName,
      playerIndex: seat,
      socketId: socket.id,
      isBot: false,
      // Sitting down keeps the profile already announced while watching.
      avatarUrl: data.avatarUrl || data.photoUrl || data.avatar || spectator.avatarUrl || null,
    });
    if (!room.addPlayer(session)) {
      return this._swapFail(socket, 'seat_taken', 'That seat is taken', seat);
    }
    if (otherRoom && otherRoom !== room) {
      const departed = otherRoom.getPlayer(playerId);
      this.gameService.leaveRoom(playerId);
      if (departed) this._broadcastRoomSwitchDeparture(otherRoom, departed);
    }
    // Standalone rooms can still establish their first host by claiming zero.
    if (!room.hostPlayerId && !room.backendManaged && seat === 0) {
      room.hostPlayerId = playerId;
    }
    this.gameService.playerToRoom.set(playerId, room.roomId);
    this.gameService.socketToPlayer.set(socket.id, playerId);
    this._removeSpectatorBySocket(socket.id);
    this._broadcastSpectatorsChanged(room.roomId);

    this._clearPendingFor(room, playerId);
    // A just-filled seat drops any stale invite that targeted it, AND any invite
    // that was addressed to the now-seated spectator (else the inviter's single
    // outgoing-invite slot stays consumed until the 15s TTL expires on nobody).
    this._clearInvitesForSeat(room, seat);
    this._clearInvitesFor(room, playerId);
    logger.info(`[CLAIM_SEAT] spectator ${playerId} seated -> ${seat}`);
    this._broadcastSeatChanged(room);
  }

  /**
   * Ask the player at targetSeat to swap with the requester. Relayed to the
   * target only; the target answers with respond_swap.
   * @param {Socket} socket
   * @param {Object} data { targetPlayerId, targetSeat, fromSeat }
   */
  handleRequestSwap(socket, data = {}) {
    const requesterId = this.gameService.getPlayerIdBySocket(socket.id);
    if (!requesterId) return;
    const room = this.gameService.getPlayerRoom(requesterId);
    if (!room) return this._swapFail(socket, 'not_allowed', 'Room not found');
    if (this._seatsLocked(room)) {
      return this._swapFail(socket, 'not_allowed', 'Game already started');
    }

    const targetPlayerId = data.targetPlayerId != null ? String(data.targetPlayerId) : null;
    const targetSeat = Number(data.targetSeat);
    const requester = room.getPlayer(requesterId);
    if (!this._socketOwnsSeat(socket, requester) || !targetPlayerId) {
      return this._swapFail(socket, 'not_allowed', 'Invalid swap request');
    }
    if (targetPlayerId === requesterId) return; // can't swap with yourself

    // Host is fixed: neither side may be the host.
    if (room.hostPlayerId === requesterId || room.hostPlayerId === targetPlayerId ||
        requester.playerIndex === 0 || targetSeat === 0) {
      return this._swapFail(socket, 'host_seat', 'The host seat can\'t be swapped');
    }

    const target = room.getPlayer(targetPlayerId);
    if (!target || (Number.isInteger(targetSeat) && target.playerIndex !== targetSeat)) {
      return this._swapFail(socket, 'seat_taken', 'That seat just changed', targetSeat);
    }
    if (target.playerIndex === 0) {
      return this._swapFail(socket, 'host_seat', 'The host seat can\'t be swapped');
    }
    if (target.isBot) {
      return this._swapFail(socket, 'not_allowed', 'Can\'t swap with a bot');
    }

    // One request in flight per requester AND per target.
    const pend = this._roomPending(room);
    for (const entry of pend.values()) {
      if (entry.requesterId === requesterId) {
        return this._swapFail(socket, 'target_busy', 'You already have a pending request');
      }
    }
    if (pend.has(targetPlayerId)) {
      return this._swapFail(socket, 'target_busy', 'That player is handling another request');
    }

    const targetSocket = this._socketFor(target);
    if (!targetSocket) {
      return this._swapFail(socket, 'not_allowed', 'That player is offline');
    }

    const expiresInMs = 15000;
    const timeout = setTimeout(() => this._expireSwap(room, targetPlayerId), expiresInMs);
    pend.set(targetPlayerId, {
      requesterId,
      requesterSeat: requester.playerIndex,
      targetSeat: target.playerIndex,
      timeout,
    });

    logger.info(`[REQUEST_SWAP] ${requesterId} -> ${targetPlayerId} (seats ${requester.playerIndex}<->${target.playerIndex})`);
    targetSocket.emit('swap_requested', {
      requesterId,
      requesterName: requester.playerName,
      requesterSeat: requester.playerIndex,
      targetSeat: target.playerIndex,
      expiresInMs,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Target answers a pending swap. On accept the two seats are swapped
   * atomically and the new roster is broadcast.
   * @param {Socket} socket
   * @param {Object} data { requesterId, requesterSeat, accept }
   */
  handleRespondSwap(socket, data = {}) {
    const targetId = this.gameService.getPlayerIdBySocket(socket.id);
    if (!targetId) return;
    const room = this.gameService.getPlayerRoom(targetId);
    if (!room) return;
    const target = room.getPlayer(targetId);
    if (!this._socketOwnsSeat(socket, target)) return;

    const pend = this._roomPending(room);
    const pending = pend.get(targetId);
    // Idempotent: no pending → stale/duplicate/expired answer, ignore.
    if (!pending) return;
    const requesterId = data.requesterId != null ? String(data.requesterId) : pending.requesterId;
    if (requesterId !== pending.requesterId) return;

    this._clearPending(room, targetId);

    const requester = room.getPlayer(pending.requesterId);
    const reqSocket = this._socketFor(requester);

    const respond = (accept, reason) => {
      if (!reqSocket) return;
      reqSocket.emit('swap_responded', {
        accept,
        requesterId: pending.requesterId,
        requesterSeat: requester ? requester.playerIndex : pending.requesterSeat,
        targetId,
        targetName: target ? target.playerName : undefined,
        targetSeat: target ? target.playerIndex : pending.targetSeat,
        reason,
        timestamp: new Date().toISOString(),
      });
    };

    if (data.accept !== true) {
      respond(false, 'declined');
      return;
    }

    // Re-validate before the swap: seats unchanged, still waiting, neither host.
    if (
      !requester ||
      !target ||
      this._seatsLocked(room) ||
      requester.playerIndex !== pending.requesterSeat ||
      target.playerIndex !== pending.targetSeat ||
      room.hostPlayerId === requester.playerId ||
      room.hostPlayerId === target.playerId ||
      requester.playerIndex === 0 || target.playerIndex === 0
    ) {
      respond(false, 'seat_taken');
      this._swapFail(socket, 'seat_taken', 'That seat just changed');
      return;
    }

    const tmp = requester.playerIndex;
    requester.playerIndex = target.playerIndex;
    target.playerIndex = tmp;
    logger.info(`[SWAP] ${requester.playerId}@${requester.playerIndex} <-> ${target.playerId}@${target.playerIndex}`);

    respond(true);
    this._broadcastSeatChanged(room);
  }

  /**
   * Requester withdraws a pending swap (also fired by the client on its 15s
   * timeout). Tells the target to drop its dialog.
   * @param {Socket} socket
   * @param {Object} data { targetPlayerId }
   */
  handleCancelSwap(socket, data = {}) {
    const requesterId = this.gameService.getPlayerIdBySocket(socket.id);
    if (!requesterId) return;
    const room = this.gameService.getPlayerRoom(requesterId);
    if (!room) return;
    if (!this._socketOwnsSeat(socket, room.getPlayer(requesterId))) return;

    const pend = this._roomPending(room);
    let targetPlayerId = data.targetPlayerId != null ? String(data.targetPlayerId) : null;
    let entry = targetPlayerId ? pend.get(targetPlayerId) : null;
    // Fall back to finding the pending by requester if the id didn't match.
    if (!entry || entry.requesterId !== requesterId) {
      targetPlayerId = null;
      for (const [tid, e] of pend.entries()) {
        if (e.requesterId === requesterId) {
          targetPlayerId = tid;
          entry = e;
          break;
        }
      }
    }
    if (!targetPlayerId || !entry) return;

    this._clearPending(room, targetPlayerId);
    const target = room.getPlayer(targetPlayerId);
    const tgtSocket = this._socketFor(target);
    if (tgtSocket) {
      tgtSocket.emit('swap_failed', {
        reason: 'cancelled',
        message: 'Swap request cancelled',
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ────────────────────────────── seat invites ──────────────────────────────

  /** Per-room pending seat invites keyed by spectatorId. */
  _roomInvites(room) {
    if (!room._pendingInvites) room._pendingInvites = new Map();
    return room._pendingInvites;
  }

  /**
   * Resolve the socket of a spectator (by spectatorId) currently watching room.
   * @returns {{socketId:string, spectator:{spectatorId:string,spectatorName:string}}|null}
   */
  _spectatorBySpectatorId(roomId, spectatorId) {
    const spectators = this._getRoomSpectators(roomId);
    for (const [socketId, spectator] of spectators.entries()) {
      if (spectator.spectatorId === spectatorId) {
        return { socketId, spectator };
      }
    }
    return null;
  }

  /** Find the spectatorId of the spectator owning [socketId] in [roomId]. */
  _spectatorIdBySocket(roomId, socketId) {
    const spectators = this.roomSpectators.get(roomId);
    if (!spectators) return null;
    const spectator = spectators.get(socketId);
    return spectator ? spectator.spectatorId : null;
  }

  /**
   * Drop any pending seat invite where [id] is the inviter OR the spectator,
   * notifying the surviving party. Mirrors _clearPendingFor for swaps.
   * @param {Object} room
   * @param {string} id playerId (inviter) or spectatorId
   */
  _clearInvitesFor(room, id) {
    const invites = this._roomInvites(room);
    for (const [spectatorId, entry] of [...invites.entries()]) {
      if (spectatorId === id) {
        // The spectator left: notify the inviter their invite is void.
        clearTimeout(entry.timeout);
        invites.delete(spectatorId);
        const inviter = room.getPlayer(entry.inviterId);
        const inviterSocket = this._socketFor(inviter);
        if (inviterSocket) {
          inviterSocket.emit('seat_invite_responded', {
            accept: false,
            spectatorId,
            seat: entry.seat,
            reason: 'cancelled',
            timestamp: new Date().toISOString(),
          });
        }
      } else if (entry.inviterId === id) {
        // The inviter left: notify the spectator their invite is void.
        clearTimeout(entry.timeout);
        invites.delete(spectatorId);
        const found = this._spectatorBySpectatorId(room.roomId, spectatorId);
        const specSocket = found ? this.io.sockets.sockets.get(found.socketId) : null;
        if (specSocket) {
          specSocket.emit('seat_invite_cancelled', {
            seat: entry.seat,
            reason: 'cancelled',
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  }

  /**
   * Drop any pending seat invite that targets [seat] (the seat was just
   * filled), notifying the affected spectator their invite is void.
   * @param {Object} room
   * @param {number} seat
   */
  _clearInvitesForSeat(room, seat) {
    const invites = this._roomInvites(room);
    for (const [spectatorId, entry] of [...invites.entries()]) {
      if (entry.seat !== seat) continue;
      clearTimeout(entry.timeout);
      invites.delete(spectatorId);
      const found = this._spectatorBySpectatorId(room.roomId, spectatorId);
      const specSocket = found ? this.io.sockets.sockets.get(found.socketId) : null;
      if (specSocket) {
        specSocket.emit('seat_invite_cancelled', {
          seat,
          reason: 'seat_taken',
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /** A pending invite expired: drop it and notify both parties. */
  _expireInvite(room, spectatorId) {
    const invites = this._roomInvites(room);
    const entry = invites.get(spectatorId);
    if (!entry) return;
    invites.delete(spectatorId);

    const inviter = room.getPlayer(entry.inviterId);
    const inviterSocket = this._socketFor(inviter);
    if (inviterSocket) {
      inviterSocket.emit('seat_invite_responded', {
        accept: false,
        spectatorId,
        seat: entry.seat,
        reason: 'expired',
        timestamp: new Date().toISOString(),
      });
    }
    const found = this._spectatorBySpectatorId(room.roomId, spectatorId);
    const specSocket = found ? this.io.sockets.sockets.get(found.socketId) : null;
    if (specSocket) {
      specSocket.emit('seat_invite_cancelled', {
        seat: entry.seat,
        reason: 'expired',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * A seated player/host invites a spectator into an empty (non-host) seat.
   * Coordination only — the spectator's client performs the actual seating via
   * claim_seat (handleClaimSeat Path B).
   * @param {Socket} socket
   * @param {Object} data { spectatorId, seat }
   */
  handleInviteToSeat(socket, data = {}) {
    const inviterId = this.gameService.getPlayerIdBySocket(socket.id);
    if (!inviterId) return this._swapFail(socket, 'not_allowed');
    const room = this.gameService.getPlayerRoom(inviterId);
    if (!room) return this._swapFail(socket, 'not_allowed', 'Room not found');

    const inviter = room.getPlayer(inviterId);
    if (!this._socketOwnsSeat(socket, inviter)) return this._swapFail(socket, 'not_allowed');
    if (this._seatsLocked(room)) {
      return this._swapFail(socket, 'not_allowed', 'Game already started');
    }

    const seat = Number(data.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.maxPlayers) {
      return this._swapFail(socket, 'seat_taken', 'Invalid seat', seat);
    }
    // The host seat is fixed and can never be the invite target.
    const occupant = room.getPlayers().find((p) => p.playerIndex === seat);
    if (seat === 0 || (occupant && occupant.playerId === room.hostPlayerId)) {
      return this._swapFail(socket, 'seat_taken', 'The host seat can\'t be taken', seat);
    }
    if (occupant) {
      return this._swapFail(socket, 'seat_taken', 'That seat is taken', seat);
    }

    const spectatorId = data.spectatorId != null ? String(data.spectatorId) : null;
    if (!spectatorId) {
      return this._swapFail(socket, 'not_allowed', 'That player is not in the room');
    }
    const found = this._spectatorBySpectatorId(room.roomId, spectatorId);
    if (!found) {
      return this._swapFail(socket, 'not_allowed', 'That player is not in the room');
    }
    const specSocket = this.io.sockets.sockets.get(found.socketId);
    if (!specSocket) {
      return this._swapFail(socket, 'not_allowed', 'That player is not in the room');
    }

    // One invite in flight per spectator AND one outgoing per inviter.
    const invites = this._roomInvites(room);
    if (invites.has(spectatorId)) {
      return this._swapFail(socket, 'target_busy', 'That player has a pending invite');
    }
    for (const entry of invites.values()) {
      if (entry.inviterId === inviterId) {
        return this._swapFail(socket, 'target_busy', 'You already have a pending invite');
      }
    }

    const expiresInMs = 15000;
    const timeout = setTimeout(() => this._expireInvite(room, spectatorId), expiresInMs);
    invites.set(spectatorId, { inviterId, seat, timeout });

    logger.info(`[SEAT_INVITE] ${inviterId} -> spectator ${spectatorId} (seat ${seat})`);
    specSocket.emit('seat_invite', {
      inviterId,
      inviterName: inviter.playerName,
      seat,
      expiresInMs,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * The spectator answers a seat invite. Coordination only — on accept the
   * spectator's client follows up with claim_seat to actually take the seat.
   * @param {Socket} socket
   * @param {Object} data { inviterId, seat, accept }
   */
  handleRespondSeatInvite(socket, data = {}) {
    const roomId = this.spectatorSocketToRoom.get(socket.id);
    if (!roomId) return;
    const room = this.gameService.getRoom(roomId);
    if (!room) return;
    const spectatorId = this._spectatorIdBySocket(roomId, socket.id);
    if (!spectatorId) return;

    const invites = this._roomInvites(room);
    const pending = invites.get(spectatorId);
    // Idempotent: no pending → stale/duplicate/expired answer, ignore.
    if (!pending) return;
    if ((data.inviterId != null && String(data.inviterId) !== String(pending.inviterId)) ||
        (data.seat != null && Number(data.seat) !== pending.seat)) return;
    invites.delete(spectatorId);
    clearTimeout(pending.timeout);

    const spectatorName = this._spectatorBySpectatorId(roomId, spectatorId)?.spectator.spectatorName;
    const inviter = room.getPlayer(pending.inviterId);
    const inviterSocket = this._socketFor(inviter);

    if (data.accept !== true) {
      if (inviterSocket) {
        inviterSocket.emit('seat_invite_responded', {
          accept: false,
          spectatorId,
          spectatorName,
          seat: pending.seat,
          reason: 'declined',
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    // Re-validate the seat is still claimable before telling the inviter "yes".
    const seat = pending.seat;
    const occupant = room.getPlayers().find((p) => p.playerIndex === seat);
    // Taken if: a match is running (started, or mid round-over intermission),
    // seat now occupied, or (defensively) it is the host seat. An occupant being
    // the host is already covered by `occupant`.
    const seatTaken =
      this._seatsLocked(room) ||
      seat === 0 ||
      !!occupant ||
      (!!occupant && occupant.playerId === room.hostPlayerId);
    if (seatTaken) {
      if (inviterSocket) {
        inviterSocket.emit('seat_invite_responded', {
          accept: false,
          spectatorId,
          spectatorName,
          seat,
          reason: 'seat_taken',
          timestamp: new Date().toISOString(),
        });
      }
      socket.emit('seat_invite_cancelled', {
        seat,
        reason: 'seat_taken',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info(`[SEAT_INVITE] spectator ${spectatorId} accepted seat ${seat} from ${pending.inviterId}`);
    if (inviterSocket) {
      inviterSocket.emit('seat_invite_responded', {
        accept: true,
        spectatorId,
        spectatorName,
        seat,
        timestamp: new Date().toISOString(),
      });
    }
    // NOTE: do NOT seat here — the spectator's client sends claim_seat next.
  }

  /**
   * The inviter withdraws a pending seat invite. Tells the spectator to drop
   * their dialog.
   * @param {Socket} socket
   * @param {Object} data { spectatorId }
   */
  handleCancelSeatInvite(socket, data = {}) {
    const inviterId = this.gameService.getPlayerIdBySocket(socket.id);
    if (!inviterId) return;
    const room = this.gameService.getPlayerRoom(inviterId);
    if (!room) return;
    if (!this._socketOwnsSeat(socket, room.getPlayer(inviterId))) return;

    const invites = this._roomInvites(room);
    let spectatorId = data.spectatorId != null ? String(data.spectatorId) : null;
    let entry = spectatorId ? invites.get(spectatorId) : null;
    // Fall back to finding the pending invite by inviter if the id didn't match.
    if (!entry || entry.inviterId !== inviterId) {
      spectatorId = null;
      for (const [sid, e] of invites.entries()) {
        if (e.inviterId === inviterId) {
          spectatorId = sid;
          entry = e;
          break;
        }
      }
    }
    if (!spectatorId || !entry) return;
    // Only the owning inviter may cancel.
    if (entry.inviterId !== inviterId) return;

    clearTimeout(entry.timeout);
    invites.delete(spectatorId);

    const found = this._spectatorBySpectatorId(room.roomId, spectatorId);
    const specSocket = found ? this.io.sockets.sockets.get(found.socketId) : null;
    if (specSocket) {
      specSocket.emit('seat_invite_cancelled', {
        seat: entry.seat,
        reason: 'cancelled',
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ───────────────────────────── host force-swap ────────────────────────────

  /**
   * Host force-swaps (or moves) two lobby seats with no approval flow. If one
   * seat is empty it is a move; if both are occupied it is a swap. The host's
   * own seat may not be involved. WAITING-phase only.
   * @param {Socket} socket
   * @param {Object} data { seatA, seatB }
   */
  handleHostSwapSeats(socket, data = {}) {
    const callerId = this.gameService.getPlayerIdBySocket(socket.id);
    if (!callerId) return this._swapFail(socket, 'not_allowed', 'Host only');
    const room = this.gameService.getPlayerRoom(callerId);
    if (!room) return this._swapFail(socket, 'not_allowed', 'Room not found');
    if (!this._socketOwnsSeat(socket, room.getPlayer(callerId))) return this._swapFail(socket, 'not_allowed');
    if (room.hostPlayerId !== callerId) {
      return this._swapFail(socket, 'not_allowed', 'Host only');
    }
    if (this._seatsLocked(room)) {
      return this._swapFail(socket, 'not_allowed', 'Game already started');
    }

    const seatA = Number(data.seatA);
    const seatB = Number(data.seatB);
    if (
      !Number.isInteger(seatA) || seatA < 0 || seatA >= room.maxPlayers ||
      !Number.isInteger(seatB) || seatB < 0 || seatB >= room.maxPlayers ||
      seatA === seatB
    ) {
      return this._swapFail(socket, 'not_allowed', 'Invalid seats');
    }

    // Re-read live state right before mutating (single-threaded; keep adjacent).
    const playerA = room.getPlayers().find((p) => p.playerIndex === seatA);
    const playerB = room.getPlayers().find((p) => p.playerIndex === seatB);
    for (const [key, player] of [['expectedPlayerAId', playerA], ['expectedPlayerBId', playerB]]) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      const expected = data[key] == null ? null : String(data[key]);
      const actual = player ? String(player.playerId) : null;
      if (expected !== actual) return this._swapFail(socket, 'seat_taken', 'That seat just changed');
    }

    // The host seat is fixed — neither end may be the host's own seat.
    if (
      seatA === 0 || seatB === 0 ||
      (playerA && playerA.playerId === room.hostPlayerId) ||
      (playerB && playerB.playerId === room.hostPlayerId)
    ) {
      return this._swapFail(socket, 'host_seat', 'The host seat can\'t be moved');
    }
    if (!playerA && !playerB) return; // nothing to move
    for (const player of [playerA, playerB]) {
      if (player) this._clearPendingFor(room, player.playerId);
    }
    this._clearInvitesForSeat(room, seatA);
    this._clearInvitesForSeat(room, seatB);

    if (playerA && playerB) {
      playerA.playerIndex = seatB;
      playerB.playerIndex = seatA;
    } else if (playerA) {
      playerA.playerIndex = seatB; // move into the empty seat
    } else {
      playerB.playerIndex = seatA; // move into the empty seat
    }

    logger.info(`[HOST_SWAP] host ${callerId} swapped seats ${seatA}<->${seatB}`);
    this._broadcastSeatChanged(room);
  }

  /**
   * A seated, NON-host player stands up and becomes a SPECTATOR of the same
   * room (WAITING-phase only). Their seat is freed (room.removePlayer) and the
   * seated socket→player bindings created by claim_seat/join are removed so the
   * spectator has NO entry in gameService.socketToPlayer/playerToRoom — exactly
   * like a join-room spectator (handleJoinRoom never sets socketToPlayer for a
   * spectator). The socket stays in the socket.io room so it keeps receiving
   * state as a viewer.
   * @param {Socket} socket
   */
  handleLeaveSeat(socket, { preserveJoinIntent = false } = {}) {
    if (!preserveJoinIntent) socket._roomJoinEpoch = (socket._roomJoinEpoch || 0) + 1;
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    if (!playerId) {
      const spectatorRoomId = this.spectatorSocketToRoom.get(socket.id);
      const spectators = this.roomSpectators.get(spectatorRoomId);
      const spectator = spectators?.get(socket.id);
      const spectatorRoom = this.gameService.getRoom(spectatorRoomId);
      if (spectator && spectatorRoom && !this._seatsLocked(spectatorRoom)) {
        // REST stand-up can finish while claim_seat is awaiting its snapshot.
        // Replace the registration to cancel that older intent, while keeping
        // the viewer in the room. The pending claim releases only its version.
        spectators.set(socket.id, { ...spectator });
        this._broadcastSeatChanged(spectatorRoom);
        return;
      }
    }
    const room = this.gameService.getPlayerRoom(playerId);
    if (!room) return this._swapFail(socket, 'not_allowed', 'Room not found');
    if (this._seatsLocked(room)) {
      return this._swapFail(socket, 'not_allowed', 'Game already started');
    }

    // Re-read live state right before mutating (single-threaded; keep adjacent).
    const player = room.getPlayer(playerId);
    if (!this._socketOwnsSeat(socket, player)) return;
    if (playerId === room.hostPlayerId) {
      return this._swapFail(socket, 'host_seat', 'The host can\'t leave their seat');
    }

    const playerName = player.playerName;
    // Captured BEFORE removePlayer wipes the session: a spectator roster with a
    // name and no face is the reported "it just says Spectator" — the seat knew
    // exactly who this is, and dropping it here was the only reason the roster
    // did not.
    const playerAvatar = player.avatarUrl || null;
    const fromSeat = player.playerIndex;

    // Free the seat and remove the seated socket→player bindings (the inverse of
    // what claim-seat/join created). A spectator has NO gameService mapping.
    room.removePlayer(playerId);
    this.gameService.playerToRoom.delete(playerId);
    this.gameService.socketToPlayer.delete(socket.id);

    // Register them as a spectator of the same room.
    this._addSpectator(socket, room.roomId, playerId, playerName, playerAvatar);
    this._broadcastSpectatorsChanged(room.roomId);

    // Their seat is gone — void any pending swap/invite that involved them.
    this._clearPendingFor(room, playerId);
    this._clearInvitesFor(room, playerId);

    logger.info(`[LEAVE_SEAT] ${playerId} left seat ${fromSeat} -> spectator of ${room.roomId}`);
    this._broadcastSeatChanged(room);
  }

  /**
   * Host forces another participant out of their seat or out of the room
   * (WAITING-phase only). With { toSpectator:true } a SEATED target is moved to
   * the spectator pool of the same room; with { toSpectator:false } the target
   * (seated OR spectator) is removed from the room entirely. The host can never
   * be kicked. The target's socket is told via a 'kicked' event.
   * @param {Socket} socket
   * @param {Object} data { targetId, toSpectator }
   */
  handleHostKick(socket, data = {}) {
    const caller = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(caller);
    if (!room) return this._swapFail(socket, 'not_allowed', 'Host only');
    if (!this._socketOwnsSeat(socket, room.getPlayer(caller))) return this._swapFail(socket, 'not_allowed', 'Host only');
    if (room.hostPlayerId !== caller) {
      return this._swapFail(socket, 'not_allowed', 'Host only');
    }
    if (this._seatsLocked(room)) {
      return this._swapFail(socket, 'not_allowed', 'Game already started');
    }

    const targetId = String(data.targetId);
    if (targetId === room.hostPlayerId) {
      return this._swapFail(socket, 'not_allowed', 'The host can\'t be kicked');
    }
    const toSpectator = data.toSpectator === true;
    const timestamp = new Date().toISOString();

    // ── Move a seated target into the spectator pool of the same room. ──
    if (toSpectator) {
      // Re-read live state right before mutating (single-threaded; keep adjacent).
      const target = room.getPlayer(targetId);
      if (!target) {
        return this._swapFail(socket, 'not_allowed', 'That player is not in the room');
      }
      const targetName = target.playerName;
      const targetAvatar = target.avatarUrl || null; // same reason as above
      const fromSeat = target.playerIndex;
      // Resolve the target's live socket from the seated session BEFORE removal.
      const targetSocketId = target.socketId;
      const targetSocket = targetSocketId
        ? this.io.sockets.sockets.get(targetSocketId)
        : null;

      // Free the seat and remove the seated socket→player bindings.
      room.removePlayer(targetId);
      this.gameService.playerToRoom.delete(targetId);
      if (targetSocketId) this.gameService.socketToPlayer.delete(targetSocketId);

      // Register them as a spectator of the same room (needs a live socket).
      if (targetSocket) {
        this._addSpectator(targetSocket, room.roomId, targetId, targetName, targetAvatar);
        this._broadcastSpectatorsChanged(room.roomId);
      }

      this._clearPendingFor(room, targetId);
      this._clearInvitesFor(room, targetId);

      if (targetSocket) {
        targetSocket.emit('kicked', { toSpectator: true, reason: 'host', timestamp });
      }
      logger.info(`[HOST_KICK] host ${caller} moved ${targetId} (seat ${fromSeat}) to spectator of ${room.roomId}`);
      this._broadcastSeatChanged(room);
      return;
    }

    // ── Remove the target from the room entirely (seated OR spectator). ──
    // Re-read live state right before mutating (single-threaded; keep adjacent).
    const seatedTarget = room.getPlayer(targetId);
    let targetSocketId = null;

    if (seatedTarget) {
      targetSocketId = seatedTarget.socketId;
      room.removePlayer(targetId);
      this.gameService.playerToRoom.delete(targetId);
      if (targetSocketId) this.gameService.socketToPlayer.delete(targetSocketId);
    } else {
      const found = this._spectatorBySpectatorId(room.roomId, targetId);
      if (!found) {
        return this._swapFail(socket, 'not_allowed', 'That player is not in the room');
      }
      targetSocketId = found.socketId;
      this._removeSpectatorBySocket(targetSocketId);
      this._broadcastSpectatorsChanged(room.roomId);
    }

    this._clearPendingFor(room, targetId);
    this._clearInvitesFor(room, targetId);

    const targetSocket = targetSocketId
      ? this.io.sockets.sockets.get(targetSocketId)
      : null;
    if (targetSocket) {
      targetSocket.emit('kicked', { toSpectator: false, reason: 'host', timestamp });
      targetSocket.leave(room.roomId);
    }
    logger.info(`[HOST_KICK] host ${caller} removed ${targetId} from room ${room.roomId}`);
    this._broadcastSeatChanged(room);
  }

  /**
   * Handle get game state request
   * @param {Socket} socket
   * @param {Object} data
   */
  handleGetGameState(socket, data) {
    // ORDERING GUARD. The client emits `join_room` and then `get_game_state`
    // synchronously, in that order, precisely so the seat is re-bound before the
    // snapshot is asked for. That order survives the wire but NOT the server:
    // `handleJoinRoom` is async and awaits Redis, and Socket.IO delivers the next
    // packet during those awaits — so the state request runs first anyway, while
    // `player.socketId` is still the OLD id (or null, if the disconnect already
    // entered grace). `_assertSocketCanViewPlayerState` then refuses an
    // unauthenticated socket outright, and the returning player gets
    // "Unauthorized player state" plus no snapshot at all — which, on the client,
    // is also silence for its resume probe.
    //
    // This is visible in the production log as the join and the state request
    // interleaving:
    //   16:53:29.324 Player 7 requesting to join room BRC-Z573M
    //   16:53:29.326 [GET_GAME_STATE] ...
    //   16:53:29.330 [FailureManager] Reconnection successful: 7 (6ms)
    //
    // So: if this socket has a join in flight, answer AFTER it lands. The
    // function stays synchronous when there is no pending join, which is every
    // path a test drives directly.
    const pendingJoin = this._pendingJoins.get(socket.id);
    if (pendingJoin) {
      let capHandle = null;
      const capped = Promise.race([
        pendingJoin,
        new Promise((resolve) => {
          capHandle = setTimeout(resolve, SocketHandlers.JOIN_WAIT_CAP_MS);
          capHandle.unref?.();
        }),
      ]);
      capped
        .then(() => {
          if (capHandle) clearTimeout(capHandle);
          return this._respondWithGameState(socket, data);
        })
        .catch((error) => {
          // The deferred path has no ErrorHandler.wrap frame around it any more,
          // so it owns its own failure or it becomes an unhandled rejection.
          if (capHandle) clearTimeout(capHandle);
          logger.error(`[GET_GAME_STATE] deferred response failed: ${error.message}`, error);
          socket.emit(
            SocketEvents.ERROR,
            ErrorHandler.createErrorResponse('Failed to load game state')
          );
        });
      return;
    }
    return this._respondWithGameState(socket, data);
  }

  /**
   * The body of {@link handleGetGameState}, split out so the ordering guard can
   * defer it behind an in-flight join.
   * @param {Socket} socket
   * @param {Object} data
   */
  _respondWithGameState(socket, data) {
    const { gameId, playerId } = data;

    logger.info(`[GET_GAME_STATE] Player ${playerId} requesting state for game ${gameId}`);

    if (!gameId || !playerId) {
      logger.warn('[GET_GAME_STATE] ✗ Missing gameId or playerId');
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('gameId and playerId required')
      );
      return;
    }

    const room = this.gameService.getRoom(gameId);
    if (!room) {
      logger.warn(`[GET_GAME_STATE] ✗ Room ${gameId} not found`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Room not found'));
      return;
    }

    const player = room.getPlayer(playerId);
    if (!player) {
      const spectatorRoomId = this.spectatorSocketToRoom.get(socket.id);
      const isOwnerController =
        room.ownerControllerSocketId === socket.id ||
        (room.ownerControllerPlayerId === playerId && !!room.replacedHostBotId);
      const canViewAsSpectator =
        spectatorRoomId === room.roomId || isOwnerController;

      if (canViewAsSpectator) {
        socket.join(room.roomId);
        // Whoever is watching already has a name and a face — from what this
        // request carries, else from the record their join established. Passing
        // the placeholder here is what used to rename them mid-session.
        const viewer = this._resolveSpectatorIdentity(socket, room.roomId, data);
        this._addSpectator(
          socket,
          room.roomId,
          playerId || room.ownerControllerPlayerId || `spectator_${socket.id}`,
          viewer.name,
          viewer.avatarUrl
        );
        this._broadcastSpectatorsChanged(room.roomId);

        if (room.hasEnded && room.hasEnded() && room.lastRoundEndPayload) {
          logger.info(
            `[GET_GAME_STATE] Room ${gameId} finished — re-sending final result to spectator ${playerId}`
          );
          socket.emit(SocketEvents.GAME_ENDED, this._roundEndReplayPayload(room));
          return;
        }

        logger.info(
          `[GET_GAME_STATE] Sending spectator state to owner/spectator ${playerId} for room ${gameId}`
        );
        this._sendStateToSpectator(socket, room, playerId, viewer.name, {
          includeGameStarted: true,
        });
        return;
      }

      logger.warn(`[GET_GAME_STATE] ✗ Player ${playerId} not in room ${gameId}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Player not in room'));
      return;
    }

    if (!this._assertSocketCanViewPlayerState(socket, player)) {
      logger.warn(
        `[GET_GAME_STATE] ✗ Socket ${socket.id} attempted to view player ${playerId} hand`
      );
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Unauthorized player state'));
      return;
    }

    // The round already ended (e.g. this client briefly disconnected and missed
    // the GAME_ENDED broadcast). Re-deliver the stored final result instead of
    // resuming play, so the player isn't stuck on a frozen table with no scores.
    if (room.hasEnded && room.hasEnded() && room.lastRoundEndPayload) {
      logger.info(
        `[GET_GAME_STATE] Room ${gameId} finished — re-sending final result to ${playerId}`
      );
      socket.emit(SocketEvents.GAME_ENDED, this._roundEndReplayPayload(room));
      return;
    }

    logger.info(
      `[GET_GAME_STATE] ✓ Sending game state to ${playerId}. Current turn: ${room.currentTurn}, Phase: playing, Deck: ${room.deck?.count || 0}, cardsDealt=${room.cardsDealt}`
    );

    // A reconnect asks for state in the lobby too. Seated mobile clients enter
    // the board on GAME_STARTED, even with cardsDealt=false, so sending that
    // event for WAITING rooms opens an empty board before the host can start.
    // Keep the full snapshot below for the client's connection watchdog, and
    // replay the lobby event it actually consumes for seat/start readiness.
    if (room.status === GameRoomStatus.WAITING && !room.cardsDealt) {
      socket.emit(SocketEvents.PLAYER_JOINED, this._lobbyPlayersPayload(room, player));
    } else {
      socket.emit(SocketEvents.GAME_STARTED, {
        ...this._serializeRoomGameSettings(room),
        players: room.getPlayers().map((p) => this._serializePlayer(p)),
        yourPlayerIndex: player.playerIndex,
        currentPlayerIndex: this._announcedTurnIndex(room),
        ruleset: room.ruleset,
        professionalWellMode: room.professionalWellMode,
        hostId: room.hostPlayerId || null,
        turnTimeLimitSeconds: room.turnTimeLimit,
        timestamp: new Date().toISOString(),
        cardsDealt: room.cardsDealt || false,
      });
    }

    // Then send current game state
    const yourHand = room.playerHands.get(playerId) || [];
    const otherPlayersHandCounts = {};
    room.getPlayers().forEach((p) => {
      const hand = room.playerHands.get(p.playerId) || [];
      otherPlayersHandCounts[p.playerIndex] = hand.length;
    });

    const playerMelds = {};
    room.getPlayers().forEach((p) => {
      playerMelds[p.playerIndex] = room.playerMelds.get(p.playerId) || [];
    });
    const playerMeldOrders = this._serializePlayerMeldOrders(room);

    // Get player scores
    const deadPileCounts = Array.isArray(room.deadPiles)
      ? room.deadPiles.map((pile) => (Array.isArray(pile) ? pile.length : 0))
      : [];
    const pozzettosAvailable = deadPileCounts.some((count) => count > 0);
    const pozzettosCardCount = deadPileCounts.reduce((sum, count) => sum + count, 0);

    socket.emit(SocketEvents.GAME_STATE_UPDATE, {
      ...this._serializeRoomGameSettings(room),
      yourPlayerIndex: player.playerIndex,
      currentPlayerIndex: room.currentTurn,
      phase: 'playing',
      // Full seat+bot roster so a resyncing client always has the player list
      // (PTW-233).
      players: room.getPlayers().map((p) => this._serializePlayer(p)),
      ruleset: room.ruleset,
      professionalWellMode: room.professionalWellMode,
      turnTimeLimit: room.turnTimeLimit,
      turnTimeLimitSeconds: room.turnTimeLimit,
      yourHand: yourHand.map((card) => this._serializeCard(card)),
      otherPlayersHandCounts, // Keep for backward compatibility
      discardPile: room.discardPile.map((card) => this._serializeCard(card)),
      deckCount: room.deck?.count || 0,
      pozzettosAvailable,
      pozzettosCardCount,
      deadPileCounts,
      // Across-the-table well takes this round. Informational for the clients'
      // HUD (no rule gates on it), and it cannot be derived from deadPileCounts
      // (a stock promotion also consumes a pile without anyone taking it).
      wellsTakenThisRound: room.wellsTakenThisRound || 0,
      playerMelds,
      playerMeldOrders,
      hasDrawnCard: room.hasDrawnCard,
      // The FULL discard-restriction set, exactly as _sendInitialGameState sends
      // it. The client REPLACES its local restriction state from whatever this
      // builder carries, so an omitted key here does not mean "unchanged" — it
      // means "cleared". Leaving these three out let a client that reconnected
      // mid-turn offer a discard the server then rejected, which is a hung turn:
      // take a one-card pile of K♥ while already holding the other deck's K♥,
      // reconnect, and the rebuilt client saw NEITHER K♥ as restricted while the
      // server still restricted the taken one. The anti ping-pong lock below
      // does not cover the gap — its escape hatch opens precisely when every
      // other card shares the locked rank+suit, which is that same hand.
      mustMeldCard: room.mustMeldCard ? this._serializeCard(room.mustMeldCard) : null,
      drawnCardRestriction: Array.from(room.drawnCardThisTurnRestriction || []),
      meldedThisTurn: room.meldedThisTurn || false,
      // ANTI PING-PONG lock for THIS recipient. This is the RECONNECT builder —
      // a client that restarted holds no local lock, so leaving the field out
      // here would let it offer a discard the server then rejects: a hung turn.
      discardLock: this._serializeDiscardLock(room, playerId),
      // NO `playerScores` here. GameRoom.getPlayerScores() returns
      // room.lastRoundScores — the PREVIOUS round's per-seat BREAKDOWN OBJECTS,
      // which startGame() never clears — while the client types the field as
      // Map<int,int> and coerces anything non-numeric to 0. Shipping it on a
      // live state frame therefore zeroed every seat's score on every frame
      // from round 2 onward. The authoritative per-seat breakdown belongs on
      // the round-end / GAME_ENDED payload, and an ABSENT key is read as "the
      // server said nothing", which is exactly right here.
      // The three fields this builder used to omit, all of which a reconnecting
      // client needs and none of which it can derive:
      //   turnTimeRemaining — without it there is nothing to re-anchor the
      //     countdown to (the client only anchors on a positive value);
      //   melds — the per-meld isBuraco/clean verdicts, including the PRO
      //     sticky-dirty flag, which is server-only state;
      //   skins — cosmetics the client would otherwise keep from before the
      //     drop, or never learn on a cold resync.
      turnTimeRemaining: room.getTurnTimeRemaining(),
      melds: room.serializeMelds(),
      ...this._skinsPayloadFields(room),
      cardsDealt: room.cardsDealt || false,
      hostId: room.hostPlayerId || null,
      // Carry the first-turn "undian" result here too: clients commonly catch up
      // via get_game_state right after entering the game screen, and that response
      // (not the deal broadcast) is what triggers their deal animation. Without
      // these the reveal never plays. Cleared once the first turn starts, so a
      // mid-game resync sees null and does not replay it.
      turnDirection: room.turnDirection || 1,
      firstTurnDraw: room.firstTurnDraw || null,
      // Lets the client tell a fresh opening deal (animate deal + undian) apart
      // from a resume/reconnect (snap to state, no replay). True only in the
      // opening window; false once the first turn has started.
      awaitingDealAnimation: !!room.awaitingDealAnimation,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Resolve the room + sender identity for a chat request, handling both seated
   * players and spectators. Returns null when the socket isn't attached to a room.
   * @param {Socket} socket
   * @param {Object} data
   * @returns {{room: GameRoom, playerId: string, playerIndex: number, playerName: string}|null}
   */
  _resolveChatContext(socket, data = {}) {
    // Seated player: resolve identity ONLY from the server-side socket→player
    // binding (never from the client payload), so a spectator cannot pass a
    // seated player's id/name and impersonate them.
    const mappedPlayerId = this.gameService.getPlayerIdBySocket(socket.id);
    if (mappedPlayerId) {
      const room = this.gameService.getPlayerRoom(mappedPlayerId);
      if (room) {
        const player = room.getPlayer(mappedPlayerId);
        if (player) {
          return {
            room,
            playerId: mappedPlayerId,
            playerIndex: player.playerIndex,
            playerName: player.playerName || 'Player',
          };
        }
      }
    }

    // Spectator: not seated (index -1). Name can only come from the client/spectator
    // session since there is no authoritative seat to read it from.
    const spectatorRoomId = this.spectatorSocketToRoom.get(socket.id);
    if (spectatorRoomId) {
      const room = this.gameService.getRoom(spectatorRoomId);
      if (room) {
        const spectators = this.roomSpectators.get(spectatorRoomId);
        const spectator = spectators ? spectators.get(socket.id) : null;
        return {
          room,
          playerId:
            (spectator && spectator.spectatorId) ||
            data.playerId ||
            `spectator_${socket.id}`,
          playerIndex: -1,
          playerName:
            this._sanitizeChatText(data.playerName, 32) ||
            (spectator && spectator.spectatorName) ||
            SPECTATOR_FALLBACK_NAME,
        };
      }
    }

    return null;
  }

  /**
   * Trim, collapse and bound a piece of user chat text. Strips control characters
   * and caps the length so a single message can't bloat the backlog or payload.
   * @param {*} raw
   * @param {number} [maxLen=200]
   * @returns {string}
   */
  _sanitizeChatText(raw, maxLen = 200) {
    if (raw === null || raw === undefined) return '';
    let text = String(raw);
    // Replace control chars (incl. newlines) with a space, then collapse runs of
    // whitespace so chat stays single-line and tidy.
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\x00-\x1F\x7F]/g, ' ');
    text = text.replace(/\s{2,}/g, ' ').trim();
    if (text.length > maxLen) text = text.slice(0, maxLen).trim();
    return text;
  }

  /**
   * Handle an incoming chat message: validate, throttle, persist to the room
   * backlog and broadcast to everyone in the room (sender included, so its own
   * message renders from the authoritative payload).
   * @param {Socket} socket
   * @param {Object} data { text, kind?, playerName? }
   */
  handleChatMessage(socket, data = {}) {
    const text = this._sanitizeChatText(data.text);
    if (!text) return; // empty / whitespace-only — ignore silently

    // Light per-socket throttle (independent of the game action rate limiter).
    const now = Date.now();
    const last = this._lastChatAt.get(socket.id) || 0;
    if (now - last < 600) return; // drop, don't error — chat spam is harmless
    this._lastChatAt.set(socket.id, now);

    const ctx = this._resolveChatContext(socket, data);
    if (!ctx) return; // socket not attached to any room

    const { room } = ctx;
    // chatEnabled toggle: when the room has chat turned off, swallow the message
    // (no persist, no broadcast) so disabling chat at room creation is honored.
    if (room.chatEnabled === false) return;
    const kind = data.kind === 'emote' ? 'emote' : 'text';

    const message = {
      type: 'chat_message',
      messageId: `${room.roomId}:${(room.chatSeq += 1)}`,
      roomId: room.roomId,
      playerId: ctx.playerId,
      playerIndex: ctx.playerIndex,
      playerName: ctx.playerName,
      text,
      kind,
      timestamp: new Date().toISOString(),
    };

    room.addChatMessage(message);
    this.io.to(room.roomId).emit(SocketEvents.CHAT_MESSAGE, message);
  }

  /**
   * Re-deliver the chat backlog to a single requesting socket (used on join and
   * reconnect so the conversation isn't lost). No-op if the socket isn't in a room.
   * @param {Socket} socket
   * @param {Object} data
   */
  handleGetChatHistory(socket, data = {}) {
    const ctx = this._resolveChatContext(socket, data);
    if (!ctx) {
      socket.emit(SocketEvents.CHAT_HISTORY, { messages: [] });
      return;
    }
    socket.emit(SocketEvents.CHAT_HISTORY, {
      messages: ctx.room.getChatHistory(),
    });
  }

  /**
   * Handle disconnect event
   * @param {Socket} socket
   */
  async handleDisconnect(socket, reason = 'unknown') {
    this._lastChatAt.delete(socket.id);
    this._pendingJoins.delete(socket.id);
    // RESTART DRAIN. io.close() fires this for every socket at once, and each
    // one used to run the full player-disconnect path: grace entered, seat
    // socketId nulled, player_disconnected broadcast to sockets being closed,
    // a `player.status: disconnected` webhook queued for the backend, and a
    // state persist racing the Redis quit a few lines later (it lost — the
    // grace marker landed but the snapshot did not; had it won AFTER
    // disposeTimers() it would have written awaitingNextRound=false and lost
    // an intermission match). None of that is a player action. The seats stay
    // exactly as the final snapshot captured them; the next boot re-derives
    // every human seat as "awaiting reconnect" (resumePersistedRooms).
    if (this.restartDraining) {
      this.matchmakingQueue?.removeBySocketId(socket.id);
      this.gameService.removeSocket(socket.id);
      return;
    }
    // P1-11: a player waiting in matchmaking has no room/player mapping, so the
    // `if (!playerId) return` below would leak their queue entry forever. Remove
    // by socket id before that early return.
    this.matchmakingQueue?.removeBySocketId(socket.id);
    // Void any pending seat invite to this spectator before we drop them.
    const preDisconnectRoomId = this.spectatorSocketToRoom.get(socket.id);
    if (preDisconnectRoomId) {
      const specRoom = this.gameService.getRoom(preDisconnectRoomId);
      const specId = this._spectatorIdBySocket(preDisconnectRoomId, socket.id);
      if (specRoom && specId) this._clearInvitesFor(specRoom, specId);
    }
    const spectatorRoomId = this._removeSpectatorBySocket(socket.id);
    if (spectatorRoomId) {
      this._broadcastSpectatorsChanged(spectatorRoomId);
      logger.info(
        `[DISCONNECT] Spectator socket ${socket.id} disconnected from room ${spectatorRoomId}`
      );
    }

    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    logger.info(
      `[DISCONNECT] Socket ${socket.id} disconnected${playerId ? ` (player: ${playerId})` : ''} reason=${reason}`
    );

    if (!playerId) return;

    const room = this.gameService.getPlayerRoom(playerId);
    if (room) {
      // Void any lobby swap this player was part of so a partner isn't stuck
      // waiting on a socket that's gone.
      this._clearPendingFor(room, playerId);
      // Void any seat invite this player issued.
      this._clearInvitesFor(room, playerId);
      const player = room.getPlayer(playerId);
      logger.info(
        `[DISCONNECT] Player ${playerId} (index: ${player?.playerIndex}) was in room ${room.roomId} (${room.players.size} players)`
      );

      // STALE SOCKET GUARD. A disconnect arriving from a socket the seat has
      // ALREADY moved off is not this player's disconnect — it is the corpse of
      // the connection they replaced, and processing it detaches a live player
      // from their own seat.
      //
      // This is the normal case on mobile, not an edge case: the OS freezes the
      // socket when the app backgrounds, the client reconnects within a second
      // of coming back, and socket.io only notices the abandoned socket at ping
      // TIMEOUT — tens of seconds after the rejoin already re-bound the seat.
      // Left unguarded, the late disconnect ran player.disconnect() and
      // FailureManager._enterGracePeriod, which nulls player.socketId; from that
      // moment _sendInitialGameState skips the seat ("Socket not found for
      // player…") and _onTurnTimerExpired force-advances it as disconnected, so
      // the board freezes on stale cards and bleeds turns to an inactivity
      // forfeit. That is the "reconnect always loses state" report.
      //
      // The `player.socketId &&` short-circuit deliberately lets a seat that is
      // ALREADY detached (socketId null) fall through to today's behaviour.
      if (player && player.socketId && player.socketId !== socket.id) {
        this.gameService.removeSocket(socket.id);
        logger.info(
          `[DISCONNECT] Ignoring STALE socket ${socket.id} for ${playerId}; the seat is live on ${player.socketId}`
        );
        return;
      }
      this._gameEvent(room, 'disconnect', {
        playerId,
        seat: player?.playerIndex ?? null,
        reason,
        inProgress: room.isInProgress?.() === true,
      });

      // If the game has not started yet, HOLD the seat through a short grace
      // window instead of hard-leaving immediately (A1). A swipe-killed host that
      // reopens within the window rejoins the SAME room (joinRoom reconnect path)
      // instead of finding it deleted and getting "Room is not ready". If they
      // don't return, _scheduleWaitingLeave runs the real leave/teardown.
      //
      // TRAP B — #11 multi-round: a room mid-intermission is FINISHED, not
      // IN_PROGRESS, so without awaitingNextRound a drop during the round-over
      // overlay took THIS pre-game branch. 30s later _scheduleWaitingLeave freed
      // the seat (breaking the "Room is not full" guard and the even/odd team
      // ids the cumulative score is keyed on) or, for the host, killed the entire
      // mid-match room. An intermission drop is an IN-GAME drop.
      if (!room.isInProgress() && !room.awaitingNextRound) {
        if (player && typeof player.disconnect === 'function') {
          player.disconnect();
        }

        // Tell the rest of the lobby this seat is reconnecting (not gone yet).
        this.io.to(room.roomId).emit(SocketEvents.PLAYER_DISCONNECTED, {
          playerId,
          playerIndex: player?.playerIndex,
          playerName: player?.playerName,
          grace: true,
          timestamp: new Date().toISOString(),
        });

        this._scheduleWaitingLeave(room.roomId, playerId);

        // Drop only the socket mapping; the player stays seated for the grace
        // window so a reopen reconnects to the held seat.
        this.gameService.removeSocket(socket.id);
        return;
      }

      // Items 7/8: host is IMMUTABLE — an in-game host disconnect does NOT
      // migrate the host. It is treated like any other disconnect: the seat
      // enters grace (reconnectable) and, if the host does not return, accrues
      // inactive turns until the game ends with the active player as winner
      // (inactivity_forfeit). No HOST_CHANGED is emitted.
      const result = ActionHandlers.handleDisconnect(room, playerId);
      // #11 multi-round: route an intermission drop into the normal in-game
      // reconnect grace too, so the seat is HELD for round N+1 instead of taking
      // the plain-broadcast branch with no grace bookkeeping at all.
      if ((room.isInProgress() || room.awaitingNextRound) && this.failureManager) {
        await this.failureManager.handlePlayerDisconnection(socket, playerId, room.roomId);
        this._emitPartnerWebhook('player.status', {
          roomId: room.roomId,
          playerId,
          playerName: player?.playerName,
          status: 'disconnected',
        });
        logger.info(
          `[DISCONNECT] ✓ FailureManager handled disconnect for ${playerId} in room ${room.roomId}`
        );
      } else if (result.success) {
        socket.to(room.roomId).emit(SocketEvents.PLAYER_DISCONNECTED, result.broadcast);
        this._emitPartnerWebhook('player.status', {
          roomId: room.roomId,
          playerId,
          playerName: player?.playerName,
          status: 'disconnected',
        });
        logger.info(`[DISCONNECT] ✓ Notified room ${room.roomId} of player ${playerId} disconnect`);

        // Mark player as disconnected in the room
        // This will automatically trigger room cleanup if all players are disconnected
        this.gameService.handlePlayerDisconnection(playerId);
      }

      // A seat that drops mid-deal can no longer report deal_animation_complete.
      // If everyone still at the table already has, start the first turn now
      // instead of making them wait out DEAL_ANIMATION_FALLBACK_MS for it.
      if (room.awaitingDealAnimation) {
        this._startFirstTurnTimerIfDealAcked(room, `disconnect of ${playerId}`);
      }
    }

    // Clean up socket mapping
    this.gameService.removeSocket(socket.id);
  }

  /**
   * Handle draw card event
   * @param {Socket} socket
   * @param {Object} data
   */
  handleDrawCard(socket, data) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(playerId);

    if (!room) {
      logger.warn(`[DRAW_CARD] Player ${playerId} not in room`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Not in a room'));
      return;
    }

    const { fromDeck, drawnCard } = data || {};

    // Taking the discard pile is a SEPARATE action (pick_up_pile). A single-card
    // draw from the pile is not supported here; reject it instead of
    // half-processing — the old code emitted CARD_DRAWN without moving a card or
    // setting hasDrawnCard, so the turn could never complete and hung.
    if (!fromDeck) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('Use pick up pile to take the discard pile')
      );
      return;
    }

    // Mark player as active
    this.gameService.markPlayerActive(playerId);

    const player = room.getPlayer(playerId);
    logger.info(
      `[DRAW_CARD] Player ${playerId} (index: ${player?.playerIndex}) drawing from ${fromDeck ? 'deck' : 'pile'} in room ${room.roomId}`
    );

    // Validate the acting seat before resolving an empty stock. A manual draw
    // promotes one untaken pozzetto, exactly as timeout auto-draw does, or ends
    // the round when no stock remains. Rejected repeat draws must not consume a
    // second well; _deckOutTerminal also checks hasDrawnCard.
    const drawTurnCheck = GameValidator.validateTurn(room, playerId);
    if (!drawTurnCheck.isValid) {
      logger.warn(
        `[DRAW_CARD] Out-of-turn draw rejected for ${playerId} in room ${room.roomId}: ${drawTurnCheck.error}`
      );
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(drawTurnCheck.error));
      return;
    }

    if (fromDeck) {
      const stockDead = ActionHandlers._deckOutTerminal(room, playerId);
      if (stockDead && stockDead.roundEnded) {
        this._broadcastRoundEndAndCleanup(room, stockDead.roundEnded);
        return;
      }
    }

    const result = ActionHandlers.handleDrawCard(room, playerId, fromDeck, drawnCard);

    if (result.success) {
      this._recordManualAction(room, playerId);
      // Actually draw the card and update game state
      let actualDrawnCard = null;

      if (fromDeck && room.deck) {
        actualDrawnCard = room.deck.draw();
        if (actualDrawnCard) {
          const playerHand = room.playerHands.get(playerId) || [];
          // Preserve the player's existing hand order. Newly acquired cards are
          // appended so every client and reconnect shows them on the right.
          playerHand.push(actualDrawnCard);
          room.playerHands.set(playerId, playerHand);
          room.hasDrawnCard = true;
          // RULE C (product call 2026-09-02): a DECK-drawn card MAY ALWAYS be
          // discarded immediately — no lock logic on this path at all. Clear (do
          // not populate) the discard restriction. The timeout auto-draw further
          // down used to disagree with this line; that divergence is closed and
          // BOTH draw paths now follow this rule. Only a LONE-card pile take
          // restricts anything.
          room.drawnCardThisTurnRestriction = new Set();
          // THE DECK DRAW ALSO RELEASES THE ANTI PING-PONG LOCK, every copy it
          // holds. The lock exists to stop a card bouncing straight back off the
          // discard pile; reaching for the STOCK instead is the seat leaving that
          // exchange, so there is nothing left to police. It is held only for as
          // long as the seat keeps feeding off the pile — which is also what
          // makes the two-copy volley impossible, since a take never passes
          // through a draw. Mirrors GameController.drawFromDeck.
          room.clearDiscardLock(playerId);

          // Update the result messages with the actual card
          result.toPlayer.card = actualDrawnCard.toJSON();

          logger.info(
            `[DRAW_CARD] ✓ Player ${playerId} drew from deck. Hand: ${playerHand.length - 1} → ${playerHand.length}, Deck: ${room.deck.count + 1} → ${room.deck.count}`
          );
          this._gameEvent(room, 'draw', {
            playerId,
            seat: player?.playerIndex,
            card: this._briefCard(actualDrawnCard),
            hand: playerHand.length,
            deck: room.deck.count,
          });
        }
      }

      socket.emit(SocketEvents.CARD_DRAWN, result.toPlayer);
      socket.to(room.roomId).emit(SocketEvents.CARD_DRAWN, result.toOthers);
      this._emitPartnerWebhook('card.drawn', {
        roomId: room.roomId,
        playerId,
        playerIndex: player?.playerIndex,
        fromDeck: Boolean(fromDeck),
      });

      logger.info(
        `[DRAW_CARD] Emitted CARD_DRAWN to player ${playerId}: ${JSON.stringify(result.toPlayer)}`
      );
      logger.info(
        `[DRAW_CARD] Emitted CARD_DRAWN to other players in room ${room.roomId}: ${JSON.stringify(result.toOthers)}`
      );
      logger.info('[DRAW_CARD] ✓ Sending updated game state to all players.');
      // Send updated game state to all players to keep UI in sync
      this._sendGameStateUpdate(room);
    } else {
      logger.error(`[DRAW_CARD] ✗ Player ${playerId} failed: ${result.error}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(result.error));
    }
  }

  /**
   * Handle play meld event
   * @param {Socket} socket
   * @param {Object} data
   */
  handlePlayMeld(socket, data) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(playerId);

    if (!room) {
      logger.warn(`[PLAY_MELD] Player ${playerId} not in room`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Not in a room'));
      return;
    }

    // Mark player as active
    this.gameService.markPlayerActive(playerId);

    const player = room.getPlayer(playerId);
    const { cards, meldIndex } = data;
    logger.info(
      `[PLAY_MELD] Player ${playerId} (index: ${player?.playerIndex}) playing ${cards?.length || 0} cards ${meldIndex !== undefined ? `to meld ${meldIndex}` : 'as new meld'} in room ${room.roomId}`
    );

    const result = ActionHandlers.handlePlayMeld(room, playerId, cards, meldIndex);

    if (result.success) {
      this._recordManualAction(room, playerId);
      const playerHand = room.playerHands.get(playerId) || [];
      const broadcastWithHandCount = {
        ...result.broadcast,
        playerHandCount: playerHand.length,
      };
      this.io.to(room.roomId).emit(SocketEvents.MELD_PLAYED, broadcastWithHandCount);
      this._emitPartnerWebhook('meld.played', {
        roomId: room.roomId,
        playerId,
        playerIndex: player?.playerIndex,
        meld: result.broadcast,
      });
      logger.info(
        `[PLAY_MELD] ✓ Player ${playerId} successfully played meld. Hand now: ${playerHand.length} cards. Sending updated game state.`
      );
      this._gameEvent(room, 'meld', {
        playerId,
        seat: player?.playerIndex,
        cards: this._briefCards(result.broadcast?.cards),
        meldIndex: result.broadcast?.meldIndex ?? null,
        isBuraco: result.broadcast?.isBuraco === true,
        grade: result.broadcast?.grade ?? null,
        hand: playerHand.length,
        pozzettoTaken: result.broadcast?.pozzettoTaken || 0,
      });
      // Send updated game state to all players to keep UI in sync. The well
      // broadcast goes FIRST — see _broadcastPozzettoBeforeState.
      this._broadcastPozzettoBeforeState(room, result);
      this._sendGameStateUpdate(room);
      // A meld can end the round (professional instant-end, or the empty-hand
      // safety net). Broadcast the end so clients aren't left hanging.
      if (result.roundEnded) {
        this._broadcastRoundEndAndCleanup(room, result.roundEnded);
      } else if (result.broadcast?.pozzettoTaken) {
        // Pot taken mid-turn: the hand refilled (11 new cards) but the turn did
        // NOT change — the same player keeps playing and must still discard.
        // Re-arm a FRESH turn timer so the prior (near-expiry) timer can't
        // force-skip them with a full new hand ("still my turn, no time left").
        // Emits TURN_TIMER_STARTED, which the client mirrors via
        // applyServerTurnTimer.
        this._startTurnTimer(room);
      }
    } else {
      logger.error(`[PLAY_MELD] ✗ Player ${playerId} failed: ${result.error}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(result.error));
    }
  }

  /**
   * Handle discard card event
   * @param {Socket} socket
   * @param {Object} data
   */
  handleDiscardCard(socket, data) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(playerId);

    if (!room) {
      logger.warn(`[DISCARD_CARD] Player ${playerId} not in room`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Not in a room'));
      return;
    }

    // Mark player as active
    this.gameService.markPlayerActive(playerId);

    const player = room.getPlayer(playerId);
    const { card } = data;
    logger.info(
      `[DISCARD_CARD] Player ${playerId} (index: ${player?.playerIndex}) discarding card in room ${room.roomId}. Current turn: ${room.currentTurn}`
    );

    // Validate BEFORE touching the clock. Stopping the timer up front let any
    // seated socket — on turn or not — clear the running timer with an invalid
    // discard, and the failure branch below then armed a FULL fresh turn, so the
    // current player's deadline could be pushed out forever against a 40/s rate
    // limit with no inactivity accrual. A rejected discard now leaves the timer
    // exactly as it was.
    const result = ActionHandlers.handleDiscard(room, playerId, card);

    if (result.success) {
      this._stopTurnTimer(room);
      this._resetInactiveCounter(room, playerId);
      this._gameEvent(room, 'discard', {
        playerId,
        seat: player?.playerIndex,
        card: this._briefCard(result.broadcast?.card),
        hand: (room.playerHands.get(playerId) || []).length,
        pozzettoTaken: result.broadcast?.pozzettoTaken || 0,
        minimumMeldFailed: Boolean(result.broadcast?.minimumMeld),
        nextSeat: result.roundEnded ? null : (result.turnChanged?.newPlayerIndex ?? room.currentTurn),
      });
      if (result.roundEnded) {
        this._broadcastRoundEndAndCleanup(room, result.roundEnded);
        return;
      }

      // The discard may have emptied the hand and auto-taken the pot (an
      // INDIRECT take). The turn STILL advances — that discard IS the turn's
      // end (the old keep-turn house rule is gone) — but clients need the
      // dedicated event to play the take animation and flip hasPickedDeadPile,
      // exactly like the manual take path.
      if (result.broadcast?.pozzettoTaken) {
        this.io.to(room.roomId).emit(SocketEvents.POZZETTO_TAKEN, {
          type: 'pozzetto_taken',
          playerIndex: result.broadcast.playerIndex,
          cardCount: result.broadcast.pozzettoTaken,
          timestamp: new Date().toISOString(),
        });
        logger.info(
          `[DISCARD_CARD] ✓ Player ${playerId} discarded last card and took the pot (${result.broadcast.pozzettoTaken} cards) — turn passes.`
        );
      }

      const turnCompletedData = {
        type: 'turn_completed',
        discardedCard: result.broadcast.card,
        playerIndex: result.broadcast.playerIndex,
        newTurnIndex: result.turnChanged.newPlayerIndex,
        previousTurnIndex: result.turnChanged.previousPlayerIndex,
        discardPile: room.discardPile.map((c) => ({ suit: c.suit, rank: c.rank })),
        hasDrawnCard: false,
        // MINIMUM MELD verdict, when there was one. The authoritative hand and
        // melds already ride in on the state update that follows, so the cards
        // put themselves back — this is the half that tells the player WHY, and
        // it has to travel with the turn rather than wait for the round-over
        // board.
        ...(result.broadcast?.minimumMeld ? { minimumMeld: result.broadcast.minimumMeld } : {}),
        timestamp: new Date().toISOString(),
      };

      this.io.to(room.roomId).emit(SocketEvents.TURN_COMPLETED, turnCompletedData);
      this._emitPartnerWebhook('turn.completed', {
        roomId: room.roomId,
        playerId,
        playerIndex: player?.playerIndex,
        data: turnCompletedData,
      });
      logger.info(
        `[DISCARD_CARD] ✓ Player ${playerId} successfully discarded. Sending updated game state.`
      );
      // Send updated game state to all players to keep UI in sync
      this._sendGameStateUpdate(room);
      // Start the turn timer for the next player
      this._startTurnTimer(room);
    } else {
      logger.error(`[DISCARD_CARD] ✗ Player ${playerId} failed: ${result.error}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(result.error));
      // The discard was rejected but it is STILL this player's turn. Resync the
      // authoritative state (the client optimistically removed the card from its
      // hand, so put it back). The timer was never stopped above, so there is
      // nothing to restart — and re-arming here is what allowed the deadline to
      // be extended indefinitely. Only arm if no timer is live at all (which
      // would otherwise be the reported freeze), and never grant more than the
      // slice that was already left on the clock.
      this._sendGameStateUpdate(room);
      if (!room.turnTimerTickHandle) {
        const remainingMs = room.turnTimerDeadline
          ? Math.max(0, room.turnTimerDeadline - Date.now())
          : undefined;
        this._startTurnTimer(room, remainingMs);
      }
    }
  }

  /**
   * Broadcast a game end consistently and schedule room cleanup. Used by
   * EVERY path that can end the round (manual discard, meld instant-end / empty-
   * hand safety net, deck exhaustion, turn timeout) so the cleanup + webhook are
   * never skipped and the round can't be finalized twice.
   * @param {import('../models/GameRoom')} room
   * @param {Object} roundEnded - payload from ActionHandlers._finalizeRound*
   */

  /**
   * Single grace-delayed room deletion used by EVERY terminal path (normal
   * win/lose AND the connection-failure forfeit), so a reconnecting player can
   * always re-fetch the final result before the room disappears. The backend
   * room-closed / game-result webhooks and socket detach already ran at the call
   * site, so the lobby de-lists immediately; only the in-memory teardown waits.
   * Reuses room.finalizeCleanupHandle so an earlier teardown cancels it.
   */
  static get FINISHED_ROOM_GRACE_MS() {
    return 60000;
  }

  _scheduleRoomDeletion(room, graceMs = SocketHandlers.FINISHED_ROOM_GRACE_MS) {
    if (!room) return;
    if (!room.gameEndedAt) room.gameEndedAt = new Date();
    if (room.finalizeCleanupHandle) clearTimeout(room.finalizeCleanupHandle);
    room.finalizeCleanupHandle = setTimeout(logger.bindRoom(room.roomId, () => {
      room.finalizeCleanupHandle = null;
      logger.info(`[GAME_ENDED] Cleaning up finished room ${room.roomId}`);
      this.gameService.deleteRoom(room.roomId);
    }), graceMs);
  }

  _broadcastRoundEndAndCleanup(room, roundEnded) {
    if (!room || !roundEnded) return;
    // Guard against a second finalization (e.g. a queued timeout firing right
    // after a manual end) re-broadcasting and double-scheduling cleanup.
    if (room._roundEndBroadcast) return;
    room._roundEndBroadcast = true;

    this._stopTurnTimer(room);
    logger.info(
      `[GAME_ENDED] Room ${room.roomId} finished. Winner index: ${roundEnded.winnerIndex}`
    );
    this._gameEvent(room, roundEnded.matchEnded === false ? 'round_end' : 'match_end', {
      round: room.roundNumber || null,
      winnerSeat: roundEnded.winnerIndex ?? null,
      winnerId: roundEnded.winnerId ?? null,
      batida: roundEnded.batidaType ?? null,
      winningTeam: roundEnded.winningTeam ?? null,
      teamScores: Object.fromEntries(
        Object.entries(roundEnded.teamScores || {}).map(([team, score]) => [
          team,
          score && typeof score === 'object' ? (score.total ?? null) : score,
        ])
      ),
      cumulative: roundEnded.cumulativeTeamScores ?? (room.cumulativeTeamScores ? Object.fromEntries(room.cumulativeTeamScores) : null),
      targetScore: room.targetScore ?? null,
    });

    // #11 multi-round: open the intermission BEFORE anything is emitted. A socket
    // that drops in the same tick as the GAME_ENDED broadcast must already see
    // awaitingNextRound=true, otherwise handleDisconnect takes the PRE-GAME
    // branch and starts a 30s timer that frees the seat mid-match (TRAP B).
    // Gate on an EXPLICIT false: an absent `matchEnded` means a single-round
    // game (targetScore 0) or a pre-#11 payload, which stays terminal as before.
    const roundOnly = roundEnded.matchEnded === false;
    if (roundOnly) {
      // Arm the flag AND the timer in the SAME step. They must never be set
      // apart: every emit/webhook call below is an uncaught synchronous throw
      // away (JSON.stringify / HMAC inside the partner relay, socket.io
      // serialization), and a throw between "flag set" and "timer armed" leaves
      // the room flagged awaitingNextRound with NO deal coming — which
      // _cleanupInactiveRooms now deliberately SKIPS, so the room (and its
      // players' mappings) would live in memory forever. _scheduleNextRound sets
      // awaitingNextRound + the absolute nextRoundAt deadline itself.
      this._scheduleNextRound(room);
      // `roundEnded` IS room.lastRoundEndPayload (ActionHandlers._finalizeWith),
      // so stamping it here also gives every reconnect replay of the round card
      // the countdown, for free. Without this the client can only GUESS when the
      // next deal lands — which is exactly what the shipped 10s client-side
      // workaround does.
      roundEnded.nextRoundInMs = Math.max(0, room.nextRoundAt - Date.now());
      roundEnded.nextRoundAt = room.nextRoundAt;
    }

    this.io.to(room.roomId).emit(SocketEvents.GAME_ENDED, { ...roundEnded, type: 'game_ended' });
    this._persistRoomState(room);
    // #11 multi-round: carry the enriched game.ended `data` so wlive-api's
    // settleGame (POST /api/brazilia/webhook) can tell round-over from match-over
    // and settle ONCE at match end. `result` kept for backward compatibility.
    this._emitPartnerWebhook('game.completed', {
      roomId: room.roomId,
      winnerId: roundEnded.winnerId || null,
      result: roundEnded,
      data: this._buildPartnerGameEndData(room, roundEnded),
    });

    // Report the finished ROUND to the backend (per-player stats + leaderboard).
    // This one is deliberately PER ROUND: `result_id` derives from gameStartedAt,
    // which startGame() resets on every deal, so each round mints a distinct,
    // dedupe-safe id — and on wlive this POST is what records the round.
    this._notifyBackendGameResult(room, roundEnded.winnerId || null);

    if (roundOnly) {
      // #11 multi-round: everything BELOW this line is PER MATCH and must NOT run
      // on an intermediate round. Conflating the two is what broke multi-round
      // end-to-end:
      //  - room-closed carries only {roomId, reason}: it has no round dimension,
      //    so a consumer can only read it as "this room is finished". wlive
      //    stamps runtime_closed_at (never cleared), which delists the STILL-LIVE
      //    match and hands it to the settlement-lost reaper 60s later — the pot
      //    is refunded mid-match. The Brazilia backend is worse: `game_ended` is
      //    not a host-gone reason, so an `ongoing` row is flipped to `closed` and
      //    every user's game_room_id is NULLed after round 1.
      //  - the 60s deletion (TRAP A) wipes the room AND its cumulative score, and
      //    its onRoomDeleted hook re-fires room-closed anyway — so both lines
      //    must sit behind the SAME condition.
      // Instead the SERVER owns the cadence to round N+1 — already armed above,
      // atomically with the awaitingNextRound flag.
      return;
    }

    // Tell the backend to close + delist this room immediately so a finished
    // game stops lingering in the lobby (PTW-255 #2). The forfeit path already
    // does this; the normal-end path previously only deleted the in-memory room
    // after a 60s grace and never closed the backend row, so completed games
    // kept showing in the listing. webhookRoomClosed is idempotent (sets
    // status=closed), so re-firing on a reconnect re-finalize is safe.
    //
    // Pass BOTH the reason and the room's own backend, exactly like the forfeit
    // path above:
    //  - `game_ended` is what distinguishes "the match finished" from the lobby
    //    kill this webhook was originally built for. wlive's handler refuses to
    //    cancel+refund a non-open room (it can't tell a stray kill from a real
    //    one), so without the reason a normally-finished room was answered with
    //    `ignored_not_open` and stayed listed in the lobby forever.
    //  - backendBaseUrl keeps a 1-socket/2-backend deploy from posting this room's
    //    close to the OTHER backend (the default URL), which would silently no-op.
    this._notifyBackendRoomClosed(room.roomId, 'game_ended', room.backendBaseUrl || null);

    // _finalizeRound already set status=FINISHED. Keep the room briefly so
    // clients can (re)fetch the final result on reconnect, then delete it.
    // Track the handle on the room so an earlier teardown (forfeit, inactivity
    // sweep, shutdown) can cancel it via disposeTimers() instead of leaking a
    // 60s closure that re-deletes an already-gone room.
    this._scheduleRoomDeletion(room);
  }

  // ---------------------------------------------------------------------------
  // #11 multi-round: SERVER-driven next round
  //
  // Before this, _broadcastRoundEndAndCleanup parked every round end in FINISHED
  // and nothing ever scheduled the next deal, so the only thing moving a match
  // forward was a client-side timer racing the 60s room deletion. The cadence now
  // lives here, on the server.
  // ---------------------------------------------------------------------------

  /**
   * How long the round-over board stays up before the next deal.
   *
   * It exists so players can read the round scoreboard, and it must stay WELL
   * under the two windows that fire against a FINISHED room:
   *  - FINISHED_ROOM_GRACE_MS (60s) — the room-deletion grace. We no longer arm
   *    it between rounds, but a delay near/over it would leave zero margin if any
   *    other path (forfeit, inactivity sweep) armed a deletion first.
   *  - WAITING_GRACE_MS (30s) — the pre-game seat-hold. awaitingNextRound now
   *    keeps intermission drops off that path, but a delay longer than the seat
   *    hold would mean a re-deal landing after a seat could already be gone.
   * 10s also comfortably beats the client's own stuck-deal watchdog, so the UI
   * never has to guess.
   */
  /**
   * How long the finished board stays up before the next round is dealt.
   *
   * Raised from 10s so players can actually read the table before it is swept
   * away; the HOST can cut it short with START_NEXT_ROUND, and this is the
   * backstop for a host who has gone quiet.
   *
   * It cannot go past WAITING_GRACE_MS (30s) — _nextRoundDelayMs clamps it — and
   * that ceiling is real: beyond it a waiting player can be dropped, and past
   * FINISHED_ROOM_GRACE_MS (60s) the room itself is deleted, mid-intermission.
   * Wanting a longer window means moving those two windows first.
   */
  static get NEXT_ROUND_DELAY_MS() {
    return 25000;
  }

  /**
   * Floor applied when RE-ARMING an intermission after a restart / lease
   * failover. The persisted deadline has usually already passed by the time the
   * process is back up, and dealing instantly would emit round N+1's hands into
   * the socket handles the restart just killed (the clients have not reconnected
   * yet). Give them a moment to come back first.
   */
  static get NEXT_ROUND_RESUME_FLOOR_MS() {
    return 5000;
  }

  /**
   * Time left on a persisted intermission deadline, floored so a resume never
   * deals into sockets that have not reconnected yet.
   * @param {import('../models/GameRoom')} room
   * @returns {number}
   */
  _remainingNextRoundMs(room) {
    const remaining = (Number(room?.nextRoundAt) || 0) - Date.now();
    return Math.max(SocketHandlers.NEXT_ROUND_RESUME_FLOOR_MS, remaining);
  }

  /**
   * Effective intermission length for a room: per-room override (sync-room) wins
   * over the ops default. Clamped to [3000, WAITING_GRACE_MS] so a bad backend
   * value can neither cut the round-over card short nor push the re-deal past the
   * seat-hold / deletion windows described on NEXT_ROUND_DELAY_MS.
   * @param {import('../models/GameRoom')} room
   * @returns {number}
   */
  _nextRoundDelayMs(room) {
    const override = Number(room?.nextRoundDelayMs);
    const configured = Number(config.game?.nextRoundDelayMs);
    const raw = Number.isFinite(override) && override > 0
      ? override
      : Number.isFinite(configured) && configured > 0
        ? configured
        : SocketHandlers.NEXT_ROUND_DELAY_MS;
    return Math.min(Math.max(raw, 3000), SocketHandlers.WAITING_GRACE_MS);
  }

  /**
   * Re-send the round-over card to ONE socket that reconnected mid-intermission.
   * The stored payload carries the countdown that was correct when the round
   * ended, so recompute it from the absolute deadline — a client that reconnects
   * 8s into a 10s intermission must be told 2s, not 10s.
   * @param {Socket} socket
   * @param {import('../models/GameRoom')} room
   */
  _replayIntermissionCard(socket, room) {
    if (!socket || !room?.awaitingNextRound || !room.lastRoundEndPayload) return;
    socket.emit(SocketEvents.GAME_ENDED, this._roundEndReplayPayload(room));
  }

  /**
   * The stored round-end payload, with the intermission countdown RE-BASED off
   * the absolute deadline. The stamped `nextRoundInMs` was correct only at the
   * instant the round ended; replaying it verbatim tells a client that reconnects
   * 8s into a 10s intermission to wait another 10s, so its own deal watchdog
   * fires against a deal that already happened.
   * @param {import('../models/GameRoom')} room
   * @returns {Object}
   */
  _roundEndReplayPayload(room) {
    const payload = { ...(room?.lastRoundEndPayload || {}), type: 'game_ended' };
    if (room?.awaitingNextRound) {
      payload.nextRoundInMs = Math.max(0, (room.nextRoundAt || 0) - Date.now());
      payload.nextRoundAt = room.nextRoundAt || null;
      return payload;
    }
    // No intermission is running, so this replay must not advertise one. The
    // stored payload still carries the countdown that was stamped when the round
    // ENDED, and nothing strips it when the intermission is consumed normally
    // (the deal) — only _abortNextRound deletes it. Replaying it verbatim hands a
    // late joiner / reconnecting client a live-looking deadline for a deal that
    // already happened, and the client counts down to a round card that will
    // never be dismissed.
    delete payload.nextRoundInMs;
    delete payload.nextRoundAt;
    return payload;
  }

  /**
   * Arm the next deal. Idempotent: re-arming replaces the pending handle instead
   * of stacking a second one.
   * @param {import('../models/GameRoom')} room
   * @param {number} [overrideMs] explicit delay (restart resume passes the
   *   REMAINING time off the persisted absolute deadline)
   */
  _scheduleNextRound(room, overrideMs) {
    if (!room) return;
    if (room.nextRoundHandle) clearTimeout(room.nextRoundHandle);
    const delayMs = overrideMs != null ? Math.max(0, Number(overrideMs) || 0) : this._nextRoundDelayMs(room);
    room.awaitingNextRound = true;
    // The deadline must always describe the timer we just armed. On a RESUME the
    // persisted nextRoundAt is already in the PAST (the process was down through
    // it) while the re-armed timer is NEXT_ROUND_RESUME_FLOOR_MS away, so keeping
    // it would make _roundEndReplayPayload tell every reconnecting client
    // "nextRoundInMs: 0" for a deal that has not happened — the exact stale
    // countdown that helper exists to prevent, and what the client's deal
    // watchdog fires on. Re-base whenever an explicit delay is supplied; the
    // normal round-end path passes none and keeps the deadline it just set.
    if (overrideMs != null || !room.nextRoundAt) room.nextRoundAt = Date.now() + delayMs;
    room.nextRoundHandle = setTimeout(logger.bindRoom(room.roomId, () => {
      room.nextRoundHandle = null;
      // A throw inside a timer callback is an UNCAUGHT exception that kills the
      // whole socket process — every other room with it. _startScheduledNextRound
      // is async, so both the sync throw and the rejected promise must be caught.
      try {
        const pending = this._startScheduledNextRound(room.roomId);
        if (pending && typeof pending.catch === 'function') {
          pending.catch((err) => this._failNextRound(room.roomId, err));
        }
      } catch (err) {
        this._failNextRound(room.roomId, err);
      }
    }), delayMs);
    // Never let a pending intermission hold the event loop open on shutdown.
    if (typeof room.nextRoundHandle.unref === 'function') room.nextRoundHandle.unref();
    // Persist awaitingNextRound + the absolute deadline so a restart inside the
    // intermission can re-arm instead of stranding the match in FINISHED.
    this._persistRoomState(room);
    metrics.increment('buraco_next_round_scheduled_total');
    this._logRoomLifecycle('next_round_scheduled', { roomId: room.roomId, delayMs });
  }

  /**
   * Cancel a pending next round. Called wherever the match becomes terminal
   * (forfeit, host-gone kill) so a phantom round can never follow a settled match.
   * @param {import('../models/GameRoom')} room
   * @param {string} reason
   */
  _cancelNextRound(room, reason) {
    if (!room || (!room.awaitingNextRound && !room.nextRoundHandle)) return;
    if (room.nextRoundHandle) {
      clearTimeout(room.nextRoundHandle);
      room.nextRoundHandle = null;
    }
    room.awaitingNextRound = false;
    room.nextRoundAt = null;
    this._logRoomLifecycle('next_round_cancelled', { roomId: room.roomId, reason });
  }

  /**
   * The scheduler blew up. Never rethrow (see _scheduleNextRound) and never leave
   * the room mid-intermission with no timer: end the match terminally so clients
   * stop waiting on a deal that will never come.
   * @private
   */
  _failNextRound(roomId, err) {
    logger.error(`[NEXT_ROUND] Scheduler failed for room ${roomId}: ${err?.message}`, err);
    try {
      const room = this.gameService.getRoom(roomId);
      if (!room) return;
      // Two ways to be stranded, and BOTH must settle:
      //  - still mid-intermission: no timer left, so no deal is coming;
      //  - HALF started: startGame() already flipped the room to IN_PROGRESS but
      //    the deal blew up, so it is a playable-looking table with no cards and
      //    no turn — the exact stuck state this whole change exists to remove.
      const stranded = room.awaitingNextRound || (room.isInProgress() && !room.cardsDealt);
      if (stranded) this._abortNextRound(room, 'scheduler_error');
    } catch (inner) {
      logger.error(`[NEXT_ROUND] Abort after scheduler failure also failed: ${inner.message}`, inner);
    }
  }

  /**
   * Give up on the match, but leave NO client staring at "next round coming".
   * Re-broadcasts the stored round payload marked TERMINAL, then runs exactly the
   * per-match teardown a normal match end runs.
   *
   * Every reason below is TERMINAL, so this DOES fire _notifyBackendGameResult.
   * It used to skip it on the grounds that "resultReported is already true and
   * result_id is unchanged, so the backend would dedupe it" — but that reasoning
   * described the bug, not a safeguard: the only thing the backend ever heard
   * about this match was round N's report carrying matchEnded:false, i.e. "expect
   * another round". Nothing ever told it the match was over, so the settlement
   * never ran. _notifyBackendGameResult now latches per report KIND and mints a
   * distinct `:final` result_id for exactly this case, so the terminal report
   * goes out once and cannot be mistaken for a re-send of round N.
   *
   * `reason` is CLIENT-FACING copy, not a log string: the Flutter board switches
   * on it to caption the game-over card. The complete set of codes a client can
   * ever receive on a game_ended is
   *   from here .............. scheduler_error | seat_missing | no_humans |
   *                            start_failed | deal_failed
   *   from _handlePlayerForfeit  host_left | opponent_left | inactivity_forfeit
   * and a clean round/match end carries NO reason key at all (ActionHandlers
   * ._finalizeWith builds its payload from scratch and never writes one). Renaming
   * any code here silently changes what players read, so treat the list as a wire
   * contract — next_round_scheduler.test.js pins it.
   * @param {import('../models/GameRoom')} room
   * @param {string} reason
   */
  _abortNextRound(room, reason) {
    if (!room) return;
    this._cancelNextRound(room, reason);
    room.status = GameRoomStatus.FINISHED;
    const payload = {
      // Fall back to the pre-deal snapshot: startGame() NULLS lastRoundEndPayload
      // as part of its per-round reset, so every abort raised after that point
      // (deal_failed, and scheduler_error on a half-started room) used to emit a
      // bare {matchEnded, reason} — a blank result card for the players and a null
      // winnerId to the settlement webhook, throwing away the round that had
      // already been scored.
      ...(room.lastRoundEndPayload || room._preDealRoundEndPayload || {}),
      type: 'game_ended',
      matchEnded: true,
      reason,
    };
    // A terminal payload must not still advertise a countdown.
    delete payload.nextRoundInMs;
    delete payload.nextRoundAt;
    room.lastRoundEndPayload = payload;
    this.io.to(room.roomId).emit(SocketEvents.GAME_ENDED, payload);
    this._emitPartnerWebhook('game.completed', {
      roomId: room.roomId,
      winnerId: payload.winnerId || null,
      result: payload,
      data: this._buildPartnerGameEndData(room, payload),
    });
    // Settle. Ordered exactly like _handlePlayerForfeit: the match result goes
    // out while the room's players are still intact, and only then is the row
    // de-listed. `room.lastRoundEndPayload` was replaced with the TERMINAL
    // payload above, so the report carries matchEnded:true (and the reason).
    //
    // Contained: this is the LAST-RESORT settle path, and everything below it is
    // the teardown (de-list + delete). _notifyBackendGameResult signs its body
    // synchronously (JSON.stringify), so an unexpected throw here would skip both
    // and strand the room listed-and-undeletable forever — a worse outcome than
    // the missing report it would be reacting to.
    try {
      this._notifyBackendGameResult(room, payload.winnerId || null);
    } catch (err) {
      logger.error(
        `[NEXT_ROUND] game-result report for aborted room ${room.roomId} threw: ${err.message}`,
        err
      );
    }
    this._notifyBackendRoomClosed(room.roomId, 'game_ended', room.backendBaseUrl || null);
    this._scheduleRoomDeletion(room);
    metrics.increment('buraco_next_round_aborted_total', { reason });
    this._logRoomLifecycle('next_round_aborted', { roomId: room.roomId, reason });
    logger.warn(`[NEXT_ROUND] Aborted match in room ${room.roomId} (${reason})`);
  }

  /**
   * Timer body: deal round N+1.
   *
   * Every precondition below is a "cannot start" case with an explicit outcome —
   * either a silent no-op (someone else already owns the outcome) or a terminal
   * abort (nobody does, so the match must settle rather than hang).
   * @param {string} roomId
   */
  /**
   * HOST STARTS THE NEXT ROUND EARLY.
   *
   * The between-rounds window exists so everyone can read the board before the
   * cards are swept away — but a table that is ready should not have to sit
   * through the rest of it. The host may cut it short; the countdown stays as the
   * backstop for a host who has gone quiet.
   *
   * Deliberately the SAME path the timer takes, so a manual start and an
   * automatic one cannot drift apart.
   * @param {Socket} socket
   */
  handleStartNextRound(socket) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(playerId);
    if (!room) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Not in a room'));
      return;
    }
    if (!room.awaitingNextRound) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('No round is waiting to start')
      );
      return;
    }
    if (room.hostPlayerId && room.hostPlayerId !== playerId) {
      socket.emit(
        SocketEvents.ERROR,
        ErrorHandler.createErrorResponse('Only the host can start the next round')
      );
      return;
    }

    if (room.nextRoundHandle) {
      clearTimeout(room.nextRoundHandle);
      room.nextRoundHandle = null;
    }
    this._logRoomLifecycle('next_round_started_by_host', {
      roomId: room.roomId,
      playerId,
    });

    // Returned so a caller (and the tests) can await the deal; the timer path
    // deliberately does not, it just guards the rejection.
    try {
      const pending = this._startScheduledNextRound(room.roomId);
      if (pending && typeof pending.catch === 'function') {
        return pending.catch((err) => this._failNextRound(room.roomId, err));
      }
      return pending;
    } catch (err) {
      this._failNextRound(room.roomId, err);
      return undefined;
    }
  }

  async _startScheduledNextRound(roomId) {
    const room = this.gameService.getRoom(roomId);
    // Room already deleted → do NOT resurrect it. Its player mappings are gone.
    if (!room) return;
    // Cancelled between the timer firing and this running (forfeit, host-gone
    // kill, manual start): the canceller already owns the outcome.
    if (!room.awaitingNextRound) return;
    // IDEMPOTENCY: a manual host start_game / backend start-game webhook won the
    // race and already dealt. startGame() cleared awaitingNextRound, so this is
    // normally unreachable — belt-and-braces so a deal can never happen twice.
    if (room.isInProgress()) {
      room.awaitingNextRound = false;
      room.nextRoundAt = null;
      return;
    }
    if (this._ownershipEnabled()) {
      // Multi-node: only the lease owner deals, or every replica would deal the
      // same round.
      const ownership = await this._ensureRoomOwner(roomId, { acquire: true });
      if (!ownership?.owned) return;
      // Ownership is async — re-check the state we validated before awaiting.
      if (!room.awaitingNextRound || room.isInProgress()) return;
    }
    // Seat integrity: never deal a short table or change even/odd team identity.
    // The model enforces the same roster invariant; detect it here first so the
    // next-round abort carries the specific reason.
    //
    // No bounded retry before this abort, deliberately. The shortfalls that made
    // it fire on HEALTHY matches were all writes that should never have happened
    // mid-match, and they are now blocked at the source (syncRoomFromBackend no
    // longer resizes a live table; handleRemoveBot is behind _seatsLocked like
    // the other seat mutations). What is left is a seat that genuinely left the
    // roster — and that does NOT self-heal inside a retry window: a merely
    // DISCONNECTED player still occupies its seat (grace → bot replacement keeps
    // the count), so reconnecting changes nothing here, while a real leave has
    // already settled the match terminally through the forfeit path and cancelled
    // this timer. A retry would therefore delay the same outcome while adding a
    // second live deadline racing the room-deletion grace and a manual start —
    // new failure modes on a money path, for no recoverable case.
    if (!room.canStart()) {
      this._abortNextRound(room, 'seat_missing');
      return;
    }
    // Everyone human is gone (the host included): dealing to bots only would burn
    // the match down in an empty room. Settle instead.
    if (!room.getPlayers().some((p) => p.isBot !== true && p.isConnected)) {
      this._abortNextRound(room, 'no_humans');
      return;
    }

    room.awaitingNextRound = false;
    room.nextRoundAt = null;
    // Keep round N's scored result reachable across the reset below. startGame()
    // clears lastRoundEndPayload (correctly — round N+1 must not replay round N's
    // card), but every abort raised AFTER this line still needs it: it is the only
    // record of who won, the per-seat scores and the cumulative totals, and
    // _abortNextRound is what ships them to both the players and the settlement
    // webhook. Without the snapshot, deal_failed / a half-started scheduler_error
    // settle the match with an empty scoreboard and a null winner.
    room._preDealRoundEndPayload = room.lastRoundEndPayload;
    // startGame(force) is the per-round reset: IN_PROGRESS, cardsDealt=false,
    // fresh discard/wells, per-round guards cleared, cumulative scores PRESERVED.
    if (!room.startGame(true)) {
      this._abortNextRound(room, 'start_failed');
      return;
    }
    this._stopHostHeartbeat(room);
    this._logRoomLifecycle('next_round_started', {
      roomId: room.roomId,
      playerCount: room.players.size,
    });

    // Past this point the room is already IN_PROGRESS. Anything that throws here
    // would leave a playable-looking table with no cards and no turn — the exact
    // stuck state this change exists to remove — so settle instead of escaping.
    try {
      // cardsDealt:false here is the client's cue to re-arm its deal latch, exactly
      // like round 1 (mirrors handleStartGame / triggerStartGame).
      room.getPlayers().forEach((p) => {
        if (p.isBot === true) return;
        const playerSocket = this.io.sockets.sockets.get(p.socketId);
        if (!playerSocket) {
          logger.warn(`[NEXT_ROUND] Socket not found for player ${p.playerId} (socketId: ${p.socketId})`);
          return;
        }
        playerSocket.emit(SocketEvents.GAME_STARTED, {
          ...this._serializeRoomGameSettings(room),
          players: room.getPlayers().map((mp) => this._serializePlayer(mp)),
          yourPlayerIndex: p.playerIndex,
          currentPlayerIndex: this._announcedTurnIndex(room),
          ...this._skinsPayloadFields(room),
          cardsDealt: room.cardsDealt || false,
          hostId: room.hostPlayerId || null,
          turnTimeLimitSeconds: room.turnTimeLimit,
          timestamp: new Date().toISOString(),
        });
      });

      // Parity with triggerStartGame: the owner-controller is not a seated player,
      // so the loop above skips it and it would otherwise never see round N+1 start.
      if (room.ownerControllerSocketId) {
        const ownerSocket = this.io.sockets.sockets.get(room.ownerControllerSocketId);
        if (ownerSocket) {
          this._sendStateToSpectator(
            ownerSocket,
            room,
            room.ownerControllerPlayerId || 'owner-controller',
            'Owner',
            { includeGameStarted: true }
          );
        }
      }

      const dealResult = this._autoDealAfterStart(room, 'server next-round scheduler');
      if (!dealResult.success) {
        // Push whatever state we have so no client is left blank, then settle: a
        // room that is IN_PROGRESS with no cards is unplayable and has no way out.
        this._sendInitialGameState(room);
        this._abortNextRound(room, 'deal_failed');
        return;
      }
      // Round N+1 is live, so round N's card is history: drop the snapshot rather
      // than let a much later abort resurrect a stale scoreboard.
      room._preDealRoundEndPayload = null;
    } catch (err) {
      logger.error(`[NEXT_ROUND] Deal for room ${room.roomId} threw: ${err.message}`, err);
      this._abortNextRound(room, 'deal_failed');
      return;
    }

    // POINT OF NO RETURN: the cards are dealt and round N+1 is playable. The
    // notification below must sit OUTSIDE the deal_failed net — PartnerWebhookRelay
    // .dispatch signs its body synchronously (JSON.stringify + HMAC), so a throw
    // there used to abort a correctly dealt round: _abortNextRound would flip the
    // live table back to FINISHED and emit a BLANK terminal card (round N's payload
    // was already cleared by startGame, and _preDealRoundEndPayload above), losing
    // the match. A failed webhook is a reporting problem, not a game-over.
    try {
      this._emitPartnerWebhook('game.started', {
        roomId: room.roomId,
        players: room.getPlayers().map((p) => this._serializePlayer(p)),
        currentPlayerIndex: room.currentTurn,
        source: 'next_round_scheduler',
      });
    } catch (err) {
      logger.error(
        `[NEXT_ROUND] game.started webhook for room ${room.roomId} threw (round is live, continuing): ${err.message}`,
        err
      );
    }
  }

  /**
   * Handle go down event
   * @param {Socket} socket
   * @param {Object} data
   */
  handleGoDown(socket, data) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(playerId);

    if (!room) {
      logger.warn(`[GO_DOWN] Player ${playerId} not in room`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Not in a room'));
      return;
    }

    const player = room.getPlayer(playerId);
    const { melds } = data;
    logger.info(
      `[GO_DOWN] Player ${playerId} (index: ${player?.playerIndex}) going down with ${melds?.length || 0} melds in room ${room.roomId}`
    );

    const result = ActionHandlers.handleGoingDown(room, playerId, melds);

    if (result.success) {
      this._recordManualAction(room, playerId);
      this.io.to(room.roomId).emit(SocketEvents.WENT_DOWN, result.broadcast);
      logger.info(
        `[GO_DOWN] ✓ Player ${playerId} successfully went down. Sending updated game state.`
      );
      this._gameEvent(room, 'go_down', {
        playerId,
        seat: player?.playerIndex,
        melds: (result.broadcast?.melds || []).map((meld) => this._briefCards(meld)),
        hand: (room.playerHands.get(playerId) || []).length,
        pozzettoTaken: result.broadcast?.pozzettoTaken || 0,
      });
      // Send updated game state to all players to keep UI in sync. The well
      // broadcast goes FIRST — see _broadcastPozzettoBeforeState.
      this._broadcastPozzettoBeforeState(room, result);
      this._sendGameStateUpdate(room);
      if (result.roundEnded) {
        this._broadcastRoundEndAndCleanup(room, result.roundEnded);
      } else if (result.broadcast?.pozzettoTaken) {
        // Going down emptied the hand and auto-took the pot: same player keeps
        // the turn (must still discard). Re-arm a fresh turn timer so they get a
        // full turn to play the 11 new cards instead of being force-skipped by
        // the pre-existing timer. See handlePlayMeld for the full rationale.
        this._startTurnTimer(room);
      }
    } else {
      logger.error(`[GO_DOWN] ✗ Player ${playerId} failed: ${result.error}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(result.error));
    }
  }

  /**
   * Handle add to meld event
   * @param {Socket} socket
   * @param {Object} data
   */
  handleAddToMeld(socket, data) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(playerId);

    if (!room) {
      logger.warn(`[ADD_TO_MELD] Player ${playerId} not in room`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Not in a room'));
      return;
    }

    const player = room.getPlayer(playerId);

    // Prefer the explicit owner + meld index contract. In a 2v2 match the client
    // renders both teammates' melds in one row, so a display index is not enough
    // to identify the authoritative server array.
    let cardsToAdd, targetPlayerIndex, targetMeldIndex;

    if (
      data.targetPlayerIndex !== undefined &&
      data.targetMeldIndex !== undefined &&
      Array.isArray(data.cards)
    ) {
      targetPlayerIndex = data.targetPlayerIndex;
      targetMeldIndex = data.targetMeldIndex;
      cardsToAdd = data.cards;
      logger.info(
        `[ADD_TO_MELD] Player ${playerId} (index: ${player?.playerIndex}) adding ${cardsToAdd.length} card(s) to player ${targetPlayerIndex} meld ${targetMeldIndex} in room ${room.roomId}`
      );
    } else if (data.meldIndex !== undefined && Array.isArray(data.cards)) {
      // Backward compatibility for older clients where meldIndex always meant
      // the current player's own meld array.
      targetPlayerIndex = player.playerIndex;
      targetMeldIndex = data.meldIndex;
      cardsToAdd = data.cards;
      logger.info(
        `[ADD_TO_MELD] Player ${playerId} (index: ${player?.playerIndex}) adding ${cardsToAdd.length} card(s) to own meld ${targetMeldIndex} in room ${room.roomId}`
      );
    } else {
      // Legacy single-card format.
      cardsToAdd = [data.card];
      targetPlayerIndex = data.targetPlayerIndex;
      targetMeldIndex = data.targetMeldIndex;
      logger.info(
        `[ADD_TO_MELD] Player ${playerId} (index: ${player?.playerIndex}) adding card to player ${targetPlayerIndex} meld ${targetMeldIndex} in room ${room.roomId}`
      );
    }

    const result = ActionHandlers.handleAddToMeld(
      room,
      playerId,
      cardsToAdd,
      targetPlayerIndex,
      targetMeldIndex
    );

    if (result.success) {
      this._recordManualAction(room, playerId);
      this.io.to(room.roomId).emit(SocketEvents.ADDED_TO_MELD, result.broadcast);
      logger.info(
        `[ADD_TO_MELD] ✓ Player ${playerId} successfully added card to meld. Sending updated game state.`
      );
      this._gameEvent(room, 'add_to_meld', {
        playerId,
        seat: player?.playerIndex,
        cards: this._briefCards(cardsToAdd),
        targetSeat: targetPlayerIndex,
        targetMeldIndex,
        hand: (room.playerHands.get(playerId) || []).length,
        pozzettoTaken: result.broadcast?.pozzettoTaken || 0,
      });
      // Send updated game state to all players to keep UI in sync. The well
      // broadcast goes FIRST — see _broadcastPozzettoBeforeState.
      this._broadcastPozzettoBeforeState(room, result);
      this._sendGameStateUpdate(room);
      if (result.roundEnded) {
        this._broadcastRoundEndAndCleanup(room, result.roundEnded);
      } else if (result.broadcast?.pozzettoTaken) {
        // Adding to a meld emptied the hand and auto-took the pot: same player
        // keeps the turn (must still discard). Re-arm a fresh turn timer so they
        // aren't force-skipped by the pre-existing timer with a full new hand.
        // See handlePlayMeld for the full rationale.
        this._startTurnTimer(room);
      }
    } else {
      logger.error(`[ADD_TO_MELD] ✗ Player ${playerId} failed: ${result.error}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(result.error));
      // The client performs an optimistic table animation. Reconcile immediately
      // when the server rejects the move so the cards do not appear stuck or lost.
      this._sendGameStateUpdate(room);
    }
  }

  /**
   * Handle pick up pile event
   * @param {Socket} socket
   * @param {Object} data
   */
  handlePickUpPile(socket, data) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(playerId);

    if (!room) {
      logger.warn(`[PICK_UP_PILE] Player ${playerId} not in room`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Not in a room'));
      return;
    }

    const player = room.getPlayer(playerId);
    logger.info(
      `[PICK_UP_PILE] Player ${playerId} (index: ${player?.playerIndex}) requesting to pick up discard pile in room ${room.roomId}. Current turn: ${room.currentTurn}, Pile size: ${room.discardPile.length}`
    );

    // Get the discard pile cards
    const pickedCards = room.discardPile.slice();

    if (pickedCards.length === 0) {
      logger.warn(`[PICK_UP_PILE] ✗ Discard pile is empty for player ${playerId}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Discard pile is empty'));
      return;
    }

    // PRODUCT RULE (revised 2026-08-20): a dead stock no longer cuts the turn
    // short here. The player facing an empty deck with no pozzetto left MAY take
    // the discard pile and play the turn out; the round ends on their DISCARD
    // instead (ActionHandlers.handleDiscard), and nobody else gets a turn after
    // it. Ending at the take robbed that player of the last hand they had every
    // right to play.
    //
    // The DRAW path keeps its own terminal check: with the pile untakeable there
    // genuinely is nothing left to do, so the round ends there as before.

    const result = ActionHandlers.handlePickUpPile(room, playerId, pickedCards);

    if (result.success) {
      this._recordManualAction(room, playerId);
      // Actually add cards to player's hand
      const playerHand = room.playerHands.get(playerId) || [];
      const handSizeBefore = playerHand.length;
      const normalizedPicked = pickedCards.map((c) => this._ensureCardInstance(c));
      // Preserve the player's existing hand order and append the picked pile.
      playerHand.push(...normalizedPicked);
      room.playerHands.set(playerId, playerHand);

      // Clear the discard pile
      room.discardPile = [];

      // Mark that player has drawn this turn
      room.hasDrawnCard = true;

      if (normalizedPicked.length > 0) {
        const topCard = normalizedPicked[normalizedPicked.length - 1];
        room.mustMeldCard = { cardId: topCard.cardId, suit: topCard.suit, rank: topCard.rank };
        // PRODUCT RULE (2026-09-02) — the discard lock has exactly THREE shapes.
        // Stated by the product owner, implemented verbatim here and mirrored
        // clause for clause by GameController.applyPileTakeRestrictions:
        //
        //   A. PILE TAKE OF EXACTLY ONE CARD — the taken card is locked, AND so
        //      is every copy of the same rank+suit ALREADY IN HAND when it
        //      lands ("ambil 8 love / ditangan sudah ada 8 love / ... gaboleh
        //      dibuang"). Without the twin the volley is trivially defeated:
        //      take the 8H off the pile, throw your OWN 8H, and the opponent
        //      watches the identical card come straight back.
        //   B. PILE TAKE OF TWO OR MORE — NOTHING is locked, every taken card
        //      may be thrown, and every existing lock is RELEASED.
        //   C. DECK DRAW (manual AND timeout auto-draw) — the drawn card is
        //      always discardable and the draw releases every lock. See the two
        //      draw paths in this file.
        //
        // This REVERTS the 2026-09-01 hoist that restricted the top card on
        // every take size. The twin half is NOT the old "one card type is stuck
        // forever" bug coming back: that one froze a twin on EVERY take and held
        // it across turns. Here a twin is recruited ONLY by a lone-card take and
        // the very next deck draw or multi-card take releases it.
        if (normalizedPicked.length === 1) {
          // RULE A, per-turn half: the card the pile was taken FOR cannot go
          // straight back this turn. Only nextTurn() wipes the set — a meld no
          // longer lifts it (2026-09-21) — so this is "keep it this turn".
          // Keyed by cardId, falling back to suit-rank only for an id-less card.
          room.drawnCardThisTurnRestriction.add(
            String(topCard.cardId ?? `${topCard.suit}-${topCard.rank}`)
          );
          // RULE A, cross-turn half: the TWINS ride in the LOCK (discardLocks),
          // never in the per-turn set above. That placement is load-bearing, not
          // stylistic — the per-turn set's only escape hatch is handSize === 1,
          // so a two-card hand of {taken, twin} with both in that set would
          // refuse BOTH discards and wedge the turn. _pingPongBlocks yields the
          // moment no OTHER card in hand is discardable, which is exactly what
          // keeps that hand playable (see the wedge test in
          // test/regression/ping_pong_discard_lock.test.js).
          //
          // The twin is found by rank+suit MINUS the taken card's own id, never
          // by "whatever was in the hand before the take": the three call sites
          // (offline take, online take, this one) disagree about when the taken
          // cards land in the hand, and an id comparison is correct under all
          // three orderings.
          const idOf = (c) => (c ? (c.cardId ?? c.instanceId ?? c.id ?? null) : null);
          const topId = idOf(topCard);
          const twins = playerHand.filter(
            (c) =>
              c &&
              c.suit === topCard.suit &&
              c.rank === topCard.rank &&
              (idOf(c) !== null && topId !== null
                ? String(idOf(c)) !== String(topId)
                : c !== topCard)
          );
          // ADDS to the seat's take history rather than replacing it: the shoe is
          // two decks, so an opponent holding both copies can volley them
          // alternately unless both stay held.
          room.armDiscardLock(playerId, topCard, twins);
        } else {
          // RULE B: a multi-card take locks NOTHING and releases EVERYTHING.
          // Throwing the top card back after a multi take leaves a smaller pile
          // and costs a card, so there is no volley left to police.
          room.drawnCardThisTurnRestriction = new Set();
          room.clearDiscardLock(playerId);
        }
      }

      logger.info(
        `[PICK_UP_PILE] ✓ Player ${playerId} picked up ${pickedCards.length} cards. Hand: ${handSizeBefore} → ${playerHand.length}`
      );
      this._gameEvent(room, 'take_pile', {
        playerId,
        seat: player?.playerIndex,
        cards: this._briefCards(pickedCards),
        hand: playerHand.length,
      });

      // Broadcast discard pile taken event (using client-expected event name)
      // Note: client expects 'discard_pile_taken' message type, not 'pile_picked_up'
      const pileTakenMessage = {
        ...result.toPlayer,
        type: 'discard_pile_taken',
      };
      const pileTakenBroadcast = {
        ...result.toOthers,
        type: 'discard_pile_taken',
      };
      socket.emit('discard_pile_taken', pileTakenMessage);
      socket.to(room.roomId).emit('discard_pile_taken', pileTakenBroadcast);

      // Send updated game state to all players AND persist to Redis (via
      // _sendGameStateUpdate → _persistRoomState). Using _sendInitialGameState
      // here skipped persistence, so a server restart between a pile pickup and
      // the next action restored stale state (pile re-appeared, picked cards
      // lost, mustMeldCard/hasDrawnCard dropped).
      this._sendGameStateUpdate(room);
    } else {
      logger.error(`[PICK_UP_PILE] ✗ Player ${playerId} failed: ${result.error}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(result.error));
    }
  }

  /**
   * Send initial game state to all players
   * @private
   * @param {GameRoom} room
   */
  _sendInitialGameState(room) {
    try {
      logger.info(
        `[_sendInitialGameState] Sending game state to ${room.players.size} players in room ${room.roomId}`
      );
      logger.info(
        `[_sendInitialGameState] playerHands keys: ${Array.from(room.playerHands.keys()).join(', ')}`
      );

      // Timer watchdog: if the game is running and cards are dealt but no turn
      // timer is active, the room's timer somehow stopped (reconnect, a missed
      // restart, etc.) — re-arm it so the turn can never be stuck forever (#1).
      if (
        room.isInProgress() &&
        room.cardsDealt &&
        !room.awaitingDealAnimation &&
        !room.turnTimerTickHandle
      ) {
        this._startTurnTimer(room);
      }

      // #5 reconnect badge: per-meld isBuraco/clean flags. Computed ONCE for the
      // whole fan-out — serializeMelds re-serializes every card and runs
      // GameValidator.meldClean per meld, so calling it inside the per-seat loop
      // would pay for the whole table once per seat.
      const meldFlags = room.serializeMelds();

      room.getPlayers().forEach((player) => {
        if (player.isBot === true) return;
        const playerSocket = this.io.sockets.sockets.get(player.socketId);
        if (playerSocket) {
          try {
            // Get player's hand
            const yourHand = room.playerHands.get(player.playerId) || [];
            logger.info(
              `[_sendInitialGameState] Player ${player.playerId} (index: ${player.playerIndex}): yourHand.length = ${yourHand.length}`
            );

            if (yourHand.length === 0) {
              logger.warn(
                `[_sendInitialGameState] ⚠️  WARNING: Player ${player.playerId} has NO cards! playerHands has keys: [${Array.from(room.playerHands.keys()).join(', ')}]`
              );
            }

            // Counts for everyone; actual hand cards only travel to the owner in
            // `yourHand`. Opponent/spectator seats render card backs from counts.
            const otherPlayersHandCounts = {};
            room.getPlayers().forEach((p) => {
              const hand = room.playerHands.get(p.playerId) || [];
              otherPlayersHandCounts[p.playerIndex] = hand.length;
            });

            // Get player melds
            const playerMelds = {};
            room.getPlayers().forEach((p) => {
              playerMelds[p.playerIndex] = room.playerMelds.get(p.playerId) || [];
            });

            const deadPileCounts = Array.isArray(room.deadPiles)
              ? room.deadPiles.map((pile) => (Array.isArray(pile) ? pile.length : 0))
              : [];
            const pozzettosAvailable = deadPileCounts.some((count) => count > 0);
            const pozzettosCardCount = deadPileCounts.reduce((sum, count) => sum + count, 0);

            const gameStatePayload = {
              ...this._serializeRoomGameSettings(room),
              yourPlayerIndex: player.playerIndex,
              currentPlayerIndex: room.currentTurn,
              phase: 'playing',
              // Full seat+bot roster on the main state builder so every client
              // has the authoritative player list (PTW-233).
              players: room.getPlayers().map((p) => this._serializePlayer(p)),
              // Current authoritative timer so a reconnecting / late-joining client
              // shows the right remaining time immediately instead of a stale value.
              // Computed live from the deadline (the server no longer ticks down).
              turnTimeRemaining: room.getTurnTimeRemaining(),
              turnTimeLimit: room.turnTimeLimit,
              turnTimeLimitSeconds: room.turnTimeLimit,
              roomName: room.name || null, // human-readable room name (#4)
              ruleset: room.ruleset,
              professionalWellMode: room.professionalWellMode,
              yourHand: yourHand.map((card) => this._serializeCard(card)),
              otherPlayersHandCounts, // Keep counts for backward compatibility
              discardPile: room.discardPile.map((card) => this._serializeCard(card)),
              deckCount: room.deck?.count || 0,
              pozzettosAvailable,
              pozzettosCardCount,
              deadPileCounts,
              wellsTakenThisRound: room.wellsTakenThisRound || 0,
              playerMelds,
              playerMeldOrders: this._serializePlayerMeldOrders(room),
              hasDrawnCard: room.hasDrawnCard,
              // Authoritative discard restrictions so the CLIENT can validate a
              // discard before sending it (instead of optimistically discarding a
              // card the server will reject, which left the turn stuck — issue 1).
              mustMeldCard: room.mustMeldCard ? this._serializeCard(room.mustMeldCard) : null,
              drawnCardRestriction: Array.from(room.drawnCardThisTurnRestriction || []),
              meldedThisTurn: room.meldedThisTurn || false,
              // ANTI PING-PONG lock for THIS recipient. Per-player (unlike every
              // other field here) because the lock survives turn changes, so
              // several seats can hold one at once. Always present, null when
              // unlocked — the client treats an absent key as "no news" and
              // keeps its local lock, which is what makes a reconnect rebuild
              // rather than silently disarm the rule.
              discardLock: this._serializeDiscardLock(room, player.playerId),
              // NO `playerScores` here. GameRoom.getPlayerScores() returns
              // room.lastRoundScores — the PREVIOUS round's per-seat BREAKDOWN OBJECTS,
              // which startGame() never clears — while the client types the field as
              // Map<int,int> and coerces anything non-numeric to 0. Shipping it on a
              // live state frame therefore zeroed every seat's score on every frame
              // from round 2 onward. The authoritative per-seat breakdown belongs on
              // the round-end / GAME_ENDED payload, and an ABSENT key is read as "the
              // server said nothing", which is exactly right here.
              // The badge flags for EVERY seat's melds. playerMelds above carries
              // the cards but not the verdicts, so a client that rebuilt from a
              // state frame re-derived isBuraco/clean locally — and got them
              // wrong, most visibly paying 200 for a buraco the server closed as
              // dirty (the PRO sticky-dirty flag is server-only state). The
              // server has always built this array; until now nothing emitted it.
              melds: meldFlags,
              ...this._skinsPayloadFields(room),
              timestamp: new Date().toISOString(),
              cardsDealt: room.cardsDealt || false,
              hostId: room.hostPlayerId || null,
              // Product contract is fixed +1 clockwise; the draw chooses only the starter.
              turnDirection: room.turnDirection || 1,
              // Pre-game high-card draw result (cards per player + winner) so the
              // client can animate the "who starts" reveal before play begins.
              firstTurnDraw: room.firstTurnDraw || null,
              // True only during the opening deal window (set in _dealCardsForRoom,
              // cleared when the first turn starts). The client animates the deal +
              // undian ONLY when true; on a later resume/reconnect it's false, so the
              // client snaps to the synced state instead of replaying the deal.
              awaitingDealAnimation: !!room.awaitingDealAnimation,
            };

            // Log payload size for debugging
            const payloadSize = JSON.stringify(gameStatePayload).length;
            logger.debug(
              `[_sendInitialGameState] Sending game state to player ${player.playerId} (${payloadSize} bytes)`
            );
            logger.info(
              `[_sendInitialGameState] ✓ Sending cardsDealt=${gameStatePayload.cardsDealt} to player ${player.playerId}`
            );

            playerSocket.emit(SocketEvents.GAME_STATE_UPDATE, gameStatePayload);
            logger.debug(
              `[_sendInitialGameState] Game state sent successfully to player ${player.playerId}`
            );
          } catch (error) {
            logger.error(
              `[_sendInitialGameState] Error sending game state to player ${player.playerId}: ${error.message}`,
              error
            );
          }
        } else {
          logger.warn(
            `[_sendInitialGameState] Socket not found for player ${player.playerId} (socketId: ${player.socketId}) - State update skipped`
          );
        }
      });

      // A SEATED player must never also receive a spectator frame. The spectator
      // builder sends `yourPlayerIndex: -1`, and it goes out AFTER the seated
      // loop above — so a socket registered in both ends the update with no seat.
      // The client then cannot rotate the board to them or let them act (it looks
      // exactly like spectator mode), and after four such frames its strand
      // recovery gives up with "Could not determine your seat at this table.
      // Please reconnect to continue." — a reconnect prompt on a perfectly
      // healthy connection. That is the reported "user tiba-tiba reconnect
      // padahal koneksi oke, kayak kedetach jadi seakan play tapi terlihat
      // spectator".
      //
      // Guarded here rather than at each registration site because there are
      // several ways a socket can end up in both lists (a stale spectator entry,
      // the owner-controller hook), and the invariant is the same for all of
      // them: whoever holds a seat is told about that seat, full stop.
      const seatedSocketIds = new Set(
        room
          .getPlayers()
          .map((p) => p.socketId)
          .filter(Boolean)
      );

      const spectators = this.roomSpectators.get(room.roomId);
      if (spectators && spectators.size > 0) {
        let prunedStaleSpectator = false;
        spectators.forEach((meta, socketId) => {
          const spectatorSocket = this.io.sockets.sockets.get(socketId);
          if (!spectatorSocket) {
            this._removeSpectatorBySocket(socketId);
            prunedStaleSpectator = true;
            return;
          }
          if (seatedSocketIds.has(socketId)) {
            // They took a seat; the spectator registration is stale. Drop it so
            // the roster stops counting a player as a viewer too.
            this._removeSpectatorBySocket(socketId);
            prunedStaleSpectator = true;
            return;
          }
          this._sendStateToSpectator(spectatorSocket, room, meta.spectatorId, meta.spectatorName);
        });
        if (prunedStaleSpectator) this._broadcastSpectatorsChanged(room.roomId);
      }

      if (
        room.ownerControllerSocketId &&
        !seatedSocketIds.has(room.ownerControllerSocketId)
      ) {
        const ownerSocket = this.io.sockets.sockets.get(room.ownerControllerSocketId);
        if (ownerSocket) {
          this._sendStateToSpectator(
            ownerSocket,
            room,
            room.ownerControllerPlayerId || 'owner-controller',
            'Owner'
          );
        }
      }
    } catch (error) {
      logger.error(
        `[_sendInitialGameState] Error sending game state to room ${room.roomId}: ${error.message}`,
        error
      );
    }
  }

  /**
   * Send game state update to all players (for mid-game updates)
   * @private
   * @param {GameRoom} room
   */
  _sendGameStateUpdate(room) {
    // Reuse the same logic as initial game state
    this._sendInitialGameState(room);
    this._persistRoomState(room);
    this.botCoordinator?.onRoomStateChanged(room);
  }

  // ---------------------------------------------------------------------------
  // Server-authoritative turn timer
  // ---------------------------------------------------------------------------

  /**
   * Start (or restart) the turn timer for the room's current player.
   *
   * Broadcasts TURN_TIMER_STARTED exactly ONCE with the full duration and an
   * absolute deadline, then stays silent: there is no per-second TURN_TIMER_TICK
   * anymore. Each client runs its own 1-second display countdown anchored to the
   * value/deadline it receives, and the server schedules a single setTimeout that
   * fires TURN_TIMER_EXPIRED and auto-advances the turn at expiry.
   *
   * Why: a per-room setInterval broadcasting every second is O(rooms × players)
   * messages/second and does not scale to many concurrent games. One timeout +
   * client-side interpolation cuts that to ~1 message per turn while keeping the
   * server authoritative over expiry (clients never act on their local zero).
   * @param {import('../models/GameRoom')} room
   */
  _startTurnTimer(room, overrideRemainingMs, ownershipRetried = false) {
    if (this._ownershipEnabled() && !this.ownedRoomIds.has(String(room.roomId))) {
      // A freshly dealt room has no lease yet: join_room / start_game / deal_cards
      // are not ownership-wrapped, so ownedRoomIds is empty on the first turn.
      // Returning here would leave the match with no clock, no expiry and no
      // anti-freeze backstop for its entire life, so acquire the lease and arm on
      // the way back instead of giving up. Only ever retried once.
      if (!ownershipRetried) {
        this._ensureRoomOwner(room.roomId, { acquire: true })
          .then((ownership) => {
            if (!ownership?.owned) {
              logger.info(
                `[TURN_TIMER] Not starting timer for ${room.roomId}; node ${this.nodeId} is not owner (owner=${ownership?.owner ?? 'unknown'})`
              );
              return;
            }
            if (!room.isInProgress?.()) return;
            this._startTurnTimer(room, overrideRemainingMs, true);
          })
          .catch((error) => {
            logger.error(
              `[TURN_TIMER] Ownership acquire failed for ${room.roomId}: ${error.message}`
            );
          });
        return;
      }
      logger.info(
        `[TURN_TIMER] Not starting timer for ${room.roomId}; node ${this.nodeId} is not owner`
      );
      return;
    }

    this._stopTurnTimer(room);

    // A fresh timer supersedes any grace-pause bookkeeping (PTW-235).
    room.turnTimerPausedForGrace = false;
    room.turnTimerPausedRemainingMs = null;

    // Turn timer "Off" (turnTimeLimit === 0): unlimited turn — schedule NO expiry
    // timer (a 0ms setTimeout would auto-skip instantly) and tell clients to hide
    // the countdown. This is the host's "Off" choice; the turn never auto-skips.
    if (!room.turnTimeLimit || room.turnTimeLimit <= 0) {
      room.turnTimeRemaining = 0;
      room.turnTimerDeadline = null;
      this.io.to(room.roomId).emit(SocketEvents.TURN_TIMER_STARTED, {
        playerIndex: room.currentTurn,
        seconds: 0,
        durationSeconds: 0,
        deadline: null,
        unlimited: true,
        serverTime: Date.now(),
        timestamp: new Date().toISOString(),
      });
      this.botCoordinator?.onRoomStateChanged(room);

      // R1 anti-freeze watchdog: "Off" still arms a long SILENT timer — no
      // countdown is announced (clients keep showing "unlimited") — that runs the
      // SAME expiry auto-play so the turn is always guaranteed to advance. A
      // disconnected seat gets the short bound so a dead seat can't stall a live
      // table. Re-armed at every turn start (this method runs per turn). Reuses
      // turnTimerTickHandle so _stopTurnTimer and every restart clean it up
      // unchanged.
      const watchdogPlayer = room.getPlayerByIndex(room.currentTurn);
      const seatDisconnected =
        !!watchdogPlayer && !watchdogPlayer.isBot && watchdogPlayer.isConnected === false;
      const watchdogMs = seatDisconnected
        ? SocketHandlers.DISCONNECT_TURN_WATCHDOG_MS
        : SocketHandlers.UNLIMITED_TURN_WATCHDOG_MS;
      room.turnTimerTickHandle = setTimeout(logger.bindRoom(room.roomId, async () => {
        room.turnTimerTickHandle = null;
        if (!room.isInProgress()) return;
        if (this._ownershipEnabled()) {
          const ownership = await this._ensureRoomOwner(room.roomId, { acquire: false });
          if (!ownership.owned) return;
        }
        this._onTurnTimerExpired(room);
      }), watchdogMs);
      return;
    }

    const fullMs = room.turnTimeLimit * 1000;
    // PTW-235 / Bug4a: when resuming after a reconnect, re-arm with the time
    // that was left when the player disconnected (clamped to a full turn and a
    // small floor) instead of granting a fresh full turn.
    const durationMs =
      typeof overrideRemainingMs === 'number' && overrideRemainingMs > 0
        ? Math.min(Math.max(overrideRemainingMs, 1000), fullMs)
        : fullMs;
    const startedAtMs = Date.now();
    room.turnTimeRemaining = Math.ceil(durationMs / 1000);
    room.turnTimerDeadline = startedAtMs + durationMs;

    // Announce timer start to everyone in the room. `deadline`/`serverTime` let
    // a client correct for clock skew if it wants; `seconds`/`durationSeconds`
    // are enough for the simple "anchor to receipt time" countdown clients use.
    this.io.to(room.roomId).emit(SocketEvents.TURN_TIMER_STARTED, {
      playerIndex: room.currentTurn,
      seconds: room.turnTimeRemaining,
      durationSeconds: room.turnTimeLimit,
      deadline: room.turnTimerDeadline,
      serverTime: startedAtMs,
      timestamp: new Date(startedAtMs).toISOString(),
    });

    this.botCoordinator?.onRoomStateChanged(room);

    // Single authoritative expiry timer (no per-second broadcast).
    room.turnTimerTickHandle = setTimeout(logger.bindRoom(room.roomId, async () => {
      room.turnTimerTickHandle = null;
      room.turnTimeRemaining = 0;
      room.turnTimerDeadline = null;
      if (!room.isInProgress()) return;
      if (this._ownershipEnabled()) {
        const ownership = await this._ensureRoomOwner(room.roomId, { acquire: false });
        if (!ownership.owned) return;
      }
      this._onTurnTimerExpired(room);
    }), durationMs);
  }

  /**
   * Stop the turn timer for a room without triggering expiry logic.
   * @param {import('../models/GameRoom')} room
   */
  _stopTurnTimer(room) {
    if (room.turnTimerTickHandle) {
      // clearTimeout/clearInterval are interchangeable for Node timer handles.
      clearTimeout(room.turnTimerTickHandle);
      room.turnTimerTickHandle = null;
    }
    // Also drop a pending deal-animation fallback so it can't fire for a torn-down
    // or already-running room.
    if (room.dealAnimationFallbackHandle) {
      clearTimeout(room.dealAnimationFallbackHandle);
      room.dealAnimationFallbackHandle = null;
    }
    room.awaitingDealAnimation = false;
    room.turnTimerDeadline = null;
  }

  /**
   * PTW-235 / Bug4a: pause the active turn timer because the current player
   * disconnected and is within their reconnect grace window. The time that was
   * left is captured so a reconnect can re-arm with the remaining slice. NO
   * auto-play / skip happens while paused — the human seat is HELD. If grace
   * expires the seat is bot-converted and the bot engine drives it instead.
   * @param {import('../models/GameRoom')} room
   */
  _pauseTurnTimerForGrace(room) {
    if (!room) return;
    const remainingMs = room.turnTimerDeadline
      ? Math.max(0, room.turnTimerDeadline - Date.now())
      : null;
    if (room.turnTimerTickHandle) {
      clearTimeout(room.turnTimerTickHandle);
      room.turnTimerTickHandle = null;
    }
    room.turnTimerDeadline = null;
    room.turnTimerPausedForGrace = true;
    room.turnTimerPausedRemainingMs = remainingMs;
    logger.info(
      `[TURN_TIMER] Paused for grace in room ${room.roomId}; ${remainingMs ?? 'full'}ms held for reconnect`
    );
  }

  /**
   * PTW-235 / Bug4a: resume the turn timer after a reconnect within grace,
   * re-arming with the time that was left when the player disconnected. The
   * turn is NOT advanced — the seat stays human-controlled. No-op if the timer
   * was not paused for grace (e.g. the player reconnected when it was not their
   * turn).
   * @param {import('../models/GameRoom')} room
   */
  _resumeTurnTimerAfterGrace(room) {
    if (!room) return;
    if (!room.turnTimerPausedForGrace) return;
    const remainingMs = room.turnTimerPausedRemainingMs;
    room.turnTimerPausedForGrace = false;
    room.turnTimerPausedRemainingMs = null;
    if (!room.isInProgress()) return;
    logger.info(
      `[TURN_TIMER] Resuming after reconnect in room ${room.roomId}; re-arming ${remainingMs ?? 'full'}ms`
    );
    this._startTurnTimer(room, remainingMs);
  }

  /**
   * Called when the turn timer reaches zero.
   * Auto-draws (if not yet drawn) then auto-discards the first discardable card.
   * @param {import('../models/GameRoom')} room
   */
  /**
   * Deck-out resolution shared by the turn-timer expiry and the bot
   * coordinator: attempts the pozzetto promotion first; if the stock stays
   * permanently dead the round is finalized no-batida and broadcast. The
   * current player declining (letting the timer lapse / a bot with no wanted
   * take) is exactly this case — standard Brazilia ends the hand on deck-out, it
   * never skips seats hoping someone takes the pile.
   * @param {import('../models/GameRoom')} room
   * @returns {boolean} true when the round was ended (callers stop the turn)
   */
  endRoundOnDeckOut(room) {
    if (!room.isInProgress()) return false;
    const refill = ActionHandlers._refillStockOrEndRound(room);
    if (refill && refill.roundEnded) {
      this._broadcastRoundEndAndCleanup(room, refill.roundEnded);
      return true;
    }
    if (room.deck && room.deck.count === 0) {
      logger.info(
        `[DECK_OUT] Stock dead in room ${room.roomId} and the pile was declined — ending round no-batida`
      );
      const ended = ActionHandlers._finalizeRoundNoBatida(room);
      this._broadcastRoundEndAndCleanup(room, ended);
      return true;
    }
    return false;
  }

  _onTurnTimerExpired(room) {
    if (!room.isInProgress()) return;

    const currentPlayer = room.getPlayerByIndex(room.currentTurn);
    if (!currentPlayer) return;

    const playerId = currentPlayer.playerId;

    logger.info(
      `[TURN_TIMER] Timer expired for player ${playerId} (index: ${room.currentTurn}) in room ${room.roomId}`
    );
    this._gameEvent(room, 'timeout', {
      playerId,
      seat: room.currentTurn,
      connected: currentPlayer.isConnected !== false,
      isBot: currentPlayer.isBot === true,
    });

    this.io.to(room.roomId).emit(SocketEvents.TURN_TIMER_EXPIRED, {
      playerIndex: room.currentTurn,
      timestamp: new Date().toISOString(),
    });

    if (this._handleInactiveTurnExpiry(room, currentPlayer)) {
      return;
    }

    // Items 7/8: a DISCONNECTED human's turn is skipped as a penalty — never
    // auto-played for them (auto-play would help the absent player). The inactive
    // counter above climbs each time their turn comes around; at MAX the game
    // ends with the active player as winner (inactivity_forfeit). Force-advance
    // so play keeps moving meanwhile. Connected idle humans / bots fall through
    // to the normal auto-draw + auto-discard below.
    if (!currentPlayer.isBot && currentPlayer.isConnected === false) {
      if (room.isInProgress()) this._forceAdvanceTurn(room);
      return;
    }

    // A card auto-drawn from the deck THIS expiry (null if the player had already
    // drawn). The timeout prefers throwing it back — the player never chose to
    // keep it — over disturbing the rest of the hand.
    let autoDrawnCard = null;

    // Step 1: Auto-draw if not drawn yet
    if (!room.hasDrawnCard) {
      // Stock empty (standard Brazilia): the deck is never refilled. Once the
      // stock is permanently dead, taking the pile is the only continuation and
      // it is strictly OPTIONAL — a lapsed turn is a decline, so the round ends
      // no-batida right here. The old behaviour force-advanced to the next seat
      // instead, and when nobody took the pile (idle humans, declining bots,
      // move-locked players) the game skipped around the table forever — the
      // reported "stuck game". endRoundOnDeckOut also covers deck+pile both
      // empty and the squeeze move-lock via ActionHandlers._deckOutTerminal.
      if (this.endRoundOnDeckOut(room)) return;
      if (room.deck && room.deck.count > 0) {
        const drawnCard = room.deck.draw();
        if (drawnCard) {
          const hand = room.playerHands.get(playerId) || [];
          hand.push(drawnCard); // preserve order; new card goes to the right
          room.playerHands.set(playerId, hand);
          room.hasDrawnCard = true;
          // RULE C (product call 2026-09-02) — A DECK DRAW NEVER LOCKS ANYTHING,
          // manual or timeout auto-draw, and it RELEASES every lock the seat
          // holds. This closes the divergence the notes carried as "the socket's
          // timeout auto-draw restricts the just-drawn card while its manual draw
          // explicitly does not... Unresolved — needs a product call on which
          // draw rule wins". The call is made: the MANUAL rule wins, everywhere.
          // Do not re-add a restriction here — the manual path 40 lines up
          // (`room.drawnCardThisTurnRestriction = new Set()`), the offline
          // GameController._drawFromDeck and the auto-draw below must all agree,
          // or the client offers a discard the server refuses and the turn hangs.
          //
          // Consequence the auto-discard below relies on: the freshly auto-drawn
          // card is now legally throwable, so the "prefer throwing back the card
          // the player never chose to keep" preference can finally fire.
          room.drawnCardThisTurnRestriction = new Set();
          room.clearDiscardLock(playerId);
          autoDrawnCard = drawnCard;
          this._gameEvent(room, 'draw', {
            playerId,
            seat: room.currentTurn,
            card: this._briefCard(drawnCard),
            hand: (room.playerHands.get(playerId) || []).length,
            deck: room.deck?.count ?? null,
            auto: true,
          });
          this.io.to(room.roomId).emit(SocketEvents.CARD_DRAWN, {
            type: 'card_drawn',
            playerIndex: room.currentTurn,
            card: null, // hidden for others
            fromDeck: true,
            autoAdvance: true,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Step 2: Auto-discard. A timeout must never THROW AWAY A WILDCARD (2 / joker):
    // wilds are the most valuable cards in Brazilia, so auto-tossing one punishes an
    // inattentive player far more than a natural card would. Selection order:
    //   1. only cards that PASS validateDiscard (never force an illegal / closing
    //      discard — that would corrupt scoring; see the no-blind-fallback note);
    //   2. prefer NON-WILD cards — a wild is discarded ONLY when no natural card is
    //      legally discardable (e.g. a hand of nothing but wilds);
    //   3. within the preferred pool, throw back a freshly auto-drawn card if we
    //      have one (the player never chose to keep it), else the LOWEST-value card
    //      so the timeout costs the fewest points.
    // If NOTHING is legally discardable, cardToDiscard stays null and we fall
    // through to _forceAdvanceTurn below (turn skipped safely) — this also covers
    // the "only a lone 2 remains" case, where the wild cannot legally close.
    const GameValidator = require('../validators/GameValidator');
    const isWild = (c) => c && (c.rank === 'joker' || c.rank === '2');
    // The SCORING table, not a fourth private copy of it. This used to hard-code
    // the classic values (2 -> 20, joker -> 30) and so was blind to the ruleset:
    // in PROFESSIONAL a 2 is worth 10 and a joker 0, which inverts the ordering
    // and made the "throw the cheapest card" timeout pick the wrong card on
    // every professional table.
    const discardValue = (c) => ActionHandlers._cardValue(c, room.ruleset);
    const legalIn = (h) =>
      h.filter((c) => GameValidator.validateDiscard(room, playerId, c).isValid);

    let hand = room.playerHands.get(playerId) || [];
    let legal = legalIn(hand);

    // NOTHING is legally discardable. The shape that produces it: the player
    // melded their hand down to a single card that cannot legally be thrown —
    // throwing it would empty the hand and close a round they are not entitled
    // to close (no brazilia, or a well still owed). The turn used to be skipped
    // outright, which handed an inattentive player a free turn AND left the
    // table staring at melds that had bought them nothing.
    //
    // Product rule (2026-08-26): TAKE THE MELDS BACK instead. Everything this
    // player laid down THIS TURN returns to their hand — every meld of the turn,
    // not just the last one, since reaching that single card usually took
    // several — and they throw one of the returned cards away. The hand is no
    // longer one card long, so the close guard that blocked the discard no
    // longer applies and the turn ends like any other.
    let meldsReturned = 0;
    if (legal.length === 0) {
      meldsReturned = ActionHandlers.undoTurnMelds(room, playerId);
      if (meldsReturned > 0) {
        hand = room.playerHands.get(playerId) || [];
        legal = legalIn(hand);
        logger.info(
          `[TURN_TIMER] No legal discard for ${playerId}; returned ${meldsReturned} melded card(s) to hand, ${legal.length} now discardable`
        );
      }
    }

    let cardToDiscard = null;
    if (meldsReturned > 0) {
      // Confiscation path: the card thrown is picked AT RANDOM among the legal
      // ones, per the product rule. Deliberately NOT the least-damage pick the
      // ordinary timeout below uses — a player who melded their way into a dead
      // end and then let the clock run out is not owed the kindest card. Legality
      // is still absolute: an illegal or closing discard would corrupt scoring.
      if (legal.length > 0) {
        cardToDiscard = legal[Math.floor(Math.random() * legal.length)];
      }
    } else {
      const nonWild = legal.filter((c) => !isWild(c));
      const pool = nonWild.length > 0 ? nonWild : legal;
      if (pool.length > 0) {
        cardToDiscard = (autoDrawnCard && pool.includes(autoDrawnCard))
          ? autoDrawnCard
          : pool.slice().sort((a, b) => discardValue(a) - discardValue(b))[0];
      }
    }

    let advanced = false;
    if (cardToDiscard) {
      const result = ActionHandlers.handleDiscard(room, playerId, cardToDiscard);
      if (result.success) {
        this._gameEvent(room, 'discard', {
          playerId,
          seat: result.broadcast?.playerIndex ?? null,
          card: this._briefCard(result.broadcast?.card),
          hand: (room.playerHands.get(playerId) || []).length,
          pozzettoTaken: result.broadcast?.pozzettoTaken || 0,
          auto: true,
          meldsReturned,
          nextSeat: result.roundEnded ? null : (result.turnChanged?.newPlayerIndex ?? room.currentTurn),
        });
        this.io.to(room.roomId).emit(SocketEvents.CARD_DISCARDED, {
          ...result.broadcast,
          // >0 when the discard was only possible because this turn's melds were
          // taken back. Carried so the board can explain melds that otherwise
          // vanish for no visible reason; unknown fields are ignored by clients
          // that don't read it yet.
          meldsReturnedOnTimeout: meldsReturned,
        });
        if (result.roundEnded) {
          this._broadcastRoundEndAndCleanup(room, result.roundEnded);
          advanced = true; // round/game over — no new timer needed
        } else if (result.turnChanged) {
          // The auto-discard may also have taken the pot (indirect take): tell
          // clients (take animation + hasPickedDeadPile flip). The turn still
          // advances — the take-discard IS the turn-ending discard. NB:
          // room.currentTurn already points at the NEXT player here, so the
          // taker's index comes from the broadcast, not the room.
          if (result.broadcast?.pozzettoTaken) {
            this.io.to(room.roomId).emit(SocketEvents.POZZETTO_TAKEN, {
              type: 'pozzetto_taken',
              playerIndex: result.broadcast.playerIndex,
              cardCount: result.broadcast.pozzettoTaken,
              timestamp: new Date().toISOString(),
            });
          }
          this.io.to(room.roomId).emit(SocketEvents.TURN_CHANGED, result.turnChanged);
          this._startTurnTimer(room);
          advanced = true;
        }
        this._sendGameStateUpdate(room);
      } else {
        logger.warn(`[TURN_TIMER] Auto-discard failed for ${playerId}: ${result.error}`);
      }
    }

    // Safety net: the turn timer was already stopped above. If no legal discard
    // advanced the turn, the game would FREEZE (no turn change, no new timer).
    // Force the turn forward so play always continues (bug #6 / S-H9).
    if (!advanced && room.isInProgress()) {
      this._forceAdvanceTurn(room);
    }
  }

  /**
   * Is this room's MATCH over for good (as opposed to just a round)?
   *
   * A room outlives its own end by FINISHED_ROOM_GRACE_MS, and the normal end
   * path does not detach player sockets, so a client can still emit start_game
   * into it. startGame() is the per-ROUND reset — it deliberately preserves
   * cumulativeTeamScores — and nothing clears matchResultReported, so restarting
   * a settled match would begin already at or past target AND have its terminal
   * settlement swallowed by the per-match latch.
   *
   * matchResultReported is set only on a terminal end (_notifyBackendGameResult
   * with matchEnded), and lastRoundEndPayload.matchEnded covers a terminal end
   * whose webhook never fired. A ROUND end sets neither, so round N+1 still
   * deals normally from either the local scheduler or wlive's start-game hook.
   * @param {import('../models/GameRoom')} room
   * @returns {boolean}
   */
  _matchIsSettled(room) {
    if (!room) return false;
    if (room.matchResultReported === true) return true;
    return room.lastRoundEndPayload?.matchEnded === true;
  }

  /**
   * Force the turn to the next player and restart the timer. Used only as a
   * last-resort safety net when a timed-out player has no legal auto-discard, to
   * guarantee the game never freezes.
   * @param {import('../models/GameRoom')} room
   */
  _forceAdvanceTurn(room) {
    const previousTurn = room.currentTurn;
    room.nextTurn();
    // Arm the incoming turn the way handleDiscard does. room.nextTurn() resets
    // the phase and the discard restrictions but NOT teamMeldPointsThisTurn or
    // turnMeldedCards, so without this the arriving side keeps last turn's
    // melded-points credit — and that counter is what the minimum-meld audit
    // reads, so a side could clear a raised bar with points it no longer has on
    // the table.
    const arriving = room.getPlayerByIndex(room.currentTurn);
    if (arriving) ActionHandlers._startTurnForPlayer(room, arriving.playerId);
    this.io.to(room.roomId).emit(SocketEvents.TURN_CHANGED, {
      newPlayerIndex: room.currentTurn,
      previousPlayerIndex: previousTurn,
      forced: true,
      timestamp: new Date().toISOString(),
    });
    if (room.getPlayerByIndex(room.currentTurn)) {
      this._startTurnTimer(room);
    }
    this._sendGameStateUpdate(room);
    logger.warn(
      `[TURN_TIMER] Force-advanced turn ${previousTurn} -> ${room.currentTurn} to avoid a frozen game`
    );
    this._gameEvent(room, 'turn_forced', { fromSeat: previousTurn, toSeat: room.currentTurn });
  }

  /**
   * Handle player joining matchmaking queue
   * @param {Socket} socket
   * @param {Object} data - { playerId, playerName, preferences }
   */
  handleJoinMatchmaking(socket, data) {
    const { playerId, playerName, preferences } = data;

    if (!playerId || !playerName) {
      socket.emit(MatchmakingEvents.MATCHMAKING_ERROR, {
        error: 'playerId and playerName are required',
      });
      return;
    }

    const result = this.matchmakingQueue.addToQueue(playerId, playerName, socket.id, preferences);

    if (result.success) {
      socket.emit(MatchmakingEvents.QUEUE_JOINED, {
        success: true,
        queuePosition: result.queuePosition,
        estimatedWait: result.estimatedWait,
        timestamp: new Date().toISOString(),
      });

      logger.info(`${playerName} joined matchmaking queue`);
    } else {
      socket.emit(MatchmakingEvents.MATCHMAKING_ERROR, {
        error: result.error,
      });
    }
  }

  /**
   * Handle player leaving matchmaking queue
   * @param {Socket} socket
   */
  handleLeaveMatchmaking(socket) {
    // Find player by socket ID
    const status = this.matchmakingQueue.getStatus();
    const player = status.players.find((p) => p.socketId === socket.id);

    if (!player) {
      socket.emit(MatchmakingEvents.MATCHMAKING_ERROR, {
        error: 'Not in matchmaking queue',
      });
      return;
    }

    const result = this.matchmakingQueue.removeFromQueue(player.playerId);

    if (result.success) {
      socket.emit(MatchmakingEvents.QUEUE_LEFT, {
        success: true,
        timestamp: new Date().toISOString(),
      });

      logger.info(`${player.playerName} left matchmaking queue`);
    } else {
      socket.emit(MatchmakingEvents.MATCHMAKING_ERROR, {
        error: result.error,
      });
    }
  }

  /**
   * Handle get matchmaking status request
   * @param {Socket} socket
   */
  handleGetMatchmakingStatus(socket) {
    const status = this.matchmakingQueue.getStatus();
    socket.emit(MatchmakingEvents.QUEUE_UPDATE, status);
  }

  /**
   * Setup matchmaking event listeners
   */
  setupMatchmakingListeners() {
    if (!this.matchmakingQueue) return;

    // Listen for match found
    this.matchmakingQueue.on('match_found', (data) => {
      logger.info(`Match found: ${data.roomId}`);

      // Notify all matched players using room data
      // Players are already added to the room, so find them there
      const room = this.gameService.getRoom(data.roomId);

      if (room) {
        logger.info(`Found room with ${room.players.length} players`);

        // First, emit MATCH_FOUND to all players
        room.players.forEach((player) => {
          logger.info(
            `Looking for socket for player ${player.playerId} with socketId ${player.socketId}`
          );
          const playerSocket = this.io.sockets.sockets.get(player.socketId);

          if (playerSocket) {
            // JOIN THE SOCKET.IO ROOM - critical for broadcasts to work!
            playerSocket.join(room.roomId);
            logger.info(`Player ${player.playerId} joined Socket.IO room ${room.roomId}`);

            logger.info(`Emitting MATCH_FOUND to ${player.playerId}`);
            playerSocket.emit(MatchmakingEvents.MATCH_FOUND, {
              roomId: data.roomId,
              players: data.players,
              gameStarted: data.gameStarted,
              timestamp: new Date().toISOString(),
            });
            logger.info(`Successfully emitted MATCH_FOUND to ${player.playerId}`);
          } else {
            logger.warn(
              `No socket found for player ${player.playerId} (socketId: ${player.socketId})`
            );
          }
        });

        // Then send game_started and initial game state to each player
        logger.info(`Sending game state to all players in room ${data.roomId}`);
        room.getPlayers().forEach((player) => {
          if (player.isBot === true) return;
          const playerSocket = this.io.sockets.sockets.get(player.socketId);
          if (playerSocket) {
            // Send game_started
            playerSocket.emit(SocketEvents.GAME_STARTED, {
              ...this._serializeRoomGameSettings(room),
              players: room.getPlayers().map((p) => this._serializePlayer(p)),
              yourPlayerIndex: player.playerIndex,
              currentPlayerIndex: this._announcedTurnIndex(room),
              ruleset: room.ruleset,
              professionalWellMode: room.professionalWellMode,
              turnTimeLimitSeconds: room.turnTimeLimit,
              cardsDealt: room.cardsDealt || false,
              ...this._skinsPayloadFields(room),
              timestamp: new Date().toISOString(),
            });

            // Send game state with dealt cards
            const yourHand = room.playerHands.get(player.playerId) || [];
            const otherPlayersHandCounts = {};
            room.getPlayers().forEach((p) => {
              const handCount = room.playerHands.get(p.playerId)?.length || 0;
              otherPlayersHandCounts[p.playerIndex] = handCount;
            });

            const playerMelds = {};
            room.getPlayers().forEach((p) => {
              playerMelds[p.playerIndex] = room.playerMelds.get(p.playerId) || [];
            });

            playerSocket.emit(SocketEvents.GAME_STATE_UPDATE, {
              ...this._serializeRoomGameSettings(room),
              yourPlayerIndex: player.playerIndex,
              currentPlayerIndex: room.currentTurn,
              phase: 'playing',
              ruleset: room.ruleset,
              professionalWellMode: room.professionalWellMode,
              turnTimeLimit: room.turnTimeLimit,
              turnTimeLimitSeconds: room.turnTimeLimit,
              yourHand: yourHand.map((card) => this._serializeCard(card)),
              otherPlayersHandCounts,
              discardPile: room.discardPile.map((card) => this._serializeCard(card)),
              deckCount: room.deck?.count || 0,
              playerMelds,
              playerMeldOrders: this._serializePlayerMeldOrders(room),
              hasDrawnCard: room.hasDrawnCard,
              // No `playerScores` — see _sendInitialGameState. It carries the
              // PREVIOUS round's breakdown objects into a field the client
              // types Map<int,int>, which zeroes every seat's score.
              cardsDealt: room.cardsDealt || false,
              hostId: room.hostPlayerId || null,
              timestamp: new Date().toISOString(),
            });

            logger.info(`Sent game state to ${player.playerId} with ${yourHand.length} cards`);
          }
        });
      } else {
        logger.error(`Room ${data.roomId} not found!`);
      }
    });

    // Listen for timeout
    this.matchmakingQueue.on('matchmaking_timeout', (data) => {
      const entry = Array.from(this.matchmakingQueue.queue.values()).find(
        (e) => e.playerId === data.playerId
      );

      if (entry) {
        const playerSocket = this.io.sockets.sockets.get(entry.socketId);
        if (playerSocket) {
          playerSocket.emit(MatchmakingEvents.MATCHMAKING_TIMEOUT, {
            playerId: data.playerId,
            waitTime: data.waitTime,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });

    // Listen for queue updates
    this.matchmakingQueue.on('player_joined_queue', (data) => {
      this.io.emit(MatchmakingEvents.QUEUE_UPDATE, {
        queueSize: data.queueSize,
      });
    });

    this.matchmakingQueue.on('player_left_queue', (data) => {
      this.io.emit(MatchmakingEvents.QUEUE_UPDATE, {
        queueSize: data.queueSize,
      });
    });
  }

  /**
   * Execute a bot intent through the same socket handler path used by online
   * players. The bot has no real socket; this adapter only supplies the minimum
   * Socket.IO surface required by existing handlers.
   * @param {string} roomId
   * @param {string} playerId
   * @param {Object} intent
   * @returns {{success:boolean,error?:string}}
   */
  async executeBotIntent(roomId, playerId, intent = {}) {
    return logger.runWithRoom(roomId, () => this._executeBotIntent(roomId, playerId, intent));
  }

  async _executeBotIntent(roomId, playerId, intent = {}) {
    const room = this.gameService.getRoom(roomId);
    if (!room) return { success: false, error: 'Room not found' };

    const ownership = await this._ensureRoomOwner(room.roomId);
    if (!ownership.owned) {
      return { success: false, error: `Room owned by ${ownership.owner || 'another node'}` };
    }

    const player = room.getPlayer(playerId);
    if (!player || player.isBot !== true) {
      return { success: false, error: 'Bot player not found' };
    }

    const internalSocketId = `bot-action:${playerId}`;
    const previousMappedPlayer = this.gameService.socketToPlayer.get(internalSocketId);
    this.gameService.socketToPlayer.set(internalSocketId, playerId);

    let lastError = null;
    const fakeSocket = {
      id: internalSocketId,
      handshake: { headers: {} },
      join: () => {},
      leave: () => {},
      emit: (event, payload) => {
        if (event === SocketEvents.ERROR) {
          lastError = payload?.error || payload?.message || 'Bot action failed';
        }
      },
      to: (targetRoomId) => ({
        emit: (event, payload) => this.io.to(targetRoomId).emit(event, payload),
      }),
    };

    try {
      switch (intent.type) {
      case SocketEvents.DRAW_CARD:
      case 'draw_card':
        this.handleDrawCard(fakeSocket, { fromDeck: intent.fromDeck !== false });
        break;
      case SocketEvents.PICK_UP_PILE:
      case 'pick_up_pile':
        this.handlePickUpPile(fakeSocket, {});
        break;
      case SocketEvents.PLAY_MELD:
      case 'play_meld':
        this.handlePlayMeld(fakeSocket, {
          cards: intent.cards || [],
          meldIndex: intent.meldIndex,
        });
        break;
      case SocketEvents.GO_DOWN:
      case 'go_down':
        this.handleGoDown(fakeSocket, { melds: intent.melds || [] });
        break;
      case SocketEvents.ADD_TO_MELD:
      case 'add_to_meld':
        this.handleAddToMeld(fakeSocket, {
          cards: intent.cards,
          card: intent.card,
          meldIndex: intent.meldIndex,
          targetPlayerIndex: intent.targetPlayerIndex,
          targetMeldIndex: intent.targetMeldIndex,
        });
        break;
      case SocketEvents.TAKE_POZZETTO:
      case 'take_pozzetto':
        this.handleTakePozzetto(fakeSocket, {});
        break;
      case SocketEvents.DISCARD_CARD:
      case 'discard_card':
        this.handleDiscardCard(fakeSocket, { card: intent.card });
        break;
      default:
        return { success: false, error: `Unsupported bot intent: ${intent.type || 'unknown'}` };
      }

      return lastError ? { success: false, error: lastError } : { success: true };
    } catch (error) {
      logger.error(`[BOT] Intent execution crashed for ${playerId}: ${error.message}`, error);
      return { success: false, error: error.message };
    } finally {
      if (previousMappedPlayer) {
        this.gameService.socketToPlayer.set(internalSocketId, previousMappedPlayer);
      } else {
        this.gameService.socketToPlayer.delete(internalSocketId);
      }
    }
  }

  /**
   * Handle take pozzetto (pot) event
   * @param {Socket} socket
   * @param {Object} data
   */
  handleTakePozzetto(socket, data) {
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    const room = this.gameService.getPlayerRoom(playerId);

    if (!room) {
      logger.warn(`[TAKE_POZZETTO] Player ${playerId} not in room`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Not in a room'));
      return;
    }

    const player = room.getPlayer(playerId);
    logger.info(
      `[TAKE_POZZETTO] Player ${playerId} (index: ${player?.playerIndex}) requesting pozzetto in room ${room.roomId}`
    );

    // Validation: turn, availability, already taken, and empty hand before taking
    const validation = GameValidator.validateTakePozzetto(room, playerId);
    if (!validation.isValid) {
      logger.warn(`[TAKE_POZZETTO] Rejected for player ${playerId}: ${validation.error}`);
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse(validation.error));
      return;
    }

    const playerHand = room.playerHands.get(playerId) || [];
    const nextPile = room.deadPiles?.find((pile) => pile.length > 0) || room.pozzetto;
    if (!nextPile || nextPile.length === 0) {
      socket.emit(SocketEvents.ERROR, ErrorHandler.createErrorResponse('Pozzetto not available'));
      return;
    }

    const pozzettoCards = [...nextPile];
    playerHand.push(...pozzettoCards);
    room.playerHands.set(playerId, playerHand);

    // Mark player as having taken pozzetto and consume from deadPiles. The slot
    // is EMPTIED, not removed — the index is the well's identity on the wire
    // (see ActionHandlers._emptyDeadPileSlot).
    ActionHandlers._markTeamPozzettoTaken(room, playerId, 'direct');
    ActionHandlers._emptyDeadPileSlot(room, nextPile);
    room.pozzetto = []; // keep legacy field empty

    logger.info(
      `[TAKE_POZZETTO] ✓ Player ${playerId} took pozzetto (${pozzettoCards.length} cards). Hand: ${playerHand.length - pozzettoCards.length} → ${playerHand.length}`
    );
    this._gameEvent(room, 'take_pozzetto', {
      playerId,
      seat: player?.playerIndex,
      cards: this._briefCards(pozzettoCards),
      hand: playerHand.length,
    });

    // Emit to all players
    this.io.to(room.roomId).emit(SocketEvents.POZZETTO_TAKEN, {
      type: 'pozzetto_taken',
      playerIndex: player.playerIndex,
      cardCount: pozzettoCards.length,
      timestamp: new Date().toISOString(),
    });

    // Send a full authoritative state update. The Flutter parser expects a
    // complete GAME_STATE_UPDATE payload, not a partial hand-only patch.
    this._sendGameStateUpdate(room);

    // Taking the pot refills the hand and the SAME player keeps the turn (they
    // must still discard). Re-arm a fresh turn timer so the pre-existing timer
    // can't force-skip them with a full new hand. Emits TURN_TIMER_STARTED,
    // which the client mirrors via applyServerTurnTimer.
    this._startTurnTimer(room);
  }

  /**
   * Handle undo_meld event — allow the current player to retract the last meld played this turn.
   * Can only be done before discarding; snapshot is cleared on discard.
   * @param {Socket} socket
   * @param {Object} data
   */
  handleUndoMeld(socket, data) {
    // UNDO REMOVED: the Brazilia-pro revision drops meld undo entirely (the client
    // removes the button). The server keeps the event registered but treats it as
    // an inert no-op so a stale client can never roll back an authoritative meld.
    // No state is mutated and no MELD_UNDONE is broadcast.
    const playerId = this.gameService.getPlayerIdBySocket(socket.id);
    logger.info(`[UNDO_MELD] Ignored — undo is disabled (player ${playerId})`);
  }
}

module.exports = SocketHandlers;
