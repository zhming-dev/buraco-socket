const path = require('path');
const { fork } = require('child_process');
const os = require('os');
const GameValidator = require('../validators/GameValidator');
const ActionHandlers = require('../handlers/ActionHandlers');

class BotCoordinator {
  constructor({ gameService, socketHandlers, logger, config }) {
    this.gameService = gameService;
    this.socketHandlers = socketHandlers;
    this.logger = logger;
    this.config = config?.bot || {};
    this.enabled = this.config.enabled !== false;
    const legacyTurnDelayMs = Number(this.config.turnDelayMs);
    const defaultTurnDelayMinMs = Number.isFinite(legacyTurnDelayMs) ? legacyTurnDelayMs : 1200;
    const defaultTurnDelayMaxMs = Number.isFinite(legacyTurnDelayMs) ? legacyTurnDelayMs : 2200;
    this.turnDelayMinMs = this._numberConfig('turnDelayMinMs', defaultTurnDelayMinMs, 0);
    this.turnDelayMaxMs = Math.max(
      this.turnDelayMinMs,
      this._numberConfig('turnDelayMaxMs', defaultTurnDelayMaxMs, this.turnDelayMinMs)
    );
    // Pause between CHAINED actions inside one bot turn (meld -> meld -> discard).
    // This used to be dead config: every successful intent re-entered
    // onRoomStateChanged synchronously and armed a fresh turnDelay, so chained
    // actions silently paid the 1200-2200ms "thinking" pause instead. See
    // _executingRooms below.
    this.followUpDelayMinMs = this._numberConfig('followUpDelayMinMs', 600, 0);
    this.followUpDelayMaxMs = Math.max(
      this.followUpDelayMinMs,
      this._numberConfig('followUpDelayMaxMs', 900, this.followUpDelayMinMs)
    );
    // Actions the client ANIMATES (meld / add / pile take / well take) need a
    // longer floor: the online coordinator fires those animations without a
    // queue, so a follow-up that lands mid-flight makes the first completion
    // clear the in-progress flag while the second batch is still airborne. A
    // 3-card meld costs ~1.13s at the "slow" animation speed, so that is the
    // floor here — anything shorter is visibly glitchy, not just fast.
    this.animatedFollowUpDelayMinMs = this._numberConfig('animatedFollowUpDelayMinMs', 1150, 0);
    this.animatedFollowUpDelayMaxMs = Math.max(
      this.animatedFollowUpDelayMinMs,
      this._numberConfig('animatedFollowUpDelayMaxMs', 1450, this.animatedFollowUpDelayMinMs)
    );
    this.retryDelayMs = this._numberConfig('retryDelayMs', 600, 200);
    // decide() is synchronous pure JS over <=22 cards — sub-millisecond. This is
    // a hang detector for a wedged worker, not a latency budget, so it does not
    // need to be a second long: a timeout costs a full retry cycle of dead air.
    this.decisionTimeoutMs = Number(this.config.decisionTimeoutMs || 250);
    this.workerRestartDelayMs = Number(this.config.workerRestartDelayMs || 1000);
    const defaultWorkerCount = Math.max(
      1,
      Math.min(4, (os.availableParallelism?.() || os.cpus().length || 2) - 1)
    );
    const configuredWorkerCount = Number(this.config.workerCount);
    this.workerCount =
      Number.isFinite(configuredWorkerCount) && configuredWorkerCount > 0
        ? Math.floor(configuredWorkerCount)
        : defaultWorkerCount;
    this.workers = new Map();
    this.workerCursor = 0;
    this.pending = new Map();
    // Single-flight per BOT (not per state hash). The old state-hash key let two
    // pipelines be armed for the same turn whenever two triggers observed
    // different hashes — each wasted cycle cost a full turn delay.
    this.inFlight = new Set();
    this.actionTimers = new Map();
    // Rooms whose bot intent is mid-execution. Every handler broadcasts a state
    // update, which re-enters onRoomStateChanged synchronously; without this
    // guard that re-entry arms a turnDelay timer and the follow-up pacing below
    // never gets to run.
    this.executingRooms = new Set();
    this.blockedStateKeys = new Set();
    this.registeredBotsByRoom = new Map();
    this.scheduledRoomChecks = new Map();
    // Event hooks drive normal bot turns. This recovery delay only schedules a
    // specific room that just changed, so bot load scales with active bot turns
    // instead of total bot rooms.
    this.recoveryDelayMs = this._numberConfig('recoveryDelayMs', 5000, 1000);
    this.requestSeq = 0;
  }

  start() {
    if (!this.enabled) {
      this.logger.info('[BOT] Server-side bot coordinator disabled');
      return;
    }
    this._ensureWorkers();
  }

  shutdown() {
    for (const entry of this.scheduledRoomChecks.values()) {
      clearTimeout(entry.timer);
    }
    this.scheduledRoomChecks.clear();
    for (const timer of this.actionTimers.values()) {
      clearTimeout(timer);
    }
    this.actionTimers.clear();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error('Bot coordinator shutting down'));
    }
    this.pending.clear();
    this.inFlight.clear();
    this.executingRooms.clear();
    this.blockedStateKeys.clear();

    for (const worker of this.workers.values()) {
      if (worker.restartTimer) {
        clearTimeout(worker.restartTimer);
      }
      if (worker.process) {
        worker.process.removeAllListeners();
        worker.process.kill();
      }
    }
    this.workers.clear();
  }

  registerBot(roomId, playerId) {
    const key = String(roomId);
    if (!this.registeredBotsByRoom.has(key)) {
      this.registeredBotsByRoom.set(key, new Set());
    }
    const roomBots = this.registeredBotsByRoom.get(key);
    const normalizedPlayerId = String(playerId);
    const isNewBot = !roomBots.has(normalizedPlayerId);
    roomBots.add(normalizedPlayerId);
    if (isNewBot) {
      this._scheduleRoomCheck(key, 0);
    }
  }

  unregisterRoom(roomId) {
    const key = String(roomId);
    const scheduled = this.scheduledRoomChecks.get(key);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.scheduledRoomChecks.delete(key);
    }
    this.registeredBotsByRoom.delete(key);
    this.executingRooms.delete(key);
    for (const stateKey of Array.from(this.actionTimers.keys())) {
      if (stateKey.startsWith(`${key}:`)) {
        clearTimeout(this.actionTimers.get(stateKey));
        this.actionTimers.delete(stateKey);
      }
    }
    for (const stateKey of Array.from(this.blockedStateKeys)) {
      if (stateKey.startsWith(`${key}:`)) {
        this.blockedStateKeys.delete(stateKey);
      }
    }
    for (const stateKey of Array.from(this.inFlight)) {
      if (stateKey.startsWith(`${key}:`)) {
        this.inFlight.delete(stateKey);
      }
    }
  }

  /**
   * Remove a single bot from a room (host taps a bot seat to free it / replaces
   * a bot). Without this the host's remove-bot handler threw a TypeError. Clears
   * room-scoped blocked/in-flight state keys so a re-added bot is not stuck.
   * @param {string} roomId
   * @param {string} playerId
   */
  unregisterBot(roomId, playerId) {
    const key = String(roomId);
    const set = this.registeredBotsByRoom.get(key);
    if (set) {
      set.delete(String(playerId));
      if (set.size === 0) this.unregisterRoom(key);
    }
    for (const stateKey of Array.from(this.blockedStateKeys)) {
      if (stateKey.startsWith(`${key}:`)) this.blockedStateKeys.delete(stateKey);
    }
    for (const stateKey of Array.from(this.inFlight)) {
      if (stateKey.startsWith(`${key}:`)) {
        this.inFlight.delete(stateKey);
        const timer = this.actionTimers.get(stateKey);
        if (timer) {
          clearTimeout(timer);
          this.actionTimers.delete(stateKey);
        }
      }
    }
  }

  /**
   * @param {import('../models/GameRoom')} room
   * @param {{actionDelayMs?: number}} [opts] `actionDelayMs` overrides the
   *   pre-action pause — the follow-up/retry paths use it so a chained action
   *   does not pay the full turn "thinking" delay again.
   */
  onRoomStateChanged(room, opts = {}) {
    if (!this.enabled || !room || !room.isInProgress?.()) return;
    if (!room.cardsDealt || room.awaitingDealAnimation) return;

    const player = room.getPlayerByIndex(room.currentTurn);
    if (!player || player.isBot !== true) return;

    // Mid-intent re-entry from a handler's broadcast: the finally block below
    // schedules the follow-up with the correct (much shorter) pacing.
    if (this.executingRooms.has(String(room.roomId))) return;

    this.registerBot(room.roomId, player.playerId);

    const stateKey = this._stateKey(room, player);
    if (this.blockedStateKeys.has(stateKey)) return;

    const botKey = this._botKey(room.roomId, player.playerId);
    if (this.inFlight.has(botKey)) return;
    this.inFlight.add(botKey);

    const delayMs = Number.isFinite(opts.actionDelayMs)
      ? Math.max(0, opts.actionDelayMs)
      : this._randomDelay(this.turnDelayMinMs, this.turnDelayMaxMs);

    const timer = setTimeout(() => {
      this.actionTimers.delete(botKey);
      this._inRoomLogContext(room.roomId, () =>
        this._playBotState(room.roomId, player.playerId, stateKey, botKey)
      ).catch((error) => {
        this.logger.warn(`[BOT] Failed to play bot turn for ${player.playerId}: ${error.message}`);
      });
    }, delayMs);
    timer.unref?.();
    this.actionTimers.set(botKey, timer);
  }

  async _playBotState(roomId, playerId, stateKey, botKey = this._botKey(roomId, playerId)) {
    let actionSucceeded = false;
    let shouldRetry = false;
    let executedIntentType = null;
    this.executingRooms.add(String(roomId));
    try {
      const room = this.gameService.getRoom(roomId);
      if (!room || !room.isInProgress?.()) return;

      const player = room.getPlayer(playerId);
      if (!player || player.isBot !== true || room.currentTurn !== player.playerIndex) return;
      if (!room.cardsDealt || room.awaitingDealAnimation) return;

      const state = this._buildBotState(room, player);
      const intent = await this._requestDecision(state);
      if (!intent) {
        // No decision came back (worker busy / timed out) — transient infra, so
        // just retry shortly.
        shouldRetry = true;
        return;
      }
      if (intent.type === 'wait') {
        // The strategy has no productive move. AFTER drawing the turn can no
        // longer advance on its own, so resolve it NOW — never loiter until the
        // turn timer force-advances (the ~30s freeze the human sits through:
        // "bot has no card to discard, won't take the pozzetto, game waits for
        // timeout").
        if (state.hasDrawnCard) {
          actionSucceeded = await this._forceTurnProgress(room, player.playerId);
          if (!actionSucceeded) shouldRetry = true;
          return;
        }
        // BEFORE drawing, 'wait' only happens when the stock is dead and the
        // strategy declines (or is blocked from) the pile — deck-out: the hand
        // ends no-batida NOW. Retrying would just spin the same decision until
        // the turn-timer watchdog fired (the reported bot-game "stuck game").
        // Re-check against the LIVE room (not the state snapshot) so a stale
        // decision can never end the round out of turn.
        if (
          (room.deck?.count || 0) === 0 &&
          !room.hasDrawnCard &&
          room.currentTurn === player.playerIndex
        ) {
          actionSucceeded = this.socketHandlers.endRoundOnDeckOut(room);
          if (!actionSucceeded) shouldRetry = true;
          return;
        }
        // Stock alive (e.g. stale state mid-refill) — transient, retry.
        shouldRetry = true;
        return;
      }

      executedIntentType = intent.type;
      const result = await this.socketHandlers.executeBotIntent(room.roomId, player.playerId, intent);
      if (!result.success) {
        if (
          state.hasDrawnCard &&
          (await this._tryFallbackDiscard(room, player.playerId, result.error))
        ) {
          executedIntentType = 'discard_card';
          actionSucceeded = true;
          return;
        }
        // Rejected AND no legal fallback discard. While drawn, the bot is wedged
        // (e.g. a lone card it cannot legally discard, or an empty hand awaiting
        // a well) — resolve the turn immediately instead of retrying until the
        // turn timer expires.
        if (state.hasDrawnCard) {
          actionSucceeded = await this._forceTurnProgress(room, player.playerId);
          if (actionSucceeded) return;
        }
        // Rejected BEFORE drawing with a dead stock: the only continuation the
        // strategy wanted (its pile take / promoted-deck draw) is illegal, and
        // retrying re-runs the exact same decision forever. Deck-out — end the
        // round no-batida instead of spinning until the watchdog. Live-room
        // checks so a raced/stale rejection can never end the round out of turn.
        if (
          (room.deck?.count || 0) === 0 &&
          !room.hasDrawnCard &&
          room.currentTurn === player.playerIndex
        ) {
          if (this.socketHandlers.endRoundOnDeckOut(room)) {
            actionSucceeded = true;
            return;
          }
        }

        // Rejected BEFORE drawing while the stock is ALIVE. The strategy is
        // stateless and the room has not changed, so a retry regenerates the
        // identical intent and is rejected identically — the bot would spin at
        // the retry cadence until the turn-timer watchdog bailed the table out.
        // Drawing from the deck is unconditionally legal here (it is our turn and
        // we have not drawn), so take that escape instead of looping.
        if (
          !room.hasDrawnCard &&
          (room.deck?.count || 0) > 0 &&
          room.currentTurn === player.playerIndex &&
          intent.type !== 'draw_card'
        ) {
          const drawResult = await this.socketHandlers.executeBotIntent(
            room.roomId,
            player.playerId,
            { type: 'draw_card', fromDeck: true }
          );
          if (drawResult.success) {
            this.logger.info(
              `[BOT] ${player.playerId}: ${intent.type} rejected (${result.error}); drew from the deck instead`
            );
            executedIntentType = 'draw_card';
            actionSucceeded = true;
            return;
          }
        }

        // Nothing recovered it. Remember this exact state as unplayable so the
        // retry loop cannot burn cycles re-deciding it (blockedStateKeys was
        // previously never populated, making its guard a permanent no-op).
        this._blockState(stateKey);
        this.logger.warn(
          `[BOT] Intent ${intent.type} rejected for ${player.playerId}: ${result.error}`
        );
        shouldRetry = true;
      } else {
        actionSucceeded = true;
      }
    } finally {
      this.inFlight.delete(botKey);
      this.executingRooms.delete(String(roomId));
      if (actionSucceeded) {
        // Chained same-turn action: pay the short follow-up pause, not the full
        // turn "thinking" delay. Actions the client animates get the longer
        // floor so consecutive meld flights never overlap.
        this._scheduleRoomCheck(roomId, 0, this._followUpDelayFor(executedIntentType));
      } else if (shouldRetry) {
        this._scheduleRoomCheck(roomId, 0, this.retryDelayMs);
      }
    }
  }

  /**
   * Pre-action pause before the bot's NEXT action in the same turn, chosen by
   * what it just did. Melds, adds, pile takes and well takes all trigger a
   * card-flight animation on the client that is fire-and-forget (no queue), so
   * they need the animation floor; a draw or discard does not.
   * @param {string|null} intentType
   * @returns {number} milliseconds
   */
  _followUpDelayFor(intentType) {
    const animated =
      intentType === 'play_meld' ||
      intentType === 'add_to_meld' ||
      intentType === 'go_down' ||
      intentType === 'pick_up_pile' ||
      intentType === 'take_pozzetto';
    return animated
      ? this._randomDelay(this.animatedFollowUpDelayMinMs, this.animatedFollowUpDelayMaxMs)
      : this._randomDelay(this.followUpDelayMinMs, this.followUpDelayMaxMs);
  }

  /**
   * Run a bot turn with the room as the ambient per-game log context (so its
   * lines land in that game's log). Tolerates a stub logger without it.
   * @private
   */
  _inRoomLogContext(roomId, fn) {
    if (typeof this.logger?.runWithRoom === 'function') return this.logger.runWithRoom(roomId, fn);
    return fn();
  }

  _botKey(roomId, playerId) {
    return `${roomId}:${playerId}`;
  }

  async _tryFallbackDiscard(room, playerId, originalError) {
    const hand = room.playerHands.get(playerId) || [];
    const legalCard = hand.find((card) => GameValidator.validateDiscard(room, playerId, card).isValid);
    if (!legalCard) return false;

    const result = await this.socketHandlers.executeBotIntent(room.roomId, playerId, {
      type: 'discard_card',
      card: legalCard,
    });
    if (!result.success) {
      this.logger.warn(
        `[BOT] Fallback discard rejected for ${playerId}: ${result.error}; original=${originalError}`
      );
      return false;
    }
    this.logger.info(`[BOT] Fallback discard used for ${playerId}; original=${originalError}`);
    return true;
  }

  /**
   * Guarantee a drawn bot's turn ends WITHOUT waiting for the turn-timer
   * watchdog (the source of the ~30s "game is stuck" freeze). In order:
   *   1. empty hand → take the well (refills to 11; the follow-up check then
   *      discards), 2. otherwise discard ANY legal card, 3. as a last resort
   *      force-advance the turn — a lone card the bot can neither legally discard
   *      (illegal close) nor meld can only be skipped, so skip it now instead of
   *      freezing the table. Returns true when the turn was moved forward.
   * @param {import('../models/GameRoom')} room
   * @param {string} playerId
   * @returns {Promise<boolean>}
   */
  async _forceTurnProgress(room, playerId) {
    const hand = room.playerHands.get(playerId) || [];

    if (hand.length === 0) {
      const takeResult = await this.socketHandlers.executeBotIntent(room.roomId, playerId, {
        type: 'take_pozzetto',
      });
      if (takeResult.success) return true;
    } else if (await this._tryFallbackDiscard(room, playerId, 'no-progress')) {
      return true;
    }

    // Nothing legal remains. Skip the turn now — the same escape the turn-timer
    // watchdog (_onTurnTimerExpired → _forceAdvanceTurn) uses — so a wedged bot
    // never hangs the game. Guard against a late fire once the turn already moved.
    const player = room.getPlayer(playerId);
    if (room.isInProgress?.() && player && room.currentTurn === player.playerIndex) {
      this.logger.warn(
        `[BOT] ${playerId} has no legal move; force-advancing turn to avoid a frozen game`
      );
      this.socketHandlers._forceAdvanceTurn(room);
      return true;
    }
    return false;
  }

  _requestDecision(state) {
    this._ensureWorkers();
    const worker = this._nextReadyWorker();
    if (!worker) {
      return Promise.resolve(null);
    }

    const requestId = `${Date.now()}_${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, this.decisionTimeoutMs);

      this.pending.set(requestId, {
        resolve,
        reject,
        timeout,
        workerId: worker.id,
      });
      worker.process.send({ type: 'decide', requestId, state }, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  _ensureWorkers() {
    if (!this.enabled) return;
    for (let i = 0; i < this.workerCount; i++) {
      this._ensureWorker(i);
    }
  }

  _ensureWorker(id) {
    if (!this.enabled) return;
    const existing = this.workers.get(id);
    if (existing?.process || existing?.restartTimer) return;

    const workerPath = path.join(__dirname, 'botWorker.js');
    const child = fork(workerPath, [], {
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const worker = {
      id,
      process: child,
      ready: true,
      restartTimer: null,
    };
    this.workers.set(id, worker);

    child.on('message', (message = {}) => this._handleWorkerMessage(message));
    child.on('exit', (code, signal) => {
      this.logger.warn(
        `[BOT] Worker ${id} exited (code=${code}, signal=${signal}). Socket server stays alive.`
      );
      this._clearPendingForWorker(id);
      const current = this.workers.get(id);
      if (current) {
        current.process = null;
        current.ready = false;
        current.restartTimer = setTimeout(() => {
          current.restartTimer = null;
          this._ensureWorker(id);
        }, this.workerRestartDelayMs);
        current.restartTimer.unref?.();
      }
    });
    child.on('error', (error) => {
      this.logger.warn(`[BOT] Worker ${id} process error: ${error.message}`);
    });

    this.logger.info(`[BOT] Server-side bot worker ${id} started`);
  }

  _nextReadyWorker() {
    if (this.workers.size === 0) return null;
    const workers = Array.from(this.workers.values()).filter(
      (worker) => worker.ready && worker.process?.connected
    );
    if (workers.length === 0) return null;
    const worker = workers[this.workerCursor % workers.length];
    this.workerCursor = (this.workerCursor + 1) % workers.length;
    return worker;
  }

  /**
   * Schedule a look at this room. Two delays, deliberately separate:
   *   `delayMs`       — when to LOOK at the room again;
   *   `actionDelayMs` — the pause taken BEFORE acting once we do (undefined =
   *                     the full turn "thinking" delay, i.e. a fresh turn).
   * Merging is on the EFFECTIVE act time (delay + action delay) so a lazy
   * follow-up can no longer swallow an urgent retry — the previous version
   * compared look-at times only and silently dropped the later request.
   * @param {string} roomId
   * @param {number} [delayMs]
   * @param {number} [actionDelayMs]
   */
  _scheduleRoomCheck(roomId, delayMs = this.recoveryDelayMs, actionDelayMs = undefined) {
    if (!this.enabled || !roomId) return;
    const key = String(roomId);
    const wait = Math.max(0, delayMs);
    const actAfter = Number.isFinite(actionDelayMs) ? Math.max(0, actionDelayMs) : null;
    // An unspecified action delay means the turn pause; compare against its
    // minimum so a known-short follow-up can still win the merge.
    const effectiveAt = Date.now() + wait + (actAfter == null ? this.turnDelayMinMs : actAfter);

    const existing = this.scheduledRoomChecks.get(key);
    if (existing) {
      if (existing.effectiveAt <= effectiveAt) return;
      clearTimeout(existing.timer);
      this.scheduledRoomChecks.delete(key);
    }
    const timer = setTimeout(() => {
      this.scheduledRoomChecks.delete(key);
      const room = this.gameService.getRoom(roomId);
      if (!room || !room.isInProgress?.()) {
        this.unregisterRoom(roomId);
        return;
      }
      this._inRoomLogContext(key, () =>
        this.onRoomStateChanged(room, actAfter == null ? {} : { actionDelayMs: actAfter })
      );
    }, wait);
    timer.unref?.();
    this.scheduledRoomChecks.set(key, { timer, effectiveAt });
  }

  _handleWorkerMessage(message) {
    if (message.type === 'worker_error') {
      this.logger.warn(`[BOT] Worker reported error: ${message.error}`);
      return;
    }

    const entry = this.pending.get(message.requestId);
    if (!entry) return;

    clearTimeout(entry.timeout);
    this.pending.delete(message.requestId);

    if (message.type === 'error') {
      entry.resolve(null);
      this.logger.warn(`[BOT] Decision error: ${message.error}`);
      return;
    }

    entry.resolve(message.intent || null);
  }

  _clearPendingForWorker(workerId) {
    for (const [requestId, entry] of this.pending.entries()) {
      if (entry.workerId !== workerId) continue;
      clearTimeout(entry.timeout);
      entry.resolve(null);
      this.pending.delete(requestId);
    }
  }

  /**
   * The redacted snapshot the strategy reasons over. Everything here is either
   * the bot's OWN private state or information the server already broadcasts to
   * every human client (hand COUNTS, melds, scores, the discard pile) — no
   * opponent card is ever exposed, so a smarter bot stays a fair bot.
   * @param {import('../models/GameRoom')} room
   * @param {import('../models/PlayerSession')} player
   */
  _buildBotState(room, player) {
    const hand = room.playerHands.get(player.playerId) || [];
    const ruleset = room.ruleset || 'classic';
    const playerMelds = {};
    const meldFlags = {};
    const handCounts = {};

    room.getPlayers().forEach((p) => {
      const melds = room.playerMelds.get(p.playerId) || [];
      playerMelds[p.playerIndex] = melds.map((meld) => meld.map((card) => this._serializeCard(card)));
      // Clean/dirty is STICKY in professional (a meld stamped dirty stays dirty
      // even after a natural covers the wild), so it cannot be recomputed from
      // the cards alone — it has to travel with the snapshot.
      meldFlags[p.playerIndex] = melds.map((meld, meldIndex) =>
        ActionHandlers._meldFlags(room, p.playerId, meld, meldIndex)
      );
      handCounts[p.playerIndex] = (room.playerHands.get(p.playerId) || []).length;
    });

    const deadPileCounts = Array.isArray(room.deadPiles)
      ? room.deadPiles.map((pile) => (Array.isArray(pile) ? pile.length : 0))
      : [];
    // Mirror GameValidator._pozzettoAvailable, including the legacy room.pozzetto
    // fallback a rehydrated/older room can still be carrying.
    const legacyPozzetto =
      !Object.prototype.hasOwnProperty.call(room, 'deadPiles') &&
      Array.isArray(room.pozzetto) &&
      room.pozzetto.length > 0;

    const teamKey = player.playerIndex % 2 === 0 ? 'teamA' : 'teamB';
    const opponentKey = teamKey === 'teamA' ? 'teamB' : 'teamA';

    return {
      roomId: room.roomId,
      playerId: player.playerId,
      playerIndex: player.playerIndex,
      currentPlayerIndex: room.currentTurn,
      cardsDealt: room.cardsDealt === true,
      hasDrawnCard: room.hasDrawnCard === true,
      meldedThisTurn: room.meldedThisTurn === true,
      ruleset,
      professionalWellMode: room.professionalWellMode || 'indirect',
      yourHand: hand.map((card) => this._serializeCard(card)),
      playerMelds,
      meldFlags,
      discardPile: (room.discardPile || []).map((card) => this._serializeCard(card)),
      deckCount: room.deck?.count || 0,
      deadPileCounts,
      pozzettosAvailable: deadPileCounts.some((count) => count > 0) || legacyPozzetto,
      mustMeldCard: room.mustMeldCard ? this._serializeCard(room.mustMeldCard) : null,
      drawnCardRestriction: Array.from(room.drawnCardThisTurnRestriction || []),
      // ANTI PING-PONG lock for THIS bot. Without it the strategy proposes a
      // locked discard, GameValidator rejects it, and the coordinator burns the
      // turn force-resolving a rejection it could have avoided.
      discardLock: (room.discardLocks && room.discardLocks.get(player.playerId)) || null,

      // --- Well bookkeeping. The house rule allows TWO wells per team, so the
      // old single boolean made the strategy believe the second one did not
      // exist. Keep the boolean for compatibility and add the real counts.
      teamHasTakenPozzetto: this._teamHasTakenPozzetto(room, player),
      opponentTeamHasTakenPozzetto: this._teamHasTakenPozzetto(room, player, true),
      teamWellsTaken: this._teamDeadPileCount(room, player, false),
      opponentWellsTaken: this._teamDeadPileCount(room, player, true),
      // Across-the-table count, informational — no planner gate reads it since
      // both wells became reachable by discard. Kept so the payload still
      // matches what human clients receive.
      wellsTakenThisRound: room.wellsTakenThisRound || 0,

      // --- Table awareness (public information; already sent to human clients).
      handCounts,
      maxPlayers: room.maxPlayers || room.getPlayers().length,
      playerCount: room.getPlayers().length,
      botLevel: player.botLevel || 'normal',

      // --- Match state, so the endgame can stop gambling once the round wins it.
      targetScore: Number(room.targetScore) || 0,
      teamScore: Number(room.cumulativeTeamScores?.get(teamKey)) || 0,
      opponentScore: Number(room.cumulativeTeamScores?.get(opponentKey)) || 0,

      // --- Professional per-turn meld requirement (the escalating 20-pt penalty).
      requiredMeldPoints: room.teamRequiredMeldPoints?.get(teamKey) ?? null,
      meldPointsThisTurn: room.teamMeldPointsThisTurn?.get(teamKey) || 0,

      // --- Everything thrown away this round, so the bot can count cards instead
      // of hoarding material that is provably no longer completable. Unlike
      // discardPile this survives a pile take.
      discardHistory: (room.discardHistory || []).map((card) => this._serializeCard(card)),
    };
  }

  /**
   * Wells banked by the bot's team (or the opposing team when `opponent`).
   * Mirrors GameValidator._teamDeadPileCount: a team key entry wins, otherwise
   * take the max across the team's players.
   * @returns {number}
   */
  _teamDeadPileCount(room, player, opponent = false) {
    const counts = room.playerDeadPileCount;
    if (!counts || typeof counts.get !== 'function') return 0;
    const parity = opponent ? (player.playerIndex + 1) % 2 : player.playerIndex % 2;
    const teamKey = parity === 0 ? 'teamA' : 'teamB';
    const teamCount = counts.get(teamKey);
    if (teamCount != null) return Number(teamCount) || 0;
    return room
      .getPlayers()
      .filter((p) => p.playerIndex % 2 === parity)
      .reduce((max, p) => Math.max(max, Number(counts.get(p.playerId)) || 0), 0);
  }

  /**
   * Whether the bot's team (or the OPPOSING team when `opponent`) has already
   * taken a well, mirroring GameValidator._teamHasTakenPozzetto (team key OR any
   * teammate flag). The opponent side feeds the threat model: a side that has
   * banked its well and holds a brazilia can go out at any moment.
   * @param {GameRoom} room
   * @param {PlayerSession} player
   * @param {boolean} [opponent]
   * @returns {boolean}
   */
  _teamHasTakenPozzetto(room, player, opponent = false) {
    const taken = room.playerHasTakenPozzetto;
    if (!taken || typeof taken.get !== 'function') return false;
    const parity = opponent ? (player.playerIndex + 1) % 2 : player.playerIndex % 2;
    const teamKey = parity === 0 ? 'teamA' : 'teamB';
    if (taken.get(teamKey) === true) return true;
    return room
      .getPlayers()
      .some((p) => p.playerIndex % 2 === parity && taken.get(p.playerId) === true);
  }

  _serializeCard(card) {
    if (!card) return null;
    return {
      cardId: card.cardId ?? card.instanceId ?? card.id ?? null,
      instanceId: card.cardId ?? card.instanceId ?? card.id ?? null,
      suit: card.suit,
      rank: card.rank,
      isJoker: card.rank === 'joker' || card.suit === 'joker',
    };
  }

  _stateKey(room, player) {
    const hand = room.playerHands.get(player.playerId) || [];
    const discardCount = room.discardPile?.length || 0;
    const meldCount = (room.playerMelds.get(player.playerId) || []).reduce(
      (sum, meld) => sum + meld.length,
      0
    );
    return [
      room.roomId,
      player.playerId,
      room.currentTurn,
      room.hasDrawnCard ? 'drawn' : 'draw',
      hand.length,
      discardCount,
      meldCount,
      room.deck?.count || 0,
    ].join(':');
  }

  _blockState(stateKey) {
    this.blockedStateKeys.add(stateKey);
    if (this.blockedStateKeys.size <= 1000) return;
    const first = this.blockedStateKeys.values().next().value;
    if (first) this.blockedStateKeys.delete(first);
  }

  _numberConfig(key, fallback, min = Number.NEGATIVE_INFINITY) {
    const value = Number(this.config[key]);
    return Number.isFinite(value) ? Math.max(min, value) : fallback;
  }

  _randomDelay(minMs, maxMs) {
    if (maxMs <= minMs) return Math.round(minMs);
    return Math.round(minMs + Math.random() * (maxMs - minMs));
  }
}

module.exports = BotCoordinator;
