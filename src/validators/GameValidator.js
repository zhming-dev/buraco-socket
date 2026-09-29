/**
 * GameValidator
 * Server-side validation for all game actions
 */

// Hard upper bound on cards in a single meld payload. A hand never exceeds
// ~22 cards (deal + pozzetto + draw), so anything beyond this is malformed or
// malicious — reject it before doing per-card work.
const MAX_MELD_CARDS = 30;

// QANOON rule 1: a meld of this length is a buraco (brazilia), the key that
// unlocks SETS for its side. Same bar as ActionHandlers._teamHasAnyBrazilia.
const BURACO_SIZE = 7;
const QANOON_SET_LOCKED_ERROR =
  'Qanoon: sets of the same rank are locked until your side has a buraco (a 7-card set is allowed)';

class GameValidator {
  /**
   * Validate that it's the player's turn
   * @param {GameRoom} room
   * @param {string} playerId
   * @returns {Object}
   */
  static validateTurn(room, playerId) {
    if (!room.isInProgress()) {
      return { isValid: false, error: 'Game is not in progress' };
    }

    const player = room.getPlayer(playerId);
    if (!player) {
      return { isValid: false, error: 'Player not found in room' };
    }

    if (!room.isPlayerTurn(playerId)) {
      return { isValid: false, error: 'Not your turn' };
    }

    return { isValid: true };
  }

  /**
   * Validate drawing a card
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {boolean} fromDeck
   * @returns {Object}
   */
  static validateDrawCard(room, playerId, fromDeck) {
    const turnCheck = this.validateTurn(room, playerId);
    if (!turnCheck.isValid) return turnCheck;

    // Prevent multiple draws per turn
    if (room.hasDrawnCard) {
      return { isValid: false, error: 'You have already drawn this turn' };
    }

    if (fromDeck) {
      if (!room.deck || room.deck.count <= 0) {
        return { isValid: false, error: 'Deck is empty' };
      }
    } else {
      if (!room.discardPile || room.discardPile.length === 0) {
        return { isValid: false, error: 'Discard pile is empty' };
      }
    }

    return { isValid: true };
  }

  /**
   * Validate playing a meld
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Array} cards
   * @returns {Object}
   */
  static validateMeld(room, playerId, cards) {
    const turnCheck = this.validateTurn(room, playerId);
    if (!turnCheck.isValid) return turnCheck;

    if (!room.hasDrawnCard) {
      return { isValid: false, error: 'You must draw or pick up before melding' };
    }

    if (!Array.isArray(cards) || cards.length < 3) {
      return { isValid: false, error: 'Meld must have at least 3 cards' };
    }

    // Upper bound (DoS guard): a single meld comes from the hand, which never
    // exceeds ~22 cards (deal + pozzetto + draw). Reject absurd arrays before
    // doing any per-card work. Ownership (_playerHasCards) would reject them
    // anyway, but only after building a Set over the whole payload.
    if (cards.length > MAX_MELD_CARDS) {
      return { isValid: false, error: 'Meld has too many cards' };
    }

    const uniqueKey = (c) => this._identityKey(c);
    const uniqueCount = new Set(cards.map(uniqueKey)).size;
    if (uniqueCount !== cards.length) {
      return { isValid: false, error: 'Duplicate cards in meld' };
    }

    // Ensure all cards are in the player's hand
    if (!this._playerHasCards(room, playerId, cards)) {
      return { isValid: false, error: 'One or more cards are not in your hand' };
    }

    const ruleset = room.ruleset || 'classic';
    // The player's OWN cards, never the client's description of them.
    const resolved = this._resolveFromHand(room, playerId, cards);
    if (!resolved) {
      return { isValid: false, error: 'One or more cards are not in your hand' };
    }
    if (!this.meldTwoCountLegal(resolved)) {
      return { isValid: false, error: 'A meld cannot hold two 2s' };
    }
    if (!this._isValidSequence(resolved, ruleset) && !this._isValidSet(resolved, ruleset)) {
      return { isValid: false, error: 'Invalid meld: not a valid sequence or set' };
    }
    // A set that is itself a buraco (7+ cards) unlocks itself.
    if (this._isSetOnly(resolved, ruleset) && this._qanoonSetLocked(room, playerId, [resolved])) {
      return { isValid: false, error: QANOON_SET_LOCKED_ERROR, reason: 'qanoonSetLocked' };
    }

    return { isValid: true };
  }

  /**
   * QANOON rule 1 — a SET (same-rank meld, the 2-2-2 set included) may not be
   * laid while the actor's side owns no buraco. `alsoLaying` are the other
   * melds going down in the SAME action: a going-down that lays a 7-card run
   * next to a set is one legal move, the run unlocks the set it travels with,
   * and a set that is ITSELF a buraco (7+ cards, clean or dirty) unlocks itself.
   * Only NEW melds are gated. Extending an existing set needs no check: none can
   * exist on a locked side.
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Array<Array>} [alsoLaying]
   * @returns {boolean}
   */
  static _qanoonSetLocked(room, playerId, alsoLaying = []) {
    if (!room || typeof room.isQanoon !== 'function' || !room.isQanoon()) return false;
    const owned = this._teamMelds(room, playerId).some(
      (m) => Array.isArray(m) && m.length >= BURACO_SIZE
    );
    if (owned) return false;
    return !alsoLaying.some((m) => Array.isArray(m) && m.length >= BURACO_SIZE);
  }

  /**
   * A meld that is legal ONLY as a set. A 3-card group can read both ways (e.g.
   * two naturals of one suit around a wild); when it is also a valid run it is
   * a run, and Qanoon lets it through.
   */
  static _isSetOnly(cards, ruleset = 'classic') {
    return !this._isValidSequence(cards, ruleset) && this._isValidSet(cards, ruleset);
  }

  /**
   * Validate adding a card to an existing meld
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Object} card
   * @param {number} targetPlayerIndex
   * @param {number} targetMeldIndex
   * @returns {Object}
   */
  static validateAddToMeld(room, playerId, card, targetPlayerIndex, targetMeldIndex) {
    return this.validateAddCardsToMeld(room, playerId, [card], targetPlayerIndex, targetMeldIndex);
  }

  /**
   * Validate adding one or more cards to an existing meld atomically.
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Object[]} cards
   * @param {number} targetPlayerIndex
   * @param {number} targetMeldIndex
   * @returns {Object}
   */
  static validateAddCardsToMeld(room, playerId, cards, targetPlayerIndex, targetMeldIndex) {
    const turnCheck = this.validateTurn(room, playerId);
    if (!turnCheck.isValid) return turnCheck;

    if (!room.hasDrawnCard) {
      return { isValid: false, error: 'You must draw or pick up before adding to melds' };
    }

    if (!Array.isArray(cards) || cards.length === 0) {
      return { isValid: false, error: 'No cards provided' };
    }

    const uniqueCount = new Set(cards.map((card) => this._identityKey(card))).size;
    if (uniqueCount !== cards.length) {
      return { isValid: false, error: 'Duplicate cards in add-to-meld request' };
    }

    if (!this._playerHasCards(room, playerId, cards)) {
      return { isValid: false, error: 'One or more cards were not found in hand' };
    }

    const targetPlayer = room.getPlayerByIndex(targetPlayerIndex);
    if (!targetPlayer) {
      return { isValid: false, error: 'Target player not found' };
    }

    // Ownership: a player may only extend their own team's melds.
    // Teams are partner-paired by index parity (0&2 vs 1&3), matching ActionHandlers._getTeam.
    const actor = room.getPlayer(playerId);
    if (!actor) {
      return { isValid: false, error: 'Player not found in room' };
    }
    if ((actor.playerIndex % 2) !== (targetPlayer.playerIndex % 2)) {
      return { isValid: false, error: 'You can only add cards to your own team\'s melds' };
    }

    const melds = room.playerMelds.get(targetPlayer.playerId) || [];
    const targetMeld = melds[targetMeldIndex];
    if (!Array.isArray(targetMeld)) {
      return { isValid: false, error: 'Target meld not found' };
    }

    const ruleset = room.ruleset || 'classic';
    // Resolved, for the same reason as validateMeld: the appended cards decide
    // whether the GROWN meld is legal, so they have to be the real ones.
    const incoming = this._resolveFromHand(room, playerId, cards);
    if (!incoming) {
      return { isValid: false, error: 'One or more cards were not found in hand' };
    }
    const candidate = [...targetMeld, ...incoming];
    // Stated explicitly here because this is the path the report named: does the
    // TARGET meld already hold a 2? Then another 2 cannot join it.
    if (!this.meldTwoCountLegal(candidate)) {
      return { isValid: false, error: 'That meld already has a 2' };
    }
    if (!this._isValidSequence(candidate, ruleset) && !this._isValidSet(candidate, ruleset)) {
      return { isValid: false, error: 'Invalid meld after adding card' };
    }

    return { isValid: true };
  }

  /**
   * Validate discarding a card
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Object} card
   * @returns {{ isValid: boolean, error?: string, reason?: string }}
   */
  static validateDiscard(room, playerId, card) {
    const turnCheck = this.validateTurn(room, playerId);
    if (!turnCheck.isValid) return turnCheck;

    // Must have drawn/taken this turn
    if (!room.hasDrawnCard) {
      return { isValid: false, error: 'You must draw or pick up before discarding', reason: 'mustDrawFirst' };
    }

    // Card must be in hand
    const playerHand = room.playerHands.get(playerId) || [];
    const inHand = playerHand.some((c) => this._sameCard(c, card));
    if (!inHand) {
      return { isValid: false, error: 'Card not found in hand', reason: 'cardNotInHand' };
    }

    const handSize = playerHand.length;

    // House rule (matches the client GameController.canDiscardReason): the card
    // the player took the pile FOR cannot be thrown straight back this turn —
    // discard a DIFFERENT card. RULE CHANGE (2026-09-21, owner): a meld does
    // NOT lift this any more (`&& !room.meldedThisTurn` used to sit here); only
    // nextTurn() does. RULE A (2026-09-02): this fires on a take of EXACTLY ONE
    // card only. A take of two or more restricts nothing (RULE B) and a deck
    // draw restricts nothing (RULE C). The classic "meld the taken card first"
    // (mustMeldCard) block stays REMOVED.
    if (this._restrictionMatches(room.drawnCardThisTurnRestriction, card)) {
      if (handSize === 1) {
        // Only card — no legal meld possible; lift restriction to avoid stuck state.
        return { isValid: true };
      }
      return { isValid: false, error: 'You cannot immediately discard a card you just drew', reason: 'drawnCardRestriction' };
    }

    // ANTI PING-PONG: you may not throw back the card you took the pile for.
    // Sits AFTER the drawn-card block so a single-card take still reports the
    // more specific "just drew" reason, and BEFORE the close branch because the
    // escape hatch is already open at hand size 1 (see _pingPongBlocks).
    if (this._pingPongBlocks(room, playerId, card, playerHand)) {
      return {
        isValid: false,
        error: 'You took the pile for that card — it cannot go back on the pile yet',
        reason: 'pingPongLocked',
      };
    }

    const ruleset = room.ruleset || 'classic';

    // If this discard would empty the hand, ensure closing requirements are met
    const willBeEmpty = handSize === 1;
    if (willBeEmpty) {
      const tookWell = this._teamHasTakenPozzetto(room, playerId);
      // The discard may take a well where the rules allow an INDIRECT
      // acquisition — the mode (direct never), the first-well-only-by-discard
      // rule, and the 2-per-team cap all live in _canTakeWellAfterEmptyHand.
      if (this._pozzettoAvailable(room) && this._canTakeWellAfterEmptyHand(room, playerId, true)) {
        return { isValid: true, willTakePozzetto: true };
      }

      if ((ruleset === 'classic' || ruleset === 'classicWithNoJoker') && (card.rank === 'joker' || card.rank === '2')) {
        return { isValid: false, error: 'Cannot discard a joker or 2 when closing', reason: 'invalidClose' };
      }

      // DIRECT well mode governs EVERY ruleset now (it defaults to 'indirect', so
      // a classic room is unaffected unless it opts in): a player may never
      // discard a last card to go out or to reach the well — every card has to be
      // melded onto the table. Closing happens on the meld-out instead, which
      // ActionHandlers._checkInstantEnd detects.
      if (room.professionalWellMode === 'direct') {
        return { isValid: false, error: 'Direct mode closes only on the fly', reason: 'invalidClose' };
      }

      if (this._pozzettoAvailable(room) && !tookWell) {
        return { isValid: false, error: 'You must take the well before going out', reason: 'mustTakeWell' };
      }

      const melds = this._teamMelds(room, playerId);
      const hasBrazilia = melds.some((m) => Array.isArray(m) && m.length >= 7);
      if (!hasBrazilia) {
        return { isValid: false, error: 'You must have a Brazilia to go out', reason: 'noBrazilia' };
      }
    }

    return { isValid: true };
  }

  /**
   * Validate taking the pozzetto (dead pile)
   * @param {GameRoom} room
   * @param {string} playerId
   * @returns {Object}
   */
  static validateTakePozzetto(room, playerId) {
    const turnCheck = this.validateTurn(room, playerId);
    if (!turnCheck.isValid) return turnCheck;

    // House rule: BOTH rulesets allow a team to take up to TWO pozzetti.
    const maxWells = 2;
    if (this._teamDeadPileCount(room, playerId) >= maxWells) {
      return { isValid: false, error: 'All wells already taken' };
    }

    if (!this._pozzettoAvailable(room)) {
      return { isValid: false, error: 'Pozzetto not available' };
    }

    const playerHand = room.playerHands.get(playerId) || [];
    if (playerHand.length > 0) {
      return { isValid: false, error: 'Hand must be empty to take the well' };
    }

    if (room.ruleset === 'professional') {
      const melds = this._teamMelds(room, playerId);
      const hasBrazilia = melds.some((m) => Array.isArray(m) && m.length >= 7);
      if (!hasBrazilia) {
        return { isValid: false, error: 'Need a Brazilia before taking the well' };
      }
    }

    return { isValid: true };
  }

  // --- Helpers ---
  static _pozzettoAvailable(room) {
    const hasDeadPiles = Object.prototype.hasOwnProperty.call(room, 'deadPiles');
    const dead = Array.isArray(room.deadPiles) && room.deadPiles.some((p) => Array.isArray(p) && p.length > 0);
    const legacy = !hasDeadPiles && Array.isArray(room.pozzetto) && room.pozzetto.length > 0;
    return legacy || dead;
  }

  static _canTakeWellAfterEmptyHand(room, playerId, emptiedByDiscard) {
    if (!this._pozzettoAvailable(room)) return false;
    const ruleset = room.ruleset || 'classic';
    // House rule (both rulesets): a team may take up to TWO pozzetti, grabbing the
    // 2nd whenever the hand clears again — by meld OR discard. Only two pozzetti
    // exist, so a fast team takes BOTH and the other side gets none.
    if (this._teamDeadPileCount(room, playerId) >= 2) return false;

    // Well-mode rules govern EVERY ruleset, not just professional (the mode
    // still defaults to 'indirect', so a classic room keeps its old behaviour).
    // Mirrors ActionHandlers._canTakeWellAfterEmptyHand.
    //
    // DIRECT: the well is only ever taken on a meld-out.
    if (room.professionalWellMode === 'direct' && emptiedByDiscard) return false;

    // House rule: BOTH wells may be reached by a discard. No "first well only"
    // gate here — the 2-per-team cap above is the sole limit. Any gate added
    // here must also be added to ActionHandlers._canTakeWellAfterEmptyHand,
    // BotStrategy._wellTakeableOnEmpty and the client, or a turn hangs on the
    // half that still forbids the move.

    // PROFESSIONAL only: a completed brazilia (clean OR dirty) is required before
    // a side may take a well. Classic keeps its free first-empty take (out of
    // scope until the classic rules pass).
    if (ruleset !== 'professional') return true;
    const melds = this._teamMelds(room, playerId);
    return melds.some((m) => Array.isArray(m) && m.length >= 7);
  }

  static _teamId(playerIndex) {
    return playerIndex % 2 === 0 ? 'teamA' : 'teamB';
  }

  static _teamKeyForPlayer(room, playerId) {
    const player = room.getPlayer(playerId);
    return player ? this._teamId(player.playerIndex) : playerId;
  }

  static _teamPlayers(room, playerId) {
    const player = room.getPlayer(playerId);
    if (!player) return [];
    const teamId = this._teamId(player.playerIndex);
    return room.getPlayers().filter((p) => this._teamId(p.playerIndex) === teamId);
  }

  static _teamHasTakenPozzetto(room, playerId) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    if (room.playerHasTakenPozzetto.get(teamKey)) return true;
    return this._teamPlayers(room, playerId).some((p) => room.playerHasTakenPozzetto.get(p.playerId));
  }

  static _teamDeadPileCount(room, playerId) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    const teamCount = room.playerDeadPileCount.get(teamKey);
    if (teamCount != null) return teamCount;
    return this._teamPlayers(room, playerId).reduce(
      (max, p) => Math.max(max, room.playerDeadPileCount.get(p.playerId) || 0),
      0
    );
  }

  static _teamMelds(room, playerId) {
    return this._teamPlayers(room, playerId).flatMap((p) => room.playerMelds.get(p.playerId) || []);
  }

  static _playerHasCards(room, playerId, cards) {
    return this._handContainsAll(room, playerId, cards);
  }

  /**
   * Validate going down (first meld)
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Array} melds
   * @returns {Object}
   */
  static validateGoingDown(room, playerId, melds) {
    const turnCheck = this.validateTurn(room, playerId);
    if (!turnCheck.isValid) return turnCheck;

    if (!room.hasDrawnCard) {
      return { isValid: false, error: 'You must draw or pick up before going down' };
    }

    if (!Array.isArray(melds) || melds.length === 0) {
      return { isValid: false, error: 'No melds provided' };
    }

    const ruleset = room.ruleset || 'classic';

    // OWNERSHIP FIRST, then judge the RESOLVED cards. This used to run the other
    // way round — structure was checked against the client's claimed ranks and
    // ownership only afterwards, by id — so a forged rank passed the shape check
    // AND was scored by _calculateMeldPoints below, carrying the
    // minPointsToGoDown gate with it. See _resolveFromHand.
    //
    // Resolved against ONE running copy of the hand across every meld, so the
    // same physical card cannot be spent in two of them.
    const hand = [...(room.playerHands.get(playerId) || [])];
    const resolvedMelds = [];
    for (const meld of melds) {
      if (!Array.isArray(meld) || meld.length < 3) {
        return { isValid: false, error: 'Each meld must have at least 3 cards' };
      }
      const resolved = [];
      for (const wanted of meld) {
        const i = hand.findIndex((held) => this._sameCard(held, wanted));
        if (i === -1) {
          return { isValid: false, error: 'One or more cards are not in your hand' };
        }
        resolved.push(hand[i]);
        hand.splice(i, 1);
      }
      if (!this.meldTwoCountLegal(resolved)) {
        return { isValid: false, error: 'A meld cannot hold two 2s' };
      }
      if (!this._isValidSequence(resolved, ruleset) && !this._isValidSet(resolved, ruleset)) {
        return { isValid: false, error: 'Invalid meld: not a valid sequence or set' };
      }
      resolvedMelds.push(resolved);
    }

    if (
      resolvedMelds.some((m) => this._isSetOnly(m, ruleset)) &&
      this._qanoonSetLocked(room, playerId, resolvedMelds)
    ) {
      return { isValid: false, error: QANOON_SET_LOCKED_ERROR, reason: 'qanoonSetLocked' };
    }

    // Minimum points requirement for the opening meld — scored on what will
    // actually be laid, not on what was claimed.
    let totalPoints = 0;
    for (const meld of resolvedMelds) {
      totalPoints += this._calculateMeldPoints(meld, ruleset);
    }
    const minPoints = require('../config').game.minPointsToGoDown;
    if (totalPoints < minPoints) {
      return {
        isValid: false,
        error: `Need at least ${minPoints} points to go down (you have ${totalPoints})`,
      };
    }

    return { isValid: true };
  }

  /**
   * Multiset check: every card (counting duplicates) is present in the player's hand.
   * Unlike _playerHasCards, this correctly rejects melding two copies of a card the
   * player only holds once.
   * @private
   */
  static _handContainsAll(room, playerId, cards) {
    const hand = room.playerHands.get(playerId) || [];
    const used = new Set();
    for (const card of cards) {
      const idx = hand.findIndex((candidate, index) => !used.has(index) && this._sameCard(candidate, card));
      if (idx < 0) return false;
      used.add(idx);
    }
    return true;
  }

  static _cardId(card) {
    if (!card) return null;
    return card.cardId ?? card.instanceId ?? card.id ?? null;
  }

  static _legacyKey(card) {
    return `${card?.suit}-${card?.rank}`;
  }

  static _identityKey(card) {
    const id = this._cardId(card);
    return id !== null && id !== undefined ? `id:${id}` : `sr:${this._legacyKey(card)}`;
  }

  /**
   * The player's OWN copy of each requested card, in the requested order.
   *
   * THE HOLE THIS CLOSES: every rule below judges rank and suit, and until now
   * it judged the ones the CLIENT sent. Ownership is matched by cardId alone
   * (`_sameCard` returns `String(aId) === String(bId)` whenever both sides carry
   * an id), so a payload could name a card it really owns and simply lie about
   * what that card IS. The meld was checked against the lie and the truth was
   * put on the table:
   *
   *     hand 2♦ 3♦ 4♦ 2♠   send [2♦, 3♦, 4♦, {id of 2♠, rank:'5', suit:'♦'}]
   *     -> validates as 2-3-4-5 of diamonds, lands as 2♦ 3♦ 4♦ 2♠
   *
   * That defeats EVERY meld rule at once, not just one 2 per run, and
   * _calculateMeldPoints scored the lie too, so minPointsToGoDown went with it.
   *
   * Returns null when any requested card is not in the hand — the caller then
   * reports the ordinary ownership error.
   *
   * @returns {Array|null}
   */
  static _resolveFromHand(room, playerId, cards) {
    const hand = [...(room.playerHands.get(playerId) || [])];
    const resolved = [];
    for (const wanted of cards) {
      const i = hand.findIndex((held) => this._sameCard(held, wanted));
      if (i === -1) return null;
      resolved.push(hand[i]);
      hand.splice(i, 1); // a duplicate request must match two DIFFERENT cards
    }
    return resolved;
  }

  /**
   * THE TWO-COUNT INVARIANT — "angka 2 ga boleh dalam 1 meld", stated
   * repeatedly and finally as an instruction to check it on the ADD path:
   * "apakah add to meld ada angka 2 dikartu yang ada di meld, kalo ada dibuat
   * gaboleh".
   *
   * A meld may hold two or more 2s ONLY when the meld IS twos — `2,2,2` is
   * explicitly allowed, and a joker may stand in inside one. Everything else
   * caps at a single 2, natural or wild.
   *
   * Kept OUT of _isValidSequence so it cannot be reached down one path and
   * missed down another: every accept below is gated on it directly.
   */
  static meldTwoCountLegal(cards) {
    if (!Array.isArray(cards)) return false;
    const twos = cards.filter((c) => c && String(c.rank) === '2').length;
    if (twos < 2) return true;
    return cards.every((c) => c && (String(c.rank) === '2' || String(c.rank) === 'joker'));
  }

  static _sameCard(a, b) {
    const aId = this._cardId(a);
    const bId = this._cardId(b);
    if (aId !== null && aId !== undefined && bId !== null && bId !== undefined) {
      return String(aId) === String(bId);
    }
    return a?.suit === b?.suit && a?.rank === b?.rank;
  }

  static _restrictionMatches(restrictions, card) {
    if (!restrictions || !card) return false;
    const id = this._cardId(card);
    if (id !== null && id !== undefined && restrictions.has(String(id))) return true;
    if (id !== null && id !== undefined && restrictions.has(`id:${id}`)) return true;
    return restrictions.has(this._legacyKey(card)) || restrictions.has(this._identityKey(card));
  }

  /**
   * ANTI PING-PONG. Whether `card` is held by the lock this player earned when
   * they took the pile. Mirrors the Flutter GameController._pingPongBlocks
   * clause for clause — if the two ever disagree the turn hangs (client offers
   * a discard the server rejects, or vice versa).
   *
   * Matches on the CARD ID — the card actually taken, not its rank+suit. The
   * shoe is two decks, so a rank+suit test also froze the twin, including one
   * drawn from the stock long after the take: the reported "one card type is
   * stuck forever". A lock with no usable id binds nothing rather than falling
   * back to rank+suit, and one whose turnsLeft has run out is already dead.
   *
   * RULE A (2026-09-02) does put a twin under the lock, but as an ID added at
   * ARM time by SocketHandlers.handlePickUpPile — only the copies that were
   * already in hand when a LONE card was taken, and only until the next deck
   * draw or multi-card take releases the lock (a MELD does not, since
   * 2026-09-21). That is deliberately narrower
   * than the old rank+suit key, which froze the family on every take, forever,
   * including copies that arrived from the stock afterwards.
   *
   * The last clause is the ESCAPE HATCH and it is load-bearing: the lock yields
   * as soon as no OTHER card in hand is discardable, so it can never wedge a
   * turn. It needs no recursion and never consults the close rules, because a
   * lock can only bind while the hand holds two or more cards — with a single
   * card left, that card IS the locked one, the `some` is false and the hatch is
   * already open. And a hand of two or more can never be making a closing
   * discard (the willBeEmpty branch is gated on handSize === 1), so the close
   * rules cannot make the hatch disagree across the two repos.
   *
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {{suit:string,rank:string}} card
   * @param {Array} hand
   * @returns {boolean}
   */
  static _pingPongBlocks(room, playerId, card, hand) {
    const lock = room.discardLocks && room.discardLocks.get(playerId);
    if (!lock || !card) return false;
    if (Number.isFinite(lock.turnsLeft) && lock.turnsLeft <= 0) return false;
    // EVERY id the lock holds — a two-deck shoe means the same card can be taken
    // twice, and both copies stay held. `cardIds` is the set; `cardId` is the
    // most recent one, kept for older payloads.
    const lockedIds = (lock.cardIds && lock.cardIds.length ? lock.cardIds : [lock.cardId])
      .filter((id) => id !== null && id !== undefined)
      .map(String);
    if (!lockedIds.length) return false;
    const held = (c) => lockedIds.includes(String(this._cardId(c)));
    if (!held(card)) return false;
    // ESCAPE HATCH — skips EVERY held instance, not just this one. With two
    // copies locked, testing only `c !== card` lets each point at the other as
    // "a card I could throw instead", and a hand of nothing but the two would
    // refuse both discards: a wedged turn.
    return (hand || []).some(
      (c) => !held(c) && !this._restrictionMatches(room.drawnCardThisTurnRestriction, c)
    );
  }

  /**
   * Check if cards form a valid sequence (same suit, consecutive ranks)
   * @private
   * @param {Array} cards
   * @returns {boolean}
   */
  static _isValidSequence(cards, ruleset = 'classic') {
    if (cards.length < 3) return false;

    if ((ruleset === 'professional' || ruleset === 'classicWithNoJoker') && cards.some((c) => c.rank === 'joker')) return false;

    const suit = this._getNonWildSuit(cards);
    if (!suit) return false;

    // All must have same suit or be wild
    for (const c of cards) {
      if (!this._isWild(c) && c.suit !== suit && c.suit !== 'joker') return false;
    }

    // ONE 2 PER RUN (product decision 2026-08-28). A sequence may hold at most a
    // single card of rank 2 — the natural two sitting in its own slot, OR a 2
    // acting as the run's single wild, but never both and never two of either.
    //
    // The wildCount check below does NOT catch this: a natural two is not a
    // wild, so A♣-2♣-[2♥ as 3]-4♣ counted exactly ONE wild and passed. That is
    // the shape this rule bans. Same for the shoe's second copy of a 2, and for
    // 2-3-4-5-6-7-[2♦ as 8]-9, which the gaps-vs-fillers reading of
    // _isNaturalTwo would otherwise accept.
    //
    // SETS ARE UNAFFECTED — this guard lives in the sequence validator only, so
    // the canastra de dois (a set of 7+ twos, flat 2000) still stands.
    if (cards.filter((c) => c && c.rank === '2').length > 1) return false;

    const wildCount = cards.filter((c) => this._isWild(c) && !this._isNaturalTwo(c, cards)).length;
    if (wildCount > 1) return false;

    const toVals = (aceHigh) => cards
      .filter((c) => !(this._isWild(c) && !this._isNaturalTwo(c, cards)))
      .map((c) => this._rankValue(c.rank, aceHigh))
      .sort((a, b) => a - b);

    // Returns the number of interior gaps (single missing rank, diff === 2) when
    // the naturals form a consecutive run, or null when the run is invalid
    // (duplicate rank, or a gap wider than a single missing card / more gaps than
    // available wilds).
    const gapCount = (vals) => {
      if (vals.length === 0) return null;
      let gaps = 0;
      for (let i = 1; i < vals.length; i++) {
        const diff = vals[i] - vals[i - 1];
        if (diff === 1) continue;
        if (diff === 2) {
          gaps++;
          continue;
        }
        return null;
      }
      return gaps > wildCount ? null : gaps;
    };

    // A wild is valid whether it plugs an interior gap OR extends a complete run
    // at an end — in BOTH classic and professional. `gapCount` already rejects
    // layouts with more gaps than wilds (and any gap wider than one card), so a
    // non-null gap count means the single wild has a functional position (a gap
    // to plug, or an end to extend when gaps === 0). orderMeldCards places it.
    // (A natural two, e.g. A-2-3, is not wild and does not count toward
    // wildCount, so consecutive-2 sequences are unaffected.)
    const acceptable = (gaps) => gaps != null;

    return acceptable(gapCount(toVals(false))) || acceptable(gapCount(toVals(true)));
  }

  /**
   * Canonical ordering for a meld about to be stored/broadcast. Sequences are
   * returned ordered by rank with the single wild-2/joker inserted at the
   * interior gap it represents (e.g. [8, 10, 2] -> [8, 2(=9), 10]); the wild
   * card carries a `representedRank` field for the client to render the gap
   * value. Sets (same-rank melds) and anything that is not a valid sequence are
   * returned untouched (order is irrelevant for sets). Mutates card objects in
   * place to (re)assign/clear `representedRank` and returns the reordered array.
   * @param {Array} cards
   * @param {string} ruleset
   * @returns {Array}
   */
  static orderMeldCards(cards, ruleset = 'classic') {
    if (!Array.isArray(cards) || cards.length < 3) return cards;

    const isWildNon = (c) => this._isWild(c) && !this._isNaturalTwo(c, cards);
    const wilds = cards.filter(isWildNon);

    // Only sequences are reordered. A meld with >1 wild, or that is not a valid
    // sequence (e.g. a set, or a sequence that is actually invalid), is left as
    // is. Clear any stale represented-rank so a set never shows a gap label.
    if (wilds.length > 1 || !this._isValidSequence(cards, ruleset)) {
      cards.forEach((c) => { if (c && c.representedRank != null) delete c.representedRank; });
      return cards;
    }

    const naturals = cards.filter((c) => !isWildNon(c));

    // Build the consecutive layout for a given ace orientation; returns the
    // sorted naturals plus where (if anywhere) the single interior gap sits.
    const build = (aceHigh) => {
      const sorted = [...naturals].sort(
        (a, b) => this._rankValue(a.rank, aceHigh) - this._rankValue(b.rank, aceHigh)
      );
      const vals = sorted.map((c) => this._rankValue(c.rank, aceHigh));
      for (let i = 1; i < vals.length; i++) {
        const diff = vals[i] - vals[i - 1];
        if (diff !== 1 && diff !== 2) return null;
      }
      let gapPos = -1;
      let gapVal = -1;
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] - vals[i - 1] === 2) {
          gapPos = i;
          gapVal = vals[i - 1] + 1;
          break;
        }
      }
      return { sorted, vals, gapPos, gapVal };
    };

    const low = build(false);
    const high = build(true);
    // Prefer the orientation that exposes an interior gap so the wild plugs it.
    let layout = null;
    if (wilds.length === 1) {
      if (low && low.gapPos >= 0) layout = low;
      else if (high && high.gapPos >= 0) layout = high;
      else layout = low || high;
    } else {
      layout = low || high;
    }
    if (!layout) {
      cards.forEach((c) => { if (c && c.representedRank != null) delete c.representedRank; });
      return cards;
    }

    cards.forEach((c) => { if (c && c.representedRank != null) delete c.representedRank; });

    const ordered = [...layout.sorted];
    if (wilds.length === 1) {
      const wild = wilds[0];
      if (layout.gapPos >= 0) {
        ordered.splice(layout.gapPos, 0, wild);
        wild.representedRank = this._rankLabel(layout.gapVal);
      } else {
        // Pure-extend (no interior gap, valid in BOTH classic and professional):
        // the wild extends at a canonical END so the run stays valid/extensible.
        // Canonical end = the HIGH end (topNatural + 1), UNLESS the top natural
        // is an Ace (nothing sits above an ace-high run) in which case the wild
        // extends at the LOW end (bottomNatural - 1). The wild card carries
        // representedRank for the client to render the inferred value.
        const topVal = layout.vals.length ? layout.vals[layout.vals.length - 1] : 0;
        const bottomVal = layout.vals.length ? layout.vals[0] : 0;
        const topIsAce = layout.sorted.length
          ? layout.sorted[layout.sorted.length - 1].rank === 'A'
          : false;
        if (topIsAce) {
          ordered.unshift(wild);
          wild.representedRank = this._rankLabel(bottomVal - 1);
        } else {
          ordered.push(wild);
          wild.representedRank = this._rankLabel(topVal + 1);
        }
      }
    }
    return ordered;
  }

  /**
   * Map a numeric rank value back to its rank label for `representedRank`.
   * @private
   */
  static _rankLabel(value) {
    if (value === 14 || value === 1) return 'A';
    if (value === 13) return 'K';
    if (value === 12) return 'Q';
    if (value === 11) return 'J';
    if (value >= 2 && value <= 10) return String(value);
    return null;
  }

  /**
   * Check if cards form a valid set (same rank, different suits)
   * @private
   * @param {Array} cards
   * @returns {boolean}
   */
  static _isValidSet(cards, ruleset = 'classic') {
    if (cards.length < 3) return false;

    if ((ruleset === 'professional' || ruleset === 'classicWithNoJoker') && cards.some((c) => c.rank === 'joker')) return false;

    let rank = this._getNonWildRank(cards);
    // House rule: a SET OF ALL 2s is legal — treat 2 as its natural rank
    // (2♠ 2♥ 2♦). A joker may still fill in as the single wild, but a joker-only
    // group is NOT a meld (rank stays null → rejected below).
    if (!rank && cards.some((c) => c.rank === '2')) {
      rank = '2';
    }
    if (!rank) return false;

    for (const c of cards) {
      // In a 2s-set the 2s are the NATURALS; only a joker acts as the wild there.
      const isWildHere = rank === '2' ? c.rank === 'joker' : this._isWild(c);
      if (isWildHere) continue;
      if (c.rank !== rank) return false;
    }

    // At most one wildcard (2 or joker; for a 2s-set only a joker counts as wild).
    const wildCount = rank === '2'
      ? cards.filter((c) => c.rank === 'joker').length
      : cards.filter((c) => this._isWild(c)).length;
    if (wildCount > 1) return false;

    // NOTE: duplicate suits are ALLOWED in a set. Brazilia is played with two decks,
    // so e.g. A♥ A♥ A♦ is a legal set of three Aces. (Previously the server
    // wrongly rejected duplicate suits, while the client allowed them — #7.)

    return true;
  }

  /**
   * Calculate total points in a meld
   * @private
   * @param {Array} meld
   * @returns {number}
   */
  static _calculateMeldPoints(meld, ruleset = 'classic') {
    const value = (card) => {
      if (ruleset === 'professional') {
        if (card.rank === 'A') return 15;
        if (['K', 'Q', 'J', '10', '9', '8', '2'].includes(card.rank)) return 10;
        if (['7', '6', '5', '4', '3'].includes(card.rank)) return 5;
        return 0;
      }

      if (card.rank === 'joker') return 30;
      if (card.rank === '2') return 20;
      if (card.rank === 'A') return 15;
      if (['K', 'Q', 'J', '10', '9', '8'].includes(card.rank)) return 10;
      if (['7', '6', '5', '4', '3'].includes(card.rank)) return 5;
      return 0;
    };
    return meld.reduce((sum, card) => sum + value(card), 0);
  }

  // Helpers
  static _isWild(card) {
    return card.rank === 'joker' || card.rank === '2';
  }

  /**
   * Whether `card` is a NATURAL two in `cards` — a 2 occupying rank two itself
   * rather than standing in for a missing card. A natural two keeps the meld
   * CLEAN and carries no `representedRank` label.
   *
   * The test is whether the run still lays out consecutively when the 2 is read
   * AS A TWO, allowing as many single-card gaps as there are OTHER wilds around
   * to plug them.
   *
   * THE BUG THIS FIXES: this used to demand the whole run be GAPLESS (it dropped
   * jokers from the layout and then rejected any gap at all). So a 2♣ sitting in
   * its own slot in 2-3-4-5-6-7-[joker as 8]-9 was declared a WILD purely because
   * of a gap somewhere else that the joker already filled. Two things went wrong
   * from that one answer: the canasta was scored DIRTY, and orderMeldCards then
   * stamped the 2♣ with `representedRank: '2'` — the client rendered a "stands in
   * for a 2" chip on a card that is a two. Reported live.
   *
   * @param {{rank:string,suit:string}} card
   * @param {Array} cards
   * @returns {boolean}
   */
  static _isNaturalTwo(card, cards) {
    if (!card || card.rank !== '2') return false;
    const suit = this._getNonWildSuit(cards);
    if (!suit) return false;
    // A 2 is natural ONLY if its suit matches the run's (single non-wild) suit.
    // A 2 of a DIFFERENT suit can only act as a WILD (it makes the meld dirty).
    if (card.suit !== suit) return false;

    const others = cards.filter((c) => c !== card);
    // Every other wild — a joker, an off-suit 2, or the shoe's SECOND copy of
    // this very 2 — can only ever be a filler, so it is available to plug a gap
    // instead of being read at a rank of its own.
    const fillers = others.filter((c) => this._isWild(c)).length;
    // Rank two only exists with the ace LOW, so that is the orientation to read.
    const vals = others
      .filter((c) => !this._isWild(c))
      .map((c) => this._rankValue(c.rank, false))
      .concat([this._rankValue('2', false)])
      .sort((a, b) => a - b);

    let gaps = 0;
    for (let i = 1; i < vals.length; i += 1) {
      const diff = vals[i] - vals[i - 1];
      if (diff <= 0) return false; // a repeated rank is not a layout at all
      gaps += diff - 1;
    }
    return gaps <= fillers;
  }

  static _isCleanMeld(meld) {
    return !meld.some((c) => this._isWild(c) && !this._isNaturalTwo(c, meld));
  }

  /**
   * Whether a brazilia/meld counts as CLEAN for badge display, per ruleset.
   * Professional: dirty when a non-natural 2 is present (or it was ever stamped
   * dirty, e.g. a wild later covered by a natural). Classic: clean when it holds
   * no non-natural wild (2 or joker). Shared by ActionHandlers (broadcast flags)
   * and GameRoom.toJSON (reconnect melds) so the flag is computed one way.
   * @param {Array} meld
   * @param {string} ruleset
   * @param {boolean} wasDirty Sticky dirty flag (room.meldDirtyFlags).
   * @returns {boolean}
   */
  /**
   * Severity order of the three grades a buraco can hold. Higher = worse.
   * 'clean' pays 200, 'semi' and 'dirty' pay 100 — the PRICE ratchet is
   * "ever below clean, never 200 again", but the LABEL still distinguishes a
   * single end-wild (semi) from a plugged hole (dirty).
   */
  static _gradeSeverity(grade) {
    if (grade === 'dirty') return 2;
    if (grade === 'semi') return 1;
    return 0;
  }

  /** The worse of two grades (either may be undefined = clean-so-far). */
  static worstGrade(a, b) {
    return this._gradeSeverity(a) >= this._gradeSeverity(b) ? (a || 'clean') : (b || 'clean');
  }

  /**
   * Grade of a meld from its CARDS ALONE: 'clean' | 'semi' | 'dirty'.
   *
   * clean — no wild standing in for another rank (a natural 2 is not a wild);
   * semi  — classic sequences only: exactly ONE substitute wild, with the
   *         naturals strictly consecutive in either ace orientation, i.e. the
   *         wild extends an END rather than plugging a hole;
   * dirty — any other substitute layout. Professional has no semi grade and no
   *         joker-dirt: only a non-natural 2 dirties it.
   *
   * This is the single authority — ActionHandlers' scoring, the per-meld wire
   * flags and GameRoom's reconnect frames all resolve through it, so a badge
   * can never disagree with the figure that was banked.
   */
  static meldCardGrade(meld, ruleset = 'classic') {
    if (!Array.isArray(meld)) return 'dirty';
    if (ruleset === 'professional') {
      return meld.some((c) => c.rank === '2' && !this._isNaturalTwo(c, meld))
        ? 'dirty'
        : 'clean';
    }
    const substitutes = meld.filter((c) => this._isWild(c) && !this._isNaturalTwo(c, meld));
    if (substitutes.length === 0) return 'clean';
    if (substitutes.length > 1) return 'dirty';

    // SEMI: the naturals must be strictly consecutive so the one wild sits at
    // an end. Checked in BOTH ace orientations — Q-K-A plus a wild is exactly
    // as semi as 2-3-4 plus one, and a single low-only read refused the high
    // end of the ladder.
    const naturals = meld.filter((c) => !(this._isWild(c) && !this._isNaturalTwo(c, meld)));
    if (naturals.length === 0) return 'dirty';
    const consecutive = (aceHigh) => {
      const vals = naturals.map((c) => this._rankValue(c.rank, aceHigh)).sort((a, b) => a - b);
      for (let i = 1; i < vals.length; i += 1) {
        if (vals[i] - vals[i - 1] !== 1) return false;
      }
      return true;
    };
    return consecutive(false) || consecutive(true) ? 'semi' : 'dirty';
  }

  /**
   * The DISPLAYED/BANKED grade: the card grade capped by the latched worst
   * grade this meld has ever held ([latched] comes from room.meldDirtyFlags).
   * A grade may fall over a meld's life; it may never climb back.
   */
  static meldGrade(meld, ruleset = 'classic', latched = undefined) {
    return this.worstGrade(this.meldCardGrade(meld, ruleset), latched);
  }

  static meldClean(meld, ruleset = 'classic', wasDirty = false) {
    if (!Array.isArray(meld)) return false;
    // ONCE DIRTY, ALWAYS DIRTY — in EVERY ruleset (2026-08-28). "200 bisa jadi
    // 100, tapi 100 gabisa jadi 200". The classic branch used to end in
    // `this._isCleanMeld(meld, ruleset, false)`, which threw the sticky flag
    // away (and passed two arguments to a one-argument function, so the intent
    // was never even wired). A classic buraco was therefore re-graded from its
    // cards alone: lay 4-5-6-7-8-[2 as 9], add the 3, and the reorder slides the
    // 2 back onto rank two and the meld reads CLEAN. The grade is a fact about
    // how the buraco was BUILT, and later cards cannot rebuild it.
    if (wasDirty) return false;
    if (ruleset === 'professional') {
      return !meld.some((c) => c.rank === '2' && !this._isNaturalTwo(c, meld));
    }
    return this._isCleanMeld(meld);
  }

  static _rankValue(rank, aceHigh) {
    if (rank === 'A') return aceHigh ? 14 : 1;
    if (rank === 'K') return 13;
    if (rank === 'Q') return 12;
    if (rank === 'J') return 11;
    if (rank === '10') return 10;
    if (rank === '9') return 9;
    if (rank === '8') return 8;
    if (rank === '7') return 7;
    if (rank === '6') return 6;
    if (rank === '5') return 5;
    if (rank === '4') return 4;
    if (rank === '3') return 3;
    if (rank === '2') return 2;
    if (rank === 'joker') return 0;
    return 0;
  }

  static _getNonWildSuit(cards) {
    for (const c of cards) {
      if (!this._isWild(c)) return c.suit;
    }
    return null;
  }

  static _getNonWildRank(cards) {
    for (const c of cards) {
      if (!this._isWild(c)) return c.rank;
    }
    return null;
  }
}

module.exports = GameValidator;
module.exports.BURACO_SIZE = BURACO_SIZE;
module.exports.QANOON_SET_LOCKED_ERROR = QANOON_SET_LOCKED_ERROR;
