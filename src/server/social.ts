/**
 * The social side of a room: chat, stickers, ready-ups, win counts and votes.
 *
 * Like rooms.ts, everything here is plain functions on plain data, so it can
 * be saved in the shared store after every change. Nothing keeps a timer or
 * an open connection: a vote that runs out of time is closed by whoever asks
 * about the room next (see tickBots in rooms.ts).
 *
 * A room made before this file existed has no `social` part. `ensureSocial`
 * gives it one, so old rooms in the store keep working.
 */
import type { EndMode, GameEvent } from "../cheque-games/engine";
import { emptyTally, type GameResult, type Tally } from "../multiplayer/profile";
import {
  CHAT_MAX_CHARS,
  CUSTOM_VOTE_MAX_OPTIONS,
  CUSTOM_VOTE_MIN_OPTIONS,
  type ChatMessage,
  REACTIONS,
  type ReactionEvent,
  type VoteKind,
  type VoteTopic,
} from "../multiplayer/protocol";

/** What a vote can change in the rules. */
export type VotePatch = {
  cardsPerPlayer?: number;
  jokers?: boolean;
  doubling?: boolean;
  endMode?: EndMode;
};

export type VoteOption = { id: string; label: string; patch: VotePatch | null };

export type Vote = {
  id: number;
  kind: VoteKind;
  /** Seat that started it. */
  by: string;
  title: string;
  options: VoteOption[];
  /** Seat id -> option id. */
  ballots: Record<string, string>;
  /** When time runs out. */
  endsAt: number;
  /** The player a "remove" vote is about. */
  targetId: string | null;
};

export type Social = {
  chat: ChatMessage[];
  chatSeq: number;
  reactions: ReactionEvent[];
  reactSeq: number;
  lastChatAt: Record<string, number>;
  lastReactAt: Record<string, number>;
  /** Seats that pressed "ready" in the lobby. */
  ready: Record<string, boolean>;
  /** Sets won since the room was made. */
  wins: Record<string, number>;
  /** After a set the table goes back to the lobby by itself. */
  autoReturn: boolean;
  /** When the current set ended, or null. */
  finishedAt: number | null;
  vote: Vote | null;
  voteSeq: number;
  /** No new vote may start before this moment. */
  voteCooldownUntil: number;
  /** Seconds each turn lasts (0 = no clock). */
  turnSeconds: number;
  /** Several cards of the same number may be played together. */
  doubling: boolean;
  /** When the player whose turn it is runs out of time, or null. */
  turnEndsAt: number | null;
  /** Clocks in a row that ran out, per seat. */
  timeouts: Record<string, number>;
  /** Seats the table plays for, until they come back. */
  away: Record<string, boolean>;
  /** A quick match found by the system (no host controls). */
  matchmade: boolean;
  /** How the latest set ended, for the profiles. */
  results: GameResult | null;
  /** What each seat did in the current set. */
  tallies: Record<string, Tally>;
  /** How many game events were already counted. */
  eventsSeen: number;
  /** Players with a profile who quit in the middle of the current set. */
  leavers: { profileId: string; name: string; seatId: string; tally: Tally }[];
};

export type Ok = { ok: true };
export type Err = { ok: false; error: string };

const CHAT_KEEP = 50;
const REACT_KEEP = 16;
/** Least time between two messages (or two stickers) from one player. */
export const CHAT_GAP_MS = 800;
export const REACT_GAP_MS = 450;
/** Rest after a vote, so nobody can spam them. */
export const VOTE_COOLDOWN_MS = 8000;

const err = (error: string): Err => ({ error, ok: false });
const done: Ok = { ok: true };

export function newSocial(): Social {
  return {
    autoReturn: true,
    away: {},
    chat: [],
    chatSeq: 0,
    doubling: false,
    eventsSeen: 0,
    finishedAt: null,
    lastChatAt: {},
    leavers: [],
    matchmade: false,
    lastReactAt: {},
    ready: {},
    reactSeq: 0,
    reactions: [],
    results: null,
    tallies: {},
    timeouts: {},
    turnEndsAt: null,
    turnSeconds: 0,
    vote: null,
    voteCooldownUntil: 0,
    voteSeq: 0,
    wins: {},
  };
}

/** The room's social part for changing it. Fills in anything an old room lacks. */
export function ensureSocial(room: { social?: Social }): Social {
  const base = newSocial();

  if (!room.social) {
    room.social = base;

    return base;
  }

  const social = room.social as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(base)) {
    if (social[key] === undefined) {
      social[key] = value;
    }
  }

  return room.social;
}

/** The room's social part for reading. Never changes the room. */
export function socialOf(room: { social?: Social }): Social {
  return { ...newSocial(), ...(room.social ?? {}) };
}

/** Plain text only: no control characters, single spaces, cut to length. */
export function cleanText(raw: unknown, max = CHAT_MAX_CHARS) {
  const text = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return Array.from(text).slice(0, max).join("");
}

/** Too soon after the last one? A clock that jumps back never blocks anyone for long. */
const tooSoon = (last: number | undefined, now: number, gap: number) =>
  last !== undefined && now - last >= 0 && now - last < gap;

function pushChat(
  social: Social,
  seatId: string | null,
  name: string,
  text: string,
  now: number,
) {
  social.chatSeq += 1;
  social.chat.push({ at: now, id: social.chatSeq, name, seatId, text });

  if (social.chat.length > CHAT_KEEP) {
    social.chat.splice(0, social.chat.length - CHAT_KEEP);
  }
}

export function postChat(
  social: Social,
  seatId: string,
  name: string,
  raw: unknown,
  now: number,
): Ok | Err {
  const text = cleanText(raw);

  if (!text) {
    return err("Type a message first.");
  }

  if (tooSoon(social.lastChatAt[seatId], now, CHAT_GAP_MS)) {
    return err("Slow down a little.");
  }

  social.lastChatAt[seatId] = now;
  pushChat(social, seatId, name, text, now);

  return done;
}

/** A line from the table itself ("Amina joined", "Vote passed"). */
export function systemMessage(social: Social, text: string, now: number) {
  const clean = cleanText(text);

  if (clean) {
    pushChat(social, null, "", clean, now);
  }
}

export function isReaction(emoji: unknown): emoji is (typeof REACTIONS)[number] {
  return (REACTIONS as readonly unknown[]).includes(emoji);
}

export function postReaction(
  social: Social,
  seatId: string,
  emoji: unknown,
  now: number,
): Ok | Err {
  if (!isReaction(emoji)) {
    return err("That sticker does not exist.");
  }

  if (tooSoon(social.lastReactAt[seatId], now, REACT_GAP_MS)) {
    return err("Slow down a little.");
  }

  social.lastReactAt[seatId] = now;
  social.reactSeq += 1;
  social.reactions.push({ emoji, seatId, seq: social.reactSeq });

  if (social.reactions.length > REACT_KEEP) {
    social.reactions.splice(0, social.reactions.length - REACT_KEEP);
  }

  return done;
}

export function setReady(social: Social, seatId: string, ready: boolean) {
  if (ready) {
    social.ready[seatId] = true;
  } else {
    delete social.ready[seatId];
  }
}

export function addWin(social: Social, seatId: string) {
  social.wins[seatId] = (social.wins[seatId] ?? 0) + 1;
}

/** A seat left the table: forget everything kept about it. */
export function forgetSeat(social: Social, seatId: string) {
  delete social.ready[seatId];
  delete social.wins[seatId];
  delete social.lastChatAt[seatId];
  delete social.lastReactAt[seatId];
  delete social.timeouts[seatId];
  delete social.away[seatId];

  if (social.vote) {
    delete social.vote.ballots[seatId];

    // A vote about someone who is gone has nothing left to decide.
    if (social.vote.targetId === seatId) {
      social.vote = null;
    }
  }
}

// --- votes -------------------------------------------------------------------

export const yesNo = (): VoteOption[] => [
  { id: "yes", label: "Yes", patch: null },
  { id: "no", label: "No", patch: null },
];

/** The question and the choices for a vote on the rules. */
export function rulesVote(
  topic: unknown,
  maxCards: number,
): { title: string; options: VoteOption[] } | null {
  const topics: VoteTopic[] = ["cards", "jokers", "ending", "doubling"];

  if (!topics.includes(topic as VoteTopic)) {
    return null;
  }

  if (topic === "cards") {
    const sizes = [3, 5, 7, 9].filter((n) => n <= maxCards);

    return {
      options: (sizes.length > 0 ? sizes : [Math.max(1, maxCards)]).map((n) => ({
        id: `c${n}`,
        label: `${n} cards`,
        patch: { cardsPerPlayer: n },
      })),
      title: "How many cards each?",
    };
  }

  if (topic === "jokers") {
    return {
      options: [
        { id: "on", label: "With jokers", patch: { jokers: true } },
        { id: "off", label: "No jokers", patch: { jokers: false } },
      ],
      title: "Play with jokers?",
    };
  }

  if (topic === "doubling") {
    return {
      options: [
        { id: "on", label: "Doubling on", patch: { doubling: true } },
        { id: "off", label: "No doubling", patch: { doubling: false } },
      ],
      title: "Play several cards of the same number together?",
    };
  }

  return {
    options: [
      { id: "first", label: "Stop at the first win", patch: { endMode: "first" } },
      { id: "ranking", label: "Keep going", patch: { endMode: "ranking" } },
    ],
    title: "When someone plays their last card?",
  };
}

/** A question the host wrote, with 2 to 6 choices. */
export function customVote(
  question: unknown,
  rawOptions: unknown,
): { title: string; options: VoteOption[] } | null {
  const title = cleanText(question, 80);
  const list = Array.isArray(rawOptions) ? rawOptions : [];
  const labels: string[] = [];

  for (const raw of list) {
    const label = cleanText(raw, 40);

    if (label && !labels.some((seen) => seen.toLowerCase() === label.toLowerCase())) {
      labels.push(label);
    }
  }

  if (title.length < 3 || labels.length < CUSTOM_VOTE_MIN_OPTIONS || labels.length > CUSTOM_VOTE_MAX_OPTIONS) {
    return null;
  }

  return {
    options: labels.map((label, index) => ({ id: `o${index}`, label, patch: null })),
    title,
  };
}

/** Count what a batch of new game events says each seat did. */
export function tallyEvents(social: Social, events: readonly GameEvent[]) {
  const of = (id: string) => {
    social.tallies[id] ??= emptyTally();

    return social.tallies[id];
  };

  for (const event of events) {
    if (event.type === "play") {
      const tally = of(event.playerId);

      tally.played += 1;

      if (event.placement === "top") {
        if (event.card.rank === "7" || event.card.rank === "joker") {
          tally.attacks += 1;
        } else if (event.card.rank === "A") {
          tally.stops += 1;
        } else if (event.card.rank === "J") {
          tally.jacks += 1;
        }
      }
    } else if (event.type === "draw") {
      const tally = of(event.playerId);

      tally.drawn += 1;

      if (event.forced) {
        tally.penalty += 1;
      }
    } else if (event.type === "check") {
      of(event.playerId).checks += 1;
    } else if (event.type === "timeout") {
      of(event.playerId).timeouts += 1;
    }
  }
}

export type NewVote = {
  kind: VoteKind;
  by: string;
  title: string;
  options: VoteOption[];
  targetId: string | null;
};

export function openVote(
  social: Social,
  vote: NewVote,
  now: number,
  durationMs: number,
): Ok | Err {
  if (social.vote) {
    return err("A vote is already running.");
  }

  if (now < social.voteCooldownUntil) {
    return err("Wait a moment before the next vote.");
  }

  social.voteSeq += 1;
  social.vote = {
    ...vote,
    ballots: {},
    endsAt: now + durationMs,
    id: social.voteSeq,
  };

  return done;
}

/** Cast (or change) a ballot. `eligible` are the seats that may vote. */
export function castBallot(
  social: Social,
  seatId: string,
  choice: unknown,
  eligible: readonly string[],
): Ok | Err {
  const vote = social.vote;

  if (!vote) {
    return err("There is no vote right now.");
  }

  if (!eligible.includes(seatId)) {
    return err("You cannot vote in this one.");
  }

  if (!vote.options.some((option) => option.id === choice)) {
    return err("That is not one of the choices.");
  }

  vote.ballots[seatId] = choice as string;

  return done;
}

/** Votes per choice, counting only the seats that may vote. */
export function tally(vote: Vote, eligible: readonly string[]) {
  const counts: Record<string, number> = {};
  let voted = 0;

  for (const id of eligible) {
    const choice = vote.ballots[id];

    if (choice !== undefined && vote.options.some((o) => o.id === choice)) {
      counts[choice] = (counts[choice] ?? 0) + 1;
      voted += 1;
    }
  }

  return { counts, voted };
}

/** Time is up, or everybody who is here has voted. */
export function voteIsDone(
  vote: Vote,
  eligible: readonly string[],
  online: readonly string[],
  now: number,
) {
  if (now >= vote.endsAt || eligible.length === 0) {
    return true;
  }

  return (
    online.length > 0 && online.every((id) => vote.ballots[id] !== undefined)
  );
}

/**
 * The choice that won, or null for no result. A yes/no vote needs more than
 * half of everybody who may vote to say yes. A vote on the rules needs one
 * choice clearly ahead; a tie changes nothing.
 */
export function winningOption(vote: Vote, eligible: readonly string[]): string | null {
  const { counts } = tally(vote, eligible);

  if (vote.kind === "kick" || vote.kind === "rematch") {
    return (counts.yes ?? 0) * 2 > eligible.length ? "yes" : null;
  }

  let best: string | null = null;
  let bestCount = 0;
  let tied = false;

  for (const option of vote.options) {
    const count = counts[option.id] ?? 0;

    if (count > bestCount) {
      best = option.id;
      bestCount = count;
      tied = false;
    } else if (count > 0 && count === bestCount) {
      tied = true;
    }
  }

  return bestCount > 0 && !tied ? best : null;
}

export function closeVote(social: Social, now: number, cooldownMs = VOTE_COOLDOWN_MS) {
  social.vote = null;
  social.voteCooldownUntil = now + cooldownMs;
}
