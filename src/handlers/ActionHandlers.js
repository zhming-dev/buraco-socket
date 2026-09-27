/**
 * ActionHandlers
 * Handles game actions and produces network messages
 */

const { GameValidator } = require('../validators');
const { GameRoomStatus } = require('../constants');
const { Card } = require('../models/Deck');
const logger = require('../utils/logger');
const { emitGameEvent } = require('../observability/gameEvents');

/** Cards a meld needs to be a buraco — and the size below which no grade
 * exists to ratchet (see _latchMeldGrade). Same figure the isBuraco stamps
 * and _teamHasAnyBrazilia read; BotStrategy names it BRAZILIA_SIZE. */
const BURACO_SIZE = 7;

class ActionHandlers {
  /**
   * Handle player drawing a card
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {boolean} fromDeck
   * @param {Object} drawnCard
   * @returns {Object}
   */
  static handleDrawCard(room, playerId, fromDeck, drawnCard) {
    const validation = GameValidator.validateDrawCard(room, playerId, fromDeck);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const player = room.getPlayer(playerId);

    // Message for the player who drew (with card details)
    const messageForPlayer = {
      type: 'card_drawn',
      playerIndex: player.playerIndex,
      card: drawnCard,
      fromDeck,
      timestamp: new Date().toISOString(),
    };

    // Message for other players (card hidden)
    const messageForOthers = {
      type: 'card_drawn',
      playerIndex: player.playerIndex,
      card: null,
      fromDeck,
      timestamp: new Date().toISOString(),
    };

    player.markActive();

    // Note: the drawn-card discard restriction (mirroring the Flutter
    // GameController._drawnCardThisTurnRestriction) is applied by SocketHandlers
    // after the card is actually moved into the player's hand.

    return {
      success: true,
      toPlayer: messageForPlayer,
      toOthers: messageForOthers,
    };
  }

  /**
   * Handle player playing a meld
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Array} cards
   * @param {number} meldIndex
   * @returns {Object}
   */
  static handlePlayMeld(room, playerId, cards, meldIndex) {
    const validation = GameValidator.validateMeld(room, playerId, cards);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const player = room.getPlayer(playerId);

    // R2: capture rollback state before mutating so an illegal meld-out can revert.
    const _rb = this._snapshotForRollback(room, playerId);

    // Persist meld: remove from hand and append to player's meld list
    const playerHand = room.playerHands.get(playerId) || [];
    const taken = this._takeCardsFromHand(playerHand, cards);
    if (!taken) {
      return { success: false, error: 'One or more cards are not in your hand' };
    }
    const resolvedCards = taken.cards;
    room.playerHands.set(playerId, taken.remaining);

    const melds = room.playerMelds.get(playerId) || [];
    melds.push(resolvedCards);
    room.playerMelds.set(playerId, melds);
    const meldOrders = room.playerMeldOrders.get(playerId) || [];
    const displayOrder = room.nextMeldOrder++;
    meldOrders.push(displayOrder);
    room.playerMeldOrders.set(playerId, meldOrders);

    const ruleset = room.ruleset || 'classic';
    const newMeldIndex = melds.length - 1;
    this._latchMeldGrade(room, playerId, newMeldIndex, resolvedCards, ruleset);

    // Canonical ordering (#2): for a sequence, place the wild-2/joker into the
    // interior gap it represents and store that order authoritatively.
    const orderedCards = GameValidator.orderMeldCards(resolvedCards, ruleset);
    melds[newMeldIndex] = orderedCards;

    this._trackTurnMeldPoints(room, playerId, resolvedCards);

    // Mark meld as happened this turn and capture undo snapshot
    const wasMeldedBefore = room.meldedThisTurn || false;
    const savedRestriction = new Set(room.drawnCardThisTurnRestriction);
    const savedDiscardLock = room.discardLocks.get(playerId) || null;
    const prevMust = (room.mustMeldCard && resolvedCards.some((c) => this._sameCard(c, room.mustMeldCard) || (c.suit === room.mustMeldCard.suit && c.rank === room.mustMeldCard.rank)))
      ? { ...room.mustMeldCard } : null;
    // RULE CHANGE (2026-09-21, owner): a meld pays off NOTHING. The just-taken
    // card keeps its per-turn restriction and the anti ping-pong lock (taken
    // card + twins) keeps its countdown. It used to be "meld anything and every
    // blocked card is yours to throw" (`drawnCardThisTurnRestriction = new
    // Set()` + `discardLocks.delete(playerId)` here); now only nextTurn(), a
    // deck draw, a multi-card take or a new deal release them. Mirrored by the
    // Flutter GameController.playMeld. The snapshot above still round-trips
    // both so an UNDO restores exactly what the meld saw.
    room.meldedThisTurn = true;
    room.lastMeldSnapshot = {
      playerId,
      wasNewMeld: true,
      meldIndex: melds.length - 1,
      displayOrder,
      cards: [...resolvedCards],
      restoredMustMeldCard: prevMust,
      savedRestriction,
      savedDiscardLock,
      wasMeldedBefore,
    };
    // Clear mustMeldCard if satisfied
    if (prevMust) {
      room.mustMeldCard = null;
    }

    // Auto-take dead pile if hand emptied and player not yet taken
    const pozzettoResult = this._autoTakeDeadIfNeeded(room, playerId, false);

    const flags = this._meldFlags(room, playerId, melds[newMeldIndex], newMeldIndex);
    const message = {
      type: 'meld_played',
      playerIndex: player.playerIndex,
      cards: melds[newMeldIndex],
      meldIndex: meldIndex,
      // #5 brazilia badge: length>=7 and clean/dirty per ruleset so the client
      // renders the marker live (and reconnect re-renders from toJSON.melds).
      isBuraco: flags.isBuraco,
      clean: flags.clean,
      grade: flags.grade,
      timestamp: new Date().toISOString(),
    };

    if (pozzettoResult?.takenCount) {
      message.pozzettoTaken = pozzettoResult.takenCount;
    }

    const instantEnd = this._checkInstantEnd(room, playerId);

    player.markActive();

    if (instantEnd?.minimumMeldBlocked) {
      // The close was refused by the minimum-meld bar and every card laid this
      // turn went back to the hand. Ride the verdict out on this broadcast the
      // way handleDiscard does, so the client knows why the table emptied.
      message.minimumMeld = instantEnd.minimumMeld;
      return { success: true, broadcast: message };
    }

    if (instantEnd) {
      return { success: true, broadcast: message, roundEnded: instantEnd };
    }

    // R2 close-requirement guard: the only legal meld-outs (pro-direct /
    // brazilia-of-2s) already returned via _checkInstantEnd above, and a takeable
    // pozzetto has refilled the hand via _autoTakeDeadIfNeeded. A hand left EMPTY
    // here is an illegal close (classic / pro-indirect require a final discard):
    // roll back and reject so the turn keeps a discardable card.
    const illegalOut = this._rejectIllegalMeldOut(room, playerId, _rb);
    if (illegalOut) {
      return illegalOut;
    }

    return { success: true, broadcast: message };
  }

  /**
   * Handle player discarding a card
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Object|Object[]} card
   * @returns {Object}
   */
  static handleDiscard(room, playerId, card) {
    const validation = GameValidator.validateDiscard(room, playerId, card);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const player = room.getPlayer(playerId);
    const previousTurn = room.currentTurn;

    // Remove from hand and append to discard pile
    const playerHand = room.playerHands.get(playerId) || [];
    const taken = this._takeCardsFromHand(playerHand, [card]);
    if (!taken) {
      return { success: false, error: 'Card not found in hand' };
    }
    const resolvedCard = taken.cards[0];
    room.playerHands.set(playerId, taken.remaining);
    // QANOON rule 2 — judged on the hand as it stands after the thrown card has
    // left it, and BEFORE the minimum-meld audit below can hand cards back: the
    // pile card the player did meld counts even if that audit later rolls the
    // meld back (it has its own consequence; this charge is for never trying).
    const qanoonPenalty = this._applyQanoonPileCharge(room, playerId, resolvedCard);
    const toPile = resolvedCard && typeof resolvedCard.toJSON === 'function'
      ? resolvedCard
      : new Card(resolvedCard.suit, resolvedCard.rank, this._cardId(resolvedCard));
    room.discardPile.push(toPile);
    // Append-only round history. room.discardPile is reset to [] the moment
    // anyone takes the pile, which erases what has been thrown; this survives it
    // so the bot's card counting keeps working after every take.
    if (Array.isArray(room.discardHistory)) room.discardHistory.push(toPile);

    const discardMessage = {
      type: 'card_discarded',
      playerIndex: player.playerIndex,
      card: resolvedCard,
      ...(qanoonPenalty ? { qanoonPenalty } : {}),
      timestamp: new Date().toISOString(),
    };

    // Undo window closes once the player commits a discard
    room.lastMeldSnapshot = null;

    // If discarding emptied the hand, take the side's POT/well where the rules
    // allow indirect acquisition.
    //
    // The taker does NOT keep the turn. An INDIRECT take is, by definition, the
    // discard that ended the turn — the refilled 11-card hand is played from the
    // next time the table comes around. (This used to be a house rule that handed
    // the turn back, letting one player empty the well and then keep playing the
    // whole round out of it.) A DIRECT take is unaffected: it happens on the
    // meld-out paths, which never reach this branch.
    // Reset draw flag for next player
    room.hasDrawnCard = false;

    // MINIMUM MELD is audited BEFORE the well is handed over, and the order is
    // load-bearing. A side that cannot reach the required points could otherwise
    // lay a junk meld, discard its last card, and collect the pozzetto on the way
    // out — the meld is rolled back, but the well it bought is kept. Trading 100
    // points for a pozzetto is a bargain, so it would be the correct play. With
    // the audit first, the returned cards leave the hand non-empty and there is
    // no empty hand to hand a well to.
    const minimumMeld = this._applyMinimumMeldRule(room, playerId);
    if (minimumMeld) {
      // The clients need this the moment it happens: a failure hands cards back
      // mid-broadcast and charges the player, and both have to be visible right
      // away rather than as a surprise on the round-over board.
      discardMessage.minimumMeld = minimumMeld;
    }

    const pozzettoResult = this._autoTakeDeadIfNeeded(room, playerId, true);
    if (pozzettoResult?.takenCount) {
      discardMessage.pozzettoTaken = pozzettoResult.takenCount;
      // Obligations tied to the emptied hand are moot — clear the single-pile-take
      // restriction so the refilled hand starts clean next turn.
      room.drawnCardThisTurnRestriction = new Set();
      room.mustMeldCard = null;
    }

    // Check round end (batida) after discard. A takeable POT/well already
    // returned above with the turn kept, so an empty hand here is a real close.
    const handNow = room.playerHands.get(playerId) || [];
    if (handNow.length === 0) {
      const roundEnded = this._finalizeRound(room, playerId);
      return {
        success: true,
        broadcast: discardMessage,
        roundEnded,
      };
    }

    // EXHAUSTION END (product rule): the stock is dead and no pozzetto is left,
    // so this discard was the last legal act on the table. The round closes right
    // here — the players after this one get NO further turn — and every remaining
    // hand is charged to its owner. Checked AFTER the empty-hand batida above, so
    // a genuine go-out still scores as a go-out.
    // NOT when this very discard collected a pot: the well was still on the table
    // when the player threw, and they are now holding the eleven cards it gave
    // them. Ending here would take that hand away the instant they earned it and
    // charge it back as a hand penalty. The stock only counts as spent once a
    // discard passes with nothing left to hand anyone.
    if (!pozzettoResult?.takenCount && this._stockIsDead(room)) {
      return {
        success: true,
        broadcast: discardMessage,
        roundEnded: this._finalizeRoundNoBatida(room),
      };
    }

    // Advance turn after discard
    room.nextTurn();
    const nextPlayer = room.getPlayerByIndex(room.currentTurn);
    if (nextPlayer) {
      this._startTurnForPlayer(room, nextPlayer.playerId);
    }

    const turnMessage = {
      type: 'turn_changed',
      newPlayerIndex: room.currentTurn,
      previousPlayerIndex: previousTurn,
      timestamp: new Date().toISOString(),
    };

    player.markActive();

    return {
      success: true,
      broadcast: discardMessage,
      turnChanged: turnMessage,
    };
  }

  /**
   * QANOON rule 2: a seat that took the discard pile this turn must lay at least
   * one of the taken cards before it discards; a discard that ends the turn with
   * every taken card still in hand (the one being thrown aside) charges the seat
   * QANOON_PILE_CHARGE through the turn-penalty ledger — the same ledger the
   * round score, the voided-round total and the HUD already read, so no scoring
   * path needs to know Qanoon exists. The discard itself stays legal: the rule
   * is a penalty, not a block. Runs on every discard path (manual and the turn
   * timeout's auto-discard both go through handleDiscard).
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Object} discarded - the card that just left the hand
   * @returns {{value:number, reason:string, playerIndex:number}|null}
   */
  static _applyQanoonPileCharge(room, playerId, discarded) {
    const take = room.qanoonPileTake;
    room.qanoonPileTake = null;
    if (typeof room.isQanoon !== 'function' || !room.isQanoon()) return null;
    if (!take || take.playerId !== playerId || !Array.isArray(take.cardIds) || take.cardIds.length === 0) {
      return null;
    }
    const discardedId = this._cardId(discarded);
    const inHand = new Set(
      (room.playerHands.get(playerId) || []).map((c) => String(this._cardId(c)))
    );
    const melded = take.cardIds.some(
      (id) => String(id) !== String(discardedId) && !inHand.has(String(id))
    );
    if (melded) return null;

    const charge = this.QANOON_PILE_CHARGE;
    room.teamTurnPenalty.set(playerId, (room.teamTurnPenalty.get(playerId) || 0) + charge);
    const player = room.getPlayer(playerId);
    logger.info(
      `[QANOON] ${playerId} discarded without melding a card from the pile taken this turn — charged ${charge}`
    );
    return {
      value: -charge,
      reason: 'pile_not_melded',
      playerIndex: player ? player.playerIndex : null,
    };
  }

  /**
   * Handle player going down (playing initial melds)
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Array} melds
   * @returns {Object}
   */
  static handleGoingDown(room, playerId, melds) {
    const validation = GameValidator.validateGoingDown(room, playerId, melds);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const player = room.getPlayer(playerId);
    const ruleset = room.ruleset || 'classic';

    // R2: capture rollback state before mutating so an illegal meld-out can revert.
    const _rb = this._snapshotForRollback(room, playerId);

    // Persist each meld: remove its cards from the hand and store it authoritatively.
    let hand = room.playerHands.get(playerId) || [];
    const playerMelds = room.playerMelds.get(playerId) || [];
    const playerMeldOrders = room.playerMeldOrders.get(playerId) || [];
    const resolvedMelds = [];
    for (const meld of melds) {
      const taken = this._takeCardsFromHand(hand, meld);
      if (!taken) {
        return { success: false, error: 'One or more cards are not in your hand' };
      }
      hand = taken.remaining;
      const resolvedMeld = taken.cards;
      playerMelds.push(resolvedMeld);
      playerMeldOrders.push(room.nextMeldOrder++);
      const newIndex = playerMelds.length - 1;
      this._latchMeldGrade(room, playerId, newIndex, resolvedMeld, ruleset);
      // Canonical ordering (#2) per laid meld.
      const orderedMeld = GameValidator.orderMeldCards(resolvedMeld, ruleset);
      playerMelds[newIndex] = orderedMeld;
      resolvedMelds.push(orderedMeld);
      this._trackTurnMeldPoints(room, playerId, resolvedMeld);
    }
    room.playerHands.set(playerId, hand);
    room.playerMelds.set(playerId, playerMelds);
    room.playerMeldOrders.set(playerId, playerMeldOrders);
    // A seat with no melds yet started from a fresh `[]` that was not in
    // room.playerMelds while the loop ran, so the per-meld recompute above saw
    // an empty table. Now that the melds are stored, price them (buraco bonus).
    this._recomputeTurnMeldPoints(room, playerId);

    // Going down lays multiple melds at once; undo of the batch is not supported.
    // RULE CHANGE (2026-09-21, owner): going down pays off nothing either — the
    // per-turn restriction and the anti ping-pong lock both survive it (see
    // handlePlayMeld).
    room.meldedThisTurn = true;
    room.lastMeldSnapshot = null;

    // Clear mustMeldCard if any laid meld includes it.
    if (room.mustMeldCard &&
        resolvedMelds.some((m) => m.some((c) => this._sameCard(c, room.mustMeldCard) || (c.suit === room.mustMeldCard.suit && c.rank === room.mustMeldCard.rank)))) {
      room.mustMeldCard = null;
    }

    const pozzettoResult = this._autoTakeDeadIfNeeded(room, playerId, false);

    // #5 brazilia badge per laid meld. The freshly laid melds are the last
    // resolvedMelds.length entries of playerMelds; map each to its flags by index.
    const startIndex = playerMelds.length - resolvedMelds.length;
    const meldFlags = resolvedMelds.map((meld, i) =>
      this._meldFlags(room, playerId, meld, startIndex + i)
    );
    const message = {
      type: 'went_down',
      playerIndex: player.playerIndex,
      melds: resolvedMelds,
      // Parallel array (aligned to `melds`) of { isBuraco, clean } so the client
      // can badge each laid meld; reconnect uses toJSON.melds instead.
      meldFlags,
      timestamp: new Date().toISOString(),
    };
    if (pozzettoResult?.takenCount) {
      message.pozzettoTaken = pozzettoResult.takenCount;
    }

    const instantEnd = this._checkInstantEnd(room, playerId);

    player.markActive();

    if (instantEnd?.minimumMeldBlocked) {
      // The close was refused by the minimum-meld bar and every card laid this
      // turn went back to the hand. Ride the verdict out on this broadcast the
      // way handleDiscard does, so the client knows why the table emptied.
      message.minimumMeld = instantEnd.minimumMeld;
      return { success: true, broadcast: message };
    }

    if (instantEnd) {
      return { success: true, broadcast: message, roundEnded: instantEnd };
    }

    // R2 close-requirement guard: the only legal meld-outs (pro-direct /
    // brazilia-of-2s) already returned via _checkInstantEnd above, and a takeable
    // pozzetto has refilled the hand via _autoTakeDeadIfNeeded. A hand left EMPTY
    // here is an illegal close (classic / pro-indirect require a final discard):
    // roll back and reject so the turn keeps a discardable card.
    const illegalOut = this._rejectIllegalMeldOut(room, playerId, _rb);
    if (illegalOut) {
      return illegalOut;
    }

    return { success: true, broadcast: message };
  }

  /**
   * Handle adding card to existing meld
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Object} card
   * @param {number} targetPlayerIndex
   * @param {number} targetMeldIndex
   * @returns {Object}
   */
  static handleAddToMeld(room, playerId, card, targetPlayerIndex, targetMeldIndex) {
    const cardsToAdd = Array.isArray(card) ? card : [card];
    const validation = GameValidator.validateAddCardsToMeld(room, playerId, cardsToAdd, targetPlayerIndex, targetMeldIndex);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const player = room.getPlayer(playerId);

    // R2: capture rollback state (incl. the target team meld) before mutating.
    const _rbTarget = room.getPlayerByIndex(targetPlayerIndex);
    const _rb = this._snapshotForRollback(room, playerId, _rbTarget ? _rbTarget.playerId : null);

    // Resolve and remove cards from the acting player's hand atomically.
    const playerHand = room.playerHands.get(playerId) || [];
    const taken = this._takeCardsFromHand(playerHand, cardsToAdd);
    if (!taken) {
      return { success: false, error: 'One or more cards were not found in hand' };
    }
    const resolvedCards = taken.cards;
    room.playerHands.set(playerId, taken.remaining);

    // Add to target meld
    const targetPlayer = room.getPlayerByIndex(targetPlayerIndex);
    if (!targetPlayer) {
      return { success: false, error: 'Target player not found' };
    }
    const melds = room.playerMelds.get(targetPlayer.playerId) || [];
    if (!melds[targetMeldIndex]) {
      return { success: false, error: 'Target meld not found' };
    }
    // The grade latch this meld carried BEFORE the add. An UNDO puts it back
    // (lastMeldSnapshot.savedLatch) and an end-of-turn confiscation restores
    // the pre-turn one (_rememberTurnLatch -> _returnTurnMeldsToHand). Without
    // both, a wild added and then taken back left the meld branded 'semi' /
    // 'dirty' with no wild on the table — and since the bar now reads the
    // bonus, that stale brand under-priced the side's next natural card by 100
    // for the bar AND the scoreboard.
    const savedLatch = this._latchedGrade(
      room.meldDirtyFlags.get(targetPlayer.playerId),
      targetMeldIndex
    );
    this._rememberTurnLatch(room, targetPlayer.playerId, targetMeldIndex, savedLatch);
    melds[targetMeldIndex].push(...resolvedCards);

    const ruleset = room.ruleset || 'classic';
    this._latchMeldGrade(
      room,
      targetPlayer.playerId,
      targetMeldIndex,
      melds[targetMeldIndex],
      ruleset
    );

    // Canonical ordering (#2): re-order the extended meld so a wild-2 sits in its
    // gap after the new cards are folded in.
    melds[targetMeldIndex] = GameValidator.orderMeldCards(melds[targetMeldIndex], ruleset);
    room.playerMelds.set(targetPlayer.playerId, melds);

    this._trackTurnMeldPoints(room, playerId, resolvedCards);

    // Mark meld as happened this turn and capture undo snapshot
    const wasMeldedBefore = room.meldedThisTurn || false;
    const savedRestriction = new Set(room.drawnCardThisTurnRestriction);
    const savedDiscardLock = room.discardLocks.get(playerId) || null;
    // RULE CHANGE (2026-09-21, owner): an add-to-meld pays off nothing — the
    // per-turn restriction and the anti ping-pong lock both survive it (see
    // handlePlayMeld). The snapshot still round-trips them for UNDO.
    room.meldedThisTurn = true;
    const prevMust = (room.mustMeldCard && resolvedCards.some((c) => this._sameCard(c, room.mustMeldCard) || (c.suit === room.mustMeldCard.suit && c.rank === room.mustMeldCard.rank)))
      ? { ...room.mustMeldCard } : null;
    if (prevMust) room.mustMeldCard = null;
    room.lastMeldSnapshot = {
      playerId,
      wasNewMeld: false,
      meldIndex: targetMeldIndex,
      targetPlayerId: targetPlayer.playerId,
      cards: [...resolvedCards],
      restoredMustMeldCard: prevMust,
      savedRestriction,
      savedDiscardLock,
      wasMeldedBefore,
      savedLatch,
    };

    // Auto-take dead pile if acting player emptied hand
    const pozzettoResult = this._autoTakeDeadIfNeeded(room, playerId, false);

    const flags = this._meldFlags(room, targetPlayer.playerId, melds[targetMeldIndex], targetMeldIndex);
    const message = {
      type: 'added_to_meld',
      playerIndex: player.playerIndex,
      card: resolvedCards[0],
      cards: resolvedCards,
      // Full target meld in canonical #2 order so the client can re-render the
      // whole run (the wild may have shifted into a new gap).
      meldCards: melds[targetMeldIndex],
      targetPlayerIndex: targetPlayerIndex,
      targetMeldIndex: targetMeldIndex,
      // #5 brazilia badge for the resulting (extended) meld.
      isBuraco: flags.isBuraco,
      clean: flags.clean,
      grade: flags.grade,
      timestamp: new Date().toISOString(),
    };

    // Emptying the hand by adding to a meld auto-takes the well: surface it so
    // the socket layer knows to re-arm the turn timer (the same player keeps the
    // turn) and the client can badge the pickup — parity with meld/going-down.
    if (pozzettoResult?.takenCount) {
      message.pozzettoTaken = pozzettoResult.takenCount;
    }

    const instantEnd = this._checkInstantEnd(room, playerId);

    player.markActive();

    if (instantEnd?.minimumMeldBlocked) {
      // The close was refused by the minimum-meld bar and every card laid this
      // turn went back to the hand. Ride the verdict out on this broadcast the
      // way handleDiscard does, so the client knows why the table emptied.
      message.minimumMeld = instantEnd.minimumMeld;
      return { success: true, broadcast: message };
    }

    if (instantEnd) {
      return { success: true, broadcast: message, roundEnded: instantEnd };
    }

    // R2 close-requirement guard: the only legal meld-outs (pro-direct /
    // brazilia-of-2s) already returned via _checkInstantEnd above, and a takeable
    // pozzetto has refilled the hand via _autoTakeDeadIfNeeded. A hand left EMPTY
    // here is an illegal close (classic / pro-indirect require a final discard):
    // roll back and reject so the turn keeps a discardable card.
    const illegalOut = this._rejectIllegalMeldOut(room, playerId, _rb);
    if (illegalOut) {
      return illegalOut;
    }

    return { success: true, broadcast: message };
  }

  /**
   * Handle picking up discard pile
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Array} pickedCards
   * @returns {Object}
   */
  static handlePickUpPile(room, playerId, pickedCards) {
    const turnCheck = GameValidator.validateTurn(room, playerId);
    if (!turnCheck.isValid) {
      return { success: false, error: turnCheck.error };
    }

    // Picking up the pile counts as the draw for the turn: reject if already drawn,
    // otherwise a player could draw from the deck and then also take the pile.
    if (room.hasDrawnCard) {
      return { success: false, error: 'You have already drawn this turn' };
    }

    // THE SQUEEZE (PRO base rule, not an option — there is no toggle): when the
    // actor is down to a single card AND the discard pile holds exactly one card,
    // taking the pile is rejected and they must draw from the deck. Suspends
    // itself once no deck draw is possible; see _pileTakeBlockedBySqueeze.
    if (this._pileTakeBlockedBySqueeze(room, playerId)) {
      return { success: false, error: 'You must draw from the deck', reason: 'squeezedPileTake' };
    }

    const player = room.getPlayer(playerId);

    // Message for the player (with cards)
    const messageForPlayer = {
      type: 'pile_picked_up',
      playerIndex: player.playerIndex,
      cards: pickedCards,
      timestamp: new Date().toISOString(),
    };

    // Message for others (card count only)
    const messageForOthers = {
      type: 'pile_picked_up',
      playerIndex: player.playerIndex,
      cardCount: pickedCards.length,
      timestamp: new Date().toISOString(),
    };

    player.markActive();

    return {
      success: true,
      toPlayer: messageForPlayer,
      toOthers: messageForOthers,
    };
  }

  /**
   * Undo the last meld played this turn.
   * All meld cards are returned to the player's hand.
   * Only available before the player discards.
   * @param {GameRoom} room
   * @param {string} playerId
   * @returns {Object}
   */
  static handleUndoMeld(room, playerId) {
    const turnCheck = GameValidator.validateTurn(room, playerId);
    if (!turnCheck.isValid) {
      return { success: false, error: turnCheck.error };
    }

    const snap = room.lastMeldSnapshot;
    if (!snap || snap.playerId !== playerId) {
      return { success: false, error: 'Nothing to undo' };
    }

    if (!room.hasDrawnCard) {
      return { success: false, error: 'Nothing to undo' };
    }

    const player = room.getPlayer(playerId);

    if (snap.wasNewMeld) {
      // Remove the new meld entirely (and keep the dirty-flag indices honest).
      this._dropMeldAt(room, playerId, snap.meldIndex);
    } else {
      // Remove cards from existing meld
      const targetPlayerId = snap.targetPlayerId || playerId;
      const melds = room.playerMelds.get(targetPlayerId) || [];
      const meld = melds[snap.meldIndex];
      if (meld) {
        for (const c of snap.cards) {
          const idx = meld.findIndex((m) => this._sameCard(m, c));
          if (idx >= 0) meld.splice(idx, 1);
        }
        room.playerMelds.set(targetPlayerId, melds);
        // If the meld is now empty, remove it — through the same helper, so the
        // orders array and the dirty flags follow. Otherwise the meld survives
        // with the added cards gone, and its latch goes back to what it was
        // before them: a latch records how a buraco was BUILT, and an undone
        // add was never built.
        if (meld.length === 0) this._dropMeldAt(room, targetPlayerId, snap.meldIndex);
        else if ('savedLatch' in snap) {
          this._setLatch(room, targetPlayerId, snap.meldIndex, snap.savedLatch);
        }
      } else {
        room.playerMelds.set(targetPlayerId, melds);
      }
    }

    // Return cards to hand, and take the turn's credit back with them: the
    // points leave teamMeldPointsThisTurn and the cards leave turnMeldedCards.
    // Without this the undo LAUNDERS the minimum-meld bar (the audit still sees
    // points for cards no longer on the table) and a later confiscation deals
    // the same card instances into the hand a second time.
    this._untrackTurnMeldPoints(room, playerId, snap.cards);
    const hand = room.playerHands.get(playerId) || [];
    hand.push(...snap.cards);
    room.playerHands.set(playerId, hand);

    // Restore state
    if (snap.restoredMustMeldCard) room.mustMeldCard = snap.restoredMustMeldCard;
    room.meldedThisTurn = snap.wasMeldedBefore || false;
    room.drawnCardThisTurnRestriction = new Set(snap.savedRestriction);
    // A meld no longer touches the anti ping-pong lock (2026-09-21), so this
    // restore is a no-op in practice; kept so an undo always lands on exactly
    // the state the meld was made from.
    if (snap.savedDiscardLock) room.discardLocks.set(playerId, snap.savedDiscardLock);
    else room.discardLocks.delete(playerId);
    room.lastMeldSnapshot = null;

    player.markActive();

    const message = {
      type: 'meld_undone',
      playerIndex: player.playerIndex,
      returnedCards: snap.cards,
      timestamp: new Date().toISOString(),
    };

    return { success: true, broadcast: message };
  }

  /**
   * Handle game end
   * @param {GameRoom} room
   * @param {string} winnerId
   * @returns {Object}
   */
  static handleGameEnd(room, winnerId) {
    room.endGame(winnerId);

    const message = {
      type: 'game_ended',
      winnerId: winnerId,
      finalScores: {}, // TODO: Calculate scores
      timestamp: new Date().toISOString(),
    };

    return { success: true, broadcast: message };
  }

  /**
   * Handle player disconnection
   * @param {GameRoom} room
   * @param {string} playerId
   * @returns {Object}
   */
  static handleDisconnect(room, playerId) {
    const player = room.getPlayer(playerId);
    if (!player) {
      return { success: false, error: 'Player not found' };
    }

    player.disconnect();

    const message = {
      type: 'player_disconnected',
      playerId: player.playerId,
      playerIndex: player.playerIndex,
      playerName: player.playerName,
      timestamp: new Date().toISOString(),
    };

    return { success: true, broadcast: message };
  }

  /**
   * Handle player reconnection
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {string} socketId
   * @returns {Object}
   */
  static handleReconnect(room, playerId, socketId) {
    const player = room.getPlayer(playerId);
    if (!player) {
      return { success: false, error: 'Player not found' };
    }

    player.socketId = socketId;
    player.markActive();

    const message = {
      type: 'player_reconnected',
      playerIndex: player.playerIndex,
      playerName: player.playerName,
      timestamp: new Date().toISOString(),
    };

    return {
      success: true,
      broadcast: message,
      gameState: room.toJSON(), // Send full game state to reconnecting player
    };
  }

  // --- Internal helpers ---
  static _removeCardsFromHand(hand, cardsToRemove) {
    return this._takeCardsFromHand(hand, cardsToRemove)?.remaining || [...hand];
  }

  static _takeCardsFromHand(hand, cardsToTake) {
    const remaining = [...(hand || [])];
    const cards = [];
    for (const card of (cardsToTake || [])) {
      const idx = remaining.findIndex((candidate) => this._sameCard(candidate, card));
      if (idx < 0) return null;
      cards.push(remaining[idx]);
      remaining.splice(idx, 1);
    }
    return { cards, remaining };
  }

  static _cardId(card) {
    if (!card) return null;
    return card.cardId ?? card.instanceId ?? card.id ?? null;
  }

  static _sameCard(a, b) {
    const aId = this._cardId(a);
    const bId = this._cardId(b);
    if (aId !== null && aId !== undefined && bId !== null && bId !== undefined) {
      return String(aId) === String(bId);
    }
    return a?.suit === b?.suit && a?.rank === b?.rank;
  }

  /**
   * Take a well OUT OF PLAY without changing the shape of `room.deadPiles`.
   *
   * The array index IS the well's identity on the wire: `deadPileCounts` is
   * `deadPiles.map(p => p.length)`, and the clients draw index 0 as the vertical
   * pile and index 1 as the horizontal one, then address take animations by that
   * same index. Splicing the taken pile out renumbered the survivor from 1 to 0
   * mid-round, which had two visible consequences on every OTHER player's table:
   *
   *   1. the surviving well flipped from horizontal to vertical for no reason;
   *   2. the take animation, which captured the index BEFORE the flight and
   *      applied it AFTER, then emptied the renumbered SURVIVOR — so both wells
   *      vanished from the opponent's board until the next state update
   *      (i.e. until the taker did something else) put one back.
   *
   * Emptying in place keeps the index stable, so a count of 0 means "this well
   * is gone" and nothing downstream has to guess. Every remaining reader already
   * asks `p.length > 0` rather than trusting the array's length.
   * @param {GameRoom} room
   * @param {Array} pile the exact pile instance that just left the table
   */
  static _emptyDeadPileSlot(room, pile) {
    const piles = room.deadPiles;
    if (!Array.isArray(piles) || !Array.isArray(pile)) return;
    const index = piles.indexOf(pile);
    if (index < 0) return;
    piles[index] = [];
  }

  /**
   * True while at least one well still holds cards. The replacement for
   * `deadPiles.length === 0` now that emptied slots stay in the array.
   * @param {GameRoom} room
   * @returns {boolean}
   */
  static _anyDeadPileRemains(room) {
    return (room.deadPiles || []).some((p) => Array.isArray(p) && p.length > 0);
  }

  static _autoTakeDeadIfNeeded(room, playerId, emptiedByDiscard) {
    const hand = room.playerHands.get(playerId) || [];
    if (hand.length > 0) return null;
    if (!room.deadPiles || room.deadPiles.length === 0) return null;

    if (!this._canTakeWellAfterEmptyHand(room, playerId, emptiedByDiscard)) return null;

    const nextPile = room.deadPiles.find((pile) => pile.length > 0);
    if (!nextPile) return null;

    const takenCount = nextPile.length;
    hand.push(...nextPile);
    room.playerHands.set(playerId, hand);
    this._markTeamPozzettoTaken(room, playerId, emptiedByDiscard ? 'indirect' : 'direct');
    // EMPTY THE SLOT, do not drop it. See _emptyDeadPileSlot.
    this._emptyDeadPileSlot(room, nextPile);

    return { takenCount };
  }

  // R2 rollback support. Capture every field a meld / go-down / add-to-meld
  // handler mutates so an ILLEGAL hand-emptying action (a meld-out that is not a
  // legal close) can be reverted wholesale, leaving the player a discardable
  // card. `targetPlayerId` is the partner whose meld an add-to-meld extends.
  static _snapshotForRollback(room, playerId, targetPlayerId = null) {
    const ids = [...new Set([playerId, targetPlayerId].filter(Boolean))];
    const melds = {};
    const meldOrders = {};
    const dirty = {};
    for (const id of ids) {
      melds[id] = (room.playerMelds.get(id) || []).map((m) => [...m]);
      meldOrders[id] = [...(room.playerMeldOrders.get(id) || [])];
      dirty[id] = new Map(this._gradeFlags(room.meldDirtyFlags.get(id)));
    }
    const teamKey = this._teamKeyForPlayer(room, playerId);
    return {
      ids,
      hand: [...(room.playerHands.get(playerId) || [])],
      melds,
      meldOrders,
      nextMeldOrder: room.nextMeldOrder,
      dirty,
      restriction: new Set(room.drawnCardThisTurnRestriction),
      meldedThisTurn: room.meldedThisTurn,
      mustMeldCard: room.mustMeldCard ? { ...room.mustMeldCard } : room.mustMeldCard,
      // Captured so a rolled-back meld (illegal meld-out) does not leave the
      // player silently unlocked while their client still shows the lock.
      discardLock: room.discardLocks.get(playerId) || null,
      teamKey,
      teamMeldPoints: room.teamMeldPointsThisTurn.get(teamKey),
      // The confiscation list goes back with the points. Left standing, the
      // rolled-back cards stayed on it while ALSO back in the hand, so a later
      // confiscation dealt them into the hand a second time — and now that the
      // points are rebuilt from this list, they would be counted again too.
      turnMelded: [...(room.turnMeldedCards?.get(playerId) || [])],
      lastMeldSnapshot: room.lastMeldSnapshot,
    };
  }

  static _restoreRollback(room, playerId, snap) {
    room.playerHands.set(playerId, snap.hand);
    for (const id of snap.ids) {
      room.playerMelds.set(id, snap.melds[id]);
      room.playerMeldOrders.set(id, snap.meldOrders[id]);
      room.meldDirtyFlags.set(id, snap.dirty[id]);
    }
    room.nextMeldOrder = snap.nextMeldOrder;
    room.drawnCardThisTurnRestriction = snap.restriction;
    room.meldedThisTurn = snap.meldedThisTurn;
    room.mustMeldCard = snap.mustMeldCard;
    if (snap.discardLock) room.discardLocks.set(playerId, snap.discardLock);
    else room.discardLocks.delete(playerId);
    if (snap.teamMeldPoints === undefined) room.teamMeldPointsThisTurn.delete(snap.teamKey);
    else room.teamMeldPointsThisTurn.set(snap.teamKey, snap.teamMeldPoints);
    if (snap.turnMelded) {
      if (!room.turnMeldedCards) room.turnMeldedCards = new Map();
      room.turnMeldedCards.set(playerId, [...snap.turnMelded]);
    }
    room.lastMeldSnapshot = snap.lastMeldSnapshot;
  }

  // Whether the player currently holds AT LEAST ONE card they could legally
  // discard right now (the mandatory end-of-turn action). Empty hand → false.
  // A lone wild in classic, or a single card with no Brazilia/well, makes every
  // discard fail validateDiscard's willBeEmpty (close) branch → false. Used by
  // the meld-out guard to detect a turn that has wedged with no way to end.
  static _handHasLegalDiscard(room, playerId) {
    const hand = room.playerHands.get(playerId) || [];
    return hand.some((c) => GameValidator.validateDiscard(room, playerId, c).isValid);
  }

  /**
   * Whether the player can still end their turn by MELDING the rest of the hand
   * away — the other legal ending, and in DIRECT well mode the only one there is.
   *
   * Scoped to a ONE-card hand on purpose. That is the position the guard below
   * actually mis-read, and it is decidable without searching: the card either
   * extends one of the side's melds or it does not. A multi-card meld-out needs a
   * partition search, and a hand of two or more always keeps a legal discard in
   * every ruleset anyway (the close branch is gated on handSize === 1), so it can
   * never reach the guard.
   *
   * THE BUG THIS FIXES: DIRECT forbids the closing discard, so after melding
   * three of four cards the player holds one card with no legal discard — and the
   * guard rolled the meld back. In direct that made the two-step close
   * ("meld the run, then lay the last card on a canasta") impossible, which is
   * the ordinary way a direct hand ends: the whole hand had to go down in a
   * SINGLE action. The Flutter client allows the shed precisely because it checks
   * this, so the server rejecting it is also a client-allows/server-rejects
   * desync — the board applied the meld and the server snapped it back.
   */
  static _handHasLegalMeldOut(room, playerId) {
    const hand = room.playerHands.get(playerId) || [];
    if (hand.length !== 1) return false;
    const card = hand[0];
    const actor = room.getPlayer(playerId);
    if (!actor) return false;

    for (const teammate of this._teamPlayers(room, playerId)) {
      const melds = room.playerMelds.get(teammate.playerId) || [];
      for (let i = 0; i < melds.length; i += 1) {
        const check = GameValidator.validateAddToMeld(
          room,
          playerId,
          card,
          teammate.playerIndex,
          i
        );
        if (!check.isValid) continue;
        // The add empties the hand, which is legal only when it pulls in a well
        // (the turn then continues on the refilled hand) or when it IS a legal
        // close. The brazilia this very add completes counts toward the close —
        // laying the seventh card of a run as your last card is exactly how a
        // direct hand finishes.
        // The brazilia this add completes counts for the WELL TEST too, not just
        // the close. Asking _canTakeWellAfterEmptyHand about the table as it
        // stands made this guard STRICTER THAN THE EXECUTOR it guards: the same
        // add, actually performed, reaches _autoTakeDeadIfNeeded with the meld
        // already seven long, so the well IS taken and the hand refills to 11.
        // The guard said "no legal meld-out" and _rejectIllegalMeldOut rolled the
        // whole shed back — the reported "cards jump back" — for the single most
        // natural professional line: lay the seventh card last and collect the
        // well with it. Hits BOTH well modes.
        const braziliaAfter =
          this._teamHasAnyBrazilia(room, playerId) || melds[i].length + 1 >= 7;
        if (this._canTakeWellAfterEmptyHand(room, playerId, false, braziliaAfter)) return true;
        const wellStillOwed =
          GameValidator._pozzettoAvailable(room) &&
          !this._teamHasTakenPozzetto(room, playerId);
        if (wellStillOwed) continue;
        if (braziliaAfter) return true;
      }
    }
    return false;
  }

  // R2 close-requirement guard shared by the meld handlers (play-meld, going-down,
  // add-to-meld). A turn must have SOME legal ending left after the action — and
  // the legal meld-out closes already returned via _checkInstantEnd before this,
  // while a takeable pozzetto has refilled the hand via _autoTakeDeadIfNeeded.
  // Two ways a turn is left with no ending at all, BOTH rolled back here so play
  // never freezes:
  //   • hand EMPTY — an illegal close (classic / indirect need a final discard);
  //   • hand NON-EMPTY with neither a legal DISCARD nor a legal MELD-OUT left —
  //     the shed stranded the player on a lone wild (classic never closes on a
  //     joker/2) or a single card with no Brazilia / an untaken well. This is the
  //     reported "add-to-meld leaves 1 card I can't discard → stuck" freeze.
  //
  // The meld-out half of that test is not optional: a discard is not the only way
  // to end a turn, and in DIRECT well mode it is not a way at all. Testing only
  // for a discardable card made the ordinary two-step direct close ("meld the
  // run, then lay the last card on a canasta") impossible — see
  // _handHasLegalMeldOut.
  static _rejectIllegalMeldOut(room, playerId, snap) {
    if (this._handHasLegalDiscard(room, playerId)) return null;
    if (this._handHasLegalMeldOut(room, playerId)) return null;
    const empty = (room.playerHands.get(playerId) || []).length === 0;
    this._restoreRollback(room, playerId, snap);
    return {
      success: false,
      error: empty
        ? 'You cannot go out by melding your last card — keep a card to discard.'
        : 'That meld would leave you no card you can legally discard — keep a discardable card.',
      reason: 'mustKeepDiscard',
    };
  }

  static _finalizeRound(room, winnerId) {
    const takeMode = this._teamPozzettoTakeMode(room, winnerId);
    const batidaType = takeMode || (this._teamHasTakenPozzetto(room, winnerId) ? 'indirect' : 'direct');
    return this._finalizeWith(room, winnerId, batidaType, winnerId);
  }

  // Stock exhausted with nobody going out: end the round and score by current
  // standings — no go-out bonus — and report the highest-scoring team's lead
  // player as winner (display only). Mirrors the client, which ends the round
  // when deck + discard are exhausted.
  static _finalizeRoundNoBatida(room) {
    const { winningTeam, teamScores } = this._computeScores(room, null, null);
    const lead = winningTeam != null ? teamScores[winningTeam]?.players?.[0] : null;
    const winnerId = lead ? lead.playerId : null;
    return this._finalizeWith(room, winnerId, null, null);
  }

  // Shared finalize: marks the room finished, computes + stores scores, and
  // accumulates cumulative totals. `scoringWinnerId` decides who (if anyone)
  // receives the go-out bonus — pass null for a no-batida (deck-exhaustion) end
  // so an anomalous/forced end never rewards a go-out that didn't happen.
  static _finalizeWith(room, winnerId, batidaType, scoringWinnerId) {
    room.endGame(winnerId);
    const { playerScores, teamScores, winningTeam } = this._computeScores(room, scoringWinnerId, batidaType);
    room.lastRoundScores = playerScores;
    room.lastTeamScores = teamScores;
    room.lastBatidaType = batidaType;
    room.status = GameRoomStatus.FINISHED;

    Object.values(playerScores).forEach((score) => {
      const prev = room.cumulativeScores.get(score.playerId) || 0;
      room.cumulativeScores.set(score.playerId, prev + (score.total || 0));
    });
    if (!room.cumulativeTeamScores) room.cumulativeTeamScores = new Map();
    Object.entries(teamScores).forEach(([teamId, score]) => {
      const prev = room.cumulativeTeamScores.get(teamId) || 0;
      room.cumulativeTeamScores.set(teamId, prev + (score.total || 0));
    });

    // THE VOID COUNTER, banked with the round it belongs to. Counted AFTER the
    // scores above, which already used `count + 1` as this round's ordinal --
    // so the round that triggers the Nth void is itself charged N x -200 and
    // the NEXT one is charged (N+1). Mirrors the client's
    // GameController.teamVoidedRoundCount.
    if (!room.voidedRoundCounts) room.voidedRoundCounts = new Map();
    Object.entries(teamScores).forEach(([teamId, score]) => {
      const voided = Array.isArray(score.flatPenalty?.reasons)
        ? score.flatPenalty.reasons.length >= 2
        : false;
      if (!voided) return;
      room.voidedRoundCounts.set(teamId, (room.voidedRoundCounts.get(teamId) || 0) + 1);
    });

    // #11 target score: when a target is set and a side's CUMULATIVE total has
    // reached it, the whole MATCH is over — flag it (the leading-by-cumulative
    // team wins) so the socket emits a terminal GAME_ENDED instead of seeding a
    // new round. Non-destructive: the per-round winner fields are preserved; the
    // match outcome is carried in the extra `matchEnded`/`matchWinner*` fields.
    const matchEnd = this._evaluateMatchEnd(room);

    const winner = winnerId ? room.getPlayer(winnerId) : null;
    const roundWinnerIndex = winner?.playerIndex;
    // Kept on the ROOM, not just in the payload: startGame() clears
    // lastRoundEndPayload, and the next round's starter is decided after that.
    room.lastRoundWinnerIndex = roundWinnerIndex ?? null;
    const result = {
      type: 'round_ended',
      winnerId,
      winnerIndex: roundWinnerIndex,
      batidaType,
      playerScores,
      teamScores,
      winningTeam,
      timestamp: new Date().toISOString(),
    };
    if (matchEnd) {
      result.matchEnded = true;
      result.matchWinnerTeam = matchEnd.teamId;
      result.matchWinnerIndex = matchEnd.winnerIndex;
      result.matchWinnerId = matchEnd.winnerId;
      result.targetScore = room.targetScore;
      result.cumulativeTeamScores = matchEnd.cumulativeTeamScores;
      // On a TERMINAL match the standard winner fields must point at the
      // cumulative leader, not the round-out (batida) player — a plain client
      // reads winnerId/winnerIndex and would otherwise show the wrong winner.
      // Preserve the per-round winner separately for clients that still want it.
      result.roundWinnerId = winnerId;
      result.roundWinnerIndex = roundWinnerIndex;
      result.winnerId = matchEnd.winnerId;
      result.winnerIndex = matchEnd.winnerIndex;
      result.winningTeam = matchEnd.teamId;
    } else if ((Number(room.targetScore) || 0) > 0) {
      // #11 multi-round: an INTERMEDIATE round of a target-score match must NOT
      // look terminal to the client (or the backend). Stamp matchEnded EXPLICIT
      // false plus the targetScore + running cumulativeTeamScores on EVERY
      // round end so the GAME_ENDED event carries them and the client can tell
      // "round over, dealing next" from "match over, payout". (Single-round
      // games — targetScore 0 — stay unchanged: no multi-round signal.)
      result.matchEnded = false;
      result.targetScore = Number(room.targetScore) || 0;
      result.cumulativeTeamScores = this._serializeCumulativeTeamScores(room);
      result.roundWinnerId = winnerId;
      result.roundWinnerIndex = roundWinnerIndex;
    }
    // Reveal every seat's remaining hand for the client's end-of-round "View
    // Desk" board. ANTI-CHEAT: this is the ONLY payload that ever carries other
    // players' actual cards — it rides the terminal round_ended / game_ended
    // frame, emitted after the round is scored and over, so no move can act on
    // it. In-play game_state_update stays counts-only (otherPlayersHandCounts),
    // and the reconnect replay of this payload is gated on room.hasEnded(), so
    // an intermediate round's hands are not resent while the next round plays.
    // Keyed by playerIndex to match the client's seat rendering; raw card
    // objects serialize via socket.io like every other card array on the wire.
    const finalHands = {};
    room.getPlayers().forEach((p) => {
      finalHands[p.playerIndex] = room.playerHands.get(p.playerId) || [];
    });
    result.finalHands = finalHands;

    // Persist the full payload so a client that missed the end event (brief
    // disconnect) can re-fetch it on reconnect (see handleGetGameState).
    room.lastRoundEndPayload = result;
    return result;
  }

  // Round-end safety net for meld actions: if a meld emptied the player's hand
  // and no dead pile refilled it, the player has gone out — finalize so the
  // round can never hang with an empty hand and no turn to play. A legitimate
  // batida (player has a brazilia) gets the go-out bonus; an anomalous empty hand
  // without a brazilia ends the round without rewarding it.
  static _finalizeIfHandEmptied(room, playerId) {
    const hand = room.playerHands.get(playerId) || [];
    if (hand.length > 0) return null;
    const melds = room.playerMelds.get(playerId) || [];
    const hasBrazilia = melds.some((m) => Array.isArray(m) && m.length >= 7);
    return hasBrazilia ? this._finalizeRound(room, playerId) : this._finalizeRoundNoBatida(room);
  }

  // Deck-exhaustion rule (mirrors the client GameController.drawFromDeck): when
  // the stock empties, promote an UNTAKEN pozzetto (dead pile / morto) into the
  // deck so play continues — but only while it hasn't been taken as a morto yet
  // (emptying your hand still takes it first; whichever happens first consumes
  // it). The discard pile is NOT reshuffled into the deck (that is a Canasta
  // house rule). Promotion is a STOCK refill, NOT a player taking the well: the
  // cards move into room.deck and NO team is credited, so a promoted pozzetto can
  // no longer be taken as a morto. When no untaken pozzetto remains the only way
  // to continue is to take the discard pile; if that pile is also empty, no move
  // is possible and the round ends with no batida. Returns { roundEnded } in that
  // terminal case, or null when the deck is usable (still had cards, was refilled
  // from a pozzetto, or the discard pile can still be taken).
  static _refillStockOrEndRound(room) {
    if (!room.deck) return null;
    if (room.deck.count > 0) return null;

    // Stock empty but an UNTAKEN pozzetto is still on the table: promote it into
    // the deck (shuffled) and play continues — matching the reference rules.
    // This is a STOCK REFILL, not a player taking the well: no team is credited,
    // so a promoted pozzetto can never afterwards be taken as a morto.
    const nextPile = (room.deadPiles || []).find(
      (p) => Array.isArray(p) && p.length > 0
    );
    if (nextPile) {
      const wellIndex = room.deadPiles.indexOf(nextPile);
      room.deck.cards.push(...nextPile);
      room.deck.shuffle();
      // EMPTY THE SLOT, do not drop it. See _emptyDeadPileSlot.
      this._emptyDeadPileSlot(room, nextPile);
      // Its own game event: the promoted well and the reshuffled stock land in
      // this event's zone diff instead of hiding inside the draw that follows.
      emitGameEvent(room, 'stock_promoted', { well: wellIndex, deck: room.deck.count });
      return null;
    }

    // Nothing left to promote AND the stock is empty -> the round is over.
    // PRODUCT RULE: the discard pile no longer keeps play alive. Previously the
    // round only ended once the pile was ALSO empty/untakeable, which left the
    // table limping on a takeable pile with a permanently dead stock.
    return { roundEnded: this._finalizeRoundNoBatida(room) };
  }

  /**
   * Single-card pile guard, shared by handlePickUpPile and the deck-out terminal
   * check so the two can never drift apart: a player holding exactly one card
   * cannot take a one-card discard pile — they must draw from the deck.
   *
   * A BASE rule in PROFESSIONAL: "if a player has only one card left, they
   * cannot take the discard pile when it contains only one card — they must draw
   * from the deck". It was once gated behind an optional toggle; the toggle is
   * gone and the rule stayed. Classic is untouched until the classic pass.
   * @param {GameRoom} room
   * @param {string} playerId
   * @returns {boolean}
   */
  static _pileTakeBlockedBySqueeze(room, playerId) {
    if ((room.ruleset || 'classic') !== 'professional') return false;
    // The rule's premise is "draw from the deck instead" — only enforceable while
    // a deck draw is actually possible (live stock, or a pozzetto that
    // _refillStockOrEndRound can still promote). Once the stock is permanently
    // dead, keeping the block would leave the actor with NO legal move at all
    // (audit §3.3/§3.13 deadlock: draw rejected AND pile take rejected), so the
    // guard is suspended and the last card becomes takeable.
    const deckDrawable =
      (room.deck?.count || 0) > 0 ||
      (room.deadPiles || []).some((p) => Array.isArray(p) && p.length > 0);
    if (!deckDrawable) return false;
    const hand = room.playerHands.get(playerId) || [];
    const pile = room.discardPile || [];
    return hand.length === 1 && pile.length === 1;
  }

  /**
   * Resolve an empty stock before a manual draw, using the same promotion rule
   * as timeout and bot draws. Taking the discard pile is a separate action and
   * still leaves an untaken pozzetto available to claim by emptying the hand.
   * @param {GameRoom} room
   * @param {string} playerId
   * @returns {Object|null}
   */
  static _deckOutTerminal(room, playerId) {
    if (!room.deck || room.deck.count > 0 || room.hasDrawnCard) return null;
    // The socket checks this before calling us too; retain the guard here so
    // any draw caller cannot consume a well on behalf of the wrong seat.
    if (!GameValidator.validateTurn(room, playerId).isValid) return null;
    return this._refillStockOrEndRound(room);
  }

  /**
   * True when the stock can never produce another card: the deck is empty AND no
   * untaken pozzetto is left to promote into it.
   *
   * READ-ONLY, unlike {@see _deckOutTerminal}, which calls
   * _refillStockOrEndRound and therefore PROMOTES a pozzetto as a side effect.
   * That promotion is correct on a DRAW ("I need a card from the stock") but not
   * on a pile take — wiring the draw-path helper into the pile take silently
   * consumed an untaken well the moment anyone took the discard pile.
   * @param {GameRoom} room
   * @returns {boolean}
   */
  static _stockIsDead(room) {
    if (!room.deck || room.deck.count > 0) return false;
    return !(room.deadPiles || []).some(
      (p) => Array.isArray(p) && p.length > 0
    );
  }

  /**
   * Terminal check for a NON-draw action: ends the round when the stock is
   * permanently dead, without promoting anything.
   * @param {GameRoom} room
   * @returns {Object|null}
   */
  static _deadStockTerminal(room) {
    if (!this._stockIsDead(room)) return null;
    return { roundEnded: this._finalizeRoundNoBatida(room) };
  }

  /**
   * @param {boolean} [braziliaAfter] overrides the "does this side hold a
   * brazilia" test for a caller validating an action that is ABOUT TO complete
   * one. Without it the predicate refuses the well to the very meld that earns
   * it — see _handHasLegalMeldOut. Mirrors the Flutter
   * GameController._canTakeWellAfterEmptyHand's `hasBuracoAfter`.
   */
  static _canTakeWellAfterEmptyHand(room, playerId, emptiedByDiscard, braziliaAfter) {
    // Any well still HOLDING cards — not merely a slot in the array. Emptied
    // slots are kept (see _emptyDeadPileSlot), so `length === 0` stopped being
    // the same question as "is there a well left to take".
    if (!this._anyDeadPileRemains(room)) return false;
    const ruleset = room.ruleset || 'classic';
    // House rule (both rulesets): a team may take up to TWO pozzetti, grabbing the
    // 2nd whenever the hand clears again — by meld OR discard. Mirrors
    // GameValidator._canTakeWellAfterEmptyHand.
    if (this._teamDeadPileCount(room, playerId) >= 2) return false;

    // Well-mode rules govern EVERY ruleset, not just professional (the mode
    // still defaults to 'indirect', so a classic room keeps its old behaviour).
    //
    // DIRECT: the well is only ever taken on a meld-out — never by discarding the
    // last card.
    if (room.professionalWellMode === 'direct' && emptiedByDiscard) return false;

    // House rule: BOTH wells may be reached by a discard. No "first well only"
    // gate here — the 2-per-team cap above is the sole limit. Mirrors
    // GameValidator._canTakeWellAfterEmptyHand exactly; the two must agree or
    // the validator accepts a discard this handler then refuses to act on.

    // PROFESSIONAL only: a completed brazilia (clean OR dirty) is required before
    // a side may take a well. Classic deliberately keeps its free first-empty
    // take — see the "classic first-empty carve-out" regression tests — and is
    // out of scope until the classic rules pass.
    if (ruleset !== 'professional') return true;
    return braziliaAfter === undefined ? this._teamHasAnyBrazilia(room, playerId) : braziliaAfter;
  }

  static _checkInstantEnd(room, playerId) {
    // A brazilia of 2s is worth 2000 and nothing more: it does NOT end the round
    // on the spot. It used to instant-win, which handed the round to whoever built
    // it even when the other side was comfortably ahead on total — the round now
    // plays out and the higher TOTAL decides it, like every other round.

    // A MELD-OUT closes the round in BOTH well modes. Direct lays every card down
    // at once by definition; indirect may now finish the same way (PRODUCT
    // DECISION — the reference instead requires a final discard to close in
    // indirect).
    //
    // Without this an indirect meld-out fell through to _rejectIllegalMeldOut,
    // which rolled the meld back and left the turn to be auto-discarded — the
    // reported "kartu balik lalu auto-discard kartu yang barusan di-meld".
    const hand = room.playerHands.get(playerId) || [];
    // TEAM-scoped, like every other brazilia question here: GameValidator's
    // closing discard, _canTakeWellAfterEmptyHand and the -200 noBrazilia
    // penalty all measure the SIDE, and the Flutter client's _canCloseWith does
    // too. This clause alone read the actor's own melds, and in 2v2 DIRECT — where
    // a meld-out is the only close there is — that made the round unfinishable
    // for a side whose brazilia happened to sit on the partner's half of the
    // table: the client called the close legal, the server rolled the meld back
    // with "You cannot go out by melding your last card".
    const hasBrazilia = this._teamHasAnyBrazilia(room, playerId);
    // "Take the well before going out" is conditional on one still BEING there,
    // exactly as GameValidator.validateDiscard states it. Requiring tookWell
    // unconditionally (the old direct-only rule) meant that once the opponents
    // had taken both wells, a side holding a brazilia could close by discarding
    // its last card but NOT by melding out — same position, two answers, and the
    // meld-out was rolled back mid-turn.
    const tookWell = this._teamHasTakenPozzetto(room, playerId);
    const wellStillOwed = GameValidator._pozzettoAvailable(room) && !tookWell;
    if (hand.length === 0 && hasBrazilia && !wellStillOwed) {
      // MINIMUM MELD is audited BEFORE the close, for exactly the reason the
      // discard path audits before the well hand-over: this IS the end of the
      // turn, and a close that skips the audit skips the rule outright. Until
      // now the bar was enforced ONLY from handleDiscard, so a side past 1000
      // could lay a 50-point run against a 75 bar, MELD OUT, and bank the round
      // with its short melds standing and the bar never escalated.
      //
      // The audit belongs INSIDE this branch and nowhere above it:
      // _checkInstantEnd runs after EVERY meld action, not just a closing one,
      // and a mid-turn audit would confiscate the first half of a legitimate
      // 30-then-45 turn that clears the bar on its total.
      const minimumMeld = this._applyMinimumMeldRule(room, playerId);
      if (minimumMeld && minimumMeld.satisfied === false) {
        // Every card laid this turn is back in the hand, so the hand is no
        // longer empty and there is no close. The turn simply continues — the
        // player still owes a discard, and by then the audit is spent for this
        // turn (turnMeldedCards is empty, so it returns null rather than
        // confiscating twice).
        return { minimumMeldBlocked: true, minimumMeld };
      }
      return this._finalizeRound(room, playerId);
    }

    return null;
  }

  /**
   * Record what a player laid down this turn: the CARDS themselves (per player,
   * so a turn that ends short can hand them back) and, derived from them, the
   * POINTS (per side, for the minimum-meld test). Runs in every ruleset — the
   * minimum applies to direct and indirect alike.
   *
   * Call it AFTER the cards are on the table: the points are rebuilt from the
   * melds as they stand (see _recomputeTurnMeldPoints), so a meld that is not
   * yet in room.playerMelds cannot earn its bonus.
   */
  static _trackTurnMeldPoints(room, playerId, cards) {
    this._recordTurnMeldCards(room, playerId, cards);
    this._recomputeTurnMeldPoints(room, playerId);
  }

  /** The confiscation list only — no points. See _trackTurnMeldPoints. */
  static _recordTurnMeldCards(room, playerId, cards) {
    if (!room.turnMeldedCards) room.turnMeldedCards = new Map();
    const laid = room.turnMeldedCards.get(playerId) || [];
    laid.push(...cards);
    room.turnMeldedCards.set(playerId, laid);
  }

  /**
   * Rebuild teamMeldPointsThisTurn — THE figure the minimum-meld bar is
   * measured against — from the table as it stands:
   *
   *     card points of everything laid this turn (turnMeldedCards)
   *   + every buraco bonus the side EARNED this turn
   *
   * The bonus was missing (reported 2026-09-05: "meld 2,3,4,5,6,7,8, kan dapet
   * 200 tuh, entah kenapa 200 ini ga masuk hitungan"). A seven-card clean run
   * is 35 card points and a 200 bonus; against a 75 bar the old card-only sum
   * read it as 35, confiscated it and raised the bar — for the strongest
   * going-down in the game. Any bonus counts: 200 clean, 100 semi/dirty, 2000
   * for a buraco of 2s. "Ga hanya bonus 200, bonus 100 juga terhitung."
   *
   * Rebuilt rather than accumulated because a bonus is a property of the MELD,
   * not of the cards: it appears when the seventh card lands (which may be an
   * add to a six-card meld from an earlier turn), it is worth nothing more on
   * the eighth, and an undo or a rollback takes it away again. Recomputing from
   * the confiscation list makes every one of those paths agree by construction.
   */
  static _recomputeTurnMeldPoints(room, playerId) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    const laid = room.turnMeldedCards?.get(playerId) || [];
    const cardPoints = laid.reduce((sum, c) => sum + this._cardValue(c, room.ruleset), 0);
    const total = cardPoints + this._buracoBonusEarnedThisTurn(room, playerId, laid);
    room.teamMeldPointsThisTurn.set(teamKey, total);
    return total;
  }

  /**
   * Buraco bonus the side gained through the cards `laid` this turn.
   *
   * Per meld that holds at least one of those cards: what it pays NOW minus what
   * it paid BEFORE this turn's cards arrived (the meld with them filtered out —
   * exactly what _returnTurnMeldsToHand would leave behind), floored at zero.
   *   fresh 2-3-4-5-6-7-8            -> 0 before, 200 now  -> +200
   *   6-card run + the 7th this turn -> 0 before, 100/200  -> +bonus
   *   8th card onto a buraco         -> same price both ways -> +0
   *   a wild that DEMOTES a clean buraco -> 200 before? no: the latch is read
   *     for both sides, so both read the demoted price and the turn earns 0.
   *     A lost bonus is not a debt on this turn's going-down.
   * The latch is the meld's CURRENT one for both readings: it is downgrade-only
   * and only ever set at seven cards, so on a meld that was short before this
   * turn it is this turn's own verdict, and on a meld that was already a buraco
   * it caps both readings alike.
   */
  static _buracoBonusEarnedThisTurn(room, playerId, laid) {
    if (!Array.isArray(laid) || laid.length === 0) return 0;
    const ruleset = room.ruleset || 'classic';
    const ids = new Set(laid.map((c) => String(this._cardId(c))));
    let earned = 0;
    for (const teammate of this._teamPlayers(room, playerId)) {
      const melds = room.playerMelds.get(teammate.playerId) || [];
      const flags = room.meldDirtyFlags?.get(teammate.playerId);
      melds.forEach((meld, index) => {
        if (!Array.isArray(meld)) return;
        const before = meld.filter((c) => !ids.has(String(this._cardId(c))));
        if (before.length === meld.length) return; // untouched this turn
        const latched = this._latchedGrade(flags, index);
        const now = this._meldBonus(meld, ruleset, latched);
        const was = this._meldBonus(before, ruleset, latched);
        earned += Math.max(0, now - was);
      });
    }
    return earned;
  }

  /**
   * The exact inverse of _trackTurnMeldPoints, for an UNDO.
   *
   * Both halves matter and both were missing:
   *
   *   the POINTS — teamMeldPointsThisTurn is what the minimum-meld audit reads.
   *     Undo used to leave them counted, so a side could lay A-A-A (45) and
   *     K-K-K (30), reach the 75 bar, UNDO one of them, and still have the audit
   *     rule the bar MET — spending the requirement for the whole round with 45
   *     points on the table and no charge. That is the bar being laundered by
   *     the undo button, which needs no timeout and no rare state to reach.
   *
   *   the CARDS — turnMeldedCards is the confiscation list. Undo used to leave
   *     the cards on it while ALSO putting them back in the hand, so a later
   *     confiscation (a failed audit, or the no-legal-discard timeout) pushed
   *     the same instances into the hand a SECOND time: duplicate cardIds, both
   *     meldable and both summed by the hand penalty.
   *
   * Taking back ONE meld (not zeroing) is right here: anything else laid this
   * turn is still on the table and keeps its credit — the points are rebuilt
   * from what remains.
   *
   * @param {GameRoom} room
   * @param {string} playerId
   * @param {Array} cards the cards the undone meld put on the table
   */
  static _untrackTurnMeldPoints(room, playerId, cards) {
    if (!Array.isArray(cards) || cards.length === 0) return;
    if (room.turnMeldedCards) {
      const ids = new Set(cards.map((c) => String(this._cardId(c))));
      const laid = room.turnMeldedCards.get(playerId) || [];
      room.turnMeldedCards.set(
        playerId,
        laid.filter((c) => !ids.has(String(this._cardId(c))))
      );
    }
    // Rebuilt from the table, not subtracted: the undone meld's cards leave
    // with their card points AND with whatever buraco bonus they had earned.
    // Call it after the meld itself is gone from room.playerMelds.
    this._recomputeTurnMeldPoints(room, playerId);
  }

  /**
   * Drop meld #index from `ownerId`'s table, keeping the parallel arrays and the
   * dirty-flag INDICES consistent.
   *
   * meldDirtyFlags stores meld indices, so splicing one out shifts every index
   * above it — leave them alone and the flags re-point at their neighbours, and
   * a clean canasta scores as dirty (or the reverse). _returnTurnMeldsToHand has
   * always done this shift; the undo path did not.
   *
   * @param {GameRoom} room
   * @param {string} ownerId
   * @param {number} index
   */
  static _dropMeldAt(room, ownerId, index) {
    const melds = room.playerMelds.get(ownerId) || [];
    if (index < 0 || index >= melds.length) return;
    const orders = room.playerMeldOrders.get(ownerId) || [];
    melds.splice(index, 1);
    if (index < orders.length) orders.splice(index, 1);
    room.playerMelds.set(ownerId, melds);
    room.playerMeldOrders.set(ownerId, orders);

    const dirty = this._gradeFlags(room.meldDirtyFlags.get(ownerId));
    if (dirty.size === 0) return;
    const shifted = new Map();
    dirty.forEach((grade, idx) => {
      if (idx === index) return;
      shifted.set(idx > index ? idx - 1 : idx, grade);
    });
    room.meldDirtyFlags.set(ownerId, shifted);
  }

  /**
   * Hand back everything `playerId` laid down this turn: pull those exact cards
   * out of whatever meld now holds them and return them to the hand, dropping
   * any meld left empty (a meld created this turn is made ENTIRELY of these
   * cards, so it disappears; an add-to-meld only loses what was added and the
   * meld underneath survives intact).
   * @returns {number} how many cards went back
   */
  static _returnTurnMeldsToHand(room, playerId) {
    const laid = room.turnMeldedCards?.get(playerId) || [];
    if (!laid.length) return 0;
    const ids = new Set(laid.map((c) => String(this._cardId(c))));

    for (const teammate of this._teamPlayers(room, playerId)) {
      const melds = room.playerMelds.get(teammate.playerId) || [];
      const orders = room.playerMeldOrders.get(teammate.playerId) || [];
      let dirty = this._gradeFlags(room.meldDirtyFlags.get(teammate.playerId));
      const latchBefore = room.turnLatchBefore?.get(teammate.playerId);
      for (let i = melds.length - 1; i >= 0; i -= 1) {
        const had = melds[i].length;
        melds[i] = melds[i].filter((c) => !ids.has(String(this._cardId(c))));
        if (melds[i].length === 0) {
          melds.splice(i, 1);
          orders.splice(i, 1);
          // meldDirtyFlags stores meld INDICES, so removing a meld shifts every
          // index above it. Leaving them alone would re-point the flags at their
          // neighbours and score a clean canasta as dirty (or the reverse).
          const shifted = new Map();
          dirty.forEach((grade, idx) => {
            if (idx === i) return;
            shifted.set(idx > i ? idx - 1 : idx, grade);
          });
          dirty = shifted;
        } else if (melds[i].length !== had) {
          // The meld survives with this turn's cards gone, so its grade goes
          // back to what it was before the turn (recorded on the first touch,
          // _rememberTurnLatch). A latch is a fact about how a buraco was
          // BUILT, and a confiscated add was never built: leaving it let a
          // joker laid as the 7th and handed straight back brand the six
          // naturals 'semi' forever. Without a record (a room restored
          // mid-turn) fall back to the one rule that needs no history: no
          // grade exists below seven cards.
          if (latchBefore && latchBefore.has(i)) {
            const grade = latchBefore.get(i);
            if (grade == null) dirty.delete(i);
            else dirty.set(i, grade);
          } else if (melds[i].length < BURACO_SIZE) {
            dirty.delete(i);
          }
        }
      }
      room.playerMelds.set(teammate.playerId, melds);
      room.playerMeldOrders.set(teammate.playerId, orders);
      room.meldDirtyFlags.set(teammate.playerId, dirty);
    }
    room.turnLatchBefore = new Map();

    const hand = room.playerHands.get(playerId) || [];
    hand.push(...laid);
    room.playerHands.set(playerId, hand);
    room.turnMeldedCards.set(playerId, []);
    return laid.length;
  }

  /**
   * CONFISCATE everything `playerId` laid down this turn: the cards go back to
   * their hand and the points go back with them.
   *
   * `_returnTurnMeldsToHand` alone is only half the operation. The points stay
   * counted in `teamMeldPointsThisTurn`, and that is what the minimum-meld audit
   * reads — so a side whose melds were taken back would still have the bar
   * scored as MET by cards no longer on the table, and `_applyMinimumMeldRule`
   * would then spend the requirement for the whole round (sets it to 0) for
   * free. Zeroing is exactly right rather than subtracting: `_startTurnForPlayer`
   * resets this counter at the start of every turn, so it holds THIS turn's
   * points only, and this returns all of them.
   *
   * @returns {number} how many cards went back
   */
  static undoTurnMelds(room, playerId) {
    const returned = this._returnTurnMeldsToHand(room, playerId);
    if (returned > 0) {
      room.teamMeldPointsThisTurn.set(this._teamKeyForPlayer(room, playerId), 0);
    }
    return returned;
  }

  /** Points a side must lay down on its FIRST going-down once it is past 1000. */
  static get MINIMUM_MELD_POINTS() {
    return 75;
  }

  /** What a failed attempt adds to the requirement. */
  static get MINIMUM_MELD_STEP() {
    return 20;
  }

  /**
   * MINIMUM MELD RULE, audited at the END of the turn (the discard, or the
   * timeout that discards for you).
   *
   * Once a side's cumulative score passes 1000, its FIRST going-down of a round
   * has to be worth at least 75 points. Melds are provisional until then: what
   * counts is the TOTAL laid down across the turn (30 then 45 is fine) — card
   * points PLUS any buraco bonus the turn earned (a fresh 2-3-4-5-6-7-8 is
   * 35 + 200, see _recomputeTurnMeldPoints) — and the verdict lands when the
   * turn ends.
   *
   *   pass -> the melds stand and the requirement is done for the round
   *   fail -> every card laid this turn goes back to the hand and the SIDE's
   *           bar rises by 20 (75 -> 95). NO POINTS ARE CHARGED.
   *
   * The 100-point charge was removed 2026-09-01 (product decision): falling
   * short costs you the turn, not the scoreboard. The two remaining costs are
   * real and load-bearing — the card-return is why a junk meld cannot empty a
   * hand to buy the well or the batida (this audit runs BEFORE the pozzetto
   * hand-over on purpose), and the raised bar belongs to the TEAM, so a partner
   * going down later faces the higher figure too. The bar returns to 75 at the
   * next deal.
   *
   * `room.teamTurnPenalty` is therefore no longer written by this rule. The map
   * and every `turnPenalty` term downstream stay: FailureManager restores rooms
   * persisted while the charge was live, and the wire field is contract.
   *
   * Deliberately NOT gated on `professional`: this is a general rule and applies
   * in direct and indirect alike.
   */
  static _applyMinimumMeldRule(room, playerId) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    // Arm here as well as at turn start. _startTurnForPlayer only runs after a
    // nextTurn(), so the FIRST player to act in a round never passes through it
    // — arming there alone let their opening going-down slip under the rule.
    if (
      room.teamRequiredMeldPoints.get(teamKey) == null &&
      this._cumulativeTeamScore(room, playerId) >= 1000
    ) {
      room.teamRequiredMeldPoints.set(teamKey, this.MINIMUM_MELD_POINTS);
    }
    const required = room.teamRequiredMeldPoints.get(teamKey);
    // null  -> the side has never been past 1000, nothing to enforce
    // 0     -> already satisfied this round; later melds are free
    if (required == null || required <= 0) return null;

    const meldPoints = room.teamMeldPointsThisTurn.get(teamKey) || 0;
    const laid = (room.turnMeldedCards?.get(playerId) || []).length;

    if (meldPoints >= required) {
      // Satisfied. The bar is spent for the rest of the round.
      room.teamRequiredMeldPoints.set(teamKey, 0);
      return { satisfied: true, meldPoints, required };
    }

    // Nothing was laid at all: there is no failed going-down to punish, only a
    // turn that melded nothing — which is every ordinary turn.
    if (laid === 0) return null;

    // undoTurnMelds, not _returnTurnMeldsToHand: the cards AND the points go
    // back. Leaving teamMeldPointsThisTurn standing let the confiscated points
    // count toward the raised bar on the very next attempt of the same turn.
    const returned = this.undoTurnMelds(room, playerId);
    room.teamRequiredMeldPoints.set(teamKey, required + this.MINIMUM_MELD_STEP);
    return {
      satisfied: false,
      meldPoints,
      required,
      // Kept on the wire at 0 rather than dropped: a client built against the
      // charging server reads `penalty` unconditionally, and a missing key
      // renders as "null points deducted".
      penalty: 0,
      nextRequired: required + this.MINIMUM_MELD_STEP,
      returnedCards: returned,
    };
  }

  static _startTurnForPlayer(room, playerId) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    room.teamMeldPointsThisTurn.set(teamKey, 0);
    if (room.turnMeldedCards) room.turnMeldedCards.set(playerId, []);
    room.turnLatchBefore = new Map();
    // Arm the minimum the moment this side is past 1000. `null` means "never
    // been there"; 0 means "already met it this round", and neither is
    // overwritten here.
    const totalScore = this._cumulativeTeamScore(room, playerId);
    if (totalScore >= 1000 && room.teamRequiredMeldPoints.get(teamKey) == null) {
      room.teamRequiredMeldPoints.set(teamKey, this.MINIMUM_MELD_POINTS);
    }
  }

  static _isCleanMeld(meld, ruleset, wasDirty = false) {
    // ONCE DIRTY, ALWAYS DIRTY — in every ruleset (2026-08-28). "200 bisa jadi
    // 100, tapi 100 gabisa jadi 200". The gate used to read `professional &&`,
    // so in CLASSIC the sticky flag was ignored outright and a buraco could be
    // re-graded upward by the cards that arrived after it closed: lay
    // 4-5-6-7-8-[2 as 9], add the 3, and the 2 slides back to its own rank and
    // the meld reads CLEAN. The grade a buraco closed at is a fact about how it
    // was built, and later cards cannot rebuild it.
    if (wasDirty) return false;
    return !meld.some((c) => this._isWild(c) && !this._isNaturalTwo(c, meld));
  }

  /**
   * Latch the grade a meld holds RIGHT NOW into room.meldDirtyFlags —
   * downgrade-only. The container maps meld index -> worst grade ever held
   * ('semi' | 'dirty'); a clean state latches nothing.
   *
   * This used to be `if (_isDirtyMeld) dirtySet.add(index)`, and _isDirtyMeld
   * is true for ANY substitute wild — the single end-wild shape included. So a
   * semi-clean buraco was branded dirty the moment it was laid, and
   * _braziliaStats' semiClean grade was unreachable on a live table: the board
   * printed DIRTY under a ladder whose one wild sat politely on the end.
   * Reported live ("Kok gini sih") from the offline score-details board, whose
   * client mirror latched exactly the same way.
   *
   * The PRICE ratchet is unchanged by the split: semi and dirty both pay 100,
   * and a latch of either bars the meld from CLEAN's 200 forever.
   *
   * A GRADE EXISTS ONLY FOR A BURACO (product decision 2026-09-03). Below
   * BURACO_SIZE nothing latches: a short run laid with a 2 as filler carries
   * nothing to ratchet, the 2 may slide onto its own rank when the real card
   * arrives, and the meld is read for the first time on the layout its
   * SEVENTH card lands in. This supersedes the 2026-08-28 "how it was built"
   * latch from the first card, which branded 8-7-6-5-4-3-2 DIRTY with no wild
   * in sight ("harusnya +200"). The user's own rule is "angka bonus gaboleh
   * naik", and there is no bonus figure to protect before the seventh card.
   * Mirrors Meld() / Meld.degrade in buraco_sdk/lib/game/game_rules.dart.
   */
  static _latchMeldGrade(room, playerId, meldIndex, meld, ruleset) {
    if (!Array.isArray(meld) || meld.length < BURACO_SIZE) return;
    const grade = GameValidator.meldCardGrade(meld, ruleset);
    if (grade === 'clean') return;
    const flags = this._gradeFlags(room.meldDirtyFlags.get(playerId));
    if (flags.get(meldIndex) !== 'dirty') flags.set(meldIndex, grade);
    room.meldDirtyFlags.set(playerId, flags);
  }

  /**
   * Normalize a per-player latch container to the current shape,
   * Map(meldIndex -> 'semi' | 'dirty'). A legacy Set of indices (older
   * FailureManager snapshots, fixtures from the Set era) reads as 'dirty'
   * per member.
   */
  static _gradeFlags(flags) {
    if (flags instanceof Map) return flags;
    if (flags instanceof Set) return new Map([...flags].map((idx) => [idx, 'dirty']));
    return new Map();
  }

  /**
   * Worst grade latched for meld [index], from a flags container that may be
   * the current Map (index -> grade) OR a legacy Set of indices (older
   * FailureManager snapshots, older tests) where membership meant 'dirty'.
   */
  static _latchedGrade(flags, index) {
    if (!flags) return undefined;
    if (flags instanceof Map) return flags.get(index);
    return flags.has && flags.has(index) ? 'dirty' : undefined;
  }

  /**
   * Write meld [index]'s latch outright — `grade` 'semi' | 'dirty' sets it,
   * null/undefined clears it. Only the two restore paths (undo, end-of-turn
   * confiscation) may write UPWARD; every live path goes through
   * _latchMeldGrade, which is downgrade-only.
   */
  static _setLatch(room, ownerId, index, grade) {
    const flags = this._gradeFlags(room.meldDirtyFlags.get(ownerId));
    if (grade == null) flags.delete(index);
    else flags.set(index, grade);
    room.meldDirtyFlags.set(ownerId, flags);
  }

  /**
   * Remember the latch meld [index] of `ownerId` carried the FIRST time this
   * turn touched it, so a confiscation at the end of the turn can put it back
   * (_returnTurnMeldsToHand). Later touches in the same turn keep the first
   * record — that is the pre-turn state. Reset at turn start and once the
   * confiscation has used it.
   */
  static _rememberTurnLatch(room, ownerId, index, latched) {
    if (!room.turnLatchBefore) room.turnLatchBefore = new Map();
    const rec = room.turnLatchBefore.get(ownerId) || new Map();
    if (!rec.has(index)) rec.set(index, latched ?? null);
    room.turnLatchBefore.set(ownerId, rec);
  }

  static _isDirtyMeld(meld, ruleset) {
    if (ruleset === 'professional') {
      return meld.some((c) => c.rank === '2' && !this._isNaturalTwo(c, meld));
    }
    return meld.some((c) => this._isWild(c) && !this._isNaturalTwo(c, meld));
  }

  /**
   * #5 brazilia badge for a meld: { isBuraco (length>=7), clean (per ruleset) }.
   * Reuses the sticky dirty flag (room.meldDirtyFlags) so a meld that was ever
   * dirty stays dirty, and GameValidator.meldClean so the clean/dirty rule is
   * computed identically to GameRoom.toJSON.
   */
  static _meldFlags(room, ownerPlayerId, meld, meldIndex) {
    const ruleset = room.ruleset || 'classic';
    const flags = room.meldDirtyFlags.get(ownerPlayerId);
    const latched = this._latchedGrade(flags, meldIndex);
    return {
      isBuraco: Array.isArray(meld) && meld.length >= 7,
      clean: GameValidator.meldClean(meld, ruleset, latched !== undefined),
      // The full lattice, because `clean:false` cannot say WHICH not-clean:
      // without it the client latched every wild-holding meld as dirty and its
      // score board could never print SEMI for an online table.
      grade: GameValidator.meldGrade(meld, ruleset, latched),
    };
  }

  static _isWild(card) {
    return card.rank === 'joker' || card.rank === '2';
  }

  /**
   * ONE natural-two predicate for the whole server. Delegates to
   * GameValidator._isNaturalTwo, which is the definition the Flutter client
   * mirrors clause for clause (game_rules.dart, "Mirrors
   * `GameValidator._isNaturalTwo`").
   *
   * There used to be a SECOND implementation here, and the split ran straight
   * through the payload: the SCORING path (_isCleanMeld / _isDirtyMeld /
   * _isSemiCleanSequence -> _braziliaStats -> _computeScores) used this strict,
   * gapless copy while the BADGE path (_meldFlags -> GameValidator.meldClean)
   * used the filler-aware one — so a single round_ended frame could carry
   * `meld.clean = true` next to a buracoDirtyCount that had counted the same
   * meld as dirty, and the client (which has only the filler-aware definition)
   * agreed with the badge and not with the score.
   *
   * The strict copy was also simply the OLD, fixed-away-from version: it
   * demanded a gapless layout, so a 2 sitting in its own slot in
   * 2-3-4-5-6-7-[joker as 8]-9 was read as a WILD because of a gap the joker had
   * already plugged.
   */
  static _isNaturalTwo(card, cards) {
    return GameValidator._isNaturalTwo(card, cards);
  }

  static _rankValue(rank) {
    if (rank === 'A') return 1;
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

  /**
   * What a side scores for the round once it has failed one of its obligations:
   * a flat -100, and nothing else counts.
   *
   * Product decision 2026-08-23. The three charges below used to be DEDUCTIONS
   * off an otherwise normal round — meld points, buraco bonuses and the go-out
   * bonus all still banked, minus 100. They are now TERMINAL: a side that fails
   * any of them scores exactly -100 for the round, and every point it laid on
   * the table is void.
   *
   *   no pozzetto   — the round ended and this side never took a well
   *   no buraco     — the round ended and this side completed none
   *
   * Going down under the bar is NOT on that list and never was a void reason
   * (see _roundVoidReasons); since 2026-09-01 it carries no charge at all.
   *
   * Applies to the WINNING side too: going out does not excuse an unmet
   * obligation.
   */
  /** QANOON rule 2: what a pile take that never reaches a meld costs the seat. */
  static get QANOON_PILE_CHARGE() {
    return 100;
  }

  static get ROUND_VOID_CHARGE() {
    return -100;
  }

  /**
   * Legacy alias. The wire field is still called `flatPenalty` and older readers
   * expect this name; the charge itself is no longer flat.
   * @deprecated use ROUND_VOID_CHARGE
   */
  static get FLAT_ROUND_PENALTY() {
    return this.ROUND_VOID_CHARGE;
  }

  /**
   * Which obligations this side failed, as reason codes the client renders. An
   * EMPTY array means the round scores normally.
   * @returns {string[]}
   */
  static _roundVoidReasons({ tookPozzetto, hasBrazilia }) {
    const reasons = [];
    if (!tookPozzetto) reasons.push('no_pozzetto');
    if (!hasBrazilia) reasons.push('no_brazilia');
    return reasons;
  }

  /**
   * What a side scores for a VOIDED round: -100 for EACH obligation it failed,
   * and its hand still counts against it.
   *
   * Product decision 2026-08-27, replacing the flat -100 of 2026-08-23. The two
   * charges STACK — a side that took no well AND completed no brazilia scores
   * -200, where before it paid the same -100 as a side that missed only one.
   * THE HAND IS NOT CHARGED (product owner 2026-09-02, reversing their own
   * 2026-08-27 call): "yang ditangan player itu ga perlu dihitung". A voided
   * round is a flat VERDICT, not a sum — what stays void is everything the side
   * EARNED (meld points, buraco bonuses, the go-out bonus) and the cards left
   * in hand simply do not enter it.
   *
   * THE CHARGE MULTIPLIES per voided round of the match: 1st -200, 2nd -400,
   * 3rd -600. `voidOrdinal` is the 1-based count INCLUDING this round, taken
   * from `room.voidedRoundCounts`, and it never resets inside a match.
   *
   * `turnPenalty` is still subtracted here, but no live rule produces one any
   * more: the minimum-meld charge was removed 2026-09-01, so this term is 0
   * except for a room FailureManager restored from state persisted while the
   * charge was live.
   */
  static _voidedRoundTotal({ reasons, turnPenalty, voidOrdinal = 1 }) {
    const ordinal = voidOrdinal > 0 ? voidOrdinal : 1;
    return reasons.length * this.ROUND_VOID_CHARGE * ordinal - turnPenalty;
  }

  /**
   * Does a side's round get VOIDED, or merely dented?
   *
   * Product decision 2026-08-27 (superseding the same morning): only failing
   * BOTH obligations voids — "Jika player atau team tidak pernah ambil pozetto +
   * tidak pernah close 100-200, scorenya jadi flat -200". Failing just one is a
   * deduction and nothing more: "scorenya dikurangi -100 aja". Those -100s are
   * the line items the round already carried (`pozzettoBonus` at -100,
   * `noBraziliaPenalty`), so a single failure needs no extra arithmetic at all —
   * confirmed against the worked example 240 + 100 - 100 - 60 = 180.
   */
  static _roundIsVoided(reasons) {
    return reasons.length >= 2;
  }

  /**
   * Do the cards still in hand count against their side?
   *
   * Only when a PLAYER closed the round. "Jika game tertutup bukan oleh pemain,
   * artinya tidak ada kalkulasi pemotongan dari score ditangan." A round that
   * simply ran out of stock is nobody's batida, so nobody is punished for the
   * hand they were dealt.
   *
   * `winnerId` is exactly that signal and needs no new plumbing: the batida path
   * passes it through as `scoringWinnerId`, and `_finalizeRoundNoBatida` passes
   * null.
   */
  static _handCountsAgainstYou(winnerId) {
    return winnerId !== null && winnerId !== undefined;
  }

  /**
   * The SIDE's total minimum-meld charge: every seat's own entry plus the legacy
   * side-keyed one. Read team-wide on purpose — the bar belongs to the side, so
   * a partner who went down short voids the round for both of them.
   */
  static _teamTurnPenaltyTotal(room, playerId) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    return (
      this._teamPlayers(room, playerId).reduce(
        (sum, p) => sum + (room.teamTurnPenalty.get(p.playerId) || 0),
        0
      ) + (room.teamTurnPenalty.get(teamKey) || 0)
    );
  }

  static _computeScores(room, winnerId, batidaType) {
    const playerScores = {};
    const teamScores = {};
    const ruleset = room.ruleset || 'classic';
    const teamPlayers = {};

    room.getPlayers().forEach((p) => {
      const hand = room.playerHands.get(p.playerId) || [];
      const melds = room.playerMelds.get(p.playerId) || [];
      const tookPozzetto = this._teamHasTakenPozzetto(room, p.playerId);
      const dirtySet = room.meldDirtyFlags.get(p.playerId) || new Set();
      const teamId = this._teamId(p.playerIndex);

      const meldPoints = melds.reduce((sum, meld) => sum + meld.reduce((s, card) => s + this._cardValue(card, ruleset), 0), 0);
      const braziliaStats = this._braziliaStats(melds, ruleset, dirtySet);

      const isTeamLead = p.playerIndex === this._teamLeadIndex(room, teamId);
      const pozzettoBonus = isTeamLead ? (tookPozzetto ? 100 : -100) : 0;
      // Legacy line-item, kept so the board can still show WHY the round was
      // voided. The charge itself is no longer a deduction: since 2026-08-23 a
      // side with no brazilia scores a flat -100 for the round (see
      // FLAT_ROUND_PENALTY), and this figure only feeds the breakdown.
      const noBraziliaPenalty =
        isTeamLead && !this._teamHasAnyBrazilia(room, p.playerId) ? 100 : 0;
      const goOutBonus = p.playerId === winnerId ? 100 : 0;
      const directBatidaBonus = 0;
      // Charged only on a round a player actually closed — see
      // _handCountsAgainstYou. Reported as the CHARGED figure, not the raw one,
      // so a board drawing this row can never show a deduction the ledger did
      // not take.
      const handPenalty = this._handCountsAgainstYou(winnerId)
        ? hand.reduce((sum, card) => sum + this._cardValue(card, ruleset), 0)
        : 0;
      // Charged to WHOEVER incurred it, not to the side. The minimum-meld penalty
      // belongs to the player who went down short — gating it on isTeamLead (as
      // the once-per-side penalties above are) silently dropped it whenever the
      // PARTNER was the one who fell short. The legacy team-keyed entry still
      // rides on the lead's line so older writers keep working.
      const turnPenalty =
        (room.teamTurnPenalty.get(p.playerId) || 0) +
        (isTeamLead ? room.teamTurnPenalty.get(teamId) || 0 : 0);

      const rawTotal =
        meldPoints +
        braziliaStats.bonus +
        pozzettoBonus +
        goOutBonus +
        directBatidaBonus -
        handPenalty -
        turnPenalty -
        noBraziliaPenalty;

      // The verdict is the SIDE's, so both partners carry it: the well, the
      // buraco and the bar are all team obligations.
      const failed = this._roundVoidReasons({
        tookPozzetto,
        hasBrazilia: this._teamHasAnyBrazilia(room, p.playerId),
      });
      const flatPenaltyReasons = this._roundIsVoided(failed) ? failed : [];
      // The void charge is a SIDE charge, so it lands ONCE — on the team lead's
      // row — exactly like pozzettoBonus and noBraziliaPenalty above. Charging
      // it on every seat made the 2v2 rows sum to -400 against a team total of
      // -200: the round board contradicted itself, and the doubled figure went
      // into room.cumulativeScores, which _cumulativeTeamScore falls back to
      // after a rehydrate — so the doubled loss could arm the 1000-point bar.
      // The hand penalty and the turn penalty stay per-seat because they ARE
      // per-seat, and their sums match the team branch's own formula.
      const total = flatPenaltyReasons.length
        ? this._voidedRoundTotal({
          reasons: isTeamLead ? flatPenaltyReasons : [],
          turnPenalty,
          voidOrdinal: (room.voidedRoundCounts?.get(teamId) || 0) + 1,
        })
        : rawTotal;

      playerScores[p.playerIndex] = {
        playerId: p.playerId,
        teamId,
        total,
        // What the round WOULD have scored without the flat charge. The board
        // shows it struck through so the player can see what the failure cost.
        rawTotal,
        flatPenalty: flatPenaltyReasons.length
          ? {
            applied: true,
            // The STACKED charge, not the per-failure one: a board that prints
            // this figure has to show -200 when both obligations were missed.
            // It is reported on BOTH partners because the verdict is the SIDE's
            // — but it is only DEDUCTED once, on the lead's `total`. A board
            // that renders it next to a per-seat total must read `chargedHere`
            // to know which row actually carries it.
            value: flatPenaltyReasons.length * this.ROUND_VOID_CHARGE,
            chargedHere: isTeamLead,
            reasons: flatPenaltyReasons,
          }
          : null,
        meldPoints,
        buracoBonus: braziliaStats.bonus,
        buracoCleanCount: braziliaStats.clean,
        // Classic-only category, and the one the payload never carried: a
        // semi-clean buraco pays like any other but was counted in NEITHER
        // buracoCleanCount nor buracoDirtyCount, so a board that adds the counts
        // up came out short of the bonus it was explaining (two clean listed
        // against a 300 bonus).
        buracoSemiCleanCount: braziliaStats.semiClean,
        buracoDirtyCount: braziliaStats.dirty,
        buracoTwosCount: braziliaStats.twos,
        buracoRoyalCount: braziliaStats.royal,
        handPenalty,
        tookPozzetto,
        pozzettoBonus,
        noBraziliaPenalty,
        goOutBonus,
        directBatidaBonus,
        turnPenalty,
        batidaType: p.playerId === winnerId ? batidaType : null,
      };

      if (!teamPlayers[teamId]) teamPlayers[teamId] = [];
      teamPlayers[teamId].push(p);
    });

    Object.entries(teamPlayers).forEach(([teamId, players]) => {
      const lead = players.reduce(
        (best, p) => (best == null || p.playerIndex < best.playerIndex ? p : best),
        null
      );
      const meldEntries = this._uniqueTeamMeldEntries(room, players);
      const meldPoints = meldEntries.reduce(
        (sum, entry) =>
          sum + entry.meld.reduce((s, card) => s + this._cardValue(card, ruleset), 0),
        0
      );
      const braziliaStats = meldEntries.reduce(
        (acc, entry) => {
          const stats = this._braziliaStats(
            [entry.meld],
            ruleset,
            entry.latched ? new Map([[0, entry.latched]]) : new Map()
          );
          acc.bonus += stats.bonus;
          acc.clean += stats.clean;
          acc.semiClean += stats.semiClean;
          acc.dirty += stats.dirty;
          acc.twos += stats.twos;
          acc.royal += stats.royal;
          return acc;
        },
        { clean: 0, semiClean: 0, dirty: 0, twos: 0, royal: 0, bonus: 0 }
      );
      const handPenalty = this._handCountsAgainstYou(winnerId)
        ? players.reduce(
          (sum, p) =>
            sum +
            (room.playerHands.get(p.playerId) || []).reduce(
              (s, card) => s + this._cardValue(card, ruleset),
              0
            ),
          0
        )
        : 0;
      const tookPozzetto = lead ? this._teamHasTakenPozzetto(room, lead.playerId) : false;
      const pozzettoBonus = tookPozzetto ? 100 : -100;
      // Line-item only (see the per-player copy above): a side with no brazilia
      // now scores a flat -100 for the whole round. Read off the team's own
      // deduped meld list, which is the same set the bonus above was computed
      // from.
      const noBraziliaPenalty = braziliaStats.clean +
        braziliaStats.semiClean +
        braziliaStats.dirty +
        braziliaStats.twos === 0
        ? 100
        : 0;
      const goOutBonus = players.some((p) => p.playerId === winnerId) ? 100 : 0;
      const directBatidaBonus = 0;
      // EVERY seat on the side, summed. The minimum-meld penalty is charged to
      // whoever fell short (see _applyMinimumMeldRule, which keys it by
      // playerId), so reading only the LEAD's entry dropped the partner's 100
      // from the side's total — while playerScores[partner] still showed it, so
      // the round board contradicted itself and the ledger banked 100 too much.
      // This total feeds room.cumulativeTeamScores and the payout webhook, so
      // the gap was a money-path gap, not a display one.
      // teamId stays in the sum as the legacy fallback: nothing writes it today,
      // but a restored/older room state may carry a side-keyed charge.
      const turnPenalty =
        players.reduce((sum, p) => sum + (room.teamTurnPenalty.get(p.playerId) || 0), 0) +
        (room.teamTurnPenalty.get(teamId) || 0);
      const rawTotal =
        meldPoints +
        braziliaStats.bonus +
        pozzettoBonus +
        goOutBonus +
        directBatidaBonus -
        handPenalty -
        turnPenalty -
        noBraziliaPenalty;

      // THE money path: this total is what lands in room.cumulativeTeamScores
      // and rides the payout webhook, so the flat charge has to be applied here
      // and not merely drawn on the board.
      const failed = this._roundVoidReasons({
        tookPozzetto,
        hasBrazilia:
          braziliaStats.clean +
            braziliaStats.semiClean +
            braziliaStats.dirty +
            braziliaStats.twos >
          0,
      });
      const flatPenaltyReasons = this._roundIsVoided(failed) ? failed : [];
      const total = flatPenaltyReasons.length
        ? this._voidedRoundTotal({
          reasons: flatPenaltyReasons,
          handPenalty,
          turnPenalty,
        })
        : rawTotal;

      if (!teamScores[teamId]) {
        teamScores[teamId] = {
          players: [],
          total: 0,
          rawTotal: 0,
          flatPenalty: null,
          meldPoints: 0,
          buracoBonus: 0,
          buracoCleanCount: 0,
          buracoSemiCleanCount: 0,
          buracoDirtyCount: 0,
          buracoTwosCount: 0,
          buracoRoyalCount: 0,
          handPenalty: 0,
          pozzettoBonus: 0,
          noBraziliaPenalty: 0,
          goOutBonus: 0,
          directBatidaBonus: 0,
          turnPenalty: 0,
        };
      }

      teamScores[teamId].players = players.map((p) => ({
        playerId: p.playerId,
        playerIndex: p.playerIndex,
      }));
      teamScores[teamId].total = total;
      teamScores[teamId].rawTotal = rawTotal;
      teamScores[teamId].flatPenalty = flatPenaltyReasons.length
        ? {
          applied: true,
          value: flatPenaltyReasons.length * this.ROUND_VOID_CHARGE,
          reasons: flatPenaltyReasons,
        }
        : null;
      teamScores[teamId].meldPoints = meldPoints;
      teamScores[teamId].buracoBonus = braziliaStats.bonus;
      teamScores[teamId].buracoCleanCount = braziliaStats.clean;
      teamScores[teamId].buracoSemiCleanCount = braziliaStats.semiClean;
      teamScores[teamId].buracoDirtyCount = braziliaStats.dirty;
      teamScores[teamId].buracoTwosCount = braziliaStats.twos;
      teamScores[teamId].buracoRoyalCount = braziliaStats.royal;
      teamScores[teamId].handPenalty = handPenalty;
      teamScores[teamId].pozzettoBonus = pozzettoBonus;
      teamScores[teamId].noBraziliaPenalty = noBraziliaPenalty;
      teamScores[teamId].goOutBonus = goOutBonus;
      teamScores[teamId].directBatidaBonus = directBatidaBonus;
      teamScores[teamId].turnPenalty = turnPenalty;
    });

    const winningTeam = Object.entries(teamScores).reduce(
      (best, [id, score]) => {
        if (!best || score.total > best.score.total) return { id, score };
        return best;
      },
      null
    )?.id || null;

    return { playerScores, teamScores, winningTeam };
  }

  static _uniqueTeamMeldEntries(room, players) {
    const entries = [];
    const seenKeys = new Set();
    const seenRefs = new WeakSet();

    players.forEach((p) => {
      const flags = room.meldDirtyFlags.get(p.playerId) || new Map();
      (room.playerMelds.get(p.playerId) || []).forEach((meld, index) => {
        if (!Array.isArray(meld)) return;
        if (seenRefs.has(meld)) return;
        seenRefs.add(meld);

        const key = this._meldIdentityKey(meld);
        if (key && seenKeys.has(key)) return;
        if (key) seenKeys.add(key);

        entries.push({
          meld,
          // The LATCH, not a boolean: _braziliaStats resolves the final grade
          // itself (worst of cards + latch), and collapsing this to
          // dirty/not-dirty is exactly the conflation that made SEMI
          // unreachable.
          latched: this._latchedGrade(flags, index),
        });
      });
    });

    return entries;
  }

  static _meldIdentityKey(meld) {
    const ids = meld.map((card) => this._cardId(card)).filter((id) => id !== null && id !== undefined);
    if (ids.length !== meld.length || ids.length === 0) return null;
    return ids.map((id) => String(id)).sort().join('|');
  }

  static _cardValue(card, ruleset = 'classic') {
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
  }

  /**
   * A buraco built ENTIRELY out of 2s (the "canastra de dois") — worth a flat
   * 2000, outranking clean/semi-clean/dirty. Jokers do not qualify; only real 2s.
   * @param {Array} meld
   * @returns {boolean}
   */
  static _isAllTwosMeld(meld) {
    if (!Array.isArray(meld) || meld.length < 7) return false;
    return meld.every((c) => c && c.rank === '2');
  }

  /** Every rank a ROYAL run has to hold, 2 at the bottom through the Ace. */
  static get ROYAL_RUN_RANKS() {
    return ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  }

  /// A CLEAN buraco: no wild standing in for another rank. A natural 2 in its
  /// own place does not spend this. Mirrors the client's
  /// `GameRules.kCleanBuracoBonus`.
  static get CLEAN_BURACO_BONUS() {
    return 200;
  }

  /// Historical name for the clean figure — a royal run is clean by
  /// construction and no longer has a price of its own. Kept so nothing that
  /// still reads it drifts away from CLEAN_BURACO_BONUS.
  static get ROYAL_BURACO_BONUS() {
    return this.CLEAN_BURACO_BONUS;
  }

  /**
   * What a buraco below CLEAN pays — semi-clean and dirty alike, run or set
   * (product decision 2026-09-02). Semi keeps its own label and count on the
   * board; it just has no price of its own.
   */
  static get BURACO_BONUS() {
    return 100;
  }

  /** A buraco built entirely of real 2s (see _isAllTwosMeld). */
  static get SPECIAL_TWOS_BONUS() {
    return 2000;
  }

  /**
   * What ONE meld pays right now — the whole bonus ladder for a single meld,
   * `latched` being its room.meldDirtyFlags grade (see _latchedGrade).
   *
   *   below seven cards -> 0
   *   buraco of 2s      -> 2000
   *   CLEAN             ->  200
   *   semi / dirty      ->  100
   *
   * _braziliaStats prices the round with this; _buracoBonusEarnedThisTurn
   * prices a turn's going-down for the minimum-meld bar with it. One ladder, so
   * the bar can never disagree with the scoreboard about what a meld is worth.
   * @param {Array} meld
   * @param {string} ruleset
   * @param {string|undefined} latched
   * @returns {number}
   */
  static _meldBonus(meld, ruleset = 'classic', latched = undefined) {
    if (!Array.isArray(meld) || meld.length < BURACO_SIZE) return 0;
    if (this._isAllTwosMeld(meld)) return this.SPECIAL_TWOS_BONUS;
    const grade = GameValidator.meldGrade(meld, ruleset, latched);
    return grade === 'clean' ? this.CLEAN_BURACO_BONUS : this.BURACO_BONUS;
  }

  /**
   * ROYAL RUN — one suit, natural cards only, every rank from the 2 up to the
   * Ace. Thirteen cards, no gaps, no wilds: the 2 must be the real 2 OF THAT
   * SUIT and the Ace the real Ace, or the ladder was never closed.
   *
   * This is the ONLY meld that still pays 200. A jokered or 2-substituted ladder
   * is a dirty buraco like any other — the bonus is for the cards actually held.
   * @param {Array} meld
   * @returns {boolean}
   */
  static _isRoyalRun(meld) {
    const ranks = this.ROYAL_RUN_RANKS;
    if (!Array.isArray(meld) || meld.length !== ranks.length) return false;
    // Jokers are wild by definition and a 2 of a foreign suit is standing in for
    // a card the side never held: either way the ladder is not natural.
    const suit = meld[0] && meld[0].suit;
    if (!suit) return false;
    if (meld.some((c) => !c || c.rank === 'joker' || c.suit !== suit)) return false;
    const held = new Set(meld.map((c) => c.rank));
    if (held.size !== meld.length) return false;
    return ranks.every((rank) => held.has(rank));
  }

  /**
   * Buraco bonuses for a set of melds.
   *
   * The clean/semi-clean/dirty COUNTS are kept exactly as they were — the board
   * still labels a buraco by how it was built — but only three figures are paid
   * out (product decision 2026-08-23):
   *
   *   buraco of 2s   -> 2000   (unchanged, still ends nothing but the argument)
   *   royal run 2->A ->  200   (the only 200 on the board)
   *   anything else  ->  100   (clean, semi-clean and dirty alike)
   *
   * A clean eight-card 2-3-4-5-6-7-8-9 therefore no longer banks the top bonus:
   * the ladder has to be carried up to the Ace to earn it.
   */
  static _braziliaStats(melds, ruleset, dirtySet) {
    return melds.reduce(
      (acc, meld, index) => {
        if (!Array.isArray(meld) || meld.length < 7) return acc;

        // Checked before the ruleset split: a set of 2s is all-wild, so every
        // other path below would score it as a plain dirty buraco.
        if (this._isAllTwosMeld(meld)) {
          acc.twos += 1;
          acc.bonus += this._meldBonus(meld, ruleset, undefined);
          return acc;
        }

        // ONE lattice for both rulesets: the grade is the WORST of what the
        // cards read now and what was ever latched (room.meldDirtyFlags maps
        // index -> 'semi' | 'dirty'; legacy Sets from old snapshots read as
        // 'dirty'). A grade may fall over a meld's life, never climb — that is
        // the "100 gabisa jadi 200" ratchet, and it is a PRICE ratchet: semi
        // and dirty both pay BURACO_BONUS, only clean reaches 200.
        //
        // The latch used to collapse 'semi' into 'dirty' (its predicate was
        // _isDirtyMeld, true for any substitute wild), which made the semiClean
        // grade unreachable on a live table: every semi buraco was counted,
        // labelled and wired as DIRTY from the moment it was laid.
        const latched = this._latchedGrade(dirtySet, index);
        const grade = GameValidator.meldGrade(meld, ruleset, latched);

        // ROYAL is still COUNTED (the payload carries buracoRoyalCount and the
        // board labels it) but 2026-09-02 it stopped being a separate PRICE.
        // Counted only at grade CLEAN: a 2→A ladder that was ever built on a
        // substitute is not the ladder the label celebrates.
        if (grade === 'clean' && this._isRoyalRun(meld)) acc.royal += 1;

        if (grade === 'clean') {
          acc.clean += 1;
        } else if (grade === 'semi') {
          // SEMI-CLEAN pays the DIRTY figure (product decision 2026-09-02).
          // It keeps its own label and count; it has no price of its own.
          acc.semiClean += 1;
        } else {
          acc.dirty += 1;
        }
        // One ladder for the round AND for the minimum-meld bar: _meldBonus.
        acc.bonus += this._meldBonus(meld, ruleset, latched);
        return acc;
      },
      { clean: 0, semiClean: 0, dirty: 0, twos: 0, royal: 0, bonus: 0 }
    );
  }

  static _isSemiCleanSequence(meld) {
    // Delegated: GameValidator.meldCardGrade is the one grade authority (it
    // also reads the ladder in BOTH ace orientations, where this local copy
    // refused Q-K-A + wild). Kept as a named predicate for its tests.
    return GameValidator.meldCardGrade(meld, 'classic') === 'semi';
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

  static _teamMelds(room, playerId) {
    return this._teamPlayers(room, playerId).flatMap((p) => room.playerMelds.get(p.playerId) || []);
  }

  static _teamLeadIndex(room, teamId) {
    const indices = room.getPlayers()
      .filter((p) => this._teamId(p.playerIndex) === teamId)
      .map((p) => p.playerIndex);
    return indices.length > 0 ? Math.min(...indices) : null;
  }

  static _markTeamPozzettoTaken(room, playerId, mode) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    const nextCount = this._teamDeadPileCount(room, playerId) + 1;
    const teammates = this._teamPlayers(room, playerId);

    // Across-the-table take count. Informational: no rule gates on it (both
    // wells may be taken by a discard) — the per-team cap in
    // playerDeadPileCount is the limit. Still tracked for the clients' HUD.
    room.wellsTakenThisRound = (room.wellsTakenThisRound || 0) + 1;

    room.playerHasTakenPozzetto.set(teamKey, true);
    room.playerPozzettoTakeMode?.set(teamKey, mode);
    room.playerDeadPileCount.set(teamKey, nextCount);

    teammates.forEach((p) => {
      room.playerHasTakenPozzetto.set(p.playerId, true);
      room.playerPozzettoTakeMode?.set(p.playerId, mode);
      room.playerDeadPileCount.set(p.playerId, nextCount);
    });
  }

  /**
   * Whether this player's SIDE completed at least one brazilia (7+ card meld).
   * Team-wide on purpose: failing to complete one voids the SIDE's round (flat
   * -100), and a canasta sitting on the partner's melds spares both of them.
   * @param {GameRoom} room
   * @param {string} playerId
   * @returns {boolean}
   */
  static _teamHasAnyBrazilia(room, playerId) {
    return this._teamMelds(room, playerId).some(
      (m) => Array.isArray(m) && m.length >= 7
    );
  }

  static _teamHasTakenPozzetto(room, playerId) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    if (room.playerHasTakenPozzetto.get(teamKey)) return true;
    return this._teamPlayers(room, playerId).some((p) => room.playerHasTakenPozzetto.get(p.playerId));
  }

  static _teamPozzettoTakeMode(room, playerId) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    const teamMode = room.playerPozzettoTakeMode?.get(teamKey);
    if (teamMode) return teamMode;
    return this._teamPlayers(room, playerId)
      .map((p) => room.playerPozzettoTakeMode?.get(p.playerId))
      .find(Boolean);
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

  /**
   * #11 target score: decide whether the match has been won outright. Returns
   * null unless room.targetScore > 0 AND some team's cumulative total >= it; in
   * that case returns the leading team plus its display lead-player so the socket
   * can emit a terminal GAME_ENDED.
   */
  static _evaluateMatchEnd(room) {
    const target = Number(room.targetScore) || 0;
    if (target <= 0) return null;
    if (!room.cumulativeTeamScores || room.cumulativeTeamScores.size === 0) return null;

    let leadTeam = null;
    let leadTotal = -Infinity;
    const cumulative = {};
    for (const [teamId, total] of room.cumulativeTeamScores) {
      cumulative[teamId] = total;
      if (total > leadTotal) {
        leadTotal = total;
        leadTeam = teamId;
      }
    }
    if (leadTeam == null || leadTotal < target) return null;

    // Display winner = lowest-index player on the leading team.
    const lead = room.getPlayers()
      .filter((p) => this._teamId(p.playerIndex) === leadTeam)
      .reduce((best, p) => (best == null || p.playerIndex < best.playerIndex ? p : best), null);

    return {
      teamId: leadTeam,
      winnerId: lead ? lead.playerId : null,
      winnerIndex: lead ? lead.playerIndex : null,
      cumulativeTeamScores: cumulative,
    };
  }

  /**
   * Serialize the running cumulative team-score Map (teamId -> total) to a plain
   * {teamA, teamB, ...} object for the round_ended payload. Accepts a Map or an
   * already-plain object; empty object when absent.
   */
  static _serializeCumulativeTeamScores(room) {
    const out = {};
    const scores = room && room.cumulativeTeamScores;
    if (!scores) return out;
    if (scores instanceof Map) {
      for (const [teamId, total] of scores) out[teamId] = total;
    } else if (typeof scores === 'object') {
      for (const [teamId, total] of Object.entries(scores)) out[teamId] = total;
    }
    return out;
  }

  /**
   * Per-TEAM round state for the game_state_update frame: who has banked a well,
   * how many, and what the side has been charged by the minimum-meld rule.
   *
   * All three were previously derivable ONLY from live events, so a client that
   * reconnected or joined late could not learn them:
   *   - `teamHasPickedDeadPile` / `teamDeadPileCount` gate the client's own
   *     legality checks (canDiscardReason's mustTakeWell, the go-out guards) and
   *     the +100 well bonus on its scoreboard estimate. The client has always
   *     parsed the field; nothing ever sent it, so the optimistic flip on
   *     POZZETTO_TAKEN was the only source and it only sees takes that happen
   *     while connected.
   *   - `teamTurnPenalty` never reached the client at all, so a minimum-meld
   *     charge was invisible on the HUD until the round-over board.
   *
   * Keyed 'teamA'/'teamB' to match every other team-keyed field on the wire.
   * Empty object when the room has no seated players, so the client's
   * "absent key means the server said nothing" rule still holds.
   * @param {GameRoom} room
   * @returns {{teamHasPickedDeadPile: Object, teamDeadPileCount: Object, teamTurnPenalty: Object}}
   */
  static serializeTeamRoundState(room) {
    const picked = {};
    const counts = {};
    const penalties = {};
    // MINIMUM-MELD (limit) HUD, added 2026-08-23. Three figures, all of which the
    // client previously had to guess at:
    //   required — the bar this side owes on its first going-down (null = never
    //              armed, 0 = already satisfied this round, else 75/95/115/…).
    //              The client could only ever re-derive the OPENING 75 from the
    //              cumulative ledger; every escalation after a failed attempt
    //              happens server-side, so its copy silently went stale.
    //   turn     — points this side has laid down THIS TURN, which is what the
    //              bar is actually measured against. Resets every turn.
    //   round    — points this side has on the table for the whole round.
    const required = {};
    const meldThisTurn = {};
    const meldThisRound = {};
    if (!room || typeof room.getPlayers !== 'function') {
      return {
        teamHasPickedDeadPile: picked,
        teamDeadPileCount: counts,
        teamTurnPenalty: penalties,
        teamRequiredMeldPoints: required,
        teamMeldPointsThisTurn: meldThisTurn,
        teamMeldPointsThisRound: meldThisRound,
      };
    }

    const ruleset = room.ruleset || 'classic';
    room.getPlayers().forEach((p) => {
      const teamId = this._teamId(p.playerIndex);
      if (picked[teamId] === undefined) {
        picked[teamId] = this._teamHasTakenPozzetto(room, p.playerId);
        counts[teamId] = this._teamDeadPileCount(room, p.playerId);
        // Same shape as the team total in _computeScores: every seat's own
        // charge, plus the legacy side-keyed entry. Read any other way the HUD
        // would disagree with the round-over board it is previewing.
        penalties[teamId] = room.teamTurnPenalty?.get(teamId) || 0;
        const bar = room.teamRequiredMeldPoints?.get(teamId);
        required[teamId] = bar === undefined ? null : bar;
        meldThisTurn[teamId] = room.teamMeldPointsThisTurn?.get(teamId) || 0;
        meldThisRound[teamId] = this._uniqueTeamMeldEntries(
          room,
          this._teamPlayers(room, p.playerId)
        ).reduce(
          (sum, entry) =>
            sum + entry.meld.reduce((s, card) => s + this._cardValue(card, ruleset), 0),
          0
        );
      }
      penalties[teamId] += room.teamTurnPenalty?.get(p.playerId) || 0;
    });

    return {
      teamHasPickedDeadPile: picked,
      teamDeadPileCount: counts,
      teamTurnPenalty: penalties,
      teamRequiredMeldPoints: required,
      teamMeldPointsThisTurn: meldThisTurn,
      teamMeldPointsThisRound: meldThisRound,
    };
  }

  static _cumulativeTeamScore(room, playerId) {
    const teamKey = this._teamKeyForPlayer(room, playerId);
    if (room.cumulativeTeamScores?.has(teamKey)) {
      return room.cumulativeTeamScores.get(teamKey) || 0;
    }
    return this._teamPlayers(room, playerId).reduce(
      (sum, p) => sum + (room.cumulativeScores?.get(p.playerId) || 0),
      0
    );
  }
}

module.exports = ActionHandlers;
