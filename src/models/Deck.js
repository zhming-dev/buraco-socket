/**
 * Deck Model
 * Represents a deck of cards for Brazilia game
 */

const crypto = require('crypto');

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

module.exports = { Deck, Card };
