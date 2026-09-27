/**
 * Replay codec — the PURE half of game recording (no I/O, no clock, no logger).
 *
 * Everything the recorder writes and the replay engine reads goes through
 * here, so the two can never disagree about a format:
 *
 *   - card references: `"QH#123"` (rank + suit letter + '#' + cardId), `"JK#7"`
 *     for a joker. Self-describing, so a single event is readable on its own.
 *   - table ZONES: the whole physical table as flat id lists, keyed
 *       h<seat>  hand            m<seat>  melds (array of id lists)
 *       g<seat>  meld grade latches ({meldIndex: 'semi'|'dirty'})
 *       s        stock, next draw FIRST
 *       d        discard pile, top LAST
 *       w<i>     well i (slot identity: a taken well is [] in place)
 *   - zone DIFFS between two captures, which is what makes every event
 *     replay-complete by construction: whatever a handler did to the table
 *     (the minimum-meld confiscation inside a discard, an auto-taken well, a
 *     stock promotion, dev hand surgery) shows up in the next event's diff
 *     without each call site having to describe it.
 *   - KEYFRAMES: a full capture plus the id -> card dictionary and the round's
 *     settings, recorded at every deal (and on a mid-round resume).
 *   - a CHECKSUM over the zones, recorded at every round end so a replay can
 *     prove it reconstructed the exact final table.
 *
 * The capture reads the room only through `getPlayers()` and the public maps
 * the handlers themselves use; nothing here mutates it.
 */

const SUIT_LETTER = { hearts: 'H', diamonds: 'D', clubs: 'C', spades: 'S' };
const LETTER_SUIT = { H: 'hearts', D: 'diamonds', C: 'clubs', S: 'spades' };

/** @param {object} card */
function cardIdOf(card) {
  if (!card) return null;
  const id = card.cardId ?? card.instanceId ?? card.id;
  return id === undefined ? null : id;
}

/** "QH", "10S", "JK" — the identity of a card without its instance id. */
function cardCode(card) {
  if (!card) return '??';
  if (card.isJoker === true || card.rank === 'joker') return 'JK';
  return `${card.rank}${SUIT_LETTER[card.suit] || '?'}`;
}

/** "QH#123" — a card reference for event payloads. */
function cardRef(card) {
  if (!card) return null;
  const id = cardIdOf(card);
  return id === null ? cardCode(card) : `${cardCode(card)}#${id}`;
}

function cardRefs(cards) {
  if (!Array.isArray(cards)) return [];
  const out = [];
  for (const card of cards) {
    const ref = cardRef(card);
    if (ref) out.push(ref);
  }
  return out;
}

/** A dictionary code ("QH") + id back into a plain card object. */
function codeToCard(code, id = null) {
  const text = String(code || '');
  if (text === 'JK') {
    return { cardId: id, suit: 'joker', rank: 'joker', isJoker: true };
  }
  const suit = LETTER_SUIT[text.slice(-1)] || 'unknown';
  return { cardId: id, suit, rank: text.slice(0, -1), isJoker: false };
}

/** "QH#123" -> { cardId: 123, suit: 'hearts', rank: 'Q', isJoker: false } */
function parseCardRef(ref) {
  if (ref && typeof ref === 'object') return ref;
  const text = String(ref || '');
  const hash = text.indexOf('#');
  const code = hash === -1 ? text : text.slice(0, hash);
  let id = null;
  if (hash !== -1) {
    const raw = text.slice(hash + 1);
    id = /^-?\d+$/.test(raw) ? Number(raw) : raw;
  }
  return codeToCard(code, id);
}

// -----------------------------------------------------------------------------
// Capture
// -----------------------------------------------------------------------------

function idsOf(cards, onCard) {
  if (!Array.isArray(cards)) return [];
  const out = new Array(cards.length);
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    const id = cardIdOf(card);
    out[i] = id;
    if (onCard && id !== null) onCard(id, card);
  }
  return out;
}

/** Map(idx -> grade) (or a legacy Set of dirty indices) -> {idx: grade}. */
function latchesOf(flags) {
  const out = {};
  if (!flags) return out;
  if (flags instanceof Map) {
    for (const [idx, grade] of flags) if (grade != null) out[idx] = grade;
  } else if (typeof flags.forEach === 'function') {
    flags.forEach((idx) => {
      out[idx] = 'dirty';
    });
  }
  return out;
}

/**
 * The whole physical table as zones of card ids.
 * @param {import('../models/GameRoom')} room
 * @param {(id: *, card: object) => void} [onCard] visited for every card (the
 *   recorder uses it to spot cards its dictionary has not seen yet)
 * @returns {Object<string, Array|Object>}
 */
function captureZones(room, onCard) {
  const zones = {};
  const players = typeof room.getPlayers === 'function' ? room.getPlayers() : [];
  for (const p of players) {
    const seat = p.playerIndex;
    zones[`h${seat}`] = idsOf(room.playerHands?.get(p.playerId), onCard);
    const melds = room.playerMelds?.get(p.playerId);
    zones[`m${seat}`] = Array.isArray(melds) ? melds.map((m) => idsOf(m, onCard)) : [];
    zones[`g${seat}`] = latchesOf(room.meldDirtyFlags?.get(p.playerId));
  }
  zones.s = idsOf(room.deck?.cards, onCard);
  zones.d = idsOf(room.discardPile, onCard);
  const wells = Array.isArray(room.deadPiles) ? room.deadPiles : [];
  for (let i = 0; i < wells.length; i += 1) zones[`w${i}`] = idsOf(wells[i], onCard);
  return zones;
}

function teamScoresOf(map) {
  const out = {};
  if (!map) return out;
  if (map instanceof Map) {
    for (const [team, total] of map) out[team] = total;
  } else if (typeof map === 'object') {
    Object.assign(out, map);
  }
  return out;
}

/**
 * Full keyframe: the table plus everything a replay needs to render and label
 * it from this point on without looking further back.
 * @param {import('../models/GameRoom')} room
 * @param {{reason?: string}} [opts]
 */
function buildKeyframe(room, opts = {}) {
  const cards = {};
  const z = captureZones(room, (id, card) => {
    cards[id] = cardCode(card);
  });
  const players = typeof room.getPlayers === 'function' ? room.getPlayers() : [];
  const draw = room.firstTurnDraw;
  return {
    reason: opts.reason || 'deal',
    round: room.roundNumber || 1,
    ruleset: room.ruleset || 'classic',
    wellMode: room.professionalWellMode || null,
    kanoon: typeof room.isKanoon === 'function' ? room.isKanoon() : room.kanoon === true,
    maxPlayers: room.maxPlayers,
    targetScore: Number(room.targetScore) || 0,
    turn: room.currentTurn ?? null,
    turnOrder: Array.isArray(room.turnOrder) ? room.turnOrder.slice() : null,
    seats: players.map((p) => ({
      seat: p.playerIndex,
      id: p.playerId,
      name: p.playerName ?? null,
      bot: p.isBot === true,
    })),
    // The high-card ceremony (round 1 / level scores): the cards each seat drew,
    // per tie-break round. They went back into the stock BEFORE this capture,
    // so they are presentation only — the stock order below already reflects it.
    firstTurn: draw
      ? {
        winner: draw.winnerIndex ?? null,
        rounds: (draw.rounds || []).map((round) =>
          (round || []).map((d) => [d.playerIndex, cardRef(d.card)])
        ),
      }
      : null,
    cum: teamScoresOf(room.cumulativeTeamScores),
    cards,
    z,
  };
}

// -----------------------------------------------------------------------------
// Diff / apply
// -----------------------------------------------------------------------------

function sameList(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Diff of one flat id list. Returns undefined (unchanged), the full new list
 * (a SET, when that is no bigger or the order changed), or `{r, a}`: remove
 * these ids (order of the rest kept), then append these. Every server move is
 * one of "take some out" / "put some at the end", so `{r, a}` is the norm.
 */
function listDiff(prev, next) {
  if (sameList(prev, next)) return undefined;
  if (!Array.isArray(prev) || !prev.length || !next.length) return next.slice();
  const inNext = new Set(next);
  const removed = [];
  let kept = 0;
  for (const id of prev) {
    if (!inNext.has(id)) {
      removed.push(id);
    } else {
      if (next[kept] !== id) return next.slice(); // reordered (a shuffle) — send it whole
      kept += 1;
    }
  }
  const added = next.slice(kept);
  if (removed.length + added.length >= next.length) return next.slice();
  const out = {};
  if (removed.length) out.r = removed;
  if (added.length) out.a = added;
  return out;
}

function applyListDiff(prev, diff) {
  if (Array.isArray(diff)) return diff.slice();
  const base = Array.isArray(prev) ? prev : [];
  let out = base;
  if (diff && Array.isArray(diff.r) && diff.r.length) {
    const gone = new Set(diff.r);
    out = base.filter((id) => !gone.has(id));
  } else {
    out = base.slice();
  }
  if (diff && Array.isArray(diff.a)) out.push(...diff.a);
  return out;
}

/** Melds of one seat: `{n: count, c: {index: [ids]}}` with only the changed melds. */
function meldsDiff(prev, next) {
  const before = Array.isArray(prev) ? prev : [];
  const changed = {};
  let any = before.length !== next.length;
  for (let i = 0; i < next.length; i += 1) {
    if (!sameList(before[i], next[i])) {
      changed[i] = next[i].slice();
      any = true;
    }
  }
  if (!any) return undefined;
  return { n: next.length, c: changed };
}

function applyMeldsDiff(prev, diff) {
  if (Array.isArray(diff)) return diff.map((m) => m.slice());
  const out = (Array.isArray(prev) ? prev : []).slice(0, diff.n).map((m) => m.slice());
  for (const [idx, ids] of Object.entries(diff.c || {})) out[Number(idx)] = ids.slice();
  return out;
}

function objKey(obj) {
  const keys = Object.keys(obj || {}).sort();
  let out = '';
  for (const k of keys) out += `${k}=${obj[k]};`;
  return out;
}

/**
 * Zone-by-zone diff of two captures. A zone that disappeared maps to null.
 * @returns {Object|undefined} undefined when nothing moved
 */
function diffZones(prev, next) {
  const out = {};
  let any = false;
  const before = prev || {};
  for (const key of Object.keys(next)) {
    const kind = key[0];
    let d;
    if (kind === 'm') d = meldsDiff(before[key], next[key]);
    else if (kind === 'g') d = objKey(before[key]) === objKey(next[key]) ? undefined : { ...next[key] };
    else d = listDiff(before[key], next[key]);
    if (d !== undefined) {
      out[key] = d;
      any = true;
    }
  }
  for (const key of Object.keys(before)) {
    if (!(key in next)) {
      out[key] = null;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** Apply a diffZones() result to a zones object. Returns a NEW zones object. */
function applyZoneDiff(zones, diff) {
  const out = { ...zones };
  for (const [key, d] of Object.entries(diff || {})) {
    if (d === null) {
      delete out[key];
      continue;
    }
    const kind = key[0];
    if (kind === 'm') out[key] = applyMeldsDiff(out[key], d);
    else if (kind === 'g') out[key] = { ...d };
    else out[key] = applyListDiff(out[key], d);
  }
  return out;
}

function cloneZones(zones) {
  const out = {};
  for (const [key, value] of Object.entries(zones || {})) {
    if (key[0] === 'm') out[key] = value.map((m) => m.slice());
    else if (key[0] === 'g') out[key] = { ...value };
    else out[key] = value.slice();
  }
  return out;
}

// -----------------------------------------------------------------------------
// Checksum
// -----------------------------------------------------------------------------

/** 32-bit FNV-1a, hex. Not cryptographic — it catches replay drift. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Checksum of a table: every zone in key order plus the cumulative scores.
 * @param {Object} zones
 * @param {Object} [scores] team -> cumulative total
 */
function tableChecksum(zones, scores = {}) {
  let text = '';
  for (const key of Object.keys(zones || {}).sort()) {
    const value = zones[key];
    text += `${key}:${key[0] === 'g' ? objKey(value) : JSON.stringify(value)}|`;
  }
  text += `S:${objKey(scores)}`;
  return fnv1a(text);
}

module.exports = {
  SUIT_LETTER,
  LETTER_SUIT,
  cardIdOf,
  cardCode,
  cardRef,
  cardRefs,
  codeToCard,
  parseCardRef,
  captureZones,
  buildKeyframe,
  teamScoresOf,
  listDiff,
  applyListDiff,
  meldsDiff,
  applyMeldsDiff,
  diffZones,
  applyZoneDiff,
  cloneZones,
  tableChecksum,
  fnv1a,
};
