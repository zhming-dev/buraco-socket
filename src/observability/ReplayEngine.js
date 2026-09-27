/**
 * Replay engine — rebuilds the table at any point of a recorded match.
 *
 * PURE: takes a stream as written by GameEventRecorder (`{header, events}`)
 * and returns plain objects. No room, no sockets, no I/O, so it runs the same
 * in a test, in the dev endpoint and (later) in any other consumer.
 *
 * The walk: find the last keyframe at or before the requested seq, start from
 * its zones, and apply every later event's zone diff up to that seq. A round
 * end carries a checksum of the table the server actually had; replaying up to
 * it and hashing the rebuilt zones proves (or disproves) the reconstruction.
 */

const codec = require('./replayCodec');
const GameValidator = require('../validators/GameValidator');

const TERMINAL = new Set(['match_end', 'voided', 'forfeit', 'match_closed']);

/**
 * Normalize whatever was handed in (a parsed stream, or its JSON text).
 * @param {object|string} stream
 * @returns {{header: object, events: object[]}}
 */
function normalize(stream) {
  const parsed = typeof stream === 'string' ? JSON.parse(stream) : stream;
  if (!parsed || !Array.isArray(parsed.events)) throw new Error('not a replay stream');
  return { header: parsed.header || {}, events: parsed.events };
}

/** Rounds of a stream: `[{round, seq, index, endSeq}]` for a round selector. */
function roundsOf(stream) {
  const { events } = normalize(stream);
  const out = [];
  events.forEach((e, index) => {
    if (e.kf) out.push({ round: e.kf.round, seq: e.seq, index, reason: e.kf.reason, endSeq: null });
    if ((e.type === 'round_end' || e.type === 'match_end') && out.length) {
      out[out.length - 1].endSeq = e.seq;
    }
  });
  return out;
}

/** Index of the last event with seq <= at (at omitted: the last event). */
function indexAt(events, at) {
  if (at === undefined || at === null || at === '') return events.length - 1;
  const target = Number(at);
  if (!Number.isFinite(target)) return events.length - 1;
  let lo = 0;
  let hi = events.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].seq <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Raw reconstruction at `at` (a seq): zones + the running facts.
 * @param {object|string} stream
 * @param {number} [at]
 * @returns {{index:number, seq:number, event:object|null, keyframe:object|null,
 *   zones:Object, cards:Object, turn:number|null, round:number|null,
 *   scores:Object, roundScores:Object|null, phase:string, verified:boolean|null}}
 */
function reconstruct(stream, at) {
  const { events } = normalize(stream);
  const index = indexAt(events, at);
  if (index < 0) {
    return { index: -1, seq: 0, event: null, keyframe: null, zones: {}, cards: {}, turn: null,
      round: null, scores: {}, roundScores: null, phase: 'empty', verified: null };
  }

  let start = -1;
  for (let i = index; i >= 0; i -= 1) {
    if (events[i].kf) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return { index, seq: events[index].seq, event: events[index], keyframe: null, zones: {},
      cards: {}, turn: null, round: null, scores: {}, roundScores: null, phase: 'no_keyframe',
      verified: null };
  }

  const kf = events[start].kf;
  let zones = codec.cloneZones(kf.z);
  const cards = { ...kf.cards };
  let turn = kf.turn ?? null;
  let scores = { ...(kf.cum || {}) };
  let roundScores = null;
  let phase = 'playing';
  let verified = null;
  // Turn-phase facts for the plate ("drew, melded"), inferred from the events.
  let drawn = false;
  let melded = false;

  for (let i = start; i <= index; i += 1) {
    const e = events[i];
    if (i > start) {
      if (e.dict) Object.assign(cards, e.dict);
      if (e.z) zones = codec.applyZoneDiff(zones, e.z);
      if (e.tn !== undefined) {
        turn = e.tn;
        drawn = false;
        melded = false;
      }
    }
    if (e.type === 'draw' || e.type === 'take_pile') drawn = true;
    if (e.type === 'meld' || e.type === 'go_down' || e.type === 'add_to_meld') melded = true;
    if (e.type === 'round_end' || e.type === 'match_end') {
      // The recorder always stamps the running match score on a round end.
      if (e.cumulative) scores = { ...e.cumulative };
      roundScores = e.teamScores || null;
      phase = e.type === 'match_end' ? 'match_over' : 'round_over';
      if (e.check) verified = codec.tableChecksum(zones, scores) === e.check;
    } else if (TERMINAL.has(e.type)) {
      phase = e.type;
    }
  }

  return {
    index,
    seq: events[index].seq,
    event: events[index],
    keyframe: kf,
    keyframeSeq: events[start].seq,
    zones,
    cards,
    turn,
    round: kf.round ?? null,
    scores,
    roundScores,
    phase,
    verified,
    drawn,
    melded,
  };
}

/**
 * Verify every round end in the stream: replay to it and compare checksums.
 * @returns {{rounds: Array<{seq:number, round:number|null, ok:boolean}>, ok: boolean}}
 */
function verify(stream) {
  const norm = normalize(stream);
  const out = [];
  for (const e of norm.events) {
    if (!e.check) continue;
    const state = reconstruct(norm, e.seq);
    out.push({ seq: e.seq, round: state.round, ok: state.verified === true });
  }
  return { rounds: out, ok: out.every((r) => r.ok) };
}

function toCards(ids, dict) {
  return (ids || []).map((id) => codec.codeToCard(dict[id] ?? dict[String(id)], id));
}

/**
 * The reconstruction shaped like the dev console's live room detail
 * (SocketHandlers.getRoomDevDetail), so the console renders a replayed table
 * with the SAME code it renders a live one.
 * @param {object|string} stream
 * @param {number} [at] seq
 */
function tableAt(stream, at) {
  const norm = normalize(stream);
  const state = reconstruct(norm, at);
  const { header } = norm;
  const kf = state.keyframe || {};
  const ruleset = kf.ruleset || header.ruleset || 'classic';
  const seats = kf.seats || header.seats || [];
  const dict = state.cards;
  const zones = state.zones;

  const players = seats
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((s) => {
      const latches = zones[`g${s.seat}`] || {};
      const melds = (zones[`m${s.seat}`] || []).map((ids, idx) => {
        const cards = toCards(ids, dict);
        let grade = null;
        try {
          grade = GameValidator.meldGrade(cards, ruleset, latches[idx]);
        } catch {
          grade = null;
        }
        return {
          index: idx,
          cards,
          isBuraco: cards.length >= 7,
          clean: grade === 'clean',
          grade,
        };
      });
      return {
        playerId: s.id,
        playerName: s.name || String(s.id),
        playerIndex: s.seat,
        team: s.seat % 2 === 0 ? 'teamA' : 'teamB',
        isBot: s.bot === true,
        isConnected: true,
        isHost: false,
        hand: toCards(zones[`h${s.seat}`], dict),
        meldGroups: melds.length,
        melds,
        discardLock: null,
        score: null,
      };
    });

  const wellKeys = Object.keys(zones)
    .filter((k) => k[0] === 'w')
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const deadPiles = wellKeys.map((k) => toCards(zones[k], dict));
  const deck = toCards(zones.s, dict);
  const playing = state.phase === 'playing';

  return {
    success: true,
    replay: true,
    matchId: header.matchId || null,
    roomId: header.roomId || null,
    name: header.roomName || null,
    seq: state.seq,
    index: state.index,
    total: norm.events.length,
    lastSeq: norm.events.length ? norm.events[norm.events.length - 1].seq : 0,
    event: state.event,
    phase: state.phase,
    verified: state.verified,
    status: playing ? 'in_progress' : 'finished',
    maxPlayers: kf.maxPlayers || header.maxPlayers || players.length,
    ruleset,
    kanoon: kf.kanoon === true,
    wellMode: kf.wellMode || null,
    cardsDealt: state.keyframe != null,
    inProgress: playing,
    currentTurn: state.turn,
    turnTimeRemaining: null,
    turnTimeLimit: null,
    hasDrawnCard: state.drawn === true,
    meldedThisTurn: state.melded === true,
    mustMeldCard: null,
    drawnCardRestriction: [],
    roundNumber: state.round || 0,
    targetScore: kf.targetScore ?? header.targetScore ?? 0,
    awaitingNextRound: state.phase === 'round_over',
    lastRound: state.roundScores ? { teamScores: state.roundScores } : null,
    spectatorCount: 0,
    deckCount: deck.length,
    deck,
    deadPiles,
    deadPileCounts: deadPiles.map((p) => p.length),
    discardPile: toCards(zones.d, dict),
    players,
    playerScores: {},
    teamScores: state.scores,
    // The high-card ceremony, only on the deal event itself.
    firstTurn: state.event && state.event.kf ? state.event.kf.firstTurn || null : null,
  };
}

module.exports = {
  normalize,
  roundsOf,
  indexAt,
  reconstruct,
  verify,
  tableAt,
};
