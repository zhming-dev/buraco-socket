const { GameRoomStatus } = require('../constants');

const validAttempt = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const hasPendingSeatMutation = (handlers, roomId) => {
  const prefix = `${roomId}:`;
  return [handlers._seatMutations, handlers._pendingSeatClaims].some((operations) =>
    operations && [...operations.keys()].some((key) => key.startsWith(prefix)));
};

// Only an undealt WAITING room can be rolled back. Keep the original lobby
// metadata as well as copies of collections startGame/dealCards mutate in place.
const waitingStateFields = [
  'status', 'phase', 'roundNumber', 'gameStartedAt', 'gameEndedAt', 'startAttemptId',
  'currentTurn', 'turnDirection', 'turnOrder', 'firstTurnDraw', 'nextMeldOrder',
  'cardsDealt', 'wellsTakenThisRound', 'resultReported', '_roundEndBroadcast',
  'lastRoundEndPayload', 'awaitingNextRound', 'nextRoundAt', 'hasDrawnCard',
  'turnHadManualAction', 'turnTimeRemaining', 'turnTimerDeadline',
  'deck', 'pozzetto', 'deadPiles', 'discardPile', 'discardHistory',
  'playerHands', 'playerMelds', 'playerMeldOrders', 'playerHasTakenPozzetto',
  'playerPozzettoTakeMode', 'playerDeadPileCount', 'meldDirtyFlags',
  'turnMeldedCards', 'discardLocks', 'pileTakeHistory',
  'teamMeldPointsThisTurn', 'teamRequiredMeldPoints', 'teamTurnPenalty',
  'consecutiveInactiveTurns', 'cumulativeScores', 'cumulativeTeamScores',
];
const copyState = (value) => value instanceof Map
  ? new Map([...value].map(([key, entry]) => [key, copyState(entry)]))
  : Array.isArray(value) ? value.map(copyState) : value;
const captureWaitingState = (room) => room.status === GameRoomStatus.WAITING && room.cardsDealt !== true
  ? Object.fromEntries(waitingStateFields.map((key) => [key, copyState(room[key])])) : null;

function restoreFailedDeal(handlers, room, attemptId, snapshot) {
  if (!snapshot || handlers.gameService.getRoom(room.roomId) !== room || room.cardsDealt ||
      room.startAttemptId !== attemptId || room.awaitingNextRound ||
      ![GameRoomStatus.WAITING, GameRoomStatus.IN_PROGRESS].includes(room.status)) return false;
  handlers._stopTurnTimer(room);
  Object.assign(room, snapshot);
  room.startAttemptId = snapshot.startAttemptId || null;
  room.dealAnimationAcks = new Set();
  handlers._ensureHostHeartbeat(room);
  handlers._persistRoomState(room);
  return true;
}

// Each API attempt is authorized durably before dealing. The pending marker
// freezes local lobby mutations while that authorization is in flight.
async function startBackendAttempt(handlers, roomId, options) {
  const attemptId = options.attemptId;
  if (!validAttempt(attemptId)) return { success: false, error: 'A backend start attempt is required' };
  const ownership = await handlers._ensureRoomOwner(roomId);
  if (!ownership.owned) return { success: false, error: 'Room belongs to another server' };
  const room = handlers.gameService.getRoom(roomId);
  if (!room || !handlers._backendUrlForRoom(roomId)) return { success: false, error: 'Room not ready' };
  room.startAttemptProtocol = 1;
  if (room.startAttemptId === attemptId && room.cardsDealt) {
    return { success: true, attemptId, cardsDealt: true, alreadyStarted: true };
  }
  const previous = room._pendingBackendStart;
  if (previous) {
    return previous.attemptId === attemptId ? previous.promise : { success: false, error: 'Another start is pending' };
  }
  // A reconnect may already have advanced its API reservation generation but
  // still be waiting to bind that session locally. Do not authorize a deal
  // from the old roster while that admission or claim is unresolved.
  if (hasPendingSeatMutation(handlers, roomId)) {
    return { success: false, error: 'A seat change is still pending. Please retry.' };
  }
  if (room.awaitingNextRound || (room.status !== GameRoomStatus.WAITING && !room.isInProgress())) {
    return { success: false, error: 'Room is not waiting to start' };
  }
  if (!room.isInProgress() && !room.canStart()) return { success: false, error: 'Room is not full' };
  const members = room.getPlayers();
  const pending = { attemptId, cancelled: false, promise: null };
  room._pendingBackendStart = pending;
  pending.promise = Promise.resolve().then(async () => {
    let waitingState = null;
    let previousAttemptId = room.startAttemptId || null;
    let triggered = false;
    try {
      const authorization = await handlers._seatBackendRequest(room, 'room-start-authorize', {
        roomId: String(room.roomId), attemptId,
        players: members.map((player) => handlers._serializePlayer(player)),
      });
      const unchanged = handlers.gameService.getRoom(roomId) === room &&
        room._pendingBackendStart === pending && !pending.cancelled &&
        !room.awaitingNextRound && (room.status === GameRoomStatus.WAITING || room.isInProgress()) &&
        members.length === room.players.size && members.every((player) => room.getPlayer(player.playerId) === player) &&
        (!handlers._ownershipEnabled() || handlers.ownedRoomIds.has(String(roomId)));
      if (!unchanged || authorization.authorized !== true || authorization.attemptId !== attemptId) {
        return { success: false, attemptId, error: 'Start authorization expired' };
      }
      // No await between the last validation and the deal. Abort cannot return
      // not_started and then allow this continuation to deal afterwards.
      room._pendingBackendStart = null;
      waitingState = captureWaitingState(room);
      previousAttemptId = room.startAttemptId || null;
      room.startAttemptId = attemptId;
      triggered = true;
      const result = handlers._triggerStartGameNow(roomId, { ...options, deferStartAnnouncement: true });
      if (room.cardsDealt) {
        handlers._persistRoomState(room);
      } else if (!restoreFailedDeal(handlers, room, attemptId, waitingState)) {
        // A previously running room is never a refund-safe failed lobby deal.
        room.startAttemptId = previousAttemptId;
      }
      return { ...result, success: result.success === true && room.cardsDealt === true, attemptId };
    } catch (error) {
      if (triggered && !room.cardsDealt) {
        if (!restoreFailedDeal(handlers, room, attemptId, waitingState)) room.startAttemptId = previousAttemptId;
      } else if (triggered && room.cardsDealt) {
        handlers._persistRoomState(room);
      }
      return { success: false, attemptId, error: 'Could not verify the backend start attempt' };
    } finally {
      if (room._pendingBackendStart === pending) room._pendingBackendStart = null;
    }
  });
  return pending.promise;
}

async function abortBackendAttempt(handlers, roomId, attemptId) {
  if (!validAttempt(attemptId)) return { success: false, error: 'Invalid attemptId' };
  const ownership = await handlers._ensureRoomOwner(roomId);
  if (!ownership.owned) return { success: false, error: 'Room belongs to another server' };
  const room = handlers.gameService.getRoom(roomId);
  // The API has durably marked the attempt aborting before calling us. A late
  // start POST must authorize again and will be rejected, even after restart.
  if (room?.startAttemptId === attemptId && room.cardsDealt) {
    return { success: true, attemptId, outcome: 'started' };
  }
  if (room?.isInProgress() || room?.cardsDealt) {
    // A running legacy/different attempt is not proof that THIS one did not
    // start. Fail closed so the API cannot refund an active game.
    return { success: false, attemptId, error: 'Another running start needs reconciliation' };
  }
  if (room?._pendingBackendStart?.attemptId === attemptId) {
    room._pendingBackendStart.cancelled = true;
  }
  return { success: true, attemptId, outcome: 'not_started' };
}

module.exports = { startBackendAttempt, abortBackendAttempt };
