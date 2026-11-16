/**
 * Cheque-games engine. Pure and framework-free: every function takes a state
 * and returns a new one, so it is easy to test and to run on a server.
 *
 * Basic rules
 *  - 2+ players, 52 cards (+2 jokers if switched on).
 *  - Equal hands are dealt, one ordinary card goes in the centre, the rest is
 *    the bank.
 *  - On your turn you play a card that matches the centre card's rank
 *    ("character") or suit ("sign"), or you take the top card of the bank.
 *    The bank is always open on your turn, even if you have a card to play.
 *    Taking a card ends your turn.
 *  - When the bank is finished, every card under the centre card is mixed
 *    (shuffled) and becomes the new bank.
 *  - Left with one card you are "on check" (it is announced automatically).
 *    Play your last card: "games".
 *  - Turns come in rounds: a round is over once everybody still playing has
 *    had their turn since it began. The system keeps track of that quietly.
 *
 * Special cards
 *  - A      The next player is stopped; the one after plays. With only two
 *           players that "one after" is you again, so you play again. That is
 *           why an A can NOT be your winning card when two are playing: you
 *           would have to play again with no card, so you take one from the
 *           bank and you are on check again.
 *  - 2      Plays on anything. You choose: on top (it becomes the centre
 *           card) or under (the centre card stays as it was).
 *  - 7      The next player takes 2 cards from the bank...
 *  - Joker  ...or 4 cards. Whoever is hit can answer with a 7 (adds 2) or a
 *           joker (adds 4) of any colour, passing the total on. Outside of
 *           that, a red joker only goes on a red card, a black one on a
 *           black card.
 *  - J      Plays on anything. You name a sign. The next player must play a
 *           card of that sign, or a 2, or a J, or the joker of that sign's
 *           colour (red joker for hearts/diamonds, black joker for
 *           clubs/spades). The request stays until a card lands on top.
 *
 * How a set ends
 *  - "first":   when a player goes out, the others still play the rest of
 *               that round. If only one player went out, they win. If two or
 *               more went out in the same round it is a tie: each of them takes
 *               2 cards from the bank and the play-off goes on between them.
 *  - "ranking": the others carry on until only one is left; everyone is
 *               ranked in the order they went out.
 */

export const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
] as const;
export const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
export type JokerColour = "red" | "black";

export type StandardCard = { id: string; rank: Rank; suit: Suit };
export type JokerCard = { id: string; rank: "joker"; suit: JokerColour };
export type Card = StandardCard | JokerCard;

export type Player = {
  id: string;
  name: string;
  hand: Card[];
};

export type Placement = "top" | "under";
export type EndMode = "first" | "ranking";

export type GameEvent =
  | { type: "start" }
  | {
      type: "play";
      playerId: string;
      card: Card;
      placement: Placement;
      /** The sign a jack asked for. */
      demand: Suit | null;
    }
  /** One card taken from the bank. `forced` means it was part of a penalty. */
  | { type: "draw"; playerId: string; card: Card; forced: boolean }
  /** A player took the cards a 7 or a joker made them take. */
  | { type: "penalty"; playerId: string; count: number }
  /** A player was stopped by an ace. */
  | { type: "skip"; playerId: string }
  /** The pile under the centre card was mixed and became the new bank. */
  | { type: "reshuffle"; count: number }
  | { type: "bank-empty"; playerId: string }
  | { type: "check"; playerId: string }
  /** A player played their last card. `rank` is 1 for the first one out. */
  | { type: "games"; playerId: string; rank: number }
  /** Several players went out in the same round: each takes `cards` and the play-off goes on. */
  | { type: "tie"; playerIds: string[]; cards: number }
  /** Nobody can move any more. */
  | { type: "stalemate" };

export type GameState = {
  players: Player[];
  /** Face-down draw pile. The next card drawn is the last element. */
  bank: Card[];
  /** Discard pile. The last element is the centre card everyone plays on. */
  pile: Card[];
  /** Index into `players` of whoever's turn it is. */
  current: number;
  /** Players who have called "check" and still hold exactly one card. */
  checked: string[];
  mode: EndMode;
  /** Players who played their last card, in the order they went out. */
  finished: string[];
  /** The first player out, or null. */
  winner: string | null;
  over: boolean;
  /** Cards the next player must take, unless they answer with a 7 or joker. */
  pending: number;
  /** The sign a jack asked for. Lasts until a card lands on top. */
  demand: Suit | null;
  /** Turns in a row where nobody could take a card. */
  stalled: number;
  events: GameEvent[];
  /** Players who lost a tie and sit out the play-off. */
  benched?: string[];
  /** Seat index of whoever began the current round. */
  roundStart?: number;
  /** Events dropped from the front of `events` to keep the state small. */
  eventBase?: number;
};

export type Rng = () => number;

export type CreateGameOptions = {
  playerNames: readonly string[];
  cardsPerPlayer: number;
  includeJokers?: boolean;
  mode?: EndMode;
  /** Ids to give the players, in the same order as `playerNames`. Default p0, p1... */
  playerIds?: readonly string[];
  /** Pick a random player to go first instead of the first one. */
  randomStart?: boolean;
  rng?: Rng;
};

export type PlayOptions = {
  /** For a 2 only. Default "top". */
  placement?: Placement;
  /** For a jack only: the sign you ask for. */
  suit?: Suit;
  /** Random source (used if a tie makes the pile be mixed). */
  rng?: Rng;
};

/** Cards each player takes when several finish in the same round. */
export const TIE_CARDS = 2;

export type Result =
  | { ok: true; state: GameState }
  | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({
  ok: false,
  reason,
});

export function isJoker(card: Card): card is JokerCard {
  return card.rank === "joker";
}

export function isStandard(card: Card): card is StandardCard {
  return card.rank !== "joker";
}

const SPECIAL_RANKS: ReadonlySet<string> = new Set(["A", "2", "7", "J"]);

/** A, 2, 7, J and the jokers. */
export function isSpecial(card: Card) {
  return isJoker(card) || SPECIAL_RANKS.has(card.rank);
}

/** Hearts and diamonds are red; clubs and spades are black. */
export function suitColour(suit: Suit): JokerColour {
  return suit === "hearts" || suit === "diamonds" ? "red" : "black";
}

/** Red or black: the colour of a card's suit, or of a joker. */
export function colourOf(card: Card): JokerColour {
  if (isJoker(card)) {
    return card.suit;
  }

  return suitColour(card.suit);
}

export function createDeck(includeJokers = false): Card[] {
  const deck: Card[] = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${rank}-${suit}`, rank, suit });
    }
  }

  if (includeJokers) {
    deck.push({ id: "joker-red", rank: "joker", suit: "red" });
    deck.push({ id: "joker-black", rank: "joker", suit: "black" });
  }

  return deck;
}

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

/** Most cards each player can be dealt while leaving a centre card and a bank. */
export function maxCardsPerPlayer(playerCount: number, includeJokers = false) {
  const deckSize = includeJokers ? 54 : 52;

  // Reserve one card for the centre and at least one for the bank.
  return Math.floor((deckSize - 2) / playerCount);
}

export function createGame({
  cardsPerPlayer,
  includeJokers = false,
  mode = "first",
  playerIds,
  playerNames,
  randomStart = false,
  rng = Math.random,
}: CreateGameOptions): GameState {
  if (playerNames.length < 2) {
    throw new Error("Cheque-games needs at least 2 players.");
  }

  if (playerIds && playerIds.length !== playerNames.length) {
    throw new Error("Give every player an id, or none at all.");
  }

  if (cardsPerPlayer < 1) {
    throw new Error("Each player needs at least 1 card.");
  }

  if (cardsPerPlayer > maxCardsPerPlayer(playerNames.length, includeJokers)) {
    throw new Error("Not enough cards in the deck for that many players.");
  }

  const deck = shuffle(createDeck(includeJokers), rng);
  const players: Player[] = playerNames.map((name, index) => ({
    hand: [],
    id: playerIds ? playerIds[index] : `p${index}`,
    name,
  }));

  // Deal one card at a time around the table so hands are equal.
  for (let round = 0; round < cardsPerPlayer; round++) {
    for (const player of players) {
      player.hand.push(deck.pop() as Card);
    }
  }

  // The first centre card is an ordinary one, so nobody starts under an
  // attack or a request. Special cards found on the way stay in the bank.
  let centreIndex = deck.length - 1;

  while (centreIndex > 0 && isSpecial(deck[centreIndex])) {
    centreIndex -= 1;
  }

  const [centre] = deck.splice(centreIndex, 1);
  const start = randomStart ? Math.floor(rng() * players.length) : 0;

  return {
    bank: deck,
    benched: [],
    checked: [],
    current: start,
    eventBase: 0,
    roundStart: start,
    demand: null,
    events: [{ type: "start" }],
    finished: [],
    mode,
    over: false,
    pending: 0,
    pile: [centre],
    players,
    stalled: 0,
    winner: null,
  };
}

export function topCard(state: GameState): Card {
  return state.pile[state.pile.length - 1];
}

// --- what can be played --------------------------------------------------

export type PlayContext = {
  centre: Card;
  pending: number;
  demand: Suit | null;
};

export function playContext(state: GameState): PlayContext {
  return {
    centre: topCard(state),
    demand: state.demand,
    pending: state.pending,
  };
}

/** Can this card be played right now, given the centre card and any attack or request? */
export function isPlayable(card: Card, context: PlayContext) {
  // Under attack you can only pass it on with a 7 or a joker.
  if (context.pending > 0) {
    return card.rank === "7" || isJoker(card);
  }

  // After a jack: the sign asked for, a 2, a jack, or the joker of the
  // colour asked for (the red joker for a red sign, the black for a black).
  if (context.demand) {
    return (
      card.rank === "2" ||
      card.rank === "J" ||
      (isStandard(card) && card.suit === context.demand) ||
      (isJoker(card) && card.suit === suitColour(context.demand))
    );
  }

  // A 2 and a jack go on anything.
  if (card.rank === "2" || card.rank === "J") {
    return true;
  }

  const { centre } = context;

  // A joker only goes on its own colour; and only its own colour goes on it.
  if (isJoker(card) || isJoker(centre)) {
    return colourOf(card) === colourOf(centre);
  }

  return card.rank === centre.rank || card.suit === centre.suit;
}

function whyNot(card: Card, context: PlayContext) {
  if (context.pending > 0) {
    return `Answer with a 7 or a joker, or take the ${context.pending} cards.`;
  }

  if (context.demand) {
    return `Play a ${context.demand.slice(0, -1)} card, a 2 or a jack, or the ${suitColour(context.demand)} joker.`;
  }

  if (isJoker(card)) {
    return `A ${card.suit} joker only goes on a ${card.suit} card.`;
  }

  if (isJoker(context.centre)) {
    return `Only ${colourOf(context.centre)} cards go on a ${colourOf(context.centre)} joker.`;
  }

  return "That card does not match the centre card.";
}

export function legalPlays(state: GameState, playerId: string): Card[] {
  const player = state.players.find((candidate) => candidate.id === playerId);

  if (!player || state.over || outOf(state).includes(playerId)) {
    return [];
  }

  const context = playContext(state);

  return player.hand.filter((card) => isPlayable(card, context));
}

// --- turns -------------------------------------------------------------------

function checkTurn(state: GameState, playerId: string): string | null {
  if (state.over) {
    return "The game is over.";
  }

  if (state.players[state.current].id !== playerId) {
    return "It is not your turn.";
  }

  return null;
}

/** Players who are not playing: gone out, or sitting out a play-off. */
function outOf(state: Pick<GameState, "finished" | "benched">) {
  return [...state.finished, ...(state.benched ?? [])];
}

/** The next player after `from` who is still in the game. */
function nextActive(
  players: readonly Player[],
  out: readonly string[],
  from: number,
) {
  for (let step = 1; step <= players.length; step++) {
    const index = (from + step) % players.length;

    if (!out.includes(players[index].id)) {
      return index;
    }
  }

  return from;
}

export function activePlayers(state: GameState) {
  const out = outOf(state);

  return state.players.filter((player) => !out.includes(player.id));
}

/** Seats you pass going forward from `from` to `to` (a full circle if they are the same seat). */
function distance(from: number, to: number, count: number) {
  const steps = (to - from + count) % count;

  return steps === 0 ? count : steps;
}

/**
 * Several players went out in the same round. Each takes cards from the bank
 * and the play-off goes on between them; everybody else sits out.
 */
function settleTie(state: GameState, rng: Rng): GameState {
  const winners = state.players
    .filter((player) => state.finished.includes(player.id))
    .map((player) => player.id);
  const events: GameEvent[] = [
    ...state.events,
    { cards: TIE_CARDS, playerIds: winners, type: "tie" },
  ];
  let bank = [...state.bank];
  let pile = [...state.pile];
  const hands = new Map<string, Card[]>();

  for (const id of winners) {
    const hand: Card[] = [];

    for (let i = 0; i < TIE_CARDS; i++) {
      if (bank.length === 0 && pile.length > 1) {
        ({ bank, pile } = mixPileIntoBank(pile, rng, events));
      }

      if (bank.length === 0) {
        break;
      }

      const card = bank.pop() as Card;

      hand.push(card);
      events.push({ card, forced: true, playerId: id, type: "draw" });

      if (bank.length === 0 && pile.length > 1) {
        ({ bank, pile } = mixPileIntoBank(pile, rng, events));
      }
    }

    hands.set(id, hand);
  }

  const players = state.players.map((player) =>
    hands.has(player.id)
      ? { ...player, hand: hands.get(player.id) as Card[] }
      : player,
  );

  // No cards left to share: the tie stands and the set ends.
  if (winners.some((id) => (hands.get(id) as Card[]).length === 0)) {
    return {
      ...state,
      bank,
      events,
      over: true,
      pile,
      players,
      winner: state.winner ?? winners[0],
    };
  }

  const benched = [
    ...(state.benched ?? []),
    ...state.players
      .filter(
        (player) =>
          !winners.includes(player.id) &&
          !(state.benched ?? []).includes(player.id),
      )
      .map((player) => player.id),
  ];
  let current = state.current;

  for (let step = 0; step < players.length; step++) {
    const index = (state.current + step) % players.length;

    if (winners.includes(players[index].id)) {
      current = index;
      break;
    }
  }

  return {
    ...state,
    bank,
    benched,
    checked: [],
    current,
    demand: null,
    events,
    finished: [],
    pending: 0,
    pile,
    players,
    roundStart: current,
    stalled: 0,
    winner: null,
  };
}

/**
 * Hand the turn on. This is also where rounds are counted: when the turn
 * reaches the seat that began the round, the round is complete. In "first"
 * mode that is when a set that has a player out really ends.
 */
function passTurn(
  state: GameState,
  from: number,
  skipNext: boolean,
  rng: Rng,
): GameState {
  const { players } = state;
  const count = players.length;
  const out = outOf(state);
  const events = [...state.events];
  let current = nextActive(players, out, from);
  let travelled = distance(from, current, count);

  if (skipNext) {
    events.push({ playerId: players[current].id, type: "skip" });

    const after = nextActive(players, out, current);

    travelled += distance(current, after, count);
    current = after;
  }

  const next: GameState = { ...state, current, events };
  const start = state.roundStart ?? from;

  if (travelled < distance(from, start, count)) {
    return next;
  }

  // The round is complete; a new one begins with whoever is up now.
  const fresh = { ...next, roundStart: current };

  if (state.mode !== "first" || state.finished.length === 0) {
    return fresh;
  }

  if (state.finished.length === 1) {
    return { ...fresh, over: true, winner: state.winner ?? state.finished[0] };
  }

  return settleTie(fresh, rng);
}

export function playCard(
  state: GameState,
  playerId: string,
  cardId: string,
  options: PlayOptions = {},
): Result {
  const turnError = checkTurn(state, playerId);

  if (turnError) {
    return fail(turnError);
  }

  const player = state.players[state.current];
  const card = player.hand.find((candidate) => candidate.id === cardId);

  if (!card) {
    return fail("You do not have that card.");
  }

  const context = playContext(state);

  if (!isPlayable(card, context)) {
    return fail(whyNot(card, context));
  }

  const placement: Placement = options.placement ?? "top";

  if (placement === "under" && card.rank !== "2") {
    return fail("Only a 2 can go under the centre card.");
  }

  if (card.rank === "J" && (!options.suit || !SUITS.includes(options.suit))) {
    return fail("Choose a sign for the jack.");
  }

  const hand = player.hand.filter((candidate) => candidate.id !== cardId);
  const players = state.players.map((candidate) =>
    candidate.id === playerId ? { ...candidate, hand } : candidate,
  );
  const events: GameEvent[] = [...state.events];
  const pile = [...state.pile];
  let pending = state.pending;
  let demand = state.demand;
  let skipNext = false;
  let askedFor: Suit | null = null;

  if (placement === "under") {
    // Slides under the centre card: the centre card, and any request, stay.
    pile.splice(pile.length - 1, 0, card);
  } else {
    pile.push(card);
    demand = null;

    if (card.rank === "J") {
      askedFor = options.suit as Suit;
      demand = askedFor;
    } else if (card.rank === "7") {
      pending += 2;
    } else if (isJoker(card)) {
      pending += 4;
    } else if (card.rank === "A") {
      skipNext = true;
    }
  }

  events.push({ card, demand: askedFor, placement, playerId, type: "play" });

  const checked = state.checked.filter((id) => id !== playerId);
  let finished = state.finished;
  let winner = state.winner;
  let over = false;

  // With only two players left, an ace stops the other one and the turn comes
  // straight back to you. With no card in hand you would have to take one, so
  // the ace cannot be the card that wins the game.
  const aceStopsAtTheEnd =
    hand.length === 0 && skipNext && activePlayers(state).length === 2;

  if (hand.length === 1) {
    // Down to one card: on check. Everybody is told, no button needed.
    checked.push(playerId);
    events.push({ playerId, type: "check" });
  }

  if (hand.length === 0 && !aceStopsAtTheEnd) {
    finished = [...finished, playerId];
    winner = winner ?? playerId;
    events.push({ playerId, rank: finished.length, type: "games" });

    // "first": the others still play out the round, so nothing ends yet.
    if (state.mode === "ranking") {
      const remaining = players.filter((p) => !finished.includes(p.id));

      if (remaining.length <= 1) {
        over = true;

        // The one left holding cards is last.
        if (remaining.length === 1) {
          finished = [...finished, remaining[0].id];
        }
      }
    }
  }

  if (over) {
    return {
      ok: true,
      state: {
        ...state,
        checked,
        demand,
        events,
        finished,
        over,
        pending,
        pile,
        players,
        stalled: 0,
        winner,
      },
    };
  }

  const rng = options.rng ?? Math.random;
  const passed = passTurn(
    {
      ...state,
      checked,
      demand,
      events,
      finished,
      over,
      pending,
      pile,
      players,
      stalled: 0,
      winner,
    },
    state.current,
    skipNext,
    rng,
  );

  if (!aceStopsAtTheEnd || passed.over) {
    return { ok: true, state: passed };
  }

  // The turn is back with the player who just played their last card, so
  // they take a card from the bank and are on check again.
  const drawn = drawCard(passed, playerId, rng);

  if (!drawn.ok) {
    return { ok: true, state: passed };
  }

  const taken = drawn.state.players.find((p) => p.id === playerId);

  if (taken && taken.hand.length === 1 && !drawn.state.checked.includes(playerId)) {
    return {
      ok: true,
      state: {
        ...drawn.state,
        checked: [...drawn.state.checked, playerId],
        events: [...drawn.state.events, { playerId, type: "check" }],
      },
    };
  }

  return drawn;
}

/**
 * Everything under the centre card is mixed and becomes the new bank. The
 * centre card stays where it is.
 */
function mixPileIntoBank(pile: Card[], rng: Rng, events: GameEvent[]) {
  const under = pile.slice(0, -1);

  events.push({ count: under.length, type: "reshuffle" });

  return { bank: shuffle(under, rng), pile: [pile[pile.length - 1]] };
}

/**
 * Can this player take from the bank right now? On your own turn the bank is
 * always open, even if you have a card to play. The one exception is a bank
 * with nothing left in it anywhere: then you must play if you can. Under
 * attack, taking the cards is how you accept it.
 */
export function canDraw(state: GameState, playerId: string) {
  if (checkTurn(state, playerId)) {
    return false;
  }

  if (state.pending > 0 || state.bank.length > 0 || state.pile.length > 1) {
    return true;
  }

  return legalPlays(state, playerId).length === 0;
}

function endByStalemate(state: GameState): GameState {
  // Fewest cards ranks highest; ties keep seat order.
  const order = activePlayers(state)
    .map((player, seat) => ({ player, seat }))
    .sort(
      (a, b) => a.player.hand.length - b.player.hand.length || a.seat - b.seat,
    )
    .map((entry) => entry.player.id);
  const finished = [...state.finished, ...order];

  return {
    ...state,
    events: [...state.events, { type: "stalemate" }],
    finished,
    over: true,
    winner: state.winner ?? finished[0],
  };
}

/**
 * Take from the bank. Normally that is one card. Under attack (a 7 or joker
 * was played on you) it is all the cards you owe. Either way your turn ends.
 */
export function drawCard(
  state: GameState,
  playerId: string,
  rng: Rng = Math.random,
): Result {
  const turnError = checkTurn(state, playerId);

  if (turnError) {
    return fail(turnError);
  }

  const events: GameEvent[] = [...state.events];
  let bank = [...state.bank];
  let pile = [...state.pile];
  const owed = state.pending;
  const wanted = owed > 0 ? owed : 1;
  const hand = [...state.players[state.current].hand];
  let taken = 0;

  // Nothing at all to take: you must play if you can.
  if (
    owed === 0 &&
    bank.length === 0 &&
    pile.length <= 1 &&
    legalPlays(state, playerId).length > 0
  ) {
    return fail("The bank is empty. Play a card.");
  }

  for (let i = 0; i < wanted; i++) {
    // Safety net: the bank is normally refilled the moment it is finished.
    if (bank.length === 0 && pile.length > 1) {
      ({ bank, pile } = mixPileIntoBank(pile, rng, events));
    }

    if (bank.length === 0) {
      break;
    }

    const card = bank.pop() as Card;

    hand.push(card);
    taken += 1;
    events.push({ card, forced: owed > 0, playerId, type: "draw" });

    // That was the last card of the bank: mix the pile into a new one now.
    if (bank.length === 0 && pile.length > 1) {
      ({ bank, pile } = mixPileIntoBank(pile, rng, events));
    }
  }

  if (owed > 0) {
    events.push({ count: taken, playerId, type: "penalty" });
  } else if (taken === 0) {
    events.push({ playerId, type: "bank-empty" });
  }

  const players = state.players.map((candidate) =>
    candidate.id === playerId ? { ...candidate, hand } : candidate,
  );
  const next = passTurn(
    {
      ...state,
      bank,
      checked: state.checked.filter((id) => id !== playerId),
      events,
      pending: 0,
      pile,
      players,
      stalled: taken === 0 ? state.stalled + 1 : 0,
    },
    state.current,
    false,
    rng,
  );

  if (!next.over && next.stalled >= activePlayers(next).length) {
    return { ok: true, state: endByStalemate(next) };
  }

  return { ok: true, state: next };
}

/** Call "check" when you are down to your last card. Works on any turn. */
export function callCheck(state: GameState, playerId: string): Result {
  if (state.over) {
    return fail("The game is over.");
  }

  const player = state.players.find((candidate) => candidate.id === playerId);

  if (!player || outOf(state).includes(playerId)) {
    return fail("Unknown player.");
  }

  if (player.hand.length !== 1) {
    return fail("You can only call check with one card left.");
  }

  if (state.checked.includes(playerId)) {
    return fail("You already called check.");
  }

  return {
    ok: true,
    state: {
      ...state,
      checked: [...state.checked, playerId],
      events: [...state.events, { playerId, type: "check" }],
    },
  };
}

/** The sign a bot asks for after a jack: the one it holds most of. */
function bestSuit(hand: readonly Card[], rng: Rng): Suit {
  const counts = new Map<Suit, number>();

  for (const card of hand) {
    if (isStandard(card)) {
      counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1);
    }
  }

  let best: Suit | null = null;

  for (const [suit, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) {
      best = suit;
    }
  }

  return best ?? SUITS[Math.floor(rng() * SUITS.length)];
}

/**
 * A simple bot: plays any card that is allowed (answers an attack if it can),
 * otherwise takes from the bank, and always calls check. Returns the state
 * after one full turn.
 */
export function botTurn(state: GameState, rng: Rng = Math.random): GameState {
  if (state.over) {
    return state;
  }

  const player = state.players[state.current];
  const plays = legalPlays(state, player.id);

  const draw = () => {
    const drawn = drawCard(state, player.id, rng);

    return drawn.ok ? drawn.state : state;
  };

  if (plays.length === 0) {
    return draw();
  }

  const card = plays[Math.floor(rng() * plays.length)];
  const options: PlayOptions = {};

  if (card.rank === "J") {
    options.suit = bestSuit(
      player.hand.filter((other) => other.id !== card.id),
      rng,
    );
  }

  if (card.rank === "2") {
    options.placement = rng() < 0.3 ? "under" : "top";
  }

  const played = playCard(state, player.id, card.id, { ...options, rng });

  if (!played.ok) {
    return draw();
  }

  return played.state;
}

/**
 * Keep the event list short. Games can run for hundreds of turns and the whole
 * state is stored after every move, so old events are dropped from the front.
 * `eventBase` remembers how many were dropped, so moves keep their numbers.
 */
export function trimEvents(state: GameState, keep = 80): GameState {
  if (state.events.length <= keep * 1.5) {
    return state;
  }

  const drop = state.events.length - keep;

  return {
    ...state,
    eventBase: (state.eventBase ?? 0) + drop,
    events: state.events.slice(drop),
  };
}
