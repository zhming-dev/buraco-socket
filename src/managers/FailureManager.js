/**
 * FailureManager - Production-Ready Implementation
 * 
 * Handles all failure management operations:
 * - Grace periods
 * - Reconnections
 * - Host migrations
 * - Bot conversions
 * - State persistence
 * 
 * Usage:
 *   const failureManager = new FailureManager(io, redis, gameManager, logger);
 *   failureManager.handlePlayerDisconnection(socket, userId, roomId);
 */

const EventEmitter = require('events');

class FailureManager extends EventEmitter {
  constructor(io, redis, gameManager, logger) {
    super();
    this.io = io;
    this.redis = redis;
    this.gameManager = gameManager;
    this.logger = logger;
    
    // Configuration (can be overridden)
    this.GRACE_PERIOD_SECONDS = 30;
    this.AUTO_SKIP_SECONDS = 10;
    this.BOT_TURN_DELAY_MS = 2000;
    this.SESSION_TTL_SECONDS = 7200;
    this.STATE_TTL_SECONDS = 7200;
    
    // Timers tracking (for cleanup)
    this.timers = new Map(); // autoskip:userId:roomId -> setTimeout id
    this.graceTimers = new Map(); // grace:userId:roomId -> timeout id

    // Single turn/bot engine: when wired (from index.js) grace-expiry bot
    // takeovers are driven by the canonical BotCoordinator instead of the old
    // in-manager draw/discard duplicate (P1-9). Null in unit tests, where we
    // fall back to a canonical room.nextTurn() skip.
    this.botCoordinator = null;
    this.ensureRoomOwnerForMutation = null;

    // Set by persistAllGames() once the final restart snapshot of every room
    // has been captured: from then on persistGameState is a no-op, so a
    // straggling per-action / grace write (e.g. from a disconnect that landed
    // a few ms before SIGTERM) can never overwrite the final snapshot after
    // GameService.shutdown() has wiped the intermission fields.
    this._snapshotFrozen = false;

    // Turn-timer control hook (wired from SocketHandlers). Lets the failure
    // manager PAUSE the active turn timer while a disconnected human is within
    // their reconnect grace window, and RESUME it (with the time that was left)
    // on reconnect — instead of auto-skipping/auto-playing a still-human seat
    // (PTW-235 / Bug4a). Null in unit tests, where there is no live timer.
    this.turnTimerControl = null;
  }
  
  // =========================================================================
  // PUBLIC API
  // =========================================================================
  
  /**
   * Handle initial player connection (new or reconnection)
   * Called from: socket.on('join_game', ...)
   */
  async handlePlayerConnection(socket, { userId, roomId, previousSocketId, userName }) {
    const START = Date.now();
    this.logger.info(`[FailureManager] Player connection: ${userId}, room: ${roomId}`);
    
    try {
      // Check if this is a reconnection
      if (previousSocketId) {
        const success = await this._handleReconnection(
          socket,
          userId,
          roomId,
          previousSocketId,
          userName
        );
        
        if (success) {
          this.logger.info(
            `[FailureManager] ✓ Reconnection successful (${Date.now() - START}ms)`
          );
          return { success: true, isReconnection: true };
        }
      }
      
      // New connection
      return await this._handleNewConnection(socket, userId, roomId, userName);
    } catch (error) {
      this.logger.error(`[FailureManager] Connection error: ${error.message}`);
      return {
        success: false,
        error: 'Connection failed',
      };
    }
  }
  
  /**
   * Handle player disconnection (unintentional)
   * Called from: socket.on('disconnect', ...)
   */
  async handlePlayerDisconnection(socket, userId, roomId) {
    this.logger.warn(
      `[FailureManager] Player disconnected: ${userId} from room ${roomId}`
    );
    
    try {
      const room = this.gameManager.getRoom(roomId);
      if (!room) {
        this.logger.warn(`[FailureManager] Room not found: ${roomId}`);
        return;
      }
      
      const player = room.getPlayer(userId);
      if (!player) {
        this.logger.warn(`[FailureManager] Player not found: ${userId}`);
        return;
      }

      if (!(await this._canMutateRoom(room, 'disconnect grace'))) {
        return;
      }
      
      // Enter grace period
      await this._enterGracePeriod(room, player, socket.id);
    } catch (error) {
      this.logger.error(
        `[FailureManager] Disconnection handler error: ${error.message}`
      );
    }
  }
  
  /**
   * Persist entire game state to Redis
   * Called after every game action
   */
  async persistGameState(room) {
    if (this._snapshotFrozen) return;
    try {
      const stateKey = `game:${room.roomId}:state`;
      
      const gameState = {
        roomId: room.roomId,
        name: room.name,
        maxPlayers: room.maxPlayers,
        hostPlayerId: room.hostPlayerId,
        hostPlayerIndex: room.hostPlayerIndex,
        status: room.status,
        currentTurn: room.currentTurn,
        phase: room.phase,
        ruleset: room.ruleset,
        professionalWellMode: room.professionalWellMode,
        targetScore: room.targetScore,
        nextRoundDelayMs: room.nextRoundDelayMs ?? null,
        // #11 multi-round: a room mid-intermission is FINISHED with a live 10s
        // timer. Timer HANDLES are not serialisable, so persist the intent + the
        // ABSOLUTE deadline and let the resume path re-arm with the remaining
        // time. Without these two fields a restart during the round-over card
        // loses the match: the room reloads FINISHED, nothing re-schedules the
        // deal, and it lingers until GameService's 1-hour FINISHED sweep.
        awaitingNextRound: room.awaitingNextRound === true,
        nextRoundAt: room.nextRoundAt || null,
        chatEnabled: room.chatEnabled,
        skinOverride: room.skinOverride || null,
        visibility: room.visibility,
        hasPassword: room.hasPassword,
        bet: room.bet,
        settingsInitialized: Boolean(room._settingsInitialized),
        cardsDealt: room.cardsDealt,
        createdAt: room.createdAt?.toISOString(),
        gameStartedAt: room.gameStartedAt?.toISOString(),
        gameEndedAt: room.gameEndedAt?.toISOString(),
        winnerId: room.winnerId,
        deck: this._serializeCards(room.deck?.cards || []),
        discardPile: this._serializeCards(room.discardPile || []),
        deadPiles: (room.deadPiles || []).map((pile) => this._serializeCards(pile || [])),
        pozzetto: this._serializeCards(room.pozzetto || []),
        playerHands: this._serializeCardMap(room.playerHands),
        playerMelds: this._serializeMeldMap(room.playerMelds),
        playerMeldOrders: this._serializeMap(room.playerMeldOrders),
        nextMeldOrder: room.nextMeldOrder || 0,
        playerHasTakenPozzetto: this._serializeMap(room.playerHasTakenPozzetto),
        playerPozzettoTakeMode: this._serializeMap(room.playerPozzettoTakeMode),
        playerDeadPileCount: this._serializeMap(room.playerDeadPileCount),
        wellsTakenThisRound: room.wellsTakenThisRound || 0,
        // TWO fields on purpose, for mixed-version safety in BOTH directions:
        // `meldDirtyFlags` keeps the LEGACY shape (bare indices) so a
        // rolled-back build restoring this snapshot rebuilds a working Set —
        // every latch reads 'dirty' there, which is conservative and can never
        // hand a 200 to a meld that earned 100. The grades ride separately in
        // `meldGradeFlags` ([idx, grade] pairs); the restore below prefers
        // them when present. Serializing pairs INTO meldDirtyFlags instead
        // made the old build's `dirtySet.has(index)` miss every latch — a
        // silent upgrade across a rollback.
        meldDirtyFlags: this._serializeMap(room.meldDirtyFlags, (flags) =>
          flags instanceof Map ? Array.from(flags.keys()) : Array.from(flags || [])),
        meldGradeFlags: this._serializeMap(room.meldDirtyFlags, (flags) =>
          flags instanceof Map
            ? Array.from(flags.entries())
            : Array.from(flags || []).map((idx) => [idx, 'dirty'])),
        teamMeldPointsThisTurn: this._serializeMap(room.teamMeldPointsThisTurn),
        // The cards laid this turn, so a host migration mid-turn cannot leave the
        // minimum-meld audit charging 100 with nothing to hand back: the POINTS
        // were already persisted above, and the two have to travel together.
        turnMeldedCards: this._serializeMap(room.turnMeldedCards),
        // Without these a failover restarts the match at round 1: the ceremony
        // replays mid-match and the leader loses the opening turn they earned.
        roundNumber: room.roundNumber || 0,
        lastRoundWinnerIndex:
          room.lastRoundWinnerIndex === undefined ? null : room.lastRoundWinnerIndex,
        // Per-round absence record. Losing it on a host migration would hand a
        // player who keeps dropping out a clean slate they did not earn.
        offlineStrikes: this._serializeMap(room.offlineStrikes),
        teamRequiredMeldPoints: this._serializeMap(room.teamRequiredMeldPoints),
        teamTurnPenalty: this._serializeMap(room.teamTurnPenalty),
        cumulativeScores: this._serializeMap(room.cumulativeScores),
        cumulativeTeamScores: this._serializeMap(room.cumulativeTeamScores),
        lastRoundScores: room.lastRoundScores || {},
        lastTeamScores: room.lastTeamScores || {},
        lastBatidaType: room.lastBatidaType || null,
        lastRoundEndPayload: room.lastRoundEndPayload || null,
        // Persist the backend callback base URL (from sync-room) so a rehydrated
        // room still routes its webhooks (room-closed / player-left / game-result
        // settlement) to the CORRECT backend after a restart, not the default.
        backendBaseUrl: room.backendBaseUrl || null,
        seatReservationProtocol: room.seatReservationProtocol || 0,
        seatConnectionProtocol: room.seatConnectionProtocol || 0,
        seatLayoutProtocol: room.seatLayoutProtocol || 0,
        startAttemptProtocol: room.startAttemptProtocol || 0,
        startAttemptId: room.startAttemptId || null,
        hasDrawnCard: room.hasDrawnCard,
        turnHadManualAction: room.turnHadManualAction,
        drawnCardThisTurnRestriction: Array.from(room.drawnCardThisTurnRestriction || []),
        meldedThisTurn: room.meldedThisTurn,
        mustMeldCard: room.mustMeldCard ? this._serializeCard(room.mustMeldCard) : null,
        // ANTI PING-PONG locks, as [playerId, {suit, rank}] pairs. A field
        // missing from this snapshot is silently lost on host migration — here
        // that means the server forgets a lock every client still enforces, so
        // the client forbids a discard the server allows.
        discardLocks: Array.from(room.discardLocks || []),
        turnTimeLimit: room.turnTimeLimit,
        turnTimeRemaining: room.getTurnTimeRemaining ? room.getTurnTimeRemaining() : room.turnTimeRemaining,
        // Exact ms left on the live turn timer (null when none is armed). The
        // seconds field above is a rounded client-facing snapshot; this one is
        // what the deploy-restart resume re-arms the interrupted turn from, so
        // a player gets back the time they actually had, not a fresh full turn
        // and not a stale value from the last action.
        turnTimerRemainingMs:
          room.turnTimerDeadline != null ? Math.max(0, room.turnTimerDeadline - Date.now()) : null,
        
        players: room.getPlayers().map(p => ({
          apiSeatReservationVersion: p.apiSeatReservationVersion ?? null,
          playerId: p.playerId,
          playerName: p.playerName,
          playerIndex: p.playerIndex,
          socketId: p.socketId,
          avatarUrl: p.avatarUrl || null,
          status: p.status,
          isConnected: p.isConnected,
          isBot: p.isBot,
          botDifficulty: p.botDifficulty,
          connectedAt: p.connectedAt?.toISOString(),
          joinedAt: p.joinedAt?.toISOString(),
          lastActivity: p.lastActivity?.toISOString(),
        })),
        
        lastUpdatedAt: new Date().toISOString(),
      };
      
      await this.redis.setex(
        stateKey,
        this.STATE_TTL_SECONDS,
        JSON.stringify(gameState)
      );
      
      this.logger.debug(`[FailureManager] State persisted: ${room.roomId}`);
    } catch (error) {
      this.logger.error(
        `[FailureManager] State persistence error: ${error.message}`
      );
    }
  }
  
  /**
   * Final durable snapshot of EVERY live room, for a graceful restart. Every
   * snapshot object is built synchronously in one tick (persistGameState only
   * yields at its Redis write), so no timer or bot can mutate a room between
   * "captured" and "written". Bounded by `timeoutMs` so a slow Redis can never
   * hold the process open; whatever did not land keeps the per-action snapshot
   * that was already there.
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{total: number, persisted: number, timedOut: boolean}>}
   */
  async persistAllGames({ timeoutMs = 5000 } = {}) {
    const rooms = Array.from(this.gameManager?.rooms?.values?.() || []);
    if (rooms.length === 0) return { total: 0, persisted: 0, timedOut: false };
    const writes = rooms.map((room) =>
      this.persistGameState(room).then(
        () => true,
        () => false
      )
    );
    // Every snapshot object above is already built (persistGameState runs
    // synchronously up to its Redis write); nothing may write after this.
    this._snapshotFrozen = true;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([Promise.all(writes), timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.logger.warn(
        `[FailureManager] Final snapshot timed out after ${timeoutMs}ms (${rooms.length} rooms)`
      );
      return { total: rooms.length, persisted: 0, timedOut: true };
    }
    const persisted = outcome.filter(Boolean).length;
    this.logger.warn(
      `[FailureManager] Final snapshot written for ${persisted}/${rooms.length} room(s) before restart`
    );
    return { total: rooms.length, persisted, timedOut: false };
  }

  /**
   * Send full game state to a specific player
   * Used after reconnection
   */
  sendFullGameStateToPlayer(socket, room, player) {
    try {
      const state = {
        roomId: room.roomId,
        hostPlayerId: room.hostPlayerId,
        hostPlayerIndex: room.hostPlayerIndex,
        currentTurn: room.currentTurn,
        phase: room.phase,
        cardsDealt: room.cardsDealt,
        deckCount: room.deck?.count || 0,
        discardPile: this._serializeCards(room.discardPile.slice(-5)),
        playerIndex: player.playerIndex,
        myHand: this._serializeCards(room.playerHands.get(player.playerId) || []),
        
        otherPlayers: room
          .getPlayers()
          .filter(p => p.playerId !== player.playerId)
          .map(p => ({
            playerId: p.playerId,
            playerIndex: p.playerIndex,
            handCount: (room.playerHands.get(p.playerId) || []).length,
            meldCount: (room.playerMelds.get(p.playerId) || []).length,
            status: p.status,
            isBot: p.isBot,
          })),
        
        timestamp: new Date().toISOString(),
      };
      
      socket.emit('full_game_state', state);
      this.logger.debug(`[FailureManager] Full state sent to player ${player.playerId}`);
    } catch (error) {
      this.logger.error(
        `[FailureManager] Full state error: ${error.message}`
      );
    }
  }
  
  /** Redis key of the admin-wide skin override (survives restarts until it expires). */
  static get GLOBAL_SKIN_OVERRIDE_KEY() {
    return 'skins:global_override';
  }

  /**
   * Persists (or removes, when `state` is null) the global skin override. The
   * TTL follows the override's own expiry so an expired override never
   * resurrects a table after a restart.
   * @param {{skins: Object, expiresAt: (string|null), setBy: (string|null), setAt: string}|null} state
   */
  async persistGlobalSkinOverride(state) {
    try {
      const key = FailureManager.GLOBAL_SKIN_OVERRIDE_KEY;
      if (!state) {
        await this.redis.del(key);
        return;
      }
      const json = JSON.stringify(state);
      const expiresMs = state.expiresAt ? Date.parse(state.expiresAt) - Date.now() : NaN;
      if (Number.isFinite(expiresMs)) {
        if (expiresMs <= 0) {
          await this.redis.del(key);
          return;
        }
        await this.redis.setex(key, Math.ceil(expiresMs / 1000), json);
      } else {
        await this.redis.set(key, json);
      }
    } catch (error) {
      this.logger.error(`[FailureManager] Global skin override persistence error: ${error.message}`);
    }
  }

  /** The persisted global skin override, or null. */
  async loadGlobalSkinOverride() {
    try {
      const json = await this.redis.get(FailureManager.GLOBAL_SKIN_OVERRIDE_KEY);
      if (!json) return null;
      const state = JSON.parse(json);
      return state && typeof state === 'object' ? state : null;
    } catch (error) {
      this.logger.error(`[FailureManager] Global skin override load error: ${error.message}`);
      return null;
    }
  }

  /**
   * Load all persisted games on server startup
   */
  async loadPersistedGames() {
    this.logger.warn('[FailureManager] Loading persisted games...');

    try {
      const gameKeys = await this.redis.keys('game:*:state');
      let count = 0;

      for (const key of gameKeys) {
        try {
          const stateJson = await this.redis.get(key);
          const state = JSON.parse(stateJson);

          // Never resurrect a match that already ended. The snapshot outlives
          // the room (it is written on every action and only expires with its
          // 2h TTL — deleting a room does not delete its key), so a restart
          // within that window used to rehydrate long-dead tables as ZOMBIE
          // rooms: still holding their old roster, still binding those playerIds
          // in playerToRoom, and still on the inactivity sweep's list. When the
          // sweep finally reaped one, it dragged the mappings of players who had
          // long since moved to a new room down with it. An intermission room is
          // FINISHED but very much alive — restore that one.
          if (this._isTerminalState(state)) {
            await this.removePersistedGame(state.roomId);
            this.logger.info(
              `[FailureManager] Skipped ended game: ${state.roomId} (status=${state.status}) — snapshot purged`
            );
            continue;
          }

          // Reconstruct GameRoom from state
          const room = this._reconstructGameRoom(state);
          this.gameManager.rooms.set(state.roomId, room);
          this._restoreGameManagerMappings(room);

          count++;
          this.logger.info(`[FailureManager] ✓ Restored game: ${state.roomId}`);
        } catch (error) {
          this.logger.error(`[FailureManager] Failed to restore ${key}: ${error.message}`);
        }
      }

      this.logger.warn(`[FailureManager] ✓ Loaded ${count} persisted games`);
      return count;
    } catch (error) {
      this.logger.error(`[FailureManager] Load error: ${error.message}`);
      return 0;
    }
  }

  /**
   * A persisted snapshot whose match is over for good — safe to drop instead of
   * rehydrating. The round-over intermission is excluded: it is FINISHED on
   * paper but owns a live next-round timer and the cumulative score.
   * @private
   */
  _isTerminalState(state) {
    if (!state || state.awaitingNextRound === true) return false;
    return state.status === 'finished' || state.status === 'abandoned';
  }

  /**
   * Drop a room's persisted snapshot. Called when the room is torn down (and at
   * boot for already-ended snapshots) so a deleted room can never come back on
   * the next restart.
   * @param {string} roomId
   */
  async removePersistedGame(roomId) {
    if (!roomId) return false;
    try {
      await this.redis.del(`game:${roomId}:state`);
      return true;
    } catch (error) {
      this.logger.error(
        `[FailureManager] Failed to purge persisted state for ${roomId}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Restore one persisted room into the local GameService. Used by room-owner
   * failover: after the previous owner stops renewing its lease, the new owner
   * rehydrates the minimal runtime before restarting timers/bots.
   */
  async restorePersistedRoom(roomId) {
    if (!roomId) return null;
    try {
      const stateJson = await this.redis.get(`game:${roomId}:state`);
      if (!stateJson) return null;
      const state = JSON.parse(stateJson);
      const room = this._reconstructGameRoom(state);
      this.gameManager.rooms.set(room.roomId, room);
      this._restoreGameManagerMappings(room);
      this.logger.info(`[FailureManager] ✓ Restored room for owner failover: ${room.roomId}`);
      return room;
    } catch (error) {
      this.logger.error(`[FailureManager] Restore room ${roomId} failed: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Cleanup: remove expired grace periods and zombie sessions
   */
  async cleanup() {
    try {
      // Sessions auto-cleanup via Redis TTL
      // Grace periods auto-cleanup via Redis TTL
      this.logger.debug('[FailureManager] Cleanup complete (TTL-based)');
    } catch (error) {
      this.logger.error(`[FailureManager] Cleanup error: ${error.message}`);
    }
  }
  
  /**
   * Get a specific configuration value
   */
  getConfig(key) {
    const configMap = {
      GRACE_PERIOD_SECONDS: this.GRACE_PERIOD_SECONDS,
      AUTO_SKIP_SECONDS: this.AUTO_SKIP_SECONDS,
      BOT_TURN_DELAY_MS: this.BOT_TURN_DELAY_MS,
    };
    return configMap[key];
  }
  
  /**
   * Set a configuration value
   */
  setConfig(key, value) {
    if (key === 'GRACE_PERIOD_SECONDS') this.GRACE_PERIOD_SECONDS = value;
    if (key === 'AUTO_SKIP_SECONDS') this.AUTO_SKIP_SECONDS = value;
    if (key === 'BOT_TURN_DELAY_MS') this.BOT_TURN_DELAY_MS = value;
  }
  
  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================
  
  /**
   * Handle new connection
   */
  async _handleNewConnection(socket, userId, roomId, userName) {
    try {
      const room = this.gameManager.getRoom(roomId);
      if (!room) {
        return {
          success: false,
          error: 'Room not found',
        };
      }
      
      const player = room.getPlayer(userId);
      if (!player) {
        return {
          success: false,
          error: 'Player not in room',
        };
      }
      
      // Update player connection
      player.socketId = socket.id;
      player.status = 'connected';
      if (typeof player.markActive === 'function') {
        player.markActive();
      }
      player.connectedAt = new Date();
      
      // Save session mapping
      const sessionKey = `session:${socket.id}`;
      await this.redis.setex(
        sessionKey,
        this.SESSION_TTL_SECONDS,
        JSON.stringify({
          userId,
          roomId,
          userName,
          connectedAt: new Date().toISOString(),
        })
      );
      
      // Notify others
      this.io.to(roomId).emit('player_joined', {
        playerId: userId,
        playerIndex: player.playerIndex,
        userName,
      });
      
      this.logger.info(`[FailureManager] ✓ New connection: ${userId}`);
      return { success: true, isReconnection: false };
    } catch (error) {
      this.logger.error(`[FailureManager] New connection error: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }
  
  /**
   * Handle reconnection
   */
  async _handleReconnection(socket, userId, roomId, previousSocketId, userName) {
    try {
      // Validate previous session. The socket→session mapping is deleted when
      // the player enters grace (_enterGracePeriod), so on a grace reconnect the
      // previous-socket session is usually already gone. The durable record for
      // a reconnect-within-grace is the grace marker (grace:userId:roomId), so
      // fall back to it for identity validation (PTW-235 / Bug4a). Without this
      // fallback every disconnect-within-turn reconnect failed with "no session"
      // and the seat was treated as a new connection instead of restored.
      const sessionKey = `session:${previousSocketId}`;
      const sessionJson = await this.redis.get(sessionKey);

      let session = sessionJson ? JSON.parse(sessionJson) : null;

      if (!session) {
        const graceJson = await this.redis.get(`grace:${userId}:${roomId}`);
        if (!graceJson) {
          this.logger.warn(
            `[FailureManager] Invalid reconnection: no session for ${previousSocketId} and no active grace for ${userId}`
          );
          return false;
        }
        const grace = JSON.parse(graceJson);
        // Reconstruct an equivalent session from the grace marker so the
        // identity check below still runs against authoritative server state.
        session = {
          userId: grace.userId,
          roomId: grace.roomId,
          userName: userName || grace.userName,
        };
      }

      // Verify identity
      if (session.userId !== userId || session.roomId !== roomId) {
        this.logger.error(
          `[FailureManager] Reconnection fraud detected: ${userId}`
        );
        socket.emit('reconnect_failed', { reason: 'Identity mismatch' });
        socket.disconnect();
        return false;
      }

      const room = this.gameManager.getRoom(roomId);
      if (!room) {
        this.logger.warn(`[FailureManager] Room not found for reconnect: ${roomId}`);
        return false;
      }
      
      const player = room.getPlayer(userId);
      if (!player) {
        this.logger.warn(`[FailureManager] Player not found for reconnect: ${userId}`);
        return false;
      }
      
      // Restore player connection
      player.socketId = socket.id;
      player.status = 'connected';
      if (typeof player.markActive === 'function') {
        player.markActive();
      }
      player.reconnectedAt = new Date();
      
      // Delete grace period
      const graceKey = `grace:${userId}:${roomId}`;
      await this.redis.del(graceKey);
      
      // Cancel grace period timeout if pending
      if (this.graceTimers.has(graceKey)) {
        clearTimeout(this.graceTimers.get(graceKey));
        this.graceTimers.delete(graceKey);
        this.logger.debug('[FailureManager] Cancelled grace period timeout');
      }

      // Cancel any pending auto-skip timer for this player on reconnect (P1-9 /
      // PTW-235): the player is back, their turn must not be auto-skipped out
      // from under them. Auto-skip is no longer scheduled (Bug4a fix), but the
      // cancel stays defensive in case a stale timer exists from an older path.
      const autoSkipKey = `autoskip:${userId}:${roomId}`;
      if (this.timers.has(autoSkipKey)) {
        clearTimeout(this.timers.get(autoSkipKey));
        this.timers.delete(autoSkipKey);
        this.logger.debug('[FailureManager] Cancelled auto-skip timer');
      }

      // PTW-235 / Bug4a: if it is still this player's turn, RESUME the turn
      // timer that was paused on disconnect — re-arming with the time that was
      // left so the returning human gets their remaining seconds and the turn
      // is NOT advanced. The seat stays human-controlled.
      if (room.currentTurn === player.playerIndex) {
        this.turnTimerControl?.resume?.(room);
      }
      
      // Update session mapping
      const newSessionKey = `session:${socket.id}`;
      await this.redis.setex(
        newSessionKey,
        this.SESSION_TTL_SECONDS,
        JSON.stringify({
          userId,
          roomId,
          userName: session.userName || userName || player.playerName,
          reconnectedAt: new Date().toISOString(),
        })
      );
      
      // Delete old session
      await this.redis.del(sessionKey);
      
      // Notify others
      this.io.to(roomId).emit('player_reconnected', {
        playerId: userId,
        playerIndex: player.playerIndex,
        timestamp: new Date().toISOString(),
      });
      
      // Send full game state
      this.sendFullGameStateToPlayer(socket, room, player);
      
      // Persist state
      await this.persistGameState(room);
      
      this.logger.info(`[FailureManager] ✓ Reconnection successful: ${userId}`);
      return true;
    } catch (error) {
      this.logger.error(`[FailureManager] Reconnection error: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Release a seat from grace on a PLAIN rejoin — no previousSocketId required.
   *
   * _handleReconnection does the same work, but only for a client that tells us
   * which socket it lost. The shipped Flutter client never does: socket_io_client
   * nulls Socket.id one line BEFORE it emits `disconnect`, so the id the client
   * tries to capture is always null and `join_room.previousSocketId` is always
   * absent. That made the whole recovery branch — grace-key deletion, grace-timer
   * cancellation, turn-timer resume — unreachable in production, and a player who
   * returned inside the grace window stayed stamped `grace_period` until the
   * expiry timer converted their seat to a bot.
   *
   * This is the identity-free half of that recovery, keyed on the seat we have
   * already re-bound. It deliberately does NOT emit `player_reconnected` —
   * handleJoinRoom emits that itself — and it does not send state, so it can be
   * called before the normal `_sendInitialGameState`.
   *
   * @param {string} userId
   * @param {string} roomId
   * @param {GameRoom} room
   * @param {PlayerSession} player
   * @returns {Promise<boolean>} whether a grace record was actually released
   */
  async clearGraceForReconnect(userId, roomId, room, player) {
    try {
      if (!room || !player) return false;
      const graceKey = `grace:${userId}:${roomId}`;
      const hadTimer = this.graceTimers.has(graceKey);
      // The redis marker is the durable record. The player's own status is NOT a
      // reliable tell: _enterGracePeriod stamps 'grace_period' and then calls
      // player.disconnect(), which immediately overwrites it with 'disconnected'.
      const hadGrace = hadTimer || (await this.redis.get(graceKey)) != null;

      player.status = 'connected';
      if (typeof player.markActive === 'function') player.markActive();
      player.reconnectedAt = new Date();

      await this.redis.del(graceKey);

      if (hadTimer) {
        clearTimeout(this.graceTimers.get(graceKey));
        this.graceTimers.delete(graceKey);
      }

      // Defensive: auto-skip is no longer scheduled, but a stale timer from an
      // older path must not fire on a seat whose owner is back.
      const autoSkipKey = `autoskip:${userId}:${roomId}`;
      if (this.timers.has(autoSkipKey)) {
        clearTimeout(this.timers.get(autoSkipKey));
        this.timers.delete(autoSkipKey);
      }

      if (room.currentTurn === player.playerIndex) {
        this.turnTimerControl?.resume?.(room);
      }

      if (player.socketId) {
        await this.redis.setex(
          `session:${player.socketId}`,
          this.SESSION_TTL_SECONDS,
          JSON.stringify({
            userId,
            roomId,
            userName: player.playerName,
            reconnectedAt: new Date().toISOString(),
          })
        );
      }

      if (hadGrace) {
        this.logger.info(`[FailureManager] ✓ Grace released for ${userId} on a plain rejoin`);
        await this.persistGameState(room);
      }
      return hadGrace;
    } catch (error) {
      this.logger.error(`[FailureManager] clearGraceForReconnect error: ${error.message}`);
      return false;
    }
  }

  /**
   * Enter grace period after disconnection
   */
  async _enterGracePeriod(room, player, oldSocketId) {
    try {
      const userId = player.playerId;
      const roomId = room.roomId;
      const graceKey = `grace:${userId}:${roomId}`;

      // OWNERSHIP GUARD. If the seat has already moved to a DIFFERENT socket,
      // this disconnect belongs to a connection the player replaced and grace
      // must not be entered — nulling player.socketId below would detach a live
      // player from their own seat, after which every state fan-out skips them
      // and their turns are force-advanced as "disconnected". On mobile the
      // abandoned socket's disconnect routinely lands tens of seconds AFTER the
      // rejoin, so this is the common ordering, not a rare race.
      if (oldSocketId && player.socketId && player.socketId !== oldSocketId) {
        this.logger.info(
          `[FailureManager] Skipping grace for ${userId}: the seat is already live on ${player.socketId} (stale socket ${oldSocketId})`
        );
        return;
      }

      // Update player status
      player.status = 'grace_period';
      player.socketId = null;
      if (typeof player.disconnect === 'function') {
        player.disconnect();
      }
      player.disconnectedAt = new Date();
      
      // Save grace period marker in Redis
      await this.redis.setex(
        graceKey,
        this.GRACE_PERIOD_SECONDS,
        JSON.stringify({
          userId,
          playerIndex: player.playerIndex,
          roomId,
          disconnectedAt: new Date().toISOString(),
        })
      );
      
      // Delete session mapping
      await this.redis.del(`session:${oldSocketId}`);

      // Re-check after the awaits: a rejoin landing during the redis round trip
      // has already re-bound the seat (GameService._rebindSeatSocket). Announcing
      // the disconnect now would grey out the returning player's OWN seat on
      // their own client — the broadcast goes to the whole room, not to everyone
      // else — and arm a grace expiry against a live connection.
      const live = room.getPlayer(userId);
      if (live && live.socketId && live.socketId !== oldSocketId) {
        this.logger.info(
          `[FailureManager] Grace for ${userId} aborted mid-flight: rejoined on ${live.socketId}`
        );
        if (typeof live.markActive === 'function') live.markActive();
        await this.redis.del(graceKey);
        return;
      }

      // Notify others
      this.io.to(roomId).emit('player_disconnected', {
        playerId: userId,
        playerIndex: player.playerIndex,
        gracePeriodSeconds: this.GRACE_PERIOD_SECONDS,
        timestamp: new Date().toISOString(),
      });
      
      this.logger.warn(
        `[FailureManager] Grace period entered: ${userId} (${this.GRACE_PERIOD_SECONDS}s)`
      );
      
      // Items 7/8: do NOT pause/hold a disconnected human's turn and do NOT
      // bot-convert. The turn timer keeps running; when it expires on their seat
      // the turn is skipped and an "inactive turn" is accrued
      // (SocketHandlers._onTurnTimerExpired). At MAX consecutive inactives the
      // game ends with the active player as winner (inactivity_forfeit).
      // Reconnecting before that resumes normal play.

      // Schedule grace period expiry
      this._scheduleGracePeriodExpiry(room, player, graceKey);
      
      // Persist state
      await this.persistGameState(room);
    } catch (error) {
      this.logger.error(`[FailureManager] Grace period error: ${error.message}`);
    }
  }
  
  /**
   * Schedule grace period expiry → bot conversion
   */
  _scheduleGracePeriodExpiry(room, player, graceKey) {
    const timerId = setTimeout(async () => {
      try {
        // Source-of-truth gate: convert iff the seat is still in grace on the
        // player object. A real reconnect sets status='connected' AND clears
        // this timer (_handleReconnection), so a fired timer means no reconnect
        // happened. We do NOT gate on redis.exists(graceKey) here: that key's
        // TTL (GRACE_PERIOD_SECONDS) equals this timer's delay
        // (GRACE_PERIOD_SECONDS*1000), so the key has always expired by the time
        // the handler runs — which silently skipped bot conversion and left a
        // hard-disconnected seat (e.g. host swipe-kill) frozen forever.
        const stillInGrace = player.status === 'grace_period';

        if (stillInGrace) {
          if (!(await this._canMutateRoom(room, 'grace expiry'))) {
            return;
          }
          this.logger.warn(
            `[FailureManager] Grace window expired (no reconnect): ${player.playerId} — seat held as disconnected`
          );
          
          // Items 7/8: NO bot conversion. The disconnected human keeps their
          // (reconnectable) seat; the game advances by skipping their turns and
          // accruing inactive turns, ending with the active player as the winner
          // at MAX consecutive inactives (inactivity_forfeit). We only drop the
          // transient grace marker here.

          // Cleanup
          await this.redis.del(graceKey);
          this.graceTimers.delete(graceKey);
          
          // Persist state
          await this.persistGameState(room);
        }
      } catch (error) {
        this.logger.error(
          `[FailureManager] Grace expiry error: ${error.message}`
        );
      }
    }, this.GRACE_PERIOD_SECONDS * 1000);
    timerId.unref?.();

    this.graceTimers.set(graceKey, timerId);
  }

  /**
   * Restart resilience: after a server restart, in-flight grace timers (plain
   * setTimeout) are gone, but a seat can still be persisted as 'grace_period' (or
   * a disconnected human). Re-arm a grace→bot expiry for each such seat so a
   * player who never reconnects post-restart is eventually replaced by a bot and
   * the game is not frozen. Players persisted as 'connected' are left alone (they
   * reconnect, or the turn-timer's 5-consecutive-inactive forfeit reaps them).
   * Idempotent: a live reconnect (_handleReconnection) clears the timer and flips
   * status; an already-armed graceKey is skipped.
   */
  rearmGraceTimers(room, { allHumanSeats = false } = {}) {
    if (!room || typeof room.getPlayers !== 'function') return 0;
    let armed = 0;
    for (const player of room.getPlayers()) {
      if (!player || player.isBot || player.status === 'bot') continue;
      // `allHumanSeats` is the deploy-restart truth: a fresh process holds NO
      // sockets, so a seat persisted as 'connected' is connected to nothing —
      // its socketId is the id of a connection that died with the old process.
      // Left as-is, the turn-timer expiry would auto-PLAY that "connected" seat
      // (instead of the offline skip), OccupancyMonitor would count a ghost, and
      // the next-round deal would pass its "some human is connected" gate on a
      // lie. Every human seat is therefore treated as mid-grace until its owner
      // rejoins — which the plain join_room path already handles.
      const midGrace =
        allHumanSeats ||
        player.status === 'grace_period' ||
        player.status === 'disconnected' ||
        player.isConnected === false;
      if (!midGrace) continue;
      player.status = 'grace_period';
      player.isConnected = false;
      player.socketId = null;
      const graceKey = `grace:${player.playerId}:${room.roomId}`;
      if (this.graceTimers.has(graceKey)) continue;
      this._scheduleGracePeriodExpiry(room, player, graceKey);
      armed++;
    }
    if (armed > 0) {
      this.logger.warn(
        `[FailureManager] Re-armed ${armed} grace timer(s) for restored room ${room.roomId}`
      );
    }
    return armed;
  }

  /**
   * Skip a player's turn
   */
  _skipPlayerTurn(room, player) {
    // Auto-draw if needed
    if (room.phase === 'draw' && !room.hasDrawnCard) {
      // Same stock-exhaustion guard as the live draw paths (standard Brazilia: the
      // deck is never refilled). When the deck AND discard are both empty the
      // round ends here; otherwise the empty-deck draw below simply yields no card
      // and the skip just advances the turn.
      const ActionHandlers = require('../handlers/ActionHandlers');
      const stockDead = ActionHandlers._refillStockOrEndRound(room);
      if (stockDead && stockDead.roundEnded) {
        // Round finalized: don't draw or advance — the caller's round-end
        // broadcast path (or the next tick) settles the finished room.
        return;
      }
      const card = room.deck.draw();
      if (card) {
        const hand = room.playerHands.get(player.playerId) || [];
        hand.push(card);
        room.playerHands.set(player.playerId, hand);
      }
    }

    // Advance via the canonical engine method so the skip stays consistent with
    // the main turn engine: it honors the authoritative turnOrder and clears ALL
    // per-turn tracking fields. The product contract keeps that order clockwise.
    // previous hardcoded `+1` ignored direction and left stale restriction state
    // (mustMeldCard, drawnCardThisTurnRestriction, ...) on the next player.
    room.nextTurn();
    // Same reason as SocketHandlers._forceAdvanceTurn: nextTurn() does not clear
    // teamMeldPointsThisTurn / turnMeldedCards, so the arriving seat has to be
    // armed explicitly or it inherits the previous turn's melded-points credit.
    {
      const ActionHandlers = require('../handlers/ActionHandlers');
      const arriving = room.getPlayerByIndex(room.currentTurn);
      if (arriving) ActionHandlers._startTurnForPlayer(room, arriving.playerId);
    }

    this.logger.info(`[FailureManager] Turn skipped: ${player.playerId}`);
  }
  
  // =========================================================================
  // HELPERS
  // =========================================================================
  
  /**
   * Serialize cards for JSON
   */
  _serializeCards(cards) {
    return (cards || []).map((c) => this._serializeCard(c));
  }

  _serializeCard(card) {
    if (!card) return null;
    return {
      cardId: card.cardId,
      instanceId: card.cardId,
      suit: card.suit,
      rank: card.rank,
      isJoker: card.isJoker ?? card.rank === 'joker',
    };
  }

  _serializeCardMap(map) {
    return this._serializeMap(map, (cards) => this._serializeCards(cards));
  }

  _serializeMeldMap(map) {
    return this._serializeMap(map, (melds) => (melds || []).map((meld) => this._serializeCards(meld)));
  }

  _serializeSetMap(map) {
    return this._serializeMap(map, (value) => Array.from(value || []));
  }

  _serializeMap(map, valueMapper = (value) => value) {
    if (!map || typeof map.entries !== 'function') return {};
    return Object.fromEntries(Array.from(map.entries()).map(([key, value]) => [key, valueMapper(value)]));
  }

  _cardFromState(card) {
    if (!card) return null;
    const { Card } = require('../models/Deck');
    return new Card(card.suit, card.rank, card.cardId ?? card.instanceId ?? null);
  }

  _cardsFromState(cards) {
    return (cards || []).map((card) => this._cardFromState(card)).filter(Boolean);
  }

  _mapFromState(raw, valueMapper = (value) => value) {
    const map = new Map();
    Object.entries(raw || {}).forEach(([key, value]) => {
      map.set(key, valueMapper(value));
    });
    return map;
  }
  
  /**
   * Reconstruct game room from persisted state
   */
  _reconstructGameRoom(state) {
    const { GameRoom, PlayerSession } = require('../models');
    const { Deck } = require('../models/Deck');
    const room = new GameRoom({ roomId: state.roomId, maxPlayers: state.maxPlayers || 2 });

    room.name = state.name || room.name;
    room.hostPlayerId = state.hostPlayerId == null ? null : String(state.hostPlayerId);
    room.hostPlayerIndex = state.hostPlayerIndex;
    room.status = state.status;
    room.currentTurn = state.currentTurn;
    room.phase = state.phase;
    room.ruleset = state.ruleset || room.ruleset;
    room.professionalWellMode = state.professionalWellMode || room.professionalWellMode;
    room.targetScore = Number.isFinite(Number(state.targetScore))
      ? Number(state.targetScore)
      : room.targetScore;
    room.nextRoundDelayMs = Number.isFinite(Number(state.nextRoundDelayMs))
      ? Number(state.nextRoundDelayMs)
      : null;
    // #11 multi-round: restore the intermission INTENT + deadline. The timer
    // itself is re-armed by the caller (SocketHandlers.resumePersistedRooms /
    // _recoverOwnedRoomRuntime), which is the only side that owns timers.
    room.awaitingNextRound = state.awaitingNextRound === true;
    room.nextRoundAt = Number.isFinite(Number(state.nextRoundAt))
      ? Number(state.nextRoundAt)
      : null;
    room.chatEnabled = state.chatEnabled ?? room.chatEnabled;
    room.skinOverride =
      state.skinOverride && typeof state.skinOverride === 'object' ? state.skinOverride : null;
    room.visibility = state.visibility || room.visibility;
    room.hasPassword = state.hasPassword ?? room.hasPassword;
    room.bet = Number.isFinite(Number(state.bet)) ? Number(state.bet) : room.bet;
    room._settingsInitialized = Boolean(state.settingsInitialized);
    room.cardsDealt = state.cardsDealt;
    room.createdAt = state.createdAt ? new Date(state.createdAt) : room.createdAt;
    room.gameStartedAt = state.gameStartedAt ? new Date(state.gameStartedAt) : null;
    room.gameEndedAt = state.gameEndedAt ? new Date(state.gameEndedAt) : null;
    room.winnerId = state.winnerId || null;
    room.hasDrawnCard = state.hasDrawnCard;
    room.turnHadManualAction = state.turnHadManualAction || false;
    room.drawnCardThisTurnRestriction = new Set(state.drawnCardThisTurnRestriction || []);
    room.meldedThisTurn = Boolean(state.meldedThisTurn);
    room.mustMeldCard = state.mustMeldCard ? this._cardFromState(state.mustMeldCard) : null;
    room.discardLocks = new Map(state.discardLocks || []);
    room.turnTimeLimit = state.turnTimeLimit ?? room.turnTimeLimit;
    room.turnTimeRemaining = state.turnTimeRemaining ?? room.turnTimeRemaining;
    room.restoredTurnRemainingMs =
      state.turnTimerRemainingMs != null && Number.isFinite(Number(state.turnTimerRemainingMs))
        ? Number(state.turnTimerRemainingMs)
        : null;
    room.lastRoundScores = state.lastRoundScores || {};
    room.lastTeamScores = state.lastTeamScores || {};
    room.lastBatidaType = state.lastBatidaType || null;
    room.lastRoundEndPayload = state.lastRoundEndPayload || null;
    room.backendBaseUrl = state.backendBaseUrl || room.backendBaseUrl || null;
    room.seatReservationProtocol = state.seatReservationProtocol === 1 ? 1 : 0;
    room.seatConnectionProtocol = state.seatConnectionProtocol === 1 ? 1 : 0;
    room.seatLayoutProtocol = state.seatLayoutProtocol === 1 ? 1 : 0;
    room.startAttemptProtocol = state.startAttemptProtocol === 1 ? 1 : 0;
    room.startAttemptId = state.startAttemptId || null;

    (state.players || []).forEach((rawPlayer) => {
      const player = new PlayerSession({
        playerId: rawPlayer.playerId,
        playerName: rawPlayer.playerName || rawPlayer.playerId,
        playerIndex: rawPlayer.playerIndex,
        socketId: rawPlayer.socketId,
      });
      player.status = rawPlayer.status || (rawPlayer.isConnected === false ? 'disconnected' : 'connected');
      player.isConnected = rawPlayer.isConnected ?? player.status === 'connected';
      player.avatarUrl = rawPlayer.avatarUrl || null;
      player.isBot = Boolean(rawPlayer.isBot);
      player.apiSeatReservationVersion = Number.isInteger(rawPlayer.apiSeatReservationVersion)
        ? rawPlayer.apiSeatReservationVersion : null;
      player.botDifficulty = rawPlayer.botDifficulty;
      player.connectedAt = rawPlayer.connectedAt ? new Date(rawPlayer.connectedAt) : player.connectedAt;
      player.joinedAt = rawPlayer.joinedAt ? new Date(rawPlayer.joinedAt) : player.joinedAt;
      player.lastActivity = rawPlayer.lastActivity ? new Date(rawPlayer.lastActivity) : player.lastActivity;
      room.players.set(player.playerId, player);
      room.everHadPlayers = true;
    });

    if (state.deck) {
      room.deck = new Deck({ includeJokers: room.ruleset === 'classic' });
      room.deck.cards = this._cardsFromState(state.deck);
    }
    room.discardPile = this._cardsFromState(state.discardPile);
    room.deadPiles = (state.deadPiles || []).map((pile) => this._cardsFromState(pile));
    room.pozzetto = this._cardsFromState(state.pozzetto);
    room.playerHands = this._mapFromState(state.playerHands, (cards) => this._cardsFromState(cards));
    room.playerMelds = this._mapFromState(state.playerMelds, (melds) => (melds || []).map((meld) => this._cardsFromState(meld)));
    room.playerMeldOrders = this._mapFromState(state.playerMeldOrders);
    room.nextMeldOrder = Number.isInteger(state.nextMeldOrder)
      ? state.nextMeldOrder
      : Math.max(-1, ...Array.from(room.playerMeldOrders.values()).flat()) + 1;
    room.playerHasTakenPozzetto = this._mapFromState(state.playerHasTakenPozzetto);
    room.playerPozzettoTakeMode = this._mapFromState(state.playerPozzettoTakeMode);
    room.playerDeadPileCount = this._mapFromState(state.playerDeadPileCount);
    // Across-the-table takes (informational; no rule gates on it). Older
    // snapshots lack the field — derive it from the per-team counts, whose sum
    // equals it by invariant (a stock promotion never touches
    // playerDeadPileCount).
    room.wellsTakenThisRound = Number.isFinite(state.wellsTakenThisRound)
      ? state.wellsTakenThisRound
      : (room.playerDeadPileCount.get('teamA') || 0) +
        (room.playerDeadPileCount.get('teamB') || 0);
    // Prefer the graded field; fall back to the legacy index list (every
    // member = 'dirty'). Entries are read tolerantly either way, so a snapshot
    // from ANY build restores to a working latch — at worst a semi reads dirty,
    // never the reverse.
    room.meldDirtyFlags = this._mapFromState(
      state.meldGradeFlags ?? state.meldDirtyFlags,
      (values) => {
        const flags = new Map();
        (values || []).forEach((entry) => {
          if (Array.isArray(entry)) flags.set(entry[0], entry[1]);
          else flags.set(entry, 'dirty');
        });
        return flags;
      }
    );
    room.teamMeldPointsThisTurn = this._mapFromState(state.teamMeldPointsThisTurn);
    room.turnMeldedCards = this._mapFromState(state.turnMeldedCards);
    room.roundNumber = Number.isFinite(Number(state.roundNumber))
      ? Number(state.roundNumber)
      : room.roundNumber || 0;
    room.lastRoundWinnerIndex =
      state.lastRoundWinnerIndex === undefined ? null : state.lastRoundWinnerIndex;
    room.offlineStrikes = this._mapFromState(state.offlineStrikes);
    room.teamRequiredMeldPoints = this._mapFromState(state.teamRequiredMeldPoints);
    room.teamTurnPenalty = this._mapFromState(state.teamTurnPenalty);
    room.cumulativeScores = this._mapFromState(state.cumulativeScores);
    room.cumulativeTeamScores = this._mapFromState(state.cumulativeTeamScores);

    return room;
  }

  _restoreGameManagerMappings(room) {
    if (!room || !this.gameManager?.playerToRoom) return;
    room.getPlayers().forEach((player) => {
      const current = this.gameManager.playerToRoom.get(player.playerId);
      if (current && current !== room.roomId) {
        // Never steal a player from a room that is still live. The same playerId
        // can appear in several snapshots (yesterday's table and today's), and a
        // blind set made it "last restore wins" — binding the player to whichever
        // room happened to be rehydrated last, no matter which one they are
        // actually sitting at. Only take over a binding whose room is gone or
        // already over.
        const currentRoom = this.gameManager.rooms?.get(current);
        if (currentRoom && !(currentRoom.hasEnded?.() === true)) return;
      }
      this.gameManager.playerToRoom.set(player.playerId, room.roomId);
    });
  }

  async _canMutateRoom(room, reason) {
    if (!this.ensureRoomOwnerForMutation || !room?.roomId) return true;
    try {
      const ownership = await this.ensureRoomOwnerForMutation(room.roomId);
      if (ownership?.owned) return true;
      this.logger.info(
        `[FailureManager] Skipping ${reason} for room ${room.roomId}; owner=${ownership?.owner || 'unknown'}`
      );
      return false;
    } catch (error) {
      this.logger.error(
        `[FailureManager] Ownership check failed for ${reason} in room ${room.roomId}: ${error.message}`
      );
      return false;
    }
  }
  
  /**
   * Cleanup all timers on shutdown
   */
  dispose() {
    this.graceTimers.forEach(timerId => clearTimeout(timerId));
    this.graceTimers.clear();
    this.timers.forEach(timerId => clearTimeout(timerId));
    this.timers.clear();
    this.logger.info('[FailureManager] Disposed');
  }
}

module.exports = FailureManager;
