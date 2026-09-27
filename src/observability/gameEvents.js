/**
 * The one way a GAME-LEVEL fact is emitted (deal, draw, discard, meld, take,
 * timeout, round end, seat comes/goes, stock promotion ...). Two sinks:
 *
 *   1. the per-match GameEventRecorder — compact, replay-complete, never
 *      evicted by log chatter (this is what the dev console's replay and
 *      Story read);
 *   2. one `[GAME] <type>` log line, which also lands in the room's log ring
 *      so the raw log still shows the spine of the game in context.
 *
 * Cards in payloads travel as compact refs ("QH#123", replayCodec.cardRef).
 * Lives outside SocketHandlers so ActionHandlers (stock promotion) can emit
 * through the exact same path.
 */

const logger = require('../utils/logger');
const { getGameEventRecorder } = require('./GameEventRecorder');

/**
 * @param {import('../models/GameRoom')} room
 * @param {string} type
 * @param {object} [payload]
 * @returns {{matchId: string, seq: number}|null} the recorded event, if any
 */
function emitGameEvent(room, type, payload = {}) {
  if (!room) return null;
  const head = getGameEventRecorder().record(room, type, payload);
  logger.info(`[GAME] ${type}`, {
    roomId: room.roomId,
    game: type,
    ...payload,
    ...(head ? { match: head.matchId, seq: head.seq } : {}),
  });
  return head;
}

module.exports = { emitGameEvent };
