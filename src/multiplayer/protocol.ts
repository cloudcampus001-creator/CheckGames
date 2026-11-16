/**
 * What the server and the browsers say to each other. Types only, plus a few
 * shared constants, so both sides can import it safely.
 */
import type {
  Card,
  EndMode,
  Placement,
  Suit,
} from "../cheque-games/engine";

/** The deck only has 54 cards, so a table tops out at 50 seats. */
export const MAX_SEATS = 50;
export const MIN_SEATS = 2;

export type Phase = "lobby" | "playing" | "finished";

/** Rules the host chooses before launching. More will be added here. */
export type RoomSettings = {
  cardsPerPlayer: number;
  /** Play with the red and black joker (54 cards). */
  jokers: boolean;
  /**
   * "first": when one player games, the others still play out the round. If
   *          two or more game in the same round, each takes 2 cards and they
   *          play on.
   * "ranking": the others carry on until everyone is ranked (1st, 2nd, ...).
   */
  endMode: EndMode;
  /**
   * Only with "ranking": the player who comes last is out for the next set,
   * until two are left (the final). After the final everybody is back.
   */
  elimination: boolean;
};

// --- chat, stickers and votes ---------------------------------------------------

/** Longest chat message, in characters. */
export const CHAT_MAX_CHARS = 140;

/**
 * The stickers a player can throw at the table. Short words (all capitals and
 * "!") are drawn as a badge, everything else as a big animated emoji.
 */
export const REACTIONS = [
  "😂",
  "😭",
  "🔥",
  "😎",
  "👏",
  "🤯",
  "😡",
  "🙏",
  "❤️",
  "🥶",
  "💀",
  "🤝",
  "GG!",
  "WOW!",
  "OOPS!",
  "FAST!",
] as const;

/** One-tap messages in the chat box. */
export const QUICK_PHRASES = [
  "Check! 😈",
  "Play faster 😤",
  "Nice one 👏",
  "GG 🤝",
  "Again!",
  "Who took my card?!",
] as const;

/** A line in the chat. `seatId` is null for messages from the table itself. */
export type ChatMessage = {
  id: number;
  seatId: string | null;
  /** The name at the time, so it still reads right after someone leaves. */
  name: string;
  text: string;
  at: number;
};

/** A sticker that was just thrown. `seq` counts up through the whole room. */
export type ReactionEvent = { seq: number; seatId: string; emoji: string };

export type VoteKind = "rules" | "kick" | "rematch";
export type VoteTopic = "cards" | "jokers" | "ending";

export type VoteView = {
  id: number;
  kind: VoteKind;
  title: string;
  /** Who started it. */
  byId: string;
  options: { id: string; label: string; count: number }[];
  /** The option this viewer picked, or null. */
  yourChoice: string | null;
  /** This viewer is allowed to vote. */
  canVote: boolean;
  /** The one who started it, or the host, can call it off. */
  canCancel: boolean;
  /** Milliseconds left, when this view was made. */
  endsInMs: number;
  /** How many people may vote, and how many already did. */
  voters: number;
  voted: number;
};

export type SeatView = {
  id: string;
  name: string;
  kind: "human" | "bot";
  /** Bots are always "connected". A human is connected while their page is open. */
  connected: boolean;
  isHost: boolean;
  /** Number of cards in hand (never which cards). */
  handCount: number;
  checked: boolean;
  isCurrent: boolean;
  /** Playing in the current set (false for eliminated players, who watch). */
  inGame: boolean;
  /** Finishing place in this set (1 = first out), or null if still playing. */
  rank: number | null;
  /** Knocked out of the tournament until the next final is over. */
  eliminated: boolean;
  /** Lost a tie: watches while the tied players play on. */
  sittingOut: boolean;
  /** Pressed "ready" in the lobby. Bots are always ready. */
  ready: boolean;
  /** Sets won since this room was made. */
  wins: number;
};

/** How many cards of the pile (newest on top) every player gets to see. */
export const PILE_VISIBLE = 8;
/** How many recent moves ride along with each update. */
export const MOVES_WINDOW = 40;
/** How many chat lines and stickers ride along with each update. */
export const CHAT_WINDOW = 30;
export const REACTIONS_WINDOW = 12;

/**
 * Something that just happened at the table, for animations. `seq` counts up
 * through the whole game, so a browser can tell which moves it has not shown
 * yet. A draw only names the card to the player who took it.
 */
export type MoveView = { seq: number } & (
  | {
      type: "play";
      seatId: string;
      card: Card;
      /** A 2 can go under the centre card. */
      placement: Placement;
      /** The sign a jack asked for. */
      demand: Suit | null;
    }
  | {
      type: "draw";
      seatId: string;
      /** Part of a penalty (taken because of a 7 or a joker). */
      forced: boolean;
      /** Only present for the player who took it. */
      card?: Card;
    }
  /** The seat was stopped by an ace. */
  | { type: "skip"; seatId: string }
  /** The seat has finished taking the cards a 7 or a joker made them take. */
  | { type: "penalty"; seatId: string; count: number }
  /** The pile under the centre card was mixed and became the new bank. */
  | { type: "reshuffle"; count: number }
  /** The seat is down to one card (announced automatically). */
  | { type: "check"; seatId: string }
  | { type: "games"; seatId: string; rank: number }
  /** Several seats finished in the same round: each took `cards` and plays on. */
  | { type: "tie"; seatIds: string[]; cards: number }
);

export type Standing = { seatId: string; name: string; rank: number };

export type GameView = {
  /** Changes with every set, so a browser knows `moves` start over. */
  gameId: number;
  /** The face-up card everyone plays on. */
  centre: Card;
  /** The top of the pile, oldest first. The last card is the centre card. */
  pile: Card[];
  /** Recent moves, oldest first. */
  moves: MoveView[];
  bankCount: number;
  currentSeatId: string;
  /** First player out (null until someone is). */
  winnerId: string | null;
  /** The set is over. */
  over: boolean;
  /** Final order of this set, best first. Filled when the set is over. */
  standings: Standing[];
  /** How many cards the next player has to take (7 = 2, joker = 4, chained). */
  pending: number;
  /** The sign a jack asked for, or null. */
  demand: Suit | null;
  /** Only the viewer's own cards. */
  hand: Card[];
  /** Cards you may play right now (empty unless it is your turn). */
  playableIds: string[];
  /** The bank is open to you: your turn, and there is something to take. */
  canDraw: boolean;
  /** Recent happenings in plain words, newest last. */
  log: string[];
};

export type TournamentView = {
  /** 1 for the first set; goes up each time the host starts the next one. */
  set: number;
  /** The current (or next) set has just two players: the final. */
  finalSet: boolean;
  /** Set once the final is over. */
  championId: string | null;
  /** The host can start another set. */
  nextSetAvailable: boolean;
  eliminatedIds: string[];
};

/** Everything one player is allowed to know about a room. */
export type RoomView = {
  code: string;
  /** Goes up on every change so browsers can ignore stale updates. */
  version: number;
  phase: Phase;
  /** The viewer's own seat id. */
  you: string;
  hostId: string;
  settings: RoomSettings;
  maxCardsPerPlayer: number;
  seats: SeatView[];
  tournament: TournamentView;
  game: GameView | null;
  /** The latest chat lines, oldest first. */
  chat: ChatMessage[];
  /** The latest stickers, oldest first. */
  reactions: ReactionEvent[];
  /** The vote that is running, or null. */
  vote: VoteView | null;
  /** After a set the table goes back to the lobby by itself. */
  autoReturn: boolean;
  /** Milliseconds until that happens (when this view was made), or null. */
  returnInMs: number | null;
  /** When it is a bot's turn: milliseconds until it moves (when this view was made). */
  botInMs: number | null;
};

export type ClientAction =
  // host, lobby
  | { type: "addBot" }
  | { type: "removeSeat"; seatId: string }
  | {
      type: "setSettings";
      cardsPerPlayer?: number;
      jokers?: boolean;
      endMode?: EndMode;
      elimination?: boolean;
    }
  | { type: "setAutoReturn"; value: boolean }
  | { type: "makeHost"; seatId: string }
  | { type: "start" }
  // host, during a game
  | { type: "replaceWithBot"; seatId: string }
  // host, after a set
  | { type: "nextSet" }
  | { type: "playAgain" }
  | { type: "backToLobby" }
  // everyone, during a game
  | { type: "play"; cardId: string; placement?: Placement; suit?: Suit }
  | { type: "draw" }
  | { type: "check" }
  // everyone
  | { type: "leave" }
  | { type: "chat"; text: string }
  | { type: "react"; emoji: string }
  | { type: "ready"; ready: boolean }
  | { type: "startVote"; kind: VoteKind; topic?: VoteTopic; seatId?: string }
  | { type: "castVote"; choice: string }
  | { type: "cancelVote" };
