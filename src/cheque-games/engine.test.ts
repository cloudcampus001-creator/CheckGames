import assert from "node:assert/strict";
import {
  botTurn,
  callCheck,
  canDraw,
  colourOf,
  createDeck,
  createGame,
  drawCard,
  type EndMode,
  type GameState,
  isPlayable,
  isSpecial,
  type JokerCard,
  type JokerColour,
  legalPlays,
  maxCardsPerPlayer,
  playCard,
  playContext,
  type Rank,
  type Result,
  type StandardCard,
  type Suit,
  topCard,
  type Card,
} from "./engine.ts";

function mulberry32(seed: number) {
  let a = seed;

  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const s = (rank: Rank, suit: Suit): StandardCard => ({
  id: `${rank}-${suit}`,
  rank,
  suit,
});
const joker = (colour: JokerColour): JokerCard => ({
  id: `joker-${colour}`,
  rank: "joker",
  suit: colour,
});

/** A table built by hand. Player ids are p0, p1, p2... */
function make(options: {
  hands: Card[][];
  centre?: Card;
  pile?: Card[];
  bank?: Card[];
  mode?: EndMode;
  current?: number;
  pending?: number;
  demand?: Suit | null;
  finished?: string[];
}): GameState {
  return {
    bank: options.bank ?? [
      s("3", "clubs"),
      s("4", "clubs"),
      s("5", "clubs"),
      s("6", "clubs"),
      s("8", "clubs"),
      s("9", "clubs"),
    ],
    checked: [],
    current: options.current ?? 0,
    demand: options.demand ?? null,
    events: [],
    finished: options.finished ?? [],
    mode: options.mode ?? "first",
    over: false,
    pending: options.pending ?? 0,
    pile: options.pile ?? [options.centre ?? s("9", "spades")],
    players: options.hands.map((hand, index) => ({
      hand,
      id: `p${index}`,
      name: `P${index}`,
    })),
    stalled: 0,
    winner: null,
  };
}

function ok(result: Result): GameState {
  assert.ok(result.ok, result.ok ? "" : `refused: ${result.reason}`);

  return (result as { ok: true; state: GameState }).state;
}

function refused(result: Result, pattern?: RegExp) {
  assert.equal(result.ok, false, "should have been refused");

  if (!result.ok && pattern) {
    assert.match(result.reason, pattern);
  }
}

const ids = (cards: readonly Card[]) => cards.map((card) => card.id);
const handOf = (state: GameState, player: string) =>
  state.players.find((p) => p.id === player)?.hand ?? [];

function totalCards(state: GameState) {
  return (
    state.bank.length +
    state.pile.length +
    state.players.reduce((sum, p) => sum + p.hand.length, 0)
  );
}

// === deck and deal ===========================================================
assert.equal(createDeck().length, 52);
assert.equal(createDeck(true).length, 54);
assert.equal(new Set(createDeck(true).map((x) => x.id)).size, 54);
assert.deepEqual(
  createDeck(true)
    .filter((card) => card.rank === "joker")
    .map((card) => card.id),
  ["joker-red", "joker-black"],
);
assert.equal(maxCardsPerPlayer(2), 25);
assert.equal(maxCardsPerPlayer(2, true), 26);
assert.ok(isSpecial(s("A", "hearts")) && isSpecial(s("2", "clubs")));
assert.ok(isSpecial(s("7", "spades")) && isSpecial(s("J", "diamonds")));
assert.ok(isSpecial(joker("red")) && !isSpecial(s("9", "hearts")));

{
  const dealt = createGame({
    cardsPerPlayer: 7,
    includeJokers: true,
    playerNames: ["A", "B", "C"],
    rng: mulberry32(1),
  });

  assert.deepEqual(
    dealt.players.map((p) => p.hand.length),
    [7, 7, 7],
  );
  assert.equal(totalCards(dealt), 54);
  assert.equal(dealt.pile.length, 1);
  assert.throws(() => createGame({ cardsPerPlayer: 27, includeJokers: true, playerNames: ["A", "B"] }));
  assert.throws(() => createGame({ cardsPerPlayer: 5, playerNames: ["solo"] }));

  // the very first centre card is always an ordinary one
  for (let seed = 1; seed <= 400; seed++) {
    const game = createGame({
      cardsPerPlayer: 1 + (seed % 12),
      includeJokers: seed % 2 === 0,
      playerNames: ["A", "B", "C", "D"],
      rng: mulberry32(seed),
    });

    assert.ok(!isSpecial(topCard(game)), `seed ${seed}: centre is ordinary`);
    assert.equal(totalCards(game), seed % 2 === 0 ? 54 : 52);
  }
}

// === what can be played ======================================================
{
  const on = (centre: Card, extra: Partial<ReturnType<typeof playContext>> = {}) => ({
    centre,
    demand: null,
    pending: 0,
    ...extra,
  });
  const can = (card: Card, context: ReturnType<typeof on>) => isPlayable(card, context);

  // ordinary matching on the 9 of spades
  const spades9 = on(s("9", "spades"));

  assert.ok(can(s("9", "hearts"), spades9), "same number");
  assert.ok(can(s("5", "spades"), spades9), "same sign");
  assert.ok(!can(s("5", "hearts"), spades9), "no match");
  assert.ok(!can(s("A", "hearts"), spades9), "an ace needs a match too");
  assert.ok(can(s("A", "spades"), spades9));
  assert.ok(!can(s("7", "hearts"), spades9), "a 7 needs a match too");
  assert.ok(can(s("7", "spades"), spades9));

  // a 2 and a jack go on anything
  assert.ok(can(s("2", "hearts"), spades9));
  assert.ok(can(s("J", "diamonds"), spades9));

  // jokers keep to their colour
  assert.ok(can(joker("black"), spades9), "black joker on a black card");
  assert.ok(!can(joker("red"), spades9), "red joker not on a black card");
  assert.ok(can(joker("red"), on(s("9", "hearts"))), "red joker on red");
  assert.ok(can(joker("red"), on(s("K", "diamonds"))));
  assert.ok(!can(joker("black"), on(s("9", "hearts"))));
  assert.ok(can(joker("black"), on(s("4", "clubs"))));

  // and only their colour goes on a joker
  const redJoker = on(joker("red"));

  assert.ok(can(s("5", "hearts"), redJoker));
  assert.ok(can(s("K", "diamonds"), redJoker));
  assert.ok(!can(s("5", "spades"), redJoker));
  assert.ok(can(joker("red"), redJoker));
  assert.ok(!can(joker("black"), redJoker));
  assert.ok(can(s("2", "spades"), redJoker), "a 2 still goes on a joker");
  assert.ok(can(s("J", "clubs"), redJoker));

  // under attack: only a 7 or a joker of ANY colour
  const attacked = on(s("7", "hearts"), { pending: 2 });

  assert.ok(can(s("7", "clubs"), attacked), "any 7, whatever its sign");
  assert.ok(can(joker("black"), attacked), "joker of any colour");
  assert.ok(can(joker("red"), on(s("7", "spades"), { pending: 4 })));
  assert.ok(!can(s("5", "hearts"), attacked));
  assert.ok(!can(s("2", "hearts"), attacked), "a 2 does not stop an attack");
  assert.ok(!can(s("J", "hearts"), attacked), "a jack does not either");
  assert.ok(!can(s("A", "hearts"), attacked));

  // after a jack: the sign asked for, a 2 or a jack
  const asked = on(s("J", "spades"), { demand: "hearts" });

  assert.ok(can(s("5", "hearts"), asked));
  assert.ok(can(s("7", "hearts"), asked), "a 7 of that sign is fine");
  assert.ok(can(s("A", "hearts"), asked));
  assert.ok(!can(s("5", "spades"), asked), "not the jack's own sign");
  assert.ok(!can(s("J", "spades").rank === "J" ? s("5", "clubs") : s("5", "clubs"), asked));
  assert.ok(can(s("2", "clubs"), asked));
  assert.ok(can(s("J", "clubs"), asked));
  assert.ok(!can(joker("red"), asked), "a joker is not of that sign");
  assert.ok(!can(joker("black"), asked));

  assert.equal(colourOf(s("3", "diamonds")), "red");
  assert.equal(colourOf(s("3", "clubs")), "black");
  assert.equal(colourOf(joker("red")), "red");
}

// === the ace: the next player is stopped =========================================
{
  const state = make({
    hands: [[s("A", "spades"), s("3", "hearts")], [s("4", "hearts")], [s("5", "hearts")]],
  });
  const after = ok(playCard(state, "p0", "A-spades"));

  assert.equal(after.current, 2, "p1 is stopped, p2 plays");
  assert.deepEqual(
    after.events.filter((e) => e.type === "skip"),
    [{ playerId: "p1", type: "skip" }],
  );
  assert.equal(topCard(after).id, "A-spades");

  // with two players, you play again
  const duel = make({ hands: [[s("A", "spades"), s("3", "hearts")], [s("4", "hearts")]] });

  assert.equal(ok(playCard(duel, "p0", "A-spades")).current, 0);

  // an ace on an ace
  const stacked = make({
    centre: s("A", "hearts"),
    hands: [[s("A", "clubs"), s("3", "hearts")], [s("4", "hearts")], [s("5", "hearts")]],
  });

  assert.equal(ok(playCard(stacked, "p0", "A-clubs")).current, 2);

  // someone who is already out is never "the next player"
  const gaps = make({
    finished: ["p1"],
    hands: [[s("A", "spades"), s("3", "hearts")], [], [s("5", "hearts")]],
    mode: "ranking",
  });
  const skipped = ok(playCard(gaps, "p0", "A-spades"));

  assert.equal(skipped.current, 0, "p2 is stopped, p1 is out, so p0 again");
  assert.deepEqual(
    skipped.events.filter((e) => e.type === "skip"),
    [{ playerId: "p2", type: "skip" }],
  );
}

// === the 2: plays on anything, on top or under ===================================
{
  const state = make({
    centre: s("9", "spades"),
    hands: [[s("2", "hearts"), s("K", "hearts")], [s("4", "hearts"), s("8", "diamonds")]],
  });

  // on top: it becomes the centre card, as usual
  const top = ok(playCard(state, "p0", "2-hearts"));

  assert.equal(topCard(top).id, "2-hearts");
  assert.equal(top.current, 1);
  assert.deepEqual(ids(top.pile), ["9-spades", "2-hearts"]);
  assert.ok(isPlayable(s("2", "clubs"), playContext(top)), "next: another 2 matches");
  assert.ok(isPlayable(s("4", "hearts"), playContext(top)), "next: same sign as the 2");
  assert.ok(!isPlayable(s("8", "diamonds"), playContext(top)));
  const explicitTop = ok(playCard(state, "p0", "2-hearts", { placement: "top" }));

  assert.deepEqual(ids(explicitTop.pile), ["9-spades", "2-hearts"]);

  // under: the centre card stays
  const under = ok(playCard(state, "p0", "2-hearts", { placement: "under" }));

  assert.equal(topCard(under).id, "9-spades", "centre card unchanged");
  assert.deepEqual(ids(under.pile), ["2-hearts", "9-spades"]);
  assert.equal(under.current, 1, "the turn still passes");
  assert.equal(handOf(under, "p0").length, 1);
  assert.ok(isPlayable(s("5", "spades"), playContext(under)), "next player matches the 9 of spades");
  assert.ok(!isPlayable(s("4", "hearts"), playContext(under)), "not the 2 you hid");

  // a 2 on a centre that does not match is fine, but only a 2 can go under
  const matching = make({ hands: [[s("9", "hearts"), s("K", "hearts")], [s("4", "hearts")]] });

  refused(playCard(matching, "p0", "9-hearts", { placement: "under" }), /Only a 2/);
  refused(playCard(state, "p0", "K-hearts", { placement: "under" }));
  refused(playCard(state, "p0", "K-hearts"), /does not match/);

  // under a request: the request stays, the centre jack stays
  const request = make({
    centre: s("J", "clubs"),
    demand: "hearts",
    hands: [[s("2", "spades"), s("3", "spades")], [s("4", "hearts")]],
  });
  const hidden = ok(playCard(request, "p0", "2-spades", { placement: "under" }));

  assert.equal(hidden.demand, "hearts");
  assert.equal(topCard(hidden).id, "J-clubs");

  // on top of a request: the 2 is the new centre and the request is gone
  const covered = ok(playCard(request, "p0", "2-spades"));

  assert.equal(covered.demand, null);
  assert.equal(topCard(covered).id, "2-spades");

  // the last card can be a 2, either way
  const last = make({ hands: [[s("2", "hearts")], [s("4", "hearts")]] });

  assert.equal(ok(playCard(last, "p0", "2-hearts", { placement: "under" })).winner, "p0");

  // a 2 cannot stop an attack
  refused(
    playCard(make({ hands: [[s("2", "hearts")], [s("4", "hearts")]], pending: 2, centre: s("7", "spades") }, ), "p0", "2-hearts"),
  );
}

// === the 7 and the joker: take 2 / take 4, and pass it on =============================
{
  const state = make({
    hands: [
      [s("7", "spades"), s("3", "hearts")],
      [joker("red"), s("7", "hearts"), s("5", "diamonds")],
      [s("K", "hearts"), s("Q", "hearts")],
    ],
  });

  // a 7 on a matching card: the next player owes 2
  const a = ok(playCard(state, "p0", "7-spades"));

  assert.equal(a.pending, 2);
  assert.equal(a.current, 1);
  assert.deepEqual(ids(legalPlays(a, "p1")), ["joker-red", "7-hearts"], "only 7s and jokers answer");
  refused(playCard(a, "p1", "5-diamonds"), /7 or a joker/);

  // the red joker answers a 7 of spades, whatever the colours: 2 + 4 = 6
  const b = ok(playCard(a, "p1", "joker-red"));

  assert.equal(b.pending, 6);
  assert.equal(b.current, 2);
  assert.equal(topCard(b).id, "joker-red");

  // p2 cannot answer, so takes all 6 from the bank
  assert.equal(canDraw(b, "p2"), true);

  const c = ok(drawCard(b, "p2"));

  assert.equal(handOf(c, "p2").length, 2 + 6);
  assert.equal(c.bank.length, 2, "bank was finished: the 2 cards under the joker were mixed into a new bank");
  assert.deepEqual(ids(c.pile), ["joker-red"]);
  assert.equal(c.pending, 0, "the attack is over");
  assert.equal(c.current, 0, "taking the cards ends the turn");
  assert.equal(topCard(c).id, "joker-red", "the joker stays as the centre card");
  assert.deepEqual(
    c.events.filter((e) => e.type === "draw").map((e) => e.type === "draw" && e.forced),
    [true, true, true, true, true, true],
  );
  assert.deepEqual(c.events[c.events.length - 1], { count: 6, playerId: "p2", type: "penalty" });

  // after that, the next player plays on the red joker: red cards only
  assert.ok(isPlayable(s("3", "hearts"), playContext(c)));
  assert.ok(!isPlayable(s("5", "spades"), playContext(c)));

  // answering with a plain 7 adds 2: 2 + 2 = 4
  const d = ok(playCard(a, "p1", "7-hearts"));

  assert.equal(d.pending, 4);

  // a joker played first costs the next player 4
  const jokerFirst = make({
    hands: [[joker("black"), s("3", "hearts")], [s("4", "hearts")]],
  });

  assert.equal(ok(playCard(jokerFirst, "p0", "joker-black")).pending, 4);
  refused(
    playCard(make({ hands: [[joker("red"), s("3", "hearts")], [s("4", "hearts")]] }), "p0", "joker-red"),
    /red joker only goes on a red/,
  );

  // not enough in the bank: you take what there is
  const short = make({
    bank: [s("3", "clubs")],
    hands: [[s("3", "hearts")], [s("5", "diamonds"), s("6", "diamonds")]],
    centre: s("7", "spades"),
    current: 1,
    pending: 4,
  });
  const little = ok(drawCard(short, "p1"));

  assert.equal(handOf(little, "p1").length, 3);
  assert.deepEqual(little.events[little.events.length - 1], { count: 1, playerId: "p1", type: "penalty" });
  assert.equal(little.pending, 0);

  // the bank runs out half way: the pile is mixed in and the rest is taken from it
  const refill = make({
    bank: [s("3", "clubs")],
    centre: s("7", "spades"),
    current: 1,
    hands: [[s("3", "hearts")], [s("5", "diamonds")]],
    pending: 4,
    pile: [s("A", "hearts"), s("2", "hearts"), s("6", "hearts"), s("K", "hearts"), s("7", "spades")],
  });
  const mixed = ok(drawCard(refill, "p1", mulberry32(3)));

  assert.equal(handOf(mixed, "p1").length, 1 + 4);
  assert.ok(mixed.events.some((e) => e.type === "reshuffle"));
  assert.equal(totalCards(mixed), totalCards(refill));
  assert.deepEqual(ids(mixed.pile), ["7-spades"]);
}

// === the jack: plays on anything, and names a sign ================================
{
  const state = make({
    centre: s("9", "spades"),
    hands: [
      [s("J", "hearts"), s("3", "clubs")],
      [s("5", "spades"), s("5", "diamonds"), s("2", "clubs"), s("J", "clubs"), joker("black")],
      [s("8", "diamonds"), s("8", "clubs")],
    ],
  });

  refused(playCard(state, "p0", "J-hearts"), /Choose a sign/);
  refused(playCard(state, "p0", "J-hearts", { suit: "stars" as Suit }), /Choose a sign/);

  const a = ok(playCard(state, "p0", "J-hearts", { suit: "diamonds" }));

  assert.equal(topCard(a).id, "J-hearts", "played on a card it does not match");
  assert.equal(a.demand, "diamonds");
  assert.equal(a.current, 1);

  // p1 must play a diamond, a 2 or a jack
  assert.deepEqual(ids(legalPlays(a, "p1")), ["5-diamonds", "2-clubs", "J-clubs"]);
  refused(playCard(a, "p1", "5-spades"), /diamond card, a 2 or a jack/);
  refused(playCard(a, "p1", "joker-black"));

  // p1 takes a card instead (always allowed): the request is still on for p2
  const b = ok(drawCard(a, "p1"));

  assert.equal(b.demand, "diamonds");
  assert.equal(b.current, 2);
  assert.deepEqual(ids(legalPlays(b, "p2")), ["8-diamonds"]);

  // playing the sign asked for lifts the request
  const c = ok(playCard(a, "p1", "5-diamonds"));

  assert.equal(c.demand, null);
  assert.equal(topCard(c).id, "5-diamonds");

  // a jack on a jack names a new sign
  const d = ok(playCard(a, "p1", "J-clubs", { suit: "clubs" }));

  assert.equal(d.demand, "clubs");
  assert.deepEqual(ids(legalPlays(d, "p2")), ["8-clubs"]);

  // a jack can't be used to dodge an attack
  refused(
    playCard(make({ hands: [[s("J", "hearts")], [s("4", "hearts")]], centre: s("7", "spades"), pending: 2 }), "p0", "J-hearts", { suit: "hearts" }),
  );

  // a jack as your last card wins the game
  const last = make({ hands: [[s("J", "hearts")], [s("4", "hearts")]] });
  const won = ok(playCard(last, "p0", "J-hearts", { suit: "spades" }));

  assert.equal(won.winner, "p0");
  assert.ok(won.over);
}

// === the bank is always open; the pile is mixed into a new bank ==========================
{
  const base = make({
    hands: [[s("9", "hearts"), s("2", "spades")], [s("K", "hearts")]],
    bank: [s("3", "clubs"), s("4", "clubs")],
  });

  assert.equal(canDraw(base, "p0"), true, "even with a playable card");
  assert.equal(canDraw(base, "p1"), false, "not your turn");

  const voluntary = ok(drawCard(base, "p0"));

  assert.equal(handOf(voluntary, "p0").length, 3);
  assert.equal(voluntary.current, 1, "drawing ends the turn");
  assert.equal(voluntary.pile.length, 1);
  refused(drawCard(voluntary, "p0"), /not your turn/);

  // empty bank and nothing under the centre: play if you can, pass if you cannot
  const dryPlayable = make({ bank: [], hands: [[s("9", "hearts")], [s("K", "hearts")]] });

  assert.equal(canDraw(dryPlayable, "p0"), false);
  refused(drawCard(dryPlayable, "p0"), /empty/);

  const dry = make({ bank: [], hands: [[s("5", "diamonds")], [s("K", "hearts")]] });

  assert.equal(canDraw(dry, "p0"), true);
  assert.equal(ok(drawCard(dry, "p0")).current, 1);

  // the last bank card: take it, and the pile under the centre is MIXED into the new bank
  const lastBank = make({
    bank: [s("3", "clubs")],
    hands: [[s("9", "hearts"), s("2", "spades")], [s("K", "hearts")]],
    pile: [
      s("A", "hearts"),
      s("2", "hearts"),
      s("3", "hearts"),
      s("4", "hearts"),
      s("5", "hearts"),
      s("6", "hearts"),
      s("9", "spades"),
    ],
  });
  const under = ids(lastBank.pile.slice(0, -1));
  const refilled = ok(drawCard(lastBank, "p0", mulberry32(7)));

  assert.deepEqual(ids(refilled.pile), ["9-spades"]);
  assert.deepEqual([...ids(refilled.bank)].sort(), [...under].sort());
  assert.deepEqual(refilled.events.slice(-2).map((e) => e.type), ["draw", "reshuffle"]);

  const orders = new Set<string>();

  for (let seed = 1; seed <= 30; seed++) {
    orders.add(ids(ok(drawCard(lastBank, "p0", mulberry32(seed))).bank).join(","));
  }
  assert.ok(orders.size > 10, "mixed, not left in the old order");
  assert.ok(!orders.has(under.join(",")) && !orders.has([...under].reverse().join(",")));
}

// === how a set ends ===================================================================
{
  // "first": the game stops as soon as one player is out
  const first = make({ hands: [[s("9", "hearts")], [s("K", "hearts")], [s("Q", "hearts")]] });
  const done = ok(playCard(first, "p0", "9-hearts"));

  assert.ok(done.over);
  assert.equal(done.winner, "p0");
  assert.deepEqual(done.finished, ["p0"]);
  refused(playCard(done, "p1", "K-hearts"), /over/);
  refused(drawCard(done, "p1"), /over/);
  refused(callCheck(done, "p1"), /over/);

  // "ranking": the others carry on, and everybody is ranked
  const ranking = make({
    hands: [
      [s("9", "hearts")],
      [s("K", "hearts"), s("Q", "hearts")],
      [s("5", "hearts"), s("6", "hearts"), s("8", "hearts")],
    ],
    mode: "ranking",
  });
  const one = ok(playCard(ranking, "p0", "9-hearts"));

  assert.equal(one.over, false);
  assert.deepEqual(one.finished, ["p0"]);
  assert.equal(one.winner, "p0");
  assert.equal(one.current, 1);
  assert.deepEqual(one.events[one.events.length - 1], { playerId: "p0", rank: 1, type: "games" });
  refused(callCheck(one, "p0"));

  // p0 is skipped from now on
  const p1 = ok(playCard(one, "p1", "K-hearts"));

  assert.equal(p1.current, 2);

  const p2 = ok(playCard(p1, "p2", "5-hearts"));

  assert.equal(p2.current, 1, "p0 is out, so back to p1");

  // p1 is out next: p2 is the one left, and last
  const two = ok(playCard(p2, "p1", "Q-hearts"));

  assert.ok(two.over);
  assert.deepEqual(two.finished, ["p0", "p1", "p2"]);
  assert.equal(two.winner, "p0");
}

{
  // nobody can move any more: the set ends, fewest cards ranks highest
  const stuck = make({
    bank: [],
    hands: [[s("5", "diamonds"), s("6", "diamonds")], [s("K", "hearts")]],
    mode: "ranking",
  });
  const first = ok(drawCard(stuck, "p0"));

  assert.equal(first.over, false);

  const second = ok(drawCard(first, "p1"));

  assert.ok(second.over);
  assert.deepEqual(second.finished, ["p1", "p0"]);
  assert.equal(second.events[second.events.length - 1].type, "stalemate");
}

// === simulated games: always finish, never lose or invent a card ================================
/** Like a bot, but sometimes takes from the bank even with a card to play. */
function chaosTurn(state: GameState, rng: () => number): GameState {
  const player = state.players[state.current];

  if (rng() < 0.2 && canDraw(state, player.id)) {
    return ok(drawCard(state, player.id, rng));
  }

  return botTurn(state, rng);
}

const seen = {
  attacks: 0,
  jackRequests: 0,
  penalties: 0,
  rankings: 0,
  skips: 0,
  twosUnder: 0,
};
let longest = 0;

for (let seed = 1; seed <= 900; seed++) {
  const rng = mulberry32(seed);
  const playerCount = 2 + (seed % 5);
  const includeJokers = seed % 4 !== 0;
  const mode: EndMode = seed % 3 === 0 ? "first" : "ranking";
  const cardsPerPlayer = Math.min(3 + (seed % 7), maxCardsPerPlayer(playerCount, includeJokers));
  const expected = includeJokers ? 54 : 52;

  let state = createGame({
    cardsPerPlayer,
    includeJokers,
    mode,
    playerNames: Array.from({ length: playerCount }, (_, i) => `P${i}`),
    randomStart: true,
    rng,
  });

  let turns = 0;

  while (!state.over && turns < 6000) {
    state = seed % 2 === 0 ? chaosTurn(state, rng) : botTurn(state, rng);
    turns++;

    assert.equal(totalCards(state), expected, `card count, seed ${seed}`);
    assert.ok(
      state.pending === 0 || topCard(state).rank === "7" || topCard(state).rank === "joker",
      `an attack needs a 7 or joker on top, seed ${seed}`,
    );
    assert.ok(
      state.demand === null || topCard(state).rank === "J",
      `a request needs a jack on top, seed ${seed}`,
    );
    assert.ok(state.pending === 0 || state.demand === null);

    for (const id of state.finished) {
      if (!state.over || mode === "first") {
        assert.equal(state.players.find((p) => p.id === id)?.hand.length, 0, "out means no cards");
      }
    }
  }

  assert.ok(state.over, `seed ${seed} did not finish in 6000 turns`);
  assert.equal(state.finished[0], state.winner);
  assert.equal(new Set(state.finished).size, state.finished.length, "nobody is ranked twice");

  if (mode === "ranking") {
    assert.equal(state.finished.length, playerCount, "everybody is ranked");
    seen.rankings++;
  } else {
    assert.ok(state.finished.length >= 1);
  }

  for (const event of state.events) {
    if (event.type === "skip") seen.skips++;
    if (event.type === "penalty" && event.count > 0) seen.penalties++;
    if (event.type === "play" && event.demand) seen.jackRequests++;
    if (event.type === "play" && event.placement === "under") seen.twosUnder++;
    if (event.type === "play" && (event.card.rank === "7" || event.card.rank === "joker")) seen.attacks++;
  }

  longest = Math.max(longest, turns);
}

assert.ok(seen.skips > 50 && seen.penalties > 50 && seen.jackRequests > 50 && seen.twosUnder > 50 && seen.attacks > 50, `the simulations used every special card: ${JSON.stringify(seen)}`);

console.log(
  `All checks passed. 900 simulated games finished (longest: ${longest} turns). Specials seen: ${JSON.stringify(seen)}`,
);
