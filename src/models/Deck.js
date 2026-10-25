/**
 * Deck Model
 * Represents a deck of cards for Brazilia game
 */

const crypto = require('crypto');

/**
 * Wild cards (every 2, and the joker on the rulesets that have one) are dealt
 * SCARCE on purpose (owner, 2026-10-24: "tiap orang max 1 kartu wild card saat
 * deal, di pozzetto masing2 max 2 wild card, trus di deck card itu menyesuaikan
 * dan pastikan kartu wild berjarak jauh2"). A hand holds at most [handMax], a
 * pozzetto at most [pozzettoMax]; every extra goes back to the stock, which then
 * spreads its wilds out (see Deck.spreadWilds). [handMin] 1 would instead give
 * every hand exactly one. The same limits apply to every seat, so no seat or
 * team gains from them.
 *
 * At a 2v2 table the two partners' hands together hold at most [teamMax]
 * (owner, 2026-10-26: "max 1 kartu per tim 2vs2 atau 1 max per user untuk
 * 1vs1"): one partner each holding a wild started that team two wilds up on a
 * side with none. In 1v1 a team is one hand, so [handMax] already says it.
 * [teamMax] 1 only works with [handMin] 0.
 */
const WILD_DEAL = Object.freeze({
  handMax: 1,
  handMin: 0,
  teamMax: 1,
  pozzettoMax: 2,
});

/**
 * A card that can stand in for another: any 2, and a joker.
 * @param {Card} card
 * @returns {boolean}
 */
function isWild(card) {
  return card?.rank === '2' || card?.rank === 'joker';
}

class Card {
  constructor(suit, rank, cardId = null) {
    this.suit = suit; // 'hearts', 'diamonds', 'clubs', 'spades'
    this.rank = rank; // 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'joker'
    this.isJoker = rank === 'joker';
    this.cardId = cardId ?? Card._nextCardId++;
  }

  // NO getValue() here. There WAS one, it had no callers anywhere in src/, bot/,
  // sdk/ or test/, and it was wrong for Buraco in three ways: 2 -> 2 instead of
  // 20, 9 and 8 -> 9 and 8 instead of 10, and 7..3 -> their face value instead
  // of 5. It also could not be right, because the scoring value depends on the
  // RULESET (professional pays a 2 ten and a joker nothing) and a Card knows
  // nothing about the room it is in. The authoritative table is
  // ActionHandlers._cardValue(card, ruleset); GameValidator._calculateMeldPoints
  // and BotStrategy._cardPoints mirror it exactly. Do not add a fourth.

  /**
   * Ordering value for the "first turn" high-card draw. This is intentionally
   * DIFFERENT from the SCORING value (ActionHandlers._cardValue, where a classic
   * 2 = 20 and a joker = 30):
   * here we use the natural card rank so the *biggest number* wins the draw,
   * exactly as a player expects when comparing drawn cards.
   * Order: Joker > A > K > Q > J > 10 > 9 > ... > 3 > 2.
   * @returns {number}
   */
  firstTurnRank() {
    if (this.isJoker) return 15;
    switch (this.rank) {
      case 'A':
        return 14;
      case 'K':
        return 13;
      case 'Q':
        return 12;
      case 'J':
        return 11;
      default:
        return parseInt(this.rank, 10); // '2'..'10' -> 2..10
    }
  }

  /**
   * Serialize to JSON
   * @returns {Object}
   */
  toJSON() {
    const json = {
      cardId: this.cardId,
      // Flutter historically calls this value instanceId. Keep both names for
      // one compatibility window while moving the wire protocol to cardId.
      instanceId: this.cardId,
      suit: this.suit,
      rank: this.rank,
      isJoker: this.isJoker,
    };
    // When a wild (2/joker) has been placed into a sequence's interior gap, the
    // ordering helper stamps the rank it represents (e.g. a 2 standing in for 9).
    // Surface it so the client can render the gap slot. Absent on normal cards.
    if (this.representedRank != null) json.representedRank = this.representedRank;
    return json;
  }
}

Card._nextCardId = 1;

class Deck {
  constructor({ includeJokers = true } = {}) {
    this.cards = [];
    this.initialize(includeJokers);
  }

  /**
   * Initialize deck with 2 standard decks + 4 jokers
   */
  initialize(includeJokers = true) {
    const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

    // Create 2 standard decks
    for (let deckNum = 0; deckNum < 2; deckNum++) {
      for (const suit of suits) {
        for (const rank of ranks) {
          this.cards.push(new Card(suit, rank));
        }
      }
    }

    if (includeJokers) {
      // Add 4 jokers
      for (let i = 0; i < 4; i++) {
        this.cards.push(new Card('joker', 'joker'));
      }
    }
  }

  /**
   * Shuffle the deck using Fisher-Yates algorithm.
   *
   * crypto.randomInt, not Math.random: Math.random's output also reaches
   * clients (room ids, bot ids), and its state can in principle be recovered
   * from enough of it, which would make the next shuffle predictable. The
   * 2026-10-01 fairness audit (17M+ deals) found the deal unbiased either way.
   */
  shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  /**
   * Holds each pile to its wild limits by trading cards with the stock (this
   * deck): a wild over a pile's `max` swaps with a natural from a random place
   * in the stock, and a pile under its `min` swaps a random natural of its own
   * for a wild from the stock while the stock has one. Caps run first, for every
   * pile, so the wilds they free are the ones a `min` can draw on. Pile sizes
   * and the deck's card set never change.
   *
   * A pile may instead be a `group` of piles that share one cap (a 2v2 team's
   * two hands): over it, a random wild of the group goes back, from whichever
   * pile holds it. A group has no `min`.
   * @param {({cards: Card[], max: number, min?: number}|{group: Card[][], max: number})[]} piles
   */
  limitWilds(piles) {
    const randomIndex = (cards, pred) => {
      const at = [];
      cards.forEach((card, i) => {
        if (pred(card)) at.push(i);
      });
      return at.length === 0 ? -1 : at[crypto.randomInt(at.length)];
    };
    const trade = (pile, i, s) => {
      [pile[i], this.cards[s]] = [this.cards[s], pile[i]];
    };

    for (const { cards, group, max } of piles) {
      const parts = group || [cards];
      for (;;) {
        const held = [];
        for (const part of parts) {
          part.forEach((card, i) => {
            if (isWild(card)) held.push({ part, i });
          });
        }
        if (held.length <= max) break;
        const s = randomIndex(this.cards, (c) => !isWild(c));
        if (s < 0) break;
        const { part, i } = held[crypto.randomInt(held.length)];
        trade(part, i, s);
      }
    }
    for (const { cards, min = 0 } of piles) {
      if (!cards) continue;
      while (cards.filter(isWild).length < min) {
        const s = randomIndex(this.cards, isWild);
        const i = randomIndex(cards, (c) => !isWild(c));
        if (s < 0 || i < 0) break;
        trade(cards, i, s);
      }
    }
  }

  /**
   * Re-orders the deck so its wilds sit far apart. The deck is cut into as many
   * equal stretches as it holds wilds and each wild lands at a random place in
   * the middle third of its own stretch, so two wilds are always at least two
   * thirds of a stretch apart (about 8 cards in a 1v1 stock) and never meet near
   * a stretch boundary. The top card, which is the opening discard or the next
   * draw, is always a natural. Naturals keep their shuffled order.
   */
  spreadWilds() {
    const wilds = this.cards.filter(isWild);
    const naturals = this.cards.filter((card) => !isWild(card));
    if (wilds.length === 0 || naturals.length === 0) return;

    const n = this.cards.length;
    const k = wilds.length;
    const stretch = n / k;
    const slots = new Set();
    let previous = 0; // index 0 stays a natural
    for (let i = 0; i < k; i++) {
      const lo = Math.ceil(i * stretch + stretch / 3);
      const hi = Math.floor(i * stretch + (stretch * 2) / 3);
      const at = hi > lo ? crypto.randomInt(lo, hi + 1) : lo;
      // Pushed past the previous wild and kept clear of the end, so every wild
      // gets its own slot even in a stock with almost no naturals left.
      previous = Math.min(Math.max(at, previous + 1), n - (k - i));
      slots.add(previous);
    }

    let w = 0;
    let m = 0;
    this.cards = Array.from({ length: n }, (_, i) =>
      slots.has(i) ? wilds[w++] : naturals[m++]
    );
  }

  /**
   * Deal a specified number of cards
   * @param {number} count
   * @returns {Card[]}
   */
  deal(count) {
    return this.cards.splice(0, count);
  }

  /**
   * Draw a single card
   * @returns {Card|null}
   */
  draw() {
    return this.cards.shift() || null;
  }

  /**
   * Get remaining card count
   * @returns {number}
   */
  get count() {
    return this.cards.length;
  }

  /**
   * Serialize to JSON
   * @returns {Object}
   */
  toJSON() {
    return {
      count: this.count,
      cards: this.cards.map(card => card.toJSON()),
    };
  }
}

module.exports = { Deck, Card, WILD_DEAL, isWild };
