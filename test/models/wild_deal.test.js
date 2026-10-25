/**
 * Wild cards are dealt scarce (WILD_DEAL): at most one per hand, at most one
 * per 2v2 team, at most two per pozzetto, and the stock keeps its wilds far
 * apart with a natural on top.
 */

const { expect } = require('chai');
const { GameRoom, PlayerSession } = require('../../src/models');
const { Deck, Card, WILD_DEAL, isWild } = require('../../src/models/Deck');

function dealtRoom({ players, ruleset }) {
  const room = new GameRoom({ roomId: 'wild-deal', maxPlayers: players });
  for (let i = 0; i < players; i++) {
    room.addPlayer(new PlayerSession({
      playerId: `p${i}`,
      playerName: `P${i}`,
      playerIndex: i,
      socketId: `s${i}`,
    }));
  }
  room.startGame();
  room.ruleset = ruleset;
  expect(room.dealCards()).to.be.true;
  return room;
}

const wildsIn = (cards) => cards.filter(isWild).length;

/** Indexes of the wilds in [cards], top first. */
const wildSlots = (cards) =>
  cards.reduce((at, card, i) => (isWild(card) ? [...at, i] : at), []);

/**
 * Smallest distance spreadWilds promises between two wilds of a pile that held
 * [count] cards and [wilds] wilds when it was spread: two thirds of a stretch.
 */
const minGap = (count, wilds) => Math.ceil((2 * count) / (3 * wilds) - 1e-9);

describe('Wild deal limits', () => {
  for (const players of [2, 4]) {
    for (const ruleset of ['professional', 'classic']) {
      const total = ruleset === 'classic' ? 108 : 104;
      const wilds = ruleset === 'classic' ? 12 : 8;

      it(`${players} players, ${ruleset}: every deal keeps the limits`, () => {
        let handsWithAWild = 0;
        const firstStockWild = new Set();
        for (let deal = 0; deal < 2000; deal++) {
          const room = dealtRoom({ players, ruleset });
          const hands = [...room.playerHands.values()];
          const stock = room.deck.cards;

          for (const hand of hands) {
            expect(hand).to.have.lengthOf(11);
            expect(wildsIn(hand)).to.be.at.most(WILD_DEAL.handMax);
            if (wildsIn(hand) > 0) handsWithAWild++;
          }
          if (players === 4) {
            // Partners sit opposite: p0 + p2 against p1 + p3.
            const team = (a, b) =>
              wildsIn(room.playerHands.get(a)) + wildsIn(room.playerHands.get(b));
            expect(team('p0', 'p2'), 'team A').to.be.at.most(WILD_DEAL.teamMax);
            expect(team('p1', 'p3'), 'team B').to.be.at.most(WILD_DEAL.teamMax);
          }
          for (const pile of room.deadPiles) {
            expect(pile).to.have.lengthOf(11);
            expect(wildsIn(pile)).to.be.at.most(WILD_DEAL.pozzettoMax);
          }
          expect(isWild(room.discardPile[0]), 'opening discard').to.be.false;

          // Nothing created, nothing lost.
          const all = [...hands.flat(), ...room.deadPiles.flat(), ...room.discardPile, ...stock];
          expect(all).to.have.lengthOf(total);
          expect(new Set(all.map((c) => c.cardId)).size).to.equal(total);
          expect(wildsIn(all)).to.equal(wilds);

          // The stock was spread with the flipped card still on top of it.
          const slots = wildSlots(stock);
          const gap = minGap(stock.length + 1, slots.length);
          for (let i = 1; i < slots.length; i++) {
            expect(slots[i] - slots[i - 1], `stock ${slots}`).to.be.at.least(gap);
          }
          if (slots.length > 0) firstStockWild.add(slots[0]);
        }

        // Still random: hands do get their one wild, and the stock's first
        // wild does not sit at a fixed depth.
        const share = handsWithAWild / (2000 * players);
        expect(share).to.be.within(0.3, 0.8);
        expect(firstStockWild.size).to.be.at.least(3);
      });
    }
  }

  it('the first-turn ceremony keeps the stock spread', () => {
    for (let deal = 0; deal < 500; deal++) {
      const room = dealtRoom({ players: 4, ruleset: 'professional' });
      const before = room.deck.count;
      room.runFirstTurnDraw();
      const stock = room.deck.cards;
      expect(stock).to.have.lengthOf(before);
      expect(isWild(stock[0]), 'next draw').to.be.false;
      const slots = wildSlots(stock);
      const gap = minGap(stock.length, slots.length);
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i] - slots[i - 1]).to.be.at.least(gap);
      }
    }
  });

  it('a promoted pozzetto spreads its two wilds', () => {
    for (let run = 0; run < 500; run++) {
      const deck = new Deck({ includeJokers: false });
      deck.cards = [
        new Card('hearts', '2'),
        new Card('spades', '2'),
        ...['3', '4', '5', '6', '7', '8', '9', '10', 'J'].map((r) => new Card('clubs', r)),
      ];
      deck.shuffle();
      deck.spreadWilds();
      const slots = wildSlots(deck.cards);
      expect(slots).to.have.lengthOf(2);
      expect(slots[0]).to.be.at.least(1);
      expect(slots[1] - slots[0]).to.be.at.least(minGap(11, 2));
    }
  });

  it('2v2: the two sides never start more than one wild apart', () => {
    const gaps = new Set();
    for (let deal = 0; deal < 2000; deal++) {
      const room = dealtRoom({ players: 4, ruleset: 'professional' });
      const team = (a, b) =>
        wildsIn(room.playerHands.get(a)) + wildsIn(room.playerHands.get(b));
      gaps.add(Math.abs(team('p0', 'p2') - team('p1', 'p3')));
    }
    expect([...gaps].every((gap) => gap <= 1)).to.be.true;
  });

  it('a group cap counts its piles together and sends back a random wild', () => {
    const keptBy = [0, 0];
    for (let run = 0; run < 2000; run++) {
      const deck = new Deck({ includeJokers: false });
      // Both partners start with a wild of their own.
      const a = [new Card('hearts', '2'), ...['3', '4', '5'].map((r) => new Card('clubs', r))];
      const b = [new Card('spades', '2'), ...['6', '7', '8'].map((r) => new Card('clubs', r))];
      deck.cards = deck.cards.filter((c) => !a.concat(b).some((x) => x.cardId === c.cardId));
      deck.shuffle();
      const before = deck.cards.length + a.length + b.length;
      deck.limitWilds([{ group: [a, b], max: 1 }]);
      expect(wildsIn(a) + wildsIn(b)).to.equal(1);
      expect(a).to.have.lengthOf(4);
      expect(b).to.have.lengthOf(4);
      expect(deck.cards.length + a.length + b.length).to.equal(before);
      keptBy[wildsIn(a) === 1 ? 0 : 1]++;
    }
    // Either partner may keep it.
    expect(keptBy[0]).to.be.within(800, 1200);
    expect(keptBy[1]).to.be.within(800, 1200);
  });

  it('a hand minimum of one tops every hand up to exactly one', () => {
    for (let run = 0; run < 500; run++) {
      const deck = new Deck({ includeJokers: false });
      deck.shuffle();
      const hands = [deck.deal(11), deck.deal(11), deck.deal(11), deck.deal(11)];
      deck.limitWilds(hands.map((cards) => ({ cards, max: 1, min: 1 })));
      for (const hand of hands) {
        expect(hand).to.have.lengthOf(11);
        expect(wildsIn(hand)).to.equal(1);
      }
      expect(wildsIn([...hands.flat(), ...deck.cards])).to.equal(8);
    }
  });
});
