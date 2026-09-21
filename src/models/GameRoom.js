/**
 * GameRoom Model
 * Represents a game room with players and state
 */

const { Deck } = require('./Deck');
const { GameRoomStatus } = require('../constants');
const GameValidator = require('../validators/GameValidator');
const logger = require('../utils/logger');

const DEFAULT_TURN_TIME_LIMIT_SECONDS = 30;

/**
 * ANTI PING-PONG: how many of the taker's turn ENDS a fresh discard lock runs
 * for. Mirrors the Flutter `PileTakeLock.armedTurns`; the two must agree or a
 * client offers a discard the server rejects.
 *
 *   2 → the turn the pile was taken on (can't throw it straight back)
 *   1 → the taker's NEXT turn (can't throw it back after passing once)
 *   0 → released
 *
 * That span is exactly the volley the rule exists to stop. Anything longer is
 * what made a card unthrowable for a whole round.
 */
const DISCARD_LOCK_TURNS = 2;

class GameRoom {
  constructor({ roomId, maxPlayers = 2 }) {
    this.roomId = roomId;
    this.name = null;
    this.maxPlayers = maxPlayers;
    this.createdAt = new Date();
    this.players = new Map(); // playerId -> PlayerSession
    this.status = GameRoomStatus.WAITING;
    this.currentTurn = 0;
    // Which round of the MATCH this is, 1-based, incremented by every deal.
    // Round 1 opens with the high-card draw; later rounds start with whoever is
    // leading (see startTurnWithRoundLeader), so the ceremony only ever plays
    // once per match.
    this.roundNumber = 0;
    // playerIndex that CLOSED the previous round, or null when a round ended
    // with no batida. Deliberately NOT cleared by startGame() — it is the input
    // to the next round's starter, and startGame runs before that is decided.
    this.lastRoundWinnerIndex = null;
    // Direction the turn rotates each step. Product contract is fixed +1
    // clockwise seat order; the high-card ceremony chooses only the starter.
    this.turnDirection = 1;
    // Result of the pre-game "first turn" high-card draw, broadcast to clients
    // so they can animate the reveal. null until dealCards/runFirstTurnDraw.
    // Shape: { draws:[{playerIndex,card}], rounds:[[{playerIndex,card}]],
    //          winnerIndex, turnDirection, turnOrder }
    this.firstTurnDraw = null;
    this.turnOrder = null;
    this.gameStartedAt = null;
    this.gameEndedAt = null;
    this.winnerId = null;
    this.hostPlayerId = null;
    // True once the room has been synced from the backend (wlive), which is
    // authoritative for the host identity. Blocks the first-joiner host fallback
    // from ever reassigning the host away from what the backend synced.
    this.backendManaged = false;
    this.seatReservationProtocol = 0;
    this.seatConnectionProtocol = 0;
    this.seatLayoutProtocol = 0;
    this.ownerControllerPlayerId = null;
    this.ownerControllerSocketId = null;
    this.replacedHostBotId = null;
    // Index mirror of hostPlayerId + coarse turn phase, both read by FailureManager
    // during reconnection/host-migration (S-C9). Default to safe values so that
    // subsystem never operates on undefined.
    this.hostPlayerIndex = null;
    this.phase = 'draw';

    // Game state
    this.deck = null;
    this.pozzetto = null; // Secondary pile (pot) - 11 cards taken when going down
    this.discardPile = [];
    // Every card discarded THIS ROUND, in order. discardPile is reset to [] the
    // moment anyone takes it, which erases the table's memory; this survives the
    // take so a card-counting bot (and any future replay/analytics) can still
    // know what has already gone by. Never taken from — append-only per round.
    this.discardHistory = [];
    this.deadPiles = [];
    this.playerHands = new Map(); // playerId -> Card[]
    this.playerMelds = new Map(); // playerId -> Meld[][]
    this.playerMeldOrders = new Map(); // playerId -> monotonic creation-order[]
    this.nextMeldOrder = 0;
    this.playerHasTakenPozzetto = new Map(); // playerId -> boolean
    this.playerPozzettoTakeMode = new Map(); // playerId -> 'direct' | 'indirect'
    this.playerDeadPileCount = new Map(); // playerId -> number of wells taken
    /**
     * How many wells (pozzetti/mortos) have been TAKEN by a player this round,
     * across both teams. Distinct from playerDeadPileCount (per team) and from
     * deadPiles.length, which also shrinks when _refillStockOrEndRound PROMOTES
     * an untaken pile into the stock. INFORMATIONAL: no rule gates on it any
     * more — BOTH wells may be taken by discarding the last card, and the only
     * limit is the 2-per-team cap in playerDeadPileCount. Still tracked and
     * shipped because the clients display it and it is not derivable from
     * deadPileCounts.
     */
    this.wellsTakenThisRound = 0;
    // playerId -> Map(meldIndex -> 'semi' | 'dirty'): the worst grade each
    // meld has ever held (absent = never below clean). Downgrade-only — see
    // ActionHandlers._latchMeldGrade. Legacy snapshots stored a Set of indices
    // meaning 'dirty'; FailureManager restores either shape.
    this.meldDirtyFlags = new Map();
    /**
     * MINIMUM MELD RULE: the cards a player laid down THIS TURN, so a turn that
     * ends below the required minimum can hand them straight back. Keyed by
     * playerId; cleared at the start of every turn.
     */
    this.turnMeldedCards = new Map();
    /**
     * OFFLINE STRIKES, per player, per ROUND. One strike is charged each time a
     * player's turn comes around while they are disconnected and the system has
     * to resolve it without them. Coming back online does NOT clear them; a new
     * deal does. At MAX_OFFLINE_STRIKES the match ends.
     */
    this.offlineStrikes = new Map();
    this.teamMeldPointsThisTurn = new Map(); // teamId -> points this turn
    this.teamRequiredMeldPoints = new Map(); // teamId -> required minimum (professional)
    this.teamTurnPenalty = new Map(); // teamId -> accumulated penalty (professional)
    this.hasDrawnCard = false;
    this.turnHadManualAction = false;
    this.consecutiveInactiveTurns = new Map(); // playerId -> timed-out turns without manual action

    // In-game chat backlog (socket-only feature). Keeps the most recent messages
    // so a reconnecting/late-joining client can replay the conversation. Bounded
    // to avoid unbounded growth on long sessions. chatSeq makes each message id
    // unique and monotonic within the room.
    this.chatHistory = [];
    this.chatSeq = 0;

    this.lastRoundScores = {};
    this.lastTeamScores = {};
    this.lastBatidaType = null;

    this.cumulativeScores = new Map(); // playerId -> cumulative score
    this.cumulativeTeamScores = new Map(); // teamId -> cumulative side score
    // teamId -> how many rounds THIS MATCH that side has had voided. The void
    // charge multiplies by it (product owner 2026-09-02): 1st void -200, 2nd
    // -400, 3rd -600, counted across the whole match and never reset by a good
    // round. Persists across deals exactly like cumulativeTeamScores, and dies
    // with the room, which is what makes a new match start over.
    this.voidedRoundCounts = new Map(); // teamId -> voided rounds so far

    // Ruleset configuration
    this.ruleset = 'classic'; // 'classic' | 'professional'
    this.professionalWellMode = 'indirect'; // 'direct' | 'indirect'

    // New PRO room settings (set from sync-room; see SocketHandlers.syncRoomFromBackend).
    /**
     * #11 Match target. When > 0, the match ends once a side's CUMULATIVE total
     * reaches it (GAME_ENDED is terminal); 0 = single round. Default 0 here so a
     * directly-constructed room (tests) is single-round; the config.game default
     * (1000) is applied at sync time when the backend omits it.
     */
    this.targetScore = 0;
    /** In-game chat toggle. When false the server suppresses chat broadcast. */
    this.chatEnabled = true;
    // Admin per-game skin override: { skins, setBy, setAt } or null. Lives and
    // dies with the room (survives round intermissions, not a new game).
    this.skinOverride = null;
    /**
     * Lobby visibility ('public' | 'private'), mirrored from the sync-room
     * payload. Used for the ROOM_SETTINGS_CHANGED lobby broadcast; the socket
     * never gates joins on it (the backend owns the password gate).
     */
    this.visibility = 'public';
    /** Entry stake in integer WLive coins; wallet authority stays in the API. */
    this.bet = 0;
    /**
     * Whether the room is password-gated. Derived from a backend flag on the
     * sync-room payload — the socket NEVER receives the raw/hashed password,
     * only this boolean. Surfaced in ROOM_SETTINGS_CHANGED as `hasPassword`.
     */
    this.hasPassword = false;

    // -----------------------------------------------------------------
    // Turn timer (server-authoritative countdown)
    // -----------------------------------------------------------------
    /** @type {ReturnType<typeof setTimeout>|null} Node timer handle */
    this.turnTimerHandle = null;
    /**
     * One-shot expiry timer handle for the current turn. The server no longer
     * broadcasts a tick every second (that did not scale to many concurrent
     * rooms); it only schedules a single setTimeout that fires at expiry and
     * lets each client run its own display countdown. Kept under the historical
     * name so existing watchdog/cleanup checks still apply.
     * @type {ReturnType<typeof setTimeout>|null}
     */
    this.turnTimerTickHandle = null;
    /**
     * Fallback timer that force-completes the opening deal if a client never
     * acks the deal animation. Set by SocketHandlers; tracked here so
     * disposeTimers() can cancel it on room teardown/shutdown.
     * @type {ReturnType<typeof setTimeout>|null}
     */
    this.dealAnimationFallbackHandle = null;
    /**
     * Delayed delete after a match finishes (kept briefly so clients can refetch
     * the final result on reconnect). Tracked so an earlier teardown can cancel
     * it instead of leaking a 60s closure that re-deletes a gone room.
     * @type {ReturnType<typeof setTimeout>|null}
     */
    this.finalizeCleanupHandle = null;
    // -----------------------------------------------------------------
    // #11 multi-round intermission (server-driven next round)
    // -----------------------------------------------------------------
    /**
     * True from the moment a NON-terminal round ends until the next round is
     * actually dealt (or the match is aborted). The room's `status` deliberately
     * stays FINISHED during this window — flipping it to a new INTERMISSION
     * status would silently change the answer for all ~40 isInProgress()/
     * hasEnded() readers at once, including GameValidator.validateTurn, which is
     * the ONLY thing stopping a player from moving while the round-over overlay
     * is up. This additive flag lets the handful of sites that must treat the
     * intermission as "still in a match" (disconnect handling, seat mutation,
     * leave/forfeit, rejoin) opt in explicitly.
     */
    this.awaitingNextRound = false;
    /**
     * Absolute epoch-ms deadline for the next deal. Persisted (unlike the timer
     * handle, which is not serialisable) so a server restart mid-intermission
     * can re-arm the scheduler instead of stranding the match in FINISHED.
     * @type {number|null}
     */
    this.nextRoundAt = null;
    /**
     * Timer that performs the next deal. Tracked here (like every other per-room
     * handle) so disposeTimers() cancels it on teardown/shutdown and it cannot
     * leak a closure that re-deals a room that is already gone.
     * @type {ReturnType<typeof setTimeout>|null}
     */
    this.nextRoundHandle = null;
    /**
     * Per-room override for the intermission length, in ms (from sync-room).
     * null = use the server default (config.game.nextRoundDelayMs).
     * @type {number|null}
     */
    this.nextRoundDelayMs = null;
    // -----------------------------------------------------------------
    // Host heartbeat (lobby/WAITING rooms only — kills stuck rooms when the
    // host swipes/kills the app and no leave/cancel REST ever fires). See
    // brazilia_host_heartbeat_contract.md and SocketHandlers._ensureHostHeartbeat.
    // -----------------------------------------------------------------
    /** @type {ReturnType<typeof setInterval>|null} ping interval handle */
    this.hostHeartbeatHandle = null;
    /** Consecutive missed pongs (reset to 0 on a valid pong). */
    this.hostHeartbeatMissed = 0;
    /** Epoch-ms of the last valid host pong (null until first pong). */
    this.lastHostPongAt = null;
    /** Monotonic per-ping sequence number. */
    this.hostHeartbeatSeq = 0;
    /**
     * Sticky: true once the host has had a LIVE socket at least once. Misses are
     * only counted after this flips true — a host that has never socket-joined
     * (room synced, app still connecting) is owned by the backend activation
     * deadline, NOT the heartbeat, so it isn't killed mid-connect.
     */
    this.hostEverConnected = false;
    /** Transient: was the host socket absent on the previous tick? */
    this._hostSocketAbsent = false;
    /** Backend callback base URL from sync-room (null → fall back to config). */
    this.backendBaseUrl = null;
    /** Absolute epoch-ms deadline of the current turn (null when no timer). */
    this.turnTimerDeadline = null;
    /**
     * Restart hold (deploy resilience). Set by SocketHandlers._holdRoomForRestart
     * on a room restored after a process restart: `{ since, untilMs, remainingTurnMs,
     * reason }` while no turn timer / bot / next-round deal may run, null once
     * released (a human rejoined, or the hold expired). The handle is the expiry
     * timer; disposeTimers() cancels it on teardown.
     */
    this.restartHold = null;
    this.restartHoldHandle = null;
    /**
     * Precise ms left in the interrupted turn, carried over from the persisted
     * snapshot (FailureManager.persistGameState → turnTimerRemainingMs). Read
     * once by the restart-hold release; null when the snapshot had no live timer.
     */
    this.restoredTurnRemainingMs = null;
    /** Seconds remaining in current turn (snapshot; see getTurnTimeRemaining). */
    this.turnTimeRemaining = DEFAULT_TURN_TIME_LIMIT_SECONDS;
    /** Default seconds per turn */
    this.turnTimeLimit = DEFAULT_TURN_TIME_LIMIT_SECONDS;

    // -----------------------------------------------------------------
    // Per-turn drawn-card restriction (mirrors Flutter GameController)
    // -----------------------------------------------------------------
    /**
     * instanceId (rank+suit key) of the card drawn/taken this turn.
     * Cannot be discarded until the player successfully melds.
     * @type {Set<string>}
     */
    this.drawnCardThisTurnRestriction = new Set();

    /** True once this turn's player has completed at least one meld. */
    this.meldedThisTurn = false;

    /**
     * Card that MUST be included in a meld before the player may discard.
     * Set when player picks up the discard pile.
     * @type {{suit:string,rank:string}|null}
     */
    this.mustMeldCard = null;

    /**
     * ANTI PING-PONG (mirrors Flutter GameController._pileTakeLocks).
     * playerId -> the card that was on TOP of the discard pile when that player
     * last took it, plus how many of that player's turn ENDS the lock still has
     * to run. While the lock stands that player may not discard THAT CARD —
     * which is what stopped two players volleying one card back and forth.
     *
     * Deliberately NOT folded into drawnCardThisTurnRestriction: that set is
     * per-turn and both nextTurn() and a deck draw wipe it, so a deck draw would
     * launder the lock away. This one survives a deck draw and one turn
     * boundary. Keyed per player because the lock binds ONLY the taker — in 2v2
     * the partner stays free.
     *
     * TWO THINGS IT IS DELIBERATELY NOT, both of which it WAS and both of which
     * were reported as "one card is stuck forever":
     *
     *   * It binds a cardId, NOT a rank+suit. The shoe is two decks, so a
     *     rank+suit lock also froze the twin — including a twin drawn from the
     *     stock several turns after the take.
     *   * It EXPIRES. It used to die only on a meld or a new round, so a taker
     *     who never melded carried it for the rest of the round. turnsLeft is
     *     armed at DISCARD_LOCK_TURNS and ticked in nextTurn().
     *
     * @type {Map<string,{cardId:*,suit:string,rank:string,turnsLeft:number}>}
     */
    this.discardLocks = new Map();
    // ANTI PING-PONG, the long half: every card this seat has taken off the pile
    // as a SINGLE-card take this round, grouped by suit-rank. The active lock is
    // released by a deck draw or a multi-card take; THIS is not, so taking the
    // same card again can put the whole family back under lock. Per round — the
    // pile it refers to does not survive a deal.
    this.pileTakeHistory = new Map();

    // -----------------------------------------------------------------
    // Undo-meld snapshot (last meld this turn)
    // -----------------------------------------------------------------
    /**
     * @type {{
     *   playerId: string,
     *   wasNewMeld: boolean,
     *   meldIndex: number,
     *   cards: Array,
     *   restoredMustMeldCard: {suit:string,rank:string}|null,
     *   savedRestriction: Set<string>
     * }|null}
     */
    this.lastMeldSnapshot = null;
  }

  /**
   * Append a chat message to the bounded backlog and return it.
   * @param {Object} message Fully-built chat payload (already sanitized).
   * @param {number} [maxHistory=50] How many recent messages to retain.
   * @returns {Object}
   */
  addChatMessage(message, maxHistory = 50) {
    this.chatHistory.push(message);
    const overflow = this.chatHistory.length - maxHistory;
    if (overflow > 0) {
      this.chatHistory.splice(0, overflow);
    }
    return message;
  }

  /**
   * Get the retained chat backlog (oldest → newest).
   * @returns {Object[]}
   */
  getChatHistory() {
    return this.chatHistory;
  }

  /**
   * Get all players sorted by index
   * @returns {PlayerSession[]}
   */
  getPlayers() {
    return Array.from(this.players.values()).sort(
      (a, b) => a.playerIndex - b.playerIndex
    );
  }

  /**
   * Get connected players only
   * @returns {PlayerSession[]}
   */
  getConnectedPlayers() {
    return this.getPlayers().filter((p) => p.isConnected);
  }

  /**
   * Check if room is full
   * @returns {boolean}
   */
  isFull() {
    return this.players.size >= this.maxPlayers;
  }

  /**
   * Check the full configured roster, including unique, valid seat indices.
   * @returns {boolean}
   */
  canStart() {
    if (![2, 4].includes(this.maxPlayers) || this.players.size !== this.maxPlayers) return false;
    const seats = this.getPlayers().map((player) => player.playerIndex);
    return new Set(seats).size === this.maxPlayers &&
      seats.every((seat) => Number.isInteger(seat) && seat >= 0 && seat < this.maxPlayers);
  }

  /**
   * Check if game is in progress
   * @returns {boolean}
   */
  isInProgress() {
    return this.status === GameRoomStatus.IN_PROGRESS;
  }

  /**
   * Check if game has ended
   * @returns {boolean}
   */
  hasEnded() {
    return this.status === GameRoomStatus.FINISHED;
  }

  /**
   * #11 multi-round: the round is over but the MATCH is not — the server has a
   * next deal scheduled. Distinct from hasEnded(): both are true right now, but
   * only this one means "do not tear anything down, a round is coming".
   * @returns {boolean}
   */
  isBetweenRounds() {
    return this.awaitingNextRound === true;
  }

  /**
   * Add a player to the room
   * @param {PlayerSession} player
   * @returns {boolean}
   */
  addPlayer(player) {
    if (this.isFull()) return false;
    if (this.players.has(player.playerId)) return false;
    // All join paths share this invariant, including spectator claims and
    // restored sessions: one player per valid seat, regardless of player count.
    if (!Number.isInteger(player.playerIndex) ||
        player.playerIndex < 0 || player.playerIndex >= this.maxPlayers) return false;
    if (this.getPlayerByIndex(player.playerIndex)) return false;

    this.players.set(player.playerId, player);
    // Mark that this room has been occupied at least once. Used when the room is
    // later deleted to decide whether to tell the backend to close it — a
    // freshly synced room that no one ever joined must NOT close the backend row
    // (the host may still be connecting). See GameService._deleteRoom.
    this.everHadPlayers = true;
    return true;
  }

  /**
   * Remove a player from the room
   * @param {string} playerId
   * @returns {boolean}
   */
  removePlayer(playerId) {
    return this.players.delete(playerId);
  }

  /**
   * Get a player by ID
   * @param {string} playerId
   * @returns {PlayerSession|undefined}
   */
  getPlayer(playerId) {
    return this.players.get(playerId);
  }

  /**
   * Get player by index
   * @param {number} playerIndex
   * @returns {PlayerSession|undefined}
   */
  getPlayerByIndex(playerIndex) {
    return this.getPlayers().find((p) => p.playerIndex === playerIndex);
  }

  /**
   * Repair a pre-game host displaced by an older first-join/switch-team path.
   * Never reseat a running match: player indices also identify its teams/hands.
   * @returns {boolean} whether any seated player moved
   */
  restoreWaitingHostSeat() {
    if (this.status !== GameRoomStatus.WAITING || this.awaitingNextRound || this._pendingBackendStart ||
        this.hostPlayerId == null) return false;
    const host = this.getPlayers().find((p) => String(p.playerId) === String(this.hostPlayerId));
    const occupant = this.getPlayerByIndex(0);
    if (host) {
      this.hostPlayerIndex = 0;
      if (host.playerIndex === 0) return false;
      if (occupant) occupant.playerIndex = host.playerIndex;
      host.playerIndex = 0;
      return true;
    }
    if (!occupant) return false;
    // The host has not connected yet. Keep their chair free without dropping
    // or duplicating the guest who was incorrectly assigned it.
    for (let seat = 1; seat < this.maxPlayers; seat += 1) {
      if (this.getPlayerByIndex(seat)) continue;
      occupant.playerIndex = seat;
      return true;
    }
    return false;
  }

  /**
   * Check if it's a player's turn
   * @param {string} playerId
   * @returns {boolean}
   */
  isPlayerTurn(playerId) {
    const player = this.getPlayer(playerId);
    return player && player.playerIndex === this.currentTurn;
  }

  /**
   * Start the game
   * Legacy callers may still pass a force argument; it never bypasses the
   * configured roster requirement or changes a 2v2 table into another mode.
   */
  startGame() {
    // A short 2v2 table can have seats [0, 1, 3]. Shrinking its capacity to 3
    // would rotate through missing seat 2 and stop the timer permanently.
    if (!this.canStart()) return false;

    this.status = GameRoomStatus.IN_PROGRESS;
    this.gameStartedAt = new Date();
    this.roundNumber = (this.roundNumber || 0) + 1;
    // #11 multi-round: this room is REUSED across rounds (triggerStartGame
    // re-deals in place). The backend game-result webhook must fire ONCE PER
    // ROUND, so clear the per-round double-fire guard at the start of every
    // (re-)deal. cumulativeTeamScores/cumulativeScores deliberately PERSIST.
    this.resultReported = false;
    // #11 multi-round: the per-round one-shots below latch when a round ends.
    // If they are NOT cleared on a re-deal the NEXT round can never broadcast
    // its GAME_ENDED (guard stays true) nor tear down (a stale finalize timer
    // from the previous round would delete the room MID round 2). Reset them so
    // round 2+ behaves exactly like round 1.
    this._roundEndBroadcast = false;
    this.lastRoundEndPayload = null;
    if (this.finalizeCleanupHandle) {
      clearTimeout(this.finalizeCleanupHandle);
      this.finalizeCleanupHandle = null;
    }
    // #11 multi-round: the intermission is OVER the instant a deal starts —
    // whoever won the race (the server scheduler, a manual host start_game, or
    // the backend start-game webhook). Clearing the flag + handle HERE is what
    // makes the whole thing idempotent: the loser of the race finds
    // awaitingNextRound=false and returns without dealing a second time.
    this.awaitingNextRound = false;
    this.nextRoundAt = null;
    if (this.nextRoundHandle) {
      clearTimeout(this.nextRoundHandle);
      this.nextRoundHandle = null;
    }
    this.currentTurn = 0;
    this.turnDirection = 1; // reset; overridden by runFirstTurnDraw after dealing
    this.turnOrder = null;
    this.firstTurnDraw = null;
    this.nextMeldOrder = 0;
    this.cardsDealt = false;
    // Per-round: both wells are back on the table for the new deal.
    this.wellsTakenThisRound = 0;
    // Anti ping-pong locks are per-round: the pile they refer to is gone.
    this.discardLocks = new Map();
    this.pileTakeHistory = new Map();
    // #11 multi-round: the discard pile is PER-ROUND state. dealCards() only
    // pushes the freshly-flipped top card onto it, so without this reset round 2+
    // would start holding every card discarded in round 1 — cards that the new
    // Deck has just reshuffled back in, so taking the pile would deal duplicates.
    // (discardHistory below is the append-only per-round record of the same.)
    this.discardPile = [];
    this.discardHistory = [];

    // The pozzetto maps are keyed BOTH by playerId and by team ('teamA'/'teamB'):
    // _markTeamPozzettoTaken writes the team key and _teamDeadPileCount reads
    // that key FIRST. Walking `players` alone therefore reset the playerId
    // entries and left last round's TEAM entries standing, where they kept
    // winning the lookup — so the 2-wells-per-team cap silently became per
    // SESSION instead of per round ("I took one well last round, so this round
    // my second take ends the game instead"). Worse, the sticky
    // playerHasTakenPozzetto let a side start every later round already flagged
    // as having taken a well: it could close without one and still collect the
    // +100 well bonus. Clear the maps whole, then re-seed per player below.
    this.turnMeldedCards.clear();
    // Per ROUND: a new deal wipes the slate, but reconnecting mid-round does not.
    this.offlineStrikes.clear();
    this.playerHasTakenPozzetto.clear();
    this.playerPozzettoTakeMode?.clear();
    this.playerDeadPileCount.clear();

    // Initialize empty game state structures
    this.players.forEach((player) => {
      this.playerHands.set(player.playerId, []);
      this.playerMelds.set(player.playerId, []);
      this.playerMeldOrders.set(player.playerId, []);
      this.playerHasTakenPozzetto.set(player.playerId, false);
      this.playerPozzettoTakeMode.set(player.playerId, null);
      this.playerDeadPileCount.set(player.playerId, 0);
      this.meldDirtyFlags.set(player.playerId, new Map());
      const teamId = player.playerIndex % 2 === 0 ? 'teamA' : 'teamB';
      this.teamMeldPointsThisTurn.set(player.playerId, 0);
      this.teamRequiredMeldPoints.set(player.playerId, null);
      this.teamTurnPenalty.set(player.playerId, 0);
      // NOT guarded by has(): these are TEAM-keyed entries in the same maps, and
      // a `has()` guard left last round's values standing — the raised minimum
      // (75 -> 95 -> ...) never came back down at a new deal, and the turn
      // penalty kept accruing across rounds. Same leak the pozzetto counters had.
      this.teamMeldPointsThisTurn.set(teamId, 0);
      this.teamRequiredMeldPoints.set(teamId, null);
      this.teamTurnPenalty.set(teamId, 0);
      if (!this.cumulativeTeamScores.has(teamId)) this.cumulativeTeamScores.set(teamId, 0);
      this.consecutiveInactiveTurns.set(player.playerId, 0);
      if (!this.cumulativeScores.has(player.playerId)) {
        this.cumulativeScores.set(player.playerId, 0);
      }
    });
    
    this.hasDrawnCard = false;
    this.turnHadManualAction = false;
    
    return true;
  }

  /**
   * Deal cards and set up the deck
   */
  dealCards() {
    if (this.cardsDealt) return false;

    try {
      // Create and shuffle deck
      this.deck = new Deck({ includeJokers: this.ruleset === 'classic' });
      this.deck.shuffle();
      
      // Deal 11 cards to each player
      this.players.forEach((player) => {
        const hand = this.deck.deal(11);
        this.playerHands.set(player.playerId, hand);
        logger.info(`[GameRoom.dealCards] Dealt ${hand.length} cards to player ${player.playerId} (index: ${player.playerIndex})`, { roomId: this.roomId });
      });
      
      // Create pozzetto (pot) - two 11-card piles.
      const pozzetto1 = this.deck.deal(11);
      const pozzetto2 = this.deck.deal(11);
      this.deadPiles = [pozzetto1, pozzetto2];
      this.pozzetto = pozzetto1; // Keep for backward compatibility.
      
      // Flip first card to discard pile
      const firstCard = this.deck.draw();
      if (firstCard) {
        this.discardPile.push(firstCard);
        this.discardHistory.push(firstCard);
      }
      
      this.cardsDealt = true;
      logger.info(`[GameRoom] Cards dealt. Deck: ${this.deck.count}, Pozzetto: ${this.pozzetto.length} cards`, { roomId: this.roomId });
      return true;
    } catch (error) {
      logger.error(`[GameRoom] Error dealing cards in room ${this.roomId}: ${error.message}`, error);
      throw error;
    }
  }

  /**
   * Run the pre-game "first turn" draw to decide who plays first.
   *
   * Every player draws one card from the top of the (already-dealt) deck. The
   * highest card (natural rank, see Card.firstTurnRank) wins the first turn.
   * Ties are resolved by having ONLY the tied players draw again (repeatedly)
   * until a single winner remains. The draw chooses only that starter; subsequent
   * turns always advance clockwise by absolute seat index. With opposite-seat
   * partnerships (0,2 vs 1,3), that also preserves team alternation.
   *
   * The drawn cards are CEREMONIAL: they are returned to the deck and reshuffled
   * afterwards, so the deck count is unchanged and gameplay is unaffected.
   *
   * Result is stored on `this.firstTurnDraw` and `this.currentTurn`/
   * `this.turnDirection` are set. Returns the firstTurnDraw object (or null).
   */
  runFirstTurnDraw() {
    if (!this.deck) return null;
    const players = this.getPlayers();
    if (players.length < 2) return null;

    const rankOf = (card) => (card && typeof card.firstTurnRank === 'function' ? card.firstTurnRank() : -1);

    const ceremonyCards = []; // every card pulled, returned to the deck afterwards
    // Draw one card for each index; returns Map(playerIndex -> Card).
    const drawCards = (indices) => {
      const out = new Map();
      for (const idx of indices) {
        const card = this.deck.draw();
        if (!card) continue;
        ceremonyCards.push(card);
        out.set(idx, card);
      }
      return out;
    };

    const allIndices = players.map((p) => p.playerIndex);

    // ---- Winner determination (these rounds ARE animated on the client) ----
    // Round 0: everybody draws. Each later round: only the players tied for the
    // current highest redraw (the others have already lost). Repeat until one
    // player stands alone. `latest` holds each player's most recent card in
    // these rounds, used for the per-player `draws` snapshot.
    const rounds = []; // [[{playerIndex, card}], ...]
    const latest = new Map(); // playerIndex -> Card
    let contenders = [...allIndices];
    let guard = 0;
    while (guard++ < 50) {
      const drawn = drawCards(contenders);
      const round = [];
      for (const idx of contenders) {
        const card = drawn.get(idx);
        if (!card) continue;
        latest.set(idx, card);
        round.push({ playerIndex: idx, card: card.toJSON() });
      }
      rounds.push(round);
      let max = -1;
      for (const idx of contenders) max = Math.max(max, rankOf(latest.get(idx)));
      contenders = contenders.filter((idx) => rankOf(latest.get(idx)) === max);
      if (contenders.length <= 1) break;
    }
    const winnerIndex = contenders[0];

    // The ceremony chooses ONLY the starter. Product contract: every match then
    // advances clockwise by absolute seat index. Opposite-seat partnerships in
    // 2v2 still alternate naturally (A-B-A-B).
    const turnOrder = allIndices.map((_, offset) =>
      (winnerIndex + offset) % this.maxPlayers
    );
    const turnDirection = 1;

    // Return all ceremony cards to the deck and reshuffle so nothing is consumed.
    for (const card of ceremonyCards) this.deck.cards.push(card);
    this.deck.shuffle();

    this.currentTurn = winnerIndex;
    this.turnDirection = turnDirection;
    this.turnOrder = turnOrder;
    this.firstTurnDraw = {
      draws: players.map((p) => ({
        playerIndex: p.playerIndex,
        card: latest.get(p.playerIndex) ? latest.get(p.playerIndex).toJSON() : null,
      })),
      rounds,
      winnerIndex,
      turnDirection,
      turnOrder,
    };

    logger.info(`[GameRoom] First-turn draw: winner=index ${winnerIndex}, direction=${turnDirection}, rounds=${rounds.length}`, { roomId: this.roomId });
    return this.firstTurnDraw;
  }

  /**
   * Seat the next round's opening turn on the side that is AHEAD, with no
   * high-card draw.
   *
   * Product decision 2026-08-27: "Pemenang harusnya yang pertama kali jalan
   * (jadi ga perlu undian lagi)". The ceremony belongs to the start of a MATCH;
   * from round 2 on, leading the scoreboard is what earns the first move.
   *
   * Ordering, in the order it is asked:
   *
   *   1. the side with the higher cumulative score starts;
   *   2. within that side, the seat that actually CLOSED the previous round —
   *      the batida — because that is the "pemenang" in the sentence above;
   *   3. failing that (a round that ended with no batida, or a closer who is not
   *      on the leading side), its lowest seat index, which is stable and needs
   *      no tiebreak of its own;
   *   4. if the sides are LEVEL there is no leader to honour, so the draw runs
   *      after all — that is the one case the ceremony still earns.
   *
   * @returns {{winnerIndex:number, reason:string}|null} null when it fell
   *   through to the draw, which the caller has then already had run.
   */
  startTurnWithRoundLeader() {
    const players = this.getPlayers();
    if (players.length < 2) return null;

    const scoreOf = (teamId) => this.cumulativeTeamScores.get(teamId) || 0;
    const teamOf = (p) => (p.playerIndex % 2 === 0 ? 'teamA' : 'teamB');

    const teams = [...new Set(players.map(teamOf))];
    const best = teams.reduce(
      (a, b) => (scoreOf(b) > scoreOf(a) ? b : a),
      teams[0]
    );
    const levelled = teams.filter((t) => scoreOf(t) === scoreOf(best)).length > 1;
    if (levelled) {
      // Nobody is ahead — fall back to the ceremony rather than inventing an
      // order out of seat numbers. Null tells the caller a draw decided it.
      this.runFirstTurnDraw();
      return null;
    }

    const onBest = players.filter((p) => teamOf(p) === best);
    const closer = onBest.find((p) => p.playerIndex === this.lastRoundWinnerIndex);
    const starter = closer
      || onBest.reduce((a, b) => (b.playerIndex < a.playerIndex ? b : a), onBest[0]);

    this.currentTurn = starter.playerIndex;
    this.turnDirection = 1;
    this.turnOrder = players.map(
      (_, offset) => (starter.playerIndex + offset) % this.maxPlayers
    );
    // No ceremony data: the client animates the reveal only when this is set, so
    // leaving it null is what silences it for rounds 2+.
    this.firstTurnDraw = null;

    logger.info(
      `[GameRoom] Round ${this.roundNumber} starts with index ${starter.playerIndex} (${best} leads${closer ? ', closed last round' : ''})`,
      { roomId: this.roomId }
    );
    return { winnerIndex: starter.playerIndex, reason: closer ? 'closed_previous' : 'leading_side' };
  }

  /**
   * End the game
   * @param {string} winnerId
   */
  endGame(winnerId = null) {
    this.status = GameRoomStatus.FINISHED;
    this.gameEndedAt = new Date();
    this.winnerId = winnerId;
  }

  /**
   * Mark room as abandoned
   */
  abandon() {
    this.status = GameRoomStatus.ABANDONED;
  }

  /**
   * Cancel and null every per-room timer handle. Idempotent and safe to call
   * multiple times. Called on room deletion and on server shutdown so no timer
   * keeps firing into (or holding a closure over) a room that is gone. Both
   * clearTimeout and clearInterval accept any Node timer handle, so this works
   * regardless of which kind each handle is.
   */
  disposeTimers() {
    const handles = [
      'turnTimerHandle',
      'turnTimerTickHandle',
      'dealAnimationFallbackHandle',
      'finalizeCleanupHandle',
      // #11 multi-round: without this, a deleted/shut-down room would keep a
      // live 10s closure that re-deals a room GameService has already wiped
      // (its playerToRoom/socketToPlayer mappings are gone, so the deal would
      // emit hands into dead sockets).
      'nextRoundHandle',
      'hostHeartbeatHandle',
      // Deploy-restart hold expiry: a torn-down room must never re-arm its
      // runtime from a stale hold.
      'restartHoldHandle',
    ];
    for (const name of handles) {
      if (this[name]) {
        clearTimeout(this[name]);
        clearInterval(this[name]);
        this[name] = null;
      }
    }
    // The room is being torn down: no next round is coming, so no reader may
    // still believe the match is mid-intermission.
    this.awaitingNextRound = false;
    this.nextRoundAt = null;
    this.hostHeartbeatMissed = 0;
    this.hostHeartbeatSeq = 0;
    this.turnTimerDeadline = null;
    this.restartHold = null;
  }

  /**
   * ANTI PING-PONG: arm `playerId`'s lock on `card`. Taking again MOVES the lock
   * to the new top card — one lock per player at a time.
   *
   * `twinsInHand` is RULE A (2026-09-02): on a take of EXACTLY ONE card the
   * caller passes every copy of the same rank+suit already in the taker's hand,
   * and they are locked alongside the taken card. Without them the volley is
   * trivially defeated — take the 8H off the pile, throw your OWN 8H, and the
   * identical card goes straight back. It is an explicit ARGUMENT rather than a
   * hand lookup done in here on purpose: several callers (and a lot of tests)
   * arm the lock directly for shapes that must NOT recruit a twin, and only
   * SocketHandlers.handlePickUpPile knows a take was a lone-card take.
   * @param {string} playerId
   * @param {{cardId:*,suit:string,rank:string}} card TOP card of the pile taken
   * @param {Array<{cardId:*}>} [twinsInHand] same rank+suit copies already held
   */
  armDiscardLock(playerId, card, twinsInHand = []) {
    if (!playerId || !card) return;
    const cardId = card.cardId ?? card.instanceId ?? card.id ?? null;

    // The lock is rebuilt from the seat's TAKE HISTORY, not from whatever lock
    // happens to be alive right now.
    //
    // Product decision 2026-08-27: "misal sebelumnya dia ambil j lock aja, trus
    // udah muter gilirannya, pas ambil kartu sama j baru dan yang lama ke lock".
    // Reading the live lock could not do that. A deck draw releases the lock, and
    // in 2v2 a full turn cycle guarantees at least one draw between two takes —
    // so copy A was always free again by the time copy B arrived, and the
    // opponent could volley the pair forever. 1v1 hid it behind a shorter cycle;
    // it was never a 2v2-only bug.
    //
    // History survives every release, so the family comes back under lock the
    // moment the same card is taken again.
    const key = `${card.suit}-${card.rank}`;
    if (!this.pileTakeHistory) this.pileTakeHistory = new Map();
    let seatHistory = this.pileTakeHistory.get(playerId);
    if (!seatHistory) {
      seatHistory = new Map();
      this.pileTakeHistory.set(playerId, seatHistory);
    }
    const taken = seatHistory.get(key) || [];
    if (cardId !== null && !taken.some((id) => String(id) === String(cardId))) {
      taken.push(cardId);
    }
    // RULE A twins join the SAME history entry — they are by definition the same
    // suit-rank family, and the history is what makes the two-copy volley
    // impossible across a release.
    for (const twin of Array.isArray(twinsInHand) ? twinsInHand : []) {
      const twinId = twin ? (twin.cardId ?? twin.instanceId ?? twin.id ?? null) : null;
      if (twinId === null) continue;
      if (String(twinId) === String(cardId)) continue;
      if (!taken.some((id) => String(id) === String(twinId))) taken.push(twinId);
    }
    seatHistory.set(key, taken);

    this.discardLocks.set(playerId, {
      // `cardId` stays as the MOST RECENT id so an older client that only reads
      // the singular field still blocks something rather than nothing.
      cardId,
      cardIds: [...taken],
      suit: card.suit,
      rank: card.rank,
      turnsLeft: DISCARD_LOCK_TURNS,
    });
  }

  /**
   * ANTI PING-PONG: release `playerId`'s ACTIVE lock. A deck draw, a multi-card
   * take and a new deal pay one off early. A MELD does NOT (owner rule change
   * 2026-09-21): ActionHandlers no longer calls this from any meld path.
   *
   * The seat's take HISTORY is deliberately left standing: releasing it here
   * would reopen the two-copy volley the moment the taker drew a card, which is
   * exactly what was reported. Only a new deal clears the history, because only
   * then is it about a different pile.
   * @param {string} playerId
   */
  clearDiscardLock(playerId) {
    if (playerId) this.discardLocks.delete(playerId);
  }

  /**
   * ANTI PING-PONG: one tick off `playerId`'s lock, released at zero.
   *
   * Called from nextTurn() for the seat whose turn just ENDED — never for the
   * incoming one, or a lock would burn down while its owner is not even playing.
   * @param {string} playerId
   */
  tickDiscardLock(playerId) {
    const lock = playerId && this.discardLocks.get(playerId);
    if (!lock) return;
    const turnsLeft = (Number.isFinite(lock.turnsLeft) ? lock.turnsLeft : DISCARD_LOCK_TURNS) - 1;
    if (turnsLeft <= 0) this.discardLocks.delete(playerId);
    else this.discardLocks.set(playerId, { ...lock, turnsLeft });
  }

  /**
   * playerId of the seat currently to act, or null.
   * @returns {string|null}
   */
  playerIdForCurrentTurn() {
    const player = this.getPlayers().find((p) => p.playerIndex === this.currentTurn);
    return player ? player.playerId : null;
  }

  /**
   * Advance to next player's turn
   */
  nextTurn() {
    // ANTI PING-PONG: the OUTGOING seat's turn is what just ended, so tick its
    // lock BEFORE currentTurn moves.
    this.tickDiscardLock(this.playerIdForCurrentTurn());

    if (Array.isArray(this.turnOrder) && this.turnOrder.length === this.maxPlayers) {
      const idx = this.turnOrder.indexOf(this.currentTurn);
      this.currentTurn = idx >= 0 ? this.turnOrder[(idx + 1) % this.turnOrder.length] : this.turnOrder[0];
    } else {
      // Legacy/restored games may not carry turnOrder. Never revive a historical
      // counter-clockwise direction: the product contract is fixed clockwise.
      this.currentTurn = (this.currentTurn + 1) % this.maxPlayers;
    }
    // Reset per-turn tracking fields
    this.phase = 'draw';
    this.hasDrawnCard = false;
    this.turnHadManualAction = false;
    this.drawnCardThisTurnRestriction = new Set();
    this.meldedThisTurn = false;
    this.mustMeldCard = null;
    this.lastMeldSnapshot = null;
    // discardLocks is not CLEARED here — it is TICKED at the top of this method.
    // The ping-pong the rule stops happens ACROSS turns (take the pile, pass,
    // throw the same card back next turn), so clearing on the boundary would
    // defeat it; but leaving it untouched until a meld is what made a card
    // unthrowable for a whole round.
  }

  /**
   * Check if all players are inactive
   * @param {number} timeoutMs
   * @returns {boolean}
   */
  allPlayersInactive(timeoutMs) {
    const players = this.getPlayers();
    if (players.length === 0) return true;
    return players.every((p) => p.isInactive(timeoutMs));
  }

  /**
   * Get room age in milliseconds
   * @returns {number}
   */
  getRoomAge() {
    return Date.now() - this.createdAt.getTime();
  }

  /**
   * Serialize to JSON
   * @returns {Object}
   */
  toJSON() {
    return {
      roomId: this.roomId,
      roomName: this.name || null,
      maxPlayers: this.maxPlayers,
      status: this.status,
      currentTurn: this.currentTurn,
      ruleset: this.ruleset,
      professionalWellMode: this.professionalWellMode,
      // New PRO settings (#11 + chat) so a reconnecting client/back end
      // can read the active room configuration.
      targetScore: this.targetScore,
      chatEnabled: this.chatEnabled,
      visibility: this.visibility,
      hasPassword: this.hasPassword,
      bet: this.bet,
      createdAt: this.createdAt.toISOString(),
      gameStartedAt: this.gameStartedAt?.toISOString(),
      gameEndedAt: this.gameEndedAt?.toISOString(),
      winnerId: this.winnerId,
      lastRoundScores: this.lastRoundScores,
      lastBatidaType: this.lastBatidaType,
      turnTimeRemaining: this.getTurnTimeRemaining(),
      turnTimeLimit: this.turnTimeLimit,
      turnTimeLimitSeconds: this.turnTimeLimit,
      players: this.getPlayers().map((p) => p.toJSON()),
      // #5 reconnect badge: every player's melds with cards in #2 canonical order
      // plus isBuraco/clean so the client re-renders brazilia markers on resume.
      melds: this.serializeMelds(),
    };
  }

  /**
   * Build the per-player melds array: each meld with its cards in #2 canonical
   * order (wild-2 in its gap) and #5 badge flags (isBuraco/clean).
   *
   * PUBLIC because the live state builders emit it too. It used to be reachable
   * only through toJSON(), whose sole non-card caller is a handleReconnect static
   * with no call site — so the badge flags this exists to carry were never
   * actually sent, and a reconnecting client re-derived them locally (paying 200
   * for a buraco the server scores 100).
   *
   * NOT cheap: it re-serializes every card and runs GameValidator.meldClean per
   * meld. Call it ONCE per fan-out, above the per-seat loop, never inside it.
   * @returns {Array<{playerIndex:number,teamId:string,melds:Array}>}
   */
  serializeMelds() {
    const ruleset = this.ruleset || 'classic';
    return this.getPlayers().map((p) => {
      const flags = this.meldDirtyFlags.get(p.playerId);
      // Map(idx -> grade) today; a legacy Set of indices means 'dirty'.
      const latchedAt = (idx) => {
        if (!flags) return undefined;
        if (flags instanceof Map) return flags.get(idx);
        return flags.has && flags.has(idx) ? 'dirty' : undefined;
      };
      const melds = (this.playerMelds.get(p.playerId) || []).map((meld, idx) => ({
        cards: (Array.isArray(meld) ? meld : []).map((c) =>
          c && typeof c.toJSON === 'function' ? c.toJSON() : c
        ),
        isBuraco: Array.isArray(meld) && meld.length >= 7,
        clean: GameValidator.meldClean(meld, ruleset, latchedAt(idx) !== undefined),
        // Full lattice for the client's board — `clean:false` alone cannot say
        // whether the not-clean is SEMI or DIRTY.
        grade: GameValidator.meldGrade(meld, ruleset, latchedAt(idx)),
      }));
      return {
        playerIndex: p.playerIndex,
        teamId: p.playerIndex % 2 === 0 ? 'teamA' : 'teamB',
        melds,
      };
    });
  }

  /**
   * Live seconds remaining in the current turn, derived from the absolute
   * deadline set when the timer started. Falls back to the stored snapshot
   * when no timer is active (e.g. unit tests / between turns). This is the
   * source of truth now that the server does not decrement every second.
   * @returns {number}
   */
  getTurnTimeRemaining() {
    if (this.turnTimerDeadline != null) {
      return Math.max(0, Math.ceil((this.turnTimerDeadline - Date.now()) / 1000));
    }
    // No armed authoritative timer → report 0 instead of a stale snapshot so a
    // client never anchors a phantom countdown the server will not fire
    // (Item 8). A live timer always sets turnTimerDeadline while running.
    return 0;
  }

  getPlayerScores() {
    return this.lastRoundScores || {};
  }

  /**
   * String representation
   * @returns {string}
   */
  toString() {
    return `GameRoom(${this.roomId}, status: ${this.status}, players: ${this.players.size}/${this.maxPlayers})`;
  }
}

module.exports = GameRoom;
module.exports.DISCARD_LOCK_TURNS = DISCARD_LOCK_TURNS;
