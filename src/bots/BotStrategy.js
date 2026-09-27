const DEFAULT_MAX_MELD_ACTIONS = 1;

/** A brazilia/canastra is 7+ cards. */
const BRAZILIA_SIZE = 7;

/** House rule: a team may take up to TWO wells (GameValidator.validateTakePozzetto). */
const MAX_WELLS_PER_TEAM = 2;

/** Two decks: 8 natural copies of every rank, 4 jokers. */
const COPIES_PER_RANK = 8;
const COPIES_OF_JOKER = 4;

const FACE_RANKS = ['K', 'Q', 'J', '10', '9', '8'];
const LOW_RANKS = ['7', '6', '5', '4', '3'];

/**
 * Heuristic decision brain for server-side bots. Stateless: every call gets a
 * redacted snapshot built by BotCoordinator._buildBotState and returns one
 * intent for SocketHandlers.executeBotIntent.
 *
 * The server validates every intent again (GameValidator + the ActionHandlers
 * close guards), and every rejected intent costs a full retry round-trip — the
 * single biggest source of visible bot lag. So the legality helpers below are
 * deliberate MIRRORS of the server, not approximations:
 *
 *   • meld shape        — GameValidator._isValidSet / _isValidSequence, including
 *                         the set-of-all-2s house rule, a same-suit 2 acting as a
 *                         natural ONLY in a gapless run, ace-low and ace-high
 *                         sequences, duplicate suits in sets (two decks), and at
 *                         most one true wild per meld;
 *   • going out         — GameValidator.validateDiscard's willBeEmpty branch AND
 *                         ActionHandlers._rejectIllegalMeldOut: a meld may NOT
 *                         empty the hand unless the well auto-refills it or the
 *                         ruleset grants an instant end (pro-direct / brazilia of
 *                         2s). Everything else must keep a discardable card;
 *   • the well          — GameValidator._canTakeWellAfterEmptyHand, including the
 *                         TWO-wells-per-team cap and the pro brazilia gate;
 *                         close inside the squeeze.
 *
 * On top of the legality floor it plays a real game: Brazilia card values (not raw
 * rank), opponent threat from public hand counts, clean-canastra preference,
 * the professional per-turn points requirement, and (at the `hard` level) card
 * counting off the discard history so it stops holding provably dead material.
 */
class BotStrategy {
  decide(state = {}) {
    if (!state.cardsDealt || state.currentPlayerIndex !== state.playerIndex) {
      return { type: 'wait' };
    }

    const ctx = this._context(state);

    if (!state.hasDrawnCard) {
      return this._chooseDrawAction(state, ctx);
    }

    const hand = this._cloneCards(state.yourHand || []);
    if (hand.length === 0) {
      // An empty hand can only continue by taking a well. Gate on the SAME
      // conditions GameValidator.validateTakePozzetto enforces so the bot never
      // burns a turn on a rejected take. If it cannot legally take, there is
      // nothing else to do and the coordinator resolves the turn.
      if (this._canTakePozzetto(state, ctx)) return { type: 'take_pozzetto' };
      return { type: 'wait' };
    }

    if (ctx.kanoonPendingIds.length) {
      const owed = this._kanoonMeldPending(state, ctx, hand);
      if (owed) return owed;
    }

    const addAction = this._findAddToMeldAction(state, ctx, hand);
    if (addAction) return addAction;

    const newMeld = this._findBestNewMeld(state, ctx, hand);
    if (newMeld) {
      const remaining = this._handWithout(hand, newMeld.cards);
      const makesBrazilia = newMeld.cards.length >= BRAZILIA_SIZE;
      if (
        this._safeToShed(state, ctx, remaining, {
          actionMakesBrazilia: makesBrazilia,
          resultingMeld: newMeld.cards,
          meldOwnedBySelf: true,
        }) &&
        !this._shouldHoldMeld(state, ctx, newMeld, hand)
      ) {
        return { type: 'play_meld', cards: newMeld.cards };
      }
    }

    const discard = this._pickDiscard(state, ctx, hand);
    if (discard) {
      return { type: 'discard_card', card: discard };
    }

    // NOTHING ELSE ENDS THIS TURN — see _findWildAddToMeld. `wait` here is
    // answered by BotCoordinator._forceTurnProgress -> _forceAdvanceTurn, i.e. a
    // VISIBLE SKIPPED TURN, and an offline sweep over the twin planner (504
    // rounds / 87,348 bot turns) found a legal move waiting in 600 of 603 such
    // skips (99.5%) — in every case the same one: a single WILD onto a team meld.
    // The add is only reached here because _findAddToMeldAction's own last-resort
    // branch is gated on the turn having no other ender, and that gate can be
    // satisfied by a new meld that the shed/hold checks above then decline.
    const wildAdd = this._findWildAddToMeld(state, ctx, hand);
    if (wildAdd) return wildAdd;

    // Genuinely nothing legal (lone un-closeable card). Reporting `wait` lets
    // BotCoordinator._forceTurnProgress resolve the turn in ONE step instead of
    // eating a guaranteed rejection first.
    return { type: 'wait' };
  }

  // ---------------------------------------------------------------------------
  // Derived per-decision context
  // ---------------------------------------------------------------------------

  /**
   * One normalized view of the snapshot. Everything downstream reads this so a
   * rule is expressed exactly once and ruleset casing is normalized in a single
   * place (BotCoordinator forwards `room.ruleset` verbatim).
   */
  _context(state) {
    const rawRuleset = String(state.ruleset || 'classic');
    const lowered = rawRuleset.toLowerCase();
    const isPro = lowered === 'professional';
    const noJoker = isPro || lowered === 'classicwithnojoker';

    const ownMelds = this._teamMelds(state, true);
    const opponentMelds = this._teamMelds(state, false);

    const teamWellsTaken = this._wellsTaken(state.teamWellsTaken, state.teamHasTakenPozzetto);
    const opponentWellsTaken = this._wellsTaken(
      state.opponentWellsTaken,
      state.opponentTeamHasTakenPozzetto
    );

    const level = this._level(state.botLevel);
    const handCounts = state.handCounts && typeof state.handCounts === 'object' ? state.handCounts : null;

    const ctx = {
      ruleset: rawRuleset,
      isPro,
      noJoker,
      level,
      professionalWellMode: state.professionalWellMode || 'indirect',
      pozzettosAvailable: state.pozzettosAvailable === true,
      teamWellsTaken,
      opponentWellsTaken,
      // Informational only — no strategy gate reads it since both wells became
      // reachable by discard. Falls back to the two sides' own counts when the
      // host did not send the across-the-table figure (older BotCoordinator
      // payloads / direct tests).
      wellsTakenThisRound: Number.isFinite(state.wellsTakenThisRound)
        ? state.wellsTakenThisRound
        : teamWellsTaken + opponentWellsTaken,
      teamHasTakenPozzetto: state.teamHasTakenPozzetto === true || teamWellsTaken > 0,
      ownMelds,
      opponentMelds,
      hasBrazilia: ownMelds.some((entry) => entry.cards.length >= BRAZILIA_SIZE),
      // ActionHandlers._checkInstantEnd reads the ACTOR'S OWN melds, not the
      // team's — a partner's brazilia does NOT unlock a pro-direct meld-out.
      // Verified against the live handler; keep these two facts separate.
      selfBrazilia: ownMelds.some(
        (entry) => entry.isOwn && entry.cards.length >= BRAZILIA_SIZE
      ),
      opponentHasBrazilia: opponentMelds.some((entry) => entry.cards.length >= BRAZILIA_SIZE),
      discardPile: Array.isArray(state.discardPile) ? state.discardPile : [],
      handCounts,
      // ANTI PING-PONG lock on this bot, {suit, rank} or null. Read only by
      // _pickDiscard; every other planner branch is indifferent to it.
      discardLock: state.discardLock || null,
    };

    // KANOON (1v1 variant on top of pro-direct). Two extra gates:
    //   kanoonSetsLocked  — no NEW set until our side owns a buraco;
    //   kanoonPendingIds  — cards this bot took off the pile this turn; while
    //                       none of them is in a meld, the discard costs 100.
    ctx.kanoon = state.kanoon === true;
    ctx.kanoonSetsLocked = ctx.kanoon && !ctx.hasBrazilia;
    ctx.kanoonPendingIds = [];
    if (ctx.kanoon && Array.isArray(state.kanoonPileCardIds) && state.kanoonPileCardIds.length) {
      const handIds = new Set((state.yourHand || []).map((c) => String(this._cardIdOf(c))));
      const ids = state.kanoonPileCardIds.map(String);
      // Satisfied the moment one taken card has left the hand (into a meld).
      if (ids.every((id) => handIds.has(id))) ctx.kanoonPendingIds = ids;
    }

    // Public information parity: hand COUNTS are already broadcast to every
    // human client (otherPlayersHandCounts), so using them is not cheating.
    ctx.partnerHandCount = null;
    ctx.opponentMinHand = null;
    if (handCounts) {
      let partner = null;
      let minOpponent = null;
      Object.entries(handCounts).forEach(([rawIndex, count]) => {
        const idx = Number(rawIndex);
        const size = Number(count);
        if (!Number.isInteger(idx) || !Number.isFinite(size)) return;
        if (idx === state.playerIndex) return;
        if (idx % 2 === state.playerIndex % 2) {
          partner = partner == null ? size : Math.min(partner, size);
        } else {
          minOpponent = minOpponent == null ? size : Math.min(minOpponent, size);
        }
      });
      ctx.partnerHandCount = partner;
      ctx.opponentMinHand = minOpponent;
    }

    // An opponent is only a real closing threat once their side can legally go
    // out: a brazilia, and (professional) a well already banked.
    ctx.opponentCanClose =
      ctx.opponentHasBrazilia && (!isPro || ctx.opponentWellsTaken > 0);
    ctx.opponentThreat =
      ctx.opponentMinHand != null && ctx.opponentCanClose && ctx.opponentMinHand <= 3;

    // Professional per-turn meld requirement (ActionHandlers._applyProfessional75PointRule).
    const required = Number(state.requiredMeldPoints);
    const melded = Number(state.meldPointsThisTurn);
    ctx.requiredMeldPoints = Number.isFinite(required) && required > 0 ? required : 0;
    ctx.meldPointsThisTurn = Number.isFinite(melded) && melded > 0 ? melded : 0;
    ctx.requiredShortfall = Math.max(0, ctx.requiredMeldPoints - ctx.meldPointsThisTurn);

    // Match state — lets the endgame stop gambling once the round already wins.
    ctx.targetScore = Number(state.targetScore) || 0;
    ctx.teamScore = Number(state.teamScore) || 0;
    ctx.opponentScore = Number(state.opponentScore) || 0;

    ctx.counting = level === 'hard';
    ctx.seen = ctx.counting ? this._buildSeenCounts(state, ctx) : null;

    return ctx;
  }

  _level(botLevel) {
    const value = String(botLevel || 'normal').toLowerCase();
    if (value === 'easy' || value === 'beginner' || value === 'low') return 'easy';
    if (value === 'hard' || value === 'expert' || value === 'pro' || value === 'high') return 'hard';
    return 'normal';
  }

  _wellsTaken(explicitCount, legacyBoolean) {
    const count = Number(explicitCount);
    if (Number.isFinite(count) && count >= 0) return Math.min(MAX_WELLS_PER_TEAM, count);
    return legacyBoolean === true ? 1 : 0;
  }

  /**
   * Rank -> how many copies are still UNSEEN, from everything public: our hand,
   * every meld on the table, the live discard pile and (when the coordinator
   * supplies it) the full discard history. Used only at the `hard` level, to
   * stop the bot hoarding material that can no longer be completed.
   */
  _buildSeenCounts(state, ctx) {
    const seen = new Map();
    const bump = (card) => {
      if (!card) return;
      const rank = String(card.rank);
      seen.set(rank, (seen.get(rank) || 0) + 1);
    };
    (state.yourHand || []).forEach(bump);
    ctx.ownMelds.forEach((entry) => entry.cards.forEach(bump));
    ctx.opponentMelds.forEach((entry) => entry.cards.forEach(bump));
    ctx.discardPile.forEach(bump);
    if (Array.isArray(state.discardHistory)) state.discardHistory.forEach(bump);
    return seen;
  }

  /** Copies of `rank` that could still be drawn/taken (never negative). */
  _liveCopies(ctx, rank) {
    if (!ctx.seen) return COPIES_PER_RANK;
    const key = String(rank);
    const total = key === 'joker' ? COPIES_OF_JOKER : COPIES_PER_RANK;
    return Math.max(0, total - (ctx.seen.get(key) || 0));
  }

  // ---------------------------------------------------------------------------
  // Draw phase
  // ---------------------------------------------------------------------------

  _chooseDrawAction(state, ctx) {
    const discardPile = ctx.discardPile;
    const topCard = discardPile[discardPile.length - 1];

    // SQUEEZE guard (PRO base rule): when down to a single card AND the discard
    // pile holds exactly one card, taking the pile is rejected by the server —
    // force a deck draw. Mirrors ActionHandlers._pileTakeBlockedBySqueeze so the
    // bot never burns a turn on a guaranteed-rejected pile take. Like the server
    // guard, it is SUSPENDED once no deck draw is possible (dead stock, no
    // promotable pozzetto) — the pile take is then the bot's only legal move
    // (§3.3/§3.13).
    const deckDrawableForSqueeze =
      Number(state.deckCount || 0) > 0 ||
      ctx.pozzettosAvailable ||
      (Array.isArray(state.deadPileCounts) &&
        state.deadPileCounts.some((count) => Number(count) > 0));
    // Always on in PROFESSIONAL: a 1-card hand may not take a 1-card discard pile.
    const squeezeBlocked =
      ctx.isPro &&
      deckDrawableForSqueeze &&
      (state.yourHand || []).length === 1 &&
      discardPile.length === 1;

    if (!squeezeBlocked && topCard && this._shouldTakeDiscardPile(state, ctx, topCard)) {
      return { type: 'pick_up_pile' };
    }

    if (Number(state.deckCount || 0) > 0) {
      return { type: 'draw_card', fromDeck: true };
    }

    // Stock exhausted. Drawing PROMOTES an untaken pozzetto into the deck, which
    // permanently destroys it as a well (nobody is credited, and the -100
    // no-well penalty becomes unavoidable). So if our side still needs a well,
    // prefer taking the pile — it keeps the pozzetto on the table.
    const pozzettoAvailable =
      ctx.pozzettosAvailable ||
      (Array.isArray(state.deadPileCounts) &&
        state.deadPileCounts.some((count) => Number(count) > 0));
    // A BOT MUST NEVER CHOOSE AN ACTION THE ENGINE WILL REFUSE.
    //
    // With a well still on the table the server DEFERS the promotion rather than
    // spending the well as a stock refill (ActionHandlers._deckOutTerminal,
    // product decision 2026-08-27): `wellOnTable && pileIsAContinuation` returns
    // null, and GameValidator.validateDrawCard then rejects the draw with "Deck
    // is empty". So a `draw_card` here is a move the server throws away. It only
    // ever survived because BotCoordinator answers the rejection with
    // endRoundOnDeckOut, whose _refillStockOrEndRound promotes the well anyway —
    // which quietly undoes the 2026-08-27 rule for bot seats, and is the exact
    // shape that DEADLOCKED the offline client, where no such breaker existed
    // (user report 2026-09-01: "bot mau ambil dari deck pile, padahal ada
    // pozetto ... game stuck gabisa diapa apain"). The offline AI now takes the
    // pile in this position; this keeps online playing the same game 1:1.
    //
    // So: take the pile when it is a REAL continuation — 2+ cards, the same bar
    // used below once no well is left. A LONE card is not one: take one, discard
    // one, nothing changes, and every seat recycling it is the round that never
    // ends (~5% of simulated rounds deadlocked exactly there). Keep declining
    // that, and let the endRoundOnDeckOut breaker promote the well as before —
    // it stays the last-resort net, it is simply no longer the ordinary path.
    // KANOON: a pile none of whose cards can reach a meld is a certain
    // 100-point charge. On a dead stock it is still not the only move — the
    // decline (draw -> well promotion, or the deck-out end below) is the same
    // exit this branch already uses for a lone card — so it is never worth it.
    const kanoonTakeOk =
      !ctx.kanoon || this._kanoonPileMeldable(state, ctx, discardPile, state.yourHand || []);

    if (pozzettoAvailable) {
      if (!squeezeBlocked && discardPile.length >= 2 && kanoonTakeOk) {
        return { type: 'pick_up_pile' };
      }
      return { type: 'draw_card', fromDeck: true };
    }

    // Dead stock and no untaken pozzetto: taking the discard pile is the only
    // way to continue at all (see the deck-exhaustion rule), so take a pile with
    // real material in it even when the valuation above was lukewarm.
    if (!squeezeBlocked && discardPile.length >= 2 && kanoonTakeOk) {
      return { type: 'pick_up_pile' };
    }

    // ...but a SINGLE card that _shouldTakeDiscardPile already judged useless is
    // a pure recycle: take one, discard one, nothing changes, and every seat
    // hands the same card on forever. This is the deck-out — report it, and the
    // coordinator turns a pre-draw `wait` on a dead stock into
    // endRoundOnDeckOut ("the pile was declined") for a no-batida finish.
    return { type: 'wait' };
  }

  /**
   * Picking up the pile takes EVERY card in it, so the gate is "does enough of
   * this pile help us", not "is the top card pretty". A junk grab bloats the
   * hand and slows the whole team down.
   */
  _shouldTakeDiscardPile(state, ctx, topCard) {
    const hand = state.yourHand || [];
    const pile = ctx.discardPile;
    const ownMelds = ctx.ownMelds;

    // KANOON: a take whose cards cannot reach a meld THIS turn is a certain
    // 100-point charge, so it is never worth it, however rich the pile.
    if (ctx.kanoon && !this._kanoonPileMeldable(state, ctx, pile, hand)) return false;

    // Top card extends one of our melds — always worth it, with ONE exception.
    for (const entry of ownMelds) {
      if (!this._canAddCardsToMeld(entry.cards, [topCard], ctx)) continue;
      // LEGAL IS NOT THE SAME AS INTENDED, and on a LONE-CARD pile the gap is a
      // round that never ends. A wild legally extends almost any meld, but the
      // planner only ever spends one on a meld it COMPLETES (6 -> 7) — see
      // _findAddToMeldAction, whose last-resort branch stays gated precisely so
      // the wild supply is not burned. So on a one-card pile "it extends one of
      // our melds" is a promise the bot will not keep: it takes the wild, holds
      // it, throws its other card back, and the next seat does the same with the
      // card it just received. Nothing enters the game and the stock never
      // drains. Traced on the offline twin for 1200 straight turns with 29 cards
      // still in the stock and both hands down to one card; without this guard
      // 5 of 504 simulated rounds never ended, with it, none did.
      //
      // A DEEPER pile is unaffected: taking 2+ cards is real material whatever
      // the top card is, and that is the case this short-circuit exists for.
      if (
        pile.length === 1 &&
        this._isWild(topCard) &&
        entry.cards.length !== BRAZILIA_SIZE - 1
      ) {
        continue;
      }
      return true;
    }

    // Top card completes a brand-new meld with cards we hold.
    const combinedMeld = this._findBestNewMeld(state, ctx, [topCard, ...hand], { ignoreHold: true });
    if (combinedMeld && combinedMeld.cards.some((card) => this._sameCard(card, topCard))) {
      return true;
    }

    // A ONE-card pile is a NET-ZERO trade: take one card, discard one card, hand
    // size unchanged and no new card enters the game. So it is only ever worth
    // doing when that exact card is IMMEDIATELY useful — which the two
    // short-circuits above already cover. "It pairs a rank I hold" is far too
    // weak a reason, and it is actively harmful:
    //   • while the stock is alive, taking it instead of drawing means the deck
    //     never drains, so the round cannot progress toward its natural end;
    //   • once the stock is dead, it is a pure recycle — the same card circles
    //     the table forever.
    // Both deadlocked whole rounds in simulation (~5% of games). Declining is
    // the engine-sanctioned exit: SocketHandlers.endRoundOnDeckOut ends a round
    // no-batida precisely when the stock is dead "and the pile was declined".
    // Deeper piles keep their normal valuation below — a rich pile is real
    // material and still worth taking.
    if (pile.length === 1) return false;

    // Whole-pile value. Controlling the discard pile is the heart of Brazilia, and
    // since the "meld the taken card first" rule is gone the top card no longer
    // needs to be immediately usable — a single-card take just means we discard a
    // DIFFERENT card next, a 2+ take leaves everything discardable. So grab the
    // pile whenever enough of ITS cards (not just the top) help us: count the
    // usable cards across the whole pile and require more value the deeper it is,
    // so the bot snaps up rich piles without bloating its hand on junk.
    const usable = pile.filter((card) => this._pileCardUsable(card, hand, ownMelds, ctx)).length;
    const pileSize = pile.length;

    // Threat adjustment: when an opponent can close within a turn or two, a big
    // hand is a liability (every unmelded card scores AGAINST us), so demand more
    // from a deep pile. Easy bots never reason about the deep pile at all.
    let required;
    if (pileSize <= 1) required = 1; // single-card take: any pairing is fine
    else if (pileSize <= 3) required = 1;
    else if (pileSize <= 6) required = 2;
    else required = 3; // deep pile: needs real value to justify the hand it adds

    // With an opponent able to close at any moment, every card that lands in the
    // hand and stays there scores AGAINST us. A deep pile is then only worth
    // taking if it is almost entirely usable — the two short-circuits above
    // (top card extends an own meld / completes a new one) remain the escape.
    // Stock exhausted but a pozzetto remains: drawing PROMOTES that pozzetto
    // into the deck and permanently destroys it as a well — nobody is credited
    // and the -100 no-well penalty becomes unavoidable. While our side still
    // owes itself a well, take the pile on thinner value instead.
    if (
      Number(state.deckCount || 0) === 0 &&
      ctx.pozzettosAvailable &&
      ctx.teamWellsTaken < MAX_WELLS_PER_TEAM
    ) {
      required = Math.max(1, required - 1);
    }

    if (ctx.opponentThreat && pileSize > 3) required = Math.max(required + 2, pileSize);
    if (ctx.level === 'easy' && pileSize > 6) required += 2;

    return usable >= required;
  }

  /** A pile card is "usable" if it advances our hand: a wild, a card that extends
   *  an own meld, pairs a rank we hold, or is near-suit sequence material. */
  _pileCardUsable(card, hand, ownMelds, ctx) {
    if (this._isWild(card)) return true;
    if (ownMelds.some((entry) => this._canAddCardsToMeld(entry.cards, [card], ctx))) {
      return true;
    }
    if (hand.some((c) => !this._isWild(c) && c.rank === card.rank)) return true;
    return hand.some((c) => {
      if (this._isWild(c) || c.suit !== card.suit) return false;
      const distance = Math.abs(this._rankValue(c.rank, true) - this._rankValue(card.rank, true));
      if (distance === 0 || distance > 2) return false;
      if (distance === 1) return true;
      // A one-rank gap is only useful if the filler is still obtainable.
      if (!ctx.counting) return true;
      const gapValue = Math.min(
        this._rankValue(c.rank, true),
        this._rankValue(card.rank, true)
      ) + 1;
      const gapRank = this._rankLabel(gapValue);
      return gapRank == null || this._liveCopies(ctx, gapRank) > 0 || this._liveWilds(ctx) > 0;
    });
  }

  _liveWilds(ctx) {
    return this._liveCopies(ctx, '2') + (ctx.noJoker ? 0 : this._liveCopies(ctx, 'joker'));
  }

  // ---------------------------------------------------------------------------
  // Extending existing melds
  // ---------------------------------------------------------------------------

  /**
   * Extend an own-team meld with everything that fits in ONE atomic intent
   * (the server validates multi-card adds as a whole). Melds closest to
   * canastra (7) are tried first; true wilds are only spent when they push the
   * meld to 7+, and (at `hard`) not even then if the meld is still CLEAN and a
   * natural completion is realistically still out there.
   */
  _findAddToMeldAction(state, ctx, hand) {
    const byCanastraDistance = [...ctx.ownMelds].sort((a, b) => {
      const aShort = a.cards.length < BRAZILIA_SIZE ? BRAZILIA_SIZE - a.cards.length : 100 + a.cards.length;
      const bShort = b.cards.length < BRAZILIA_SIZE ? BRAZILIA_SIZE - b.cards.length : 100 + b.cards.length;
      return aShort - bShort;
    });

    for (const meld of byCanastraDistance) {
      const batch = [];
      let candidate = meld.cards;

      // Pass 1: exhaust NATURAL extensions first. Keeping naturals ahead of
      // wilds is what keeps a brazilia clean — a natural that takes the meld to 7
      // is always preferred over spending a wild for the same length.
      let grew = true;
      while (grew) {
        grew = false;
        for (const card of hand) {
          if (!this._joinsAsNatural(candidate, card)) continue;
          if (batch.some((picked) => this._sameCard(picked, card))) continue;
          if (!this._canAddCardsToMeld(candidate, [card], ctx)) continue;
          batch.push(card);
          candidate = [...candidate, card];
          grew = true;
        }
      }

      // Pass 1b: some card sets are only JOINTLY addable (the server validates
      // `[...meld, ...cards]` as a whole, never per prefix). Try the untouched
      // remainder as one batch before giving up on it.
      const remainder = hand.filter(
        (card) => !batch.some((picked) => this._sameCard(picked, card)) && !this._isWild(card)
      );
      if (remainder.length > 1 && this._canAddCardsToMeld(candidate, remainder, ctx)) {
        batch.push(...remainder);
        candidate = [...candidate, ...remainder];
      }

      // Pass 2: spend a SINGLE wild only to COMPLETE a brazilia (6 -> 7) that no
      // natural could finish. We never pile a wild onto a meld that is already a
      // brazilia (>=7) or still short of 6 — that only burns a wild and dirties
      // the meld for no canastra gain.
      if (candidate.length === BRAZILIA_SIZE - 1 && !this._shouldPreserveClean(ctx, meld, candidate)) {
        for (const card of hand) {
          if (!this._isWild(card)) continue;
          if (batch.some((picked) => this._sameCard(picked, card))) continue;
          if (!this._canAddCardsToMeld(candidate, [card], ctx)) continue;
          batch.push(card);
          candidate = [...candidate, card];
          break;
        }
      }

      if (batch.length === 0) continue;

      // Trim the batch until BOTH hold:
      //   • the resulting meld is still valid, and
      //   • the hand we are left with is one we can legally leave.
      //
      // Validity has to be re-checked because pass 1b adds its cards as a JOINT
      // batch — only the whole set is legal, so dropping one card off the tail
      // can leave an invalid combination (the server then answers "Invalid meld
      // after adding card" and, since the strategy is stateless, the identical
      // intent is regenerated forever).
      //
      // `actionMakesBrazilia` likewise MUST be recomputed from the CURRENT
      // candidate each iteration: a batch that reached 7 kept claiming it made a
      // canastra after being trimmed back to 6, so the close check granted a
      // go-out on a brazilia that no longer existed. Both were found by full-game
      // simulation, not by unit tests.
      candidate = [...meld.cards, ...batch];
      while (
        batch.length > 0 &&
        (!this._canAddCardsToMeld(meld.cards, batch, ctx) ||
          !this._safeToShed(state, ctx, this._handWithout(hand, batch), {
            actionMakesBrazilia: candidate.length >= BRAZILIA_SIZE,
            resultingMeld: candidate,
            meldOwnedBySelf: meld.isOwn === true,
          }))
      ) {
        batch.pop();
        candidate = [...meld.cards, ...batch];
      }
      if (batch.length === 0) continue;

      return {
        type: 'add_to_meld',
        cards: batch,
        targetPlayerIndex: meld.playerIndex,
        targetMeldIndex: meld.meldIndex,
      };
    }

    // LAST RESORT — see _findWildAddToMeld. Gated, because an unconditional wild
    // add would burn the very wilds the brazilia logic above is saving.
    if (this._hasTurnEnder(state, ctx, hand)) return null;
    return this._findWildAddToMeld(state, ctx, hand);
  }

  /**
   * A single WILD onto a team meld — the move the three passes above are
   * structurally blind to, and the ONE move a skipped bot turn was throwing away.
   *
   * Pass 1 refuses every wild (`_joinsAsNatural`), pass 1b filters wilds out of
   * its remainder, and pass 2 only ever fires at EXACTLY BRAZILIA_SIZE - 1. At
   * meld length 3, 4, 5, 7 or 8 a wild in hand is therefore invisible to the
   * planner even when the server would accept it — and when it is the hand's only
   * legal move, `decide()` answers `wait` and the coordinator skips the turn.
   *
   * Deliberately NOT part of the ordinary plan: both callers gate it
   * (`_hasTurnEnder` here, an exhausted decide() there). Legality is the server's
   * mirror, not a local re-derivation — `_canAddCardsToMeld` for the meld and
   * `_safeToShed` for the hand that is left, the same two judges the ordinary
   * passes use.
   *
   * The offline twin is AIPlayer._findWildAddToMeld; the two must stay identical
   * or vs-bot and online stop playing the same game.
   */
  _findWildAddToMeld(state, ctx, hand) {
    // A 2 before a joker: both spend the meld's single wild slot, but a joker is
    // the more flexible one to keep (a 2 is additionally bound by the
    // one-2-per-meld rule), so spend the 2.
    const wilds = hand
      .filter((card) => this._isWild(card))
      .sort((a, b) => (a.rank === 'joker' ? 1 : 0) - (b.rank === 'joker' ? 1 : 0));
    if (wilds.length === 0) return null;

    let best = null;
    let bestRank = -1;
    for (const meld of ctx.ownMelds) {
      const length = meld.cards.length;
      const makesBrazilia = length + 1 >= BRAZILIA_SIZE;
      // Prefer the meld this wild TURNS INTO a brazilia, then the longest meld —
      // so a wild is never squandered on a 3-card meld while a 6 sits next to it.
      const rank = (makesBrazilia && length < BRAZILIA_SIZE ? 1000 : 0) + length;
      if (rank <= bestRank) continue;
      for (const wild of wilds) {
        if (ctx.noJoker && wild.rank === 'joker') continue;
        if (!this._canAddCardsToMeld(meld.cards, [wild], ctx)) continue;
        if (
          !this._safeToShed(state, ctx, this._handWithout(hand, [wild]), {
            actionMakesBrazilia: makesBrazilia,
            resultingMeld: [...meld.cards, wild],
            meldOwnedBySelf: meld.isOwn === true,
          })
        ) {
          continue;
        }
        bestRank = rank;
        best = {
          type: 'add_to_meld',
          cards: [wild],
          targetPlayerIndex: meld.playerIndex,
          targetMeldIndex: meld.meldIndex,
        };
        break;
      }
    }
    return best;
  }

  /**
   * Whether this hand can end the turn WITHOUT the last-resort wild: a legal
   * discard, or a new meld to open. The cheaper test comes first — a legal discard
   * exists on almost every turn, so the meld enumeration is rarely paid.
   */
  _hasTurnEnder(state, ctx, hand) {
    if (this._pickDiscard(state, ctx, hand)) return true;
    return this._findBestNewMeld(state, ctx, hand) != null;
  }

  /**
   * `hard` only: refuse to dirty a still-CLEAN 6-card meld with a wild while a
   * natural completion is realistically still in the shoe. A clean canastra is
   * worth substantially more than a dirty one, and the meld is not going
   * anywhere — a wild spent here can never be un-spent.
   */
  _shouldPreserveClean(ctx, meld, candidate) {
    if (ctx.level !== 'hard') return false;
    if (meld.clean !== true) return false;
    if (ctx.requiredShortfall > 0) return false; // pro 75-rule outranks cleanliness
    if (ctx.opponentThreat) return false; // no time to be fussy
    return this._naturalCompletionsLive(ctx, candidate) >= 2;
  }

  /** How many unseen naturals could still extend `meld` (rough, rank-level). */
  _naturalCompletionsLive(ctx, meld) {
    if (!ctx.counting) return 0;
    const naturals = meld.filter((c) => !this._isWild(c));
    if (naturals.length === 0) return 0;

    if (this._isValidSet(meld, ctx)) {
      return this._liveCopies(ctx, naturals[0].rank);
    }

    const suit = this._nonWildSuit(meld);
    if (!suit) return 0;
    const values = naturals.map((c) => this._rankValue(c.rank, true)).sort((a, b) => a - b);
    let live = 0;
    for (const value of [values[0] - 1, values[values.length - 1] + 1]) {
      const rank = this._rankLabel(value);
      if (rank == null) continue;
      // Only the copies of the right SUIT can extend a run: 2 decks => 2 each.
      live += Math.min(2, this._liveCopies(ctx, rank));
    }
    return live;
  }

  // ---------------------------------------------------------------------------
  // Going out / shedding legality — mirrors of the server guards
  // ---------------------------------------------------------------------------

  /**
   * Whether the hand left AFTER a meld/add is one the bot can legally continue
   * from. This is the client-side twin of ActionHandlers._rejectIllegalMeldOut:
   * a meld that leaves no legally-discardable card is rolled back by the server,
   * costing a wasted round trip and (via the coordinator's force-progress path)
   * a SKIPPED bot turn at exactly the wrong moment.
   *
   *   • 2+ cards left  — always fine, a discard is guaranteed available;
   *   • 0 cards left   — only the well auto-refill (_wellTakeableOnEmpty) or an
   *                      instant-end ruleset case makes this legal;
   *   • 1 card left    — that exact card must satisfy the close rules, because
   *                      the turn still has to end on a discard.
   *
   * `opts.meldOwnedBySelf` is accepted and ignored: the close rules are TEAM
   * scoped on both sides now (see ActionHandlers._checkInstantEnd), so extending
   * a partner's meld unlocks a close exactly as extending your own does.
   */
  _safeToShed(state, ctx, remainingHand, opts = {}) {
    const remaining = Array.isArray(remainingHand) ? remainingHand : [];
    if (remaining.length >= 2) return true;

    const actionMakesBrazilia = opts.actionMakesBrazilia === true;
    const projected = actionMakesBrazilia ? { ...ctx, hasBrazilia: true } : ctx;

    // NB: a brazilia of 2s NO LONGER ends the round on the spot — it is worth
    // 2000 and nothing more (ActionHandlers._checkInstantEnd). Shedding down to
    // an unplayable hand on the strength of one is therefore not safe, so the two
    // "instant win" short-circuits that used to sit here are gone.

    if (remaining.length === 0) {
      // (a) The server auto-takes an available well and refills the hand, so the
      //     turn continues normally (ActionHandlers._autoTakeDeadIfNeeded).
      if (this._wellTakeableOnEmpty(projected, false)) return true;

      // (b) A MELD-OUT closes the round, clause for clause with
      //     ActionHandlers._checkInstantEnd. Two clauses used to be stricter than
      //     the rule they predict, and a bot that under-reads its own legal moves
      //     simply never plays them:
      //       • it demanded professionalWellMode === 'direct'. The server closes
      //         on a meld-out in BOTH modes, so the bot declined every legal
      //         indirect meld-out.
      //       • it demanded teamHasTakenPozzetto unconditionally, while the
      //         server only owes a well while one is still ON THE TABLE. In
      //         DIRECT, where a meld-out is the only close there is, a side that
      //         watched the opponents take both wells could then never end the
      //         round at all.
      //     The brazilia is TEAM-scoped for the same reason _checkInstantEnd now
      //     is: a partner's canasta closes for both of them.
      const braziliaAfter = projected.hasBrazilia || actionMakesBrazilia;
      const wellStillOwed =
        projected.pozzettosAvailable && !projected.teamHasTakenPozzetto;
      return braziliaAfter && !wellStillOwed;
    }

    // Exactly one card left: the turn must still end on a discard of THAT card.
    return this._legalCloseDiscard(state, projected, remaining[0]);
  }

  /**
   * Mirror of GameValidator._canTakeWellAfterEmptyHand: may the team take a well
   * the moment the hand clears? `emptiedByDiscard` distinguishes the indirect
   * take (last card discarded) from the direct one (last card melded).
   */
  _wellTakeableOnEmpty(ctx, emptiedByDiscard) {
    if (!ctx.pozzettosAvailable) return false;
    if (ctx.teamWellsTaken >= MAX_WELLS_PER_TEAM) return false;
    // Well-mode rules govern EVERY ruleset, so these two sit BEFORE the
    // non-professional early return.
    if (ctx.professionalWellMode === 'direct' && emptiedByDiscard) return false;
    // House rule: BOTH wells may be reached by a discard, so there is no
    // "first well only" gate. Keeping one here would make the bot refuse a
    // shed/close the validator accepts, wasting its turn.
    // PROFESSIONAL only: a completed brazilia is required before taking a well.
    if (!ctx.isPro) return true;
    return ctx.hasBrazilia;
  }

  /** True only when GameValidator.validateTakePozzetto would accept right now. */
  _canTakePozzetto(state, ctx) {
    if ((state.yourHand || []).length > 0) return false;
    if (!ctx.pozzettosAvailable) return false;
    if (ctx.teamWellsTaken >= MAX_WELLS_PER_TEAM) return false;
    if (ctx.isPro && !ctx.hasBrazilia) return false;
    return true;
  }

  /**
   * Whether discarding `card` as the FINAL card is legal, mirroring
   * GameValidator.validateDiscard's willBeEmpty branch IN ORDER. The first
   * branch is a bypass the previous implementation missed entirely, and it is
   * exactly the line a good player plays for:
   *   1. an untaken well the team may still claim — the discard is accepted and
   *      the server auto-takes the well; the TURN ENDS with that discard (the
   *      refilled hand is played the next time the table comes around);
   */
  _legalCloseDiscard(state, ctx, card) {
    if (ctx.pozzettosAvailable && this._wellTakeableOnEmpty(ctx, true)) return true;

    if (!ctx.isPro && this._isWild(card)) return false; // classic never closes on a joker/2
    // Direct mode never closes on a discard, in ANY ruleset.
    if (ctx.professionalWellMode === 'direct') return false;
    if (ctx.pozzettosAvailable && !ctx.teamHasTakenPozzetto) return false;

    return ctx.hasBrazilia;
  }

  _isSpecialBraziliaOfTwos(ctx, meld) {
    return (
      ctx.isPro &&
      Array.isArray(meld) &&
      meld.length >= BRAZILIA_SIZE &&
      meld.every((card) => card.rank === '2')
    );
  }

  // ---------------------------------------------------------------------------
  // Team / meld bookkeeping
  // ---------------------------------------------------------------------------

  _teamMelds(state, own) {
    const playerIndex = state.playerIndex;
    const playerMelds = state.playerMelds || {};
    const meldFlags = state.meldFlags || {};
    const entries = [];
    Object.entries(playerMelds).forEach(([rawIndex, melds]) => {
      const playerMeldIndex = Number(rawIndex);
      if (!Number.isInteger(playerMeldIndex)) return;
      const sameTeam = playerMeldIndex % 2 === playerIndex % 2;
      if (sameTeam !== own) return;
      (melds || []).forEach((cards, meldIndex) => {
        if (!Array.isArray(cards)) return;
        const flags = (meldFlags[playerMeldIndex] || [])[meldIndex] || null;
        entries.push({
          playerIndex: playerMeldIndex,
          meldIndex,
          cards,
          clean: flags ? flags.clean === true : null,
          isOwn: playerMeldIndex === playerIndex,
        });
      });
    });
    return entries;
  }

  // ---------------------------------------------------------------------------
  // Meld generation
  // ---------------------------------------------------------------------------

  _findBestNewMeld(state, ctx, hand, opts = {}) {
    let candidates = [
      ...(ctx.kanoonSetsLocked ? [] : this._findSetMelds(hand, ctx)),
      ...this._findSequenceMelds(hand, ctx),
    ].filter((entry) => this._isLegalNewMeld(entry.cards, ctx));

    // Opening a bare 3-card meld by burning a joker/2 is a losing trade: the
    // wild is worth far more later (completing a canastra, or plugging a run
    // that actually goes somewhere) than the 3-card meld is now. Only spend it
    // when the clock says otherwise — the professional per-turn points
    // requirement, or an opponent who can close at any moment.
    if (ctx.requiredShortfall === 0 && !ctx.opponentThreat) {
      const patient = candidates.filter(
        (entry) => entry.cards.length >= 4 || this._trueWildCount(entry.cards) === 0
      );
      if (patient.length > 0) candidates = patient;
      else candidates = [];
    }

    if (candidates.length === 0) return null;

    candidates.forEach((entry) => {
      entry.score = this._scoreMeld(entry.cards, ctx);
    });
    candidates.sort((left, right) => right.score - left.score);

    if (ctx.level === 'easy' && !opts.ignoreHold && candidates.length > 1) {
      // Easy bots do not always find the best line — they play a plausible one.
      if (Math.random() < 0.35) return candidates[1];
    }

    return candidates[0];
  }

  /**
   * A meld is worth playing for its length (canastra progress) and its points,
   * minus what it costs in wilds. Card values are the REAL Brazilia values per
   * ruleset — raw rank ordering (the old behaviour) ranks a 2 below a 3 when the
   * game scores it at 20.
   */
  _scoreMeld(cards, ctx) {
    const length = cards.length;
    const wilds = this._trueWildCount(cards);
    const points = this._meldPoints(cards, ctx);

    let score = length * 60 + points;

    if (length >= BRAZILIA_SIZE) {
      score += 1200;
      if (wilds === 0) score += 400; // a CLEAN canastra is worth markedly more
    }
    score -= wilds * 140; // a wild in hand is worth more than a wild in a short meld

    // Professional per-turn requirement: points that close the shortfall are
    // worth far more than usual, because falling short costs 20 AND raises the
    // bar by 20 for every following turn.
    if (ctx.requiredShortfall > 0) {
      score += Math.min(points, ctx.requiredShortfall) * 6;
    }

    // A set built out of 2s is legal (house rule) but only pays at 7 — below
    // that it just burns the hand's entire wild supply.
    const twos = cards.filter((card) => card.rank === '2').length;
    if (twos >= 3 && length < BRAZILIA_SIZE) score -= twos * 120;
    // A brazilia of 2s pays 2000 — a big prize, but no longer the instant win it
    // was scored as (5000 made the bot chase it over anything else on the table).
    if (this._isSpecialBraziliaOfTwos(ctx, cards)) score += 2000;

    return score;
  }

  _meldPoints(cards, ctx) {
    return cards.reduce((sum, card) => sum + this._cardPoints(card, ctx), 0);
  }

  /** Ruleset-aware Brazilia card values — mirrors GameValidator._calculateMeldPoints. */
  _cardPoints(card, ctx) {
    const rank = String(card?.rank);
    if (ctx.isPro) {
      if (rank === 'A') return 15;
      if (rank === '2' || FACE_RANKS.includes(rank)) return 10;
      if (LOW_RANKS.includes(rank)) return 5;
      return 0;
    }
    if (rank === 'joker') return 30;
    if (rank === '2') return 20;
    if (rank === 'A') return 15;
    if (FACE_RANKS.includes(rank)) return 10;
    if (LOW_RANKS.includes(rank)) return 5;
    return 0;
  }

  /**
   * Holding a meld back is only ever right when playing it now costs more than
   * it gains: at `hard`, a 5-6 card run that a still-live natural could turn
   * into a CLEAN canastra next turn is worth one turn of patience — but never
   * while an opponent can close, and never while the pro points requirement is
   * unmet.
   */
  _shouldHoldMeld(state, ctx, meld, hand) {
    if (ctx.level !== 'hard') return false;
    if (!ctx.counting) return false;
    if (ctx.opponentThreat) return false;
    if (ctx.requiredShortfall > 0) return false;
    if (meld.cards.length >= BRAZILIA_SIZE) return false;
    if (meld.cards.length < BRAZILIA_SIZE - 2) return false;
    if (hand.length - meld.cards.length < 2) return false; // do not stall a shed we need
    return this._naturalCompletionsLive(ctx, meld.cards) >= 3;
  }

  /**
   * Two decks: a rank can have up to 8 natural copies and duplicate suits are
   * legal in a set, so take EVERY natural of the rank. A wild joins only when
   * it is needed for the 3-card minimum or completes a canastra (6 -> 7).
   */
  _findSetMelds(hand, ctx) {
    const wilds = hand.filter((card) => this._isWild(card));
    const usableWild = this._pickWild(wilds, ctx);
    const byRank = new Map();
    hand
      .filter((card) => !this._isWild(card))
      .forEach((card) => {
        const rank = String(card.rank);
        if (!byRank.has(rank)) byRank.set(rank, []);
        byRank.get(rank).push(card);
      });

    const melds = [];
    for (const cards of byRank.values()) {
      if (cards.length >= 3) {
        melds.push({ cards: this._cloneCards(cards) });
        if (cards.length === BRAZILIA_SIZE - 1 && usableWild) {
          melds.push({ cards: this._cloneCards([...cards, usableWild]) });
        }
      } else if (cards.length === 2 && usableWild) {
        melds.push({ cards: this._cloneCards([...cards, usableWild]) });
      }
    }

    // House rule: a SET OF ALL 2s is a legal meld (2 is its own natural rank,
    // GameValidator._isValidSet). Only worth opening when it is already close to
    // the 7 that makes it a canastra — in professional that is an instant win.
    const twos = hand.filter((card) => card.rank === '2');
    if (twos.length >= 5) {
      melds.push({ cards: this._cloneCards(twos) });
      const joker = hand.find((card) => card.rank === 'joker');
      if (joker && !ctx.noJoker && twos.length === BRAZILIA_SIZE - 1) {
        melds.push({ cards: this._cloneCards([...twos, joker]) });
      }
    }

    return melds;
  }

  /**
   * Per-suit run search mirroring GameValidator: the ace plays low (A-2-3) or
   * high (Q-K-A), a 2 of the run's suit slots in as a natural, and at most one
   * true wild either fills a single-rank gap or EXTENDS the run at an end (the
   * server allows that at any length — the old generator only tried it on a
   * 2-natural run, so it never found "6 naturals + 1 wild = instant canastra").
   *
   * Every candidate is validated through _isValidSequence before it leaves here,
   * so over-generation can never produce an intent the server rejects.
   */
  _findSequenceMelds(hand, ctx) {
    const melds = [];
    const suits = new Set(
      hand.filter((card) => card.rank !== 'joker' && card.suit !== 'joker').map((card) => String(card.suit))
    );

    for (const suit of suits) {
      // Two passes: a same-suit 2 is PREFERRED as the natural rank-2 slot, but it
      // can also serve as the run's single wild (e.g. 3♥ 2♥ 5♥). Enumerate both.
      this._collectSuitRuns(hand, ctx, suit, false, melds);
      if (hand.some((card) => card.rank === '2' && String(card.suit) === suit)) {
        this._collectSuitRuns(hand, ctx, suit, true, melds);
      }
    }

    return melds;
  }

  _collectSuitRuns(hand, ctx, suit, treatSameSuitTwosAsWild, out) {
    const isSameSuitTwo = (card) => card.rank === '2' && String(card.suit) === suit;

    const naturals = hand.filter((card) => {
      if (card.rank === 'joker' || card.suit === 'joker') return false;
      if (String(card.suit) !== suit) return false;
      if (treatSameSuitTwosAsWild && isSameSuitTwo(card)) return false;
      return true;
    });
    if (naturals.length < 2) return;

    const wildPool = hand.filter((card) => {
      if (!this._isWild(card)) return false;
      if (card.rank === 'joker') return !ctx.noJoker;
      // A 2 of ANOTHER suit is always a wild here; a same-suit 2 only in pass 2.
      return String(card.suit) !== suit || treatSameSuitTwosAsWild;
    });

    for (const aceHigh of [false, true]) {
      // One card per rank value; the ace contributes 1 (low pass) or 14 (high).
      const byValue = new Map();
      for (const card of naturals) {
        const value = this._rankValue(card.rank, aceHigh);
        if (!byValue.has(value)) byValue.set(value, card);
      }
      const values = [...byValue.keys()].sort((a, b) => a - b);

      for (let i = 0; i < values.length; i++) {
        const run = [byValue.get(values[i])];
        let gapWild = null;

        for (let j = i + 1; j < values.length; j++) {
          const prev = values[j - 1];
          const next = values[j];
          const nextCard = byValue.get(next);

          if (next === prev + 1) {
            run.push(nextCard);
          } else if (next === prev + 2 && !gapWild) {
            const wild = this._pickWild(
              wildPool.filter((w) => !run.some((r) => this._sameCard(r, w))),
              ctx
            );
            if (!wild) break;
            gapWild = wild;
            run.push(wild, nextCard);
          } else {
            break;
          }

          // Emit every prefix of length 3+, not just the maximal run: a shorter
          // clean run can outscore a longer one that had to burn a wild.
          if (run.length >= 3) out.push({ cards: this._cloneCards(run) });

          // ...and the same run extended by a spare wild at the end.
          if (!gapWild) {
            const spare = this._pickWild(
              wildPool.filter((w) => !run.some((r) => this._sameCard(r, w))),
              ctx
            );
            if (spare && run.length >= 2) {
              out.push({ cards: this._cloneCards([...run, spare]) });
            }
          }
        }

        // A 2-natural run plus a wild also reaches the 3-card minimum.
        if (run.length === 2 && !gapWild) {
          const wild = this._pickWild(
            wildPool.filter((w) => !run.some((r) => this._sameCard(r, w))),
            ctx
          );
          if (wild) out.push({ cards: this._cloneCards([...run, wild]) });
        }
      }
    }
  }

  /** First wild legal under the ruleset (no jokers in professional/noJoker melds). */
  _pickWild(wilds, ctx) {
    for (const wild of wilds || []) {
      if (wild.rank === 'joker' && ctx.noJoker) continue;
      return wild;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Meld legality — faithful mirrors of GameValidator
  // ---------------------------------------------------------------------------

  _isLegalMeld(cards, ctx) {
    return this._isValidSet(cards, ctx) || this._isValidSequence(cards, ctx);
  }

  /**
   * Legal as a NEW meld: _isLegalMeld plus the Kanoon set lock (a group that is
   * only valid as a set may not open while our side has no buraco). Extending an
   * existing meld keeps using _isLegalMeld — no set can exist on a locked side.
   */
  _isLegalNewMeld(cards, ctx) {
    if (this._isValidSequence(cards, ctx)) return true;
    if (ctx.kanoonSetsLocked) return false;
    return this._isValidSet(cards, ctx);
  }

  /** Id of a serialized card, in the same order of preference the server uses. */
  _cardIdOf(card) {
    if (!card) return null;
    return card.cardId ?? card.instanceId ?? card.id ?? null;
  }

  /**
   * KANOON pile gate: can at least one card of `pile` go into a meld this turn —
   * onto an own meld, or into a new meld with cards in hand — WITHOUT stranding
   * the hand? Judged on the hand as it will be after the take (hand + pile),
   * through the same _safeToShed the post-take placement is held to: a
   * placement that is legal but unsafe is refused by _kanoonMeldPending, and a
   * take that leads there is a certain 100-point charge. (A deep-check sim
   * found half the stock-alive charges came from exactly that gap.)
   */
  _kanoonPileMeldable(state, ctx, pile, hand) {
    const afterTake = [...(hand || []), ...(pile || [])];
    for (const card of pile || []) {
      for (const entry of ctx.ownMelds) {
        if (!this._canAddCardsToMeld(entry.cards, [card], ctx)) continue;
        const grown = [...entry.cards, card];
        if (
          this._safeToShed(state, ctx, this._handWithout(afterTake, [card]), {
            actionMakesBrazilia: entry.cards.length < BRAZILIA_SIZE && grown.length >= BRAZILIA_SIZE,
            resultingMeld: grown,
            meldOwnedBySelf: entry.isOwn === true,
          })
        ) {
          return true;
        }
      }
      const meld = this._kanoonNewMeldWith(state, ctx, card, afterTake);
      if (
        meld &&
        this._safeToShed(state, ctx, this._handWithout(afterTake, meld.cards), {
          actionMakesBrazilia: meld.cards.length >= BRAZILIA_SIZE,
          resultingMeld: meld.cards,
          meldOwnedBySelf: true,
        })
      ) {
        return true;
      }
    }
    return false;
  }

  /** A legal new meld drawn from `card` + `hand` that contains `card`, or null. */
  _kanoonNewMeldWith(state, ctx, card, hand) {
    const pool = [card, ...hand.filter((c) => !this._sameCard(c, card))];
    const candidates = [
      ...(ctx.kanoonSetsLocked ? [] : this._findSetMelds(pool, ctx)),
      ...this._findSequenceMelds(pool, ctx),
    ].filter(
      (entry) =>
        this._isLegalNewMeld(entry.cards, ctx) &&
        entry.cards.some((c) => this._sameCard(c, card))
    );
    if (candidates.length === 0) return null;
    candidates.forEach((entry) => {
      entry.score = this._scoreMeld(entry.cards, ctx);
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  /**
   * KANOON: the pile was taken this turn and nothing from it is in a meld yet.
   * Lay one of the taken cards before anything else — onto an own meld first
   * (cheapest, keeps the hand's material), else in a new meld. Null when no
   * taken card fits anywhere (the charge is then unavoidable; play on normally).
   */
  _kanoonMeldPending(state, ctx, hand) {
    const pending = new Set(ctx.kanoonPendingIds);
    const owed = hand.filter((c) => pending.has(String(this._cardIdOf(c))));
    for (const card of owed) {
      for (const entry of ctx.ownMelds) {
        if (!this._canAddCardsToMeld(entry.cards, [card], ctx)) continue;
        const grown = [...entry.cards, card];
        if (
          !this._safeToShed(state, ctx, this._handWithout(hand, [card]), {
            actionMakesBrazilia: entry.cards.length < BRAZILIA_SIZE && grown.length >= BRAZILIA_SIZE,
            resultingMeld: grown,
            meldOwnedBySelf: entry.isOwn === true,
          })
        ) {
          continue;
        }
        return {
          type: 'add_to_meld',
          cards: [card],
          targetPlayerIndex: entry.playerIndex,
          targetMeldIndex: entry.meldIndex,
        };
      }
    }
    for (const card of owed) {
      const meld = this._kanoonNewMeldWith(state, ctx, card, hand);
      if (
        meld &&
        this._safeToShed(state, ctx, this._handWithout(hand, meld.cards), {
          actionMakesBrazilia: meld.cards.length >= BRAZILIA_SIZE,
          resultingMeld: meld.cards,
          meldOwnedBySelf: true,
        })
      ) {
        return { type: 'play_meld', cards: meld.cards };
      }
    }
    return null;
  }

  _canAddCardsToMeld(meld, cards, ctx) {
    const candidate = [...(meld || []), ...(cards || [])];
    return this._isLegalMeld(candidate, ctx);
  }

  _isValidSet(cards, ctx) {
    if (!Array.isArray(cards) || cards.length < 3) return false;
    if (ctx.noJoker && cards.some((c) => c.rank === 'joker')) return false;

    let rank = this._nonWildRank(cards);
    // House rule: a SET OF ALL 2s is legal — treat 2 as its natural rank. A joker
    // may still fill in as the single wild, but a joker-only group is NOT a meld.
    if (!rank && cards.some((c) => c.rank === '2')) rank = '2';
    if (!rank) return false;

    for (const card of cards) {
      // In a 2s-set the 2s are the NATURALS; only a joker acts as the wild there.
      const isWildHere = rank === '2' ? card.rank === 'joker' : this._isWild(card);
      if (isWildHere) continue;
      if (String(card.rank) !== rank) return false;
    }

    const wildCount =
      rank === '2'
        ? cards.filter((c) => c.rank === 'joker').length
        : cards.filter((c) => this._isWild(c)).length;
    return wildCount <= 1;
    // NOTE: duplicate suits are ALLOWED in a set — Brazilia is played with two decks.
  }

  _isValidSequence(cards, ctx) {
    if (!Array.isArray(cards) || cards.length < 3) return false;
    if (ctx.noJoker && cards.some((c) => c.rank === 'joker')) return false;

    const suit = this._nonWildSuit(cards);
    if (!suit) return false;
    for (const card of cards) {
      if (!this._isWild(card) && String(card.suit) !== suit && String(card.suit) !== 'joker') {
        return false;
      }
    }

    // ONE 2 PER RUN — mirrors GameValidator._isValidSequence (2026-08-28). Kept
    // here as well as there because this is the bot's OWN copy of the shape
    // check: without it the planner would keep proposing A♣-2♣-[2♥ as 3]-4♣,
    // the server would reject every one, and the bot would burn its turn.
    // Sets are untouched, so a bot can still build the canastra de dois.
    if (cards.filter((card) => String(card.rank) === '2').length > 1) return false;

    const isEffectiveWild = (card) => this._isWild(card) && !this._isNaturalTwo(card, cards, suit);
    const wildCount = cards.filter(isEffectiveWild).length;
    if (wildCount > 1) return false;

    const toValues = (aceHigh) =>
      cards
        .filter((card) => !isEffectiveWild(card))
        .map((card) => this._rankValue(card.rank, aceHigh))
        .sort((a, b) => a - b);

    const gapCount = (values) => {
      if (values.length === 0) return null;
      let gaps = 0;
      for (let i = 1; i < values.length; i++) {
        const diff = values[i] - values[i - 1];
        if (diff === 1) continue;
        if (diff === 2) {
          gaps += 1;
          continue;
        }
        return null;
      }
      return gaps > wildCount ? null : gaps;
    };

    return gapCount(toValues(false)) != null || gapCount(toValues(true)) != null;
  }

  /**
   * Mirror of GameValidator._isNaturalTwo: a 2 is NATURAL only when its suit
   * matches the run's AND the resulting natural ranks are strictly consecutive.
   * The moment a gap exists elsewhere in the run the 2 is demoted back to a
   * wild — which is what makes "2♥ 3♥ joker 5♥" a two-wild meld the server
   * rejects, even though the old check happily emitted it.
   */
  _isNaturalTwo(card, cards, suitHint) {
    if (card.rank !== '2') return false;
    const suit = suitHint || this._nonWildSuit(cards);
    if (!suit) return false;
    if (String(card.suit) !== suit) return false;

    // GAPS vs FILLERS — the server's exact reading (GameValidator._isNaturalTwo).
    //
    // This used to drop the jokers from the layout and then demand the rest be
    // strictly consecutive, which made the bot STRICTER than the server: it
    // refused 2H-3H-[joker as 4H]-5H, AC-2C-[joker]-4C and 2H-4H-[joker] — all
    // legal runs the server accepts. The bot could never produce something the
    // server would reject, so nothing leaked; it simply declined free, legal
    // extensions and burned tempo, and vs-bot stopped being the same game as
    // online. Every other wild is a FILLER available to plug a hole, so a hole
    // somewhere else must not demote a 2 sitting on its own rank.
    const others = cards.filter((c) => c !== card);
    const fillers = others.filter((c) => this._isWild(c)).length;
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

  /**
   * Whether `card` joins `meld` as a NATURAL rather than spending its wild slot.
   * A 2 is natural in two distinct situations, and missing either one made the
   * bot refuse legal, free extensions:
   *   • inside a SET OF 2s, where 2 is the set's own rank (the whole meld has no
   *     non-wild card, so the sequence-oriented _isNaturalTwo cannot see it);
   *   • inside a same-suit run where the 2 can sit on rank two — judged the
   *     way the server judges it, so a gap that some OTHER wild plugs does not
   *     demote it.
   */
  _joinsAsNatural(meld, card) {
    if (!this._isWild(card)) return true;
    if (card.rank !== '2') return false; // a joker is always a wild
    const combined = [...meld, card];
    if (this._nonWildRank(combined) === null && this._nonWildSuit(combined) === null) {
      // Every card is a 2 (or a joker): this is the 2s-set, where 2s are naturals.
      return combined.every((c) => c.rank === '2' || c.rank === 'joker');
    }
    return this._isNaturalTwo(card, combined);
  }

  // ---------------------------------------------------------------------------
  // Discard
  // ---------------------------------------------------------------------------

  _pickDiscard(state, ctx, hand) {
    const restrictions = new Set(state.drawnCardRestriction || []);
    // Discarding the last card goes OUT — only a card that satisfies the close
    // rules is a legal pick (GameValidator.validateDiscard willBeEmpty branch).
    const closing = hand.length === 1;

    const legal = hand.filter((card) => {
      // A meld no longer lifts the just-taken restriction (2026-09-21), so
      // `state.meldedThisTurn` is deliberately not consulted here — mirror of
      // GameValidator.validateDiscard.
      const restricted = this._restrictionMatches(restrictions, card);
      // The server SHORT-CIRCUITS a restricted card at hand size 1 as valid,
      // bypassing the close requirements entirely — mirror that exactly.
      if (restricted) return hand.length === 1;
      // ANTI PING-PONG, checked in the same position GameValidator checks it:
      // after the drawn-card block, before the close branch.
      if (this._pingPongBlocks(state, ctx, card, hand)) return false;
      if (closing && !this._legalCloseDiscard(state, ctx, card)) return false;
      return true;
    });

    // No legal discard: report it honestly. decide() turns this into `wait`, and
    // the coordinator force-resolves the turn in one step instead of paying for a
    // rejection first.
    if (legal.length === 0) return null;

    const scored = legal
      .map((card) => ({ card, score: this._discardScore(card, hand, state, ctx) }))
      .sort((a, b) => b.score - a.score);

    // Easy bots throw away the obvious junk but are not precise about it.
    if (ctx.level === 'easy' && scored.length > 2 && Math.random() < 0.4) {
      return scored[1 + Math.floor(Math.random() * 2)].card;
    }

    return scored[0].card;
  }

  /**
   * Higher score = more willing to throw it away.
   *
   * Base is the card's REAL Brazilia value (an unmelded card counts against us at
   * scoring, so shedding value is the point), reduced by everything that makes
   * the card useful to us and by everything that makes it useful to THEM.
   */
  _discardScore(card, hand, state, ctx) {
    if (!card) return -999;
    if (this._isWild(card)) return -1000; // never volunteer a wild

    const sameRank = hand.filter((c) => !this._sameCard(c, card) && c.rank === card.rank).length;
    const sameSuitNear = hand.filter((c) => {
      if (this._sameCard(c, card) || c.suit !== card.suit || this._isWild(c)) return false;
      const distance = Math.abs(this._rankValue(c.rank, true) - this._rankValue(card.rank, true));
      return distance > 0 && distance <= 2;
    }).length;

    let score = this._cardPoints(card, ctx);

    // Material we are actively building with.
    score -= sameRank * 14;
    score -= sameSuitNear * 9;

    // Extending one of our own melds is the strongest reason to keep a card.
    if (ctx.ownMelds.some((entry) => this._canAddCardsToMeld(entry.cards, [card], ctx))) {
      score -= 60;
    }

    // Feeding a card the opposing team can slot straight into a meld hands them
    // tempo; when they are close to going out it is close to handing them the round.
    if (ctx.opponentMelds.some((entry) => this._canAddCardsToMeld(entry.cards, [card], ctx))) {
      score -= ctx.opponentThreat ? 140 : 60;
    }

    if (ctx.level === 'easy') return score; // easy bots stop reasoning here

    // Card counting: material that can no longer be completed is dead weight —
    // shed it now rather than carrying it to the scoring penalty.
    if (ctx.counting) {
      const live = this._liveCopies(ctx, card.rank);
      if (sameRank === 0 && sameSuitNear === 0 && live === 0) score += 45;
      else if (sameRank > 0 && sameRank < 2 && live === 0) score += 20;
    }

    // Endgame: once an opponent can close at any moment, dumping the biggest
    // penalty cards beats holding speculative material.
    if (ctx.opponentThreat) {
      score += this._cardPoints(card, ctx);
    }

    return score;
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  /** The hand that remains after `cards` are played out of it (identity-based). */
  _handWithout(hand, cards) {
    return hand.filter((card) => !(cards || []).some((played) => this._sameCard(played, card)));
  }

  _trueWildCount(cards) {
    return cards.filter((card) => this._isWild(card) && !this._isNaturalTwo(card, cards)).length;
  }

  _isWild(card) {
    return card?.rank === 'joker' || card?.rank === '2';
  }

  _nonWildSuit(cards) {
    for (const card of cards) {
      if (!this._isWild(card)) return String(card.suit);
    }
    return null;
  }

  _nonWildRank(cards) {
    for (const card of cards) {
      if (!this._isWild(card)) return String(card.rank);
    }
    return null;
  }

  _rankValue(rank, aceHigh = true) {
    if (String(rank) === 'A') return aceHigh ? 14 : 1;
    const values = {
      joker: 0,
      K: 13,
      Q: 12,
      J: 11,
      10: 10,
      9: 9,
      8: 8,
      7: 7,
      6: 6,
      5: 5,
      4: 4,
      3: 3,
      2: 2,
    };
    return values[String(rank)] || 0;
  }

  _rankLabel(value) {
    if (value === 14 || value === 1) return 'A';
    if (value === 13) return 'K';
    if (value === 12) return 'Q';
    if (value === 11) return 'J';
    if (value >= 2 && value <= 10) return String(value);
    return null;
  }

  /**
   * ANTI PING-PONG mirror of GameValidator._pingPongBlocks, clause for clause.
   * A bot that proposes a locked discard gets rejected by the validator and the
   * coordinator has to force-resolve the turn, so the planner has to know the
   * rule rather than discover it.
   *
   * Matches on the CARD ID like the validator does, never rank+suit: a rank+suit
   * test also freezes the twin from the other deck, which is not what the rule
   * binds. An expired or id-less lock binds nothing.
   *
   * The last clause is the ESCAPE HATCH: the lock yields when no OTHER card is
   * discardable, so it can never leave the bot with `legal.length === 0`. That
   * is also why _legalCloseDiscard needs no lock check — at hand length 1 the
   * hatch is always open.
   */
  _pingPongBlocks(state, ctx, card, hand) {
    const lock = ctx.discardLock;
    if (!lock || !card) return false;
    if (Number.isFinite(lock.turnsLeft) && lock.turnsLeft <= 0) return false;
    // EVERY id the lock holds: a two-deck shoe lets the same card be taken twice
    // and both copies stay held. The escape hatch skips them all, or a hand of
    // nothing but the two would refuse both discards and wedge the bot's turn.
    const lockedIds = (lock.cardIds && lock.cardIds.length ? lock.cardIds : [lock.cardId])
      .filter((id) => id !== null && id !== undefined)
      .map(String);
    if (!lockedIds.length) return false;
    const held = (c) => lockedIds.includes(String(c?.cardId ?? c?.instanceId ?? c?.id));
    if (!held(card)) return false;
    const restrictions = new Set(state.drawnCardRestriction || []);
    return (hand || []).some((c) => !held(c) && !this._restrictionMatches(restrictions, c));
  }

  _restrictionMatches(restrictions, card) {
    if (!card) return false;
    const id = card.cardId ?? card.instanceId ?? card.id;
    if (id !== null && id !== undefined && restrictions.has(String(id))) return true;
    if (id !== null && id !== undefined && restrictions.has(`id:${id}`)) return true;
    return restrictions.has(`${card.suit}-${card.rank}`);
  }

  _sameRankSuit(a, b) {
    return !!a && !!b && a.suit === b.suit && a.rank === b.rank;
  }

  _sameCard(a, b) {
    const aId = a?.cardId ?? a?.instanceId ?? a?.id;
    const bId = b?.cardId ?? b?.instanceId ?? b?.id;
    if (aId !== null && aId !== undefined && bId !== null && bId !== undefined) {
      return String(aId) === String(bId);
    }
    return this._sameRankSuit(a, b);
  }

  _cloneCards(cards) {
    return (cards || []).map((card) => ({ ...card }));
  }
}

BotStrategy.DEFAULT_MAX_MELD_ACTIONS = DEFAULT_MAX_MELD_ACTIONS;
BotStrategy.MAX_WELLS_PER_TEAM = MAX_WELLS_PER_TEAM;
BotStrategy.BRAZILIA_SIZE = BRAZILIA_SIZE;

module.exports = BotStrategy;
