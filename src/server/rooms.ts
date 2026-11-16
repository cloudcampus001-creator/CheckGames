/**
 * The rules of a room, as plain functions on plain data.
 *
 * A room is a JSON-friendly object, so it can be saved in a shared store
 * (see store.ts) after every move and loaded again by whichever server
 * instance gets the next request. Nothing here keeps anything in memory
 * between calls: no timers, no open connections. service.ts does the loading,
 * saving and retrying (and the realtime server, realtime/server.ts, keeps the
 * rooms in memory and calls the same functions).
 *
 * The server owns the game. Browsers send actions ("play this card") and
 * receive a personal view of the room, so nobody ever receives another
 * player's hand.
 */
import {
  botTurn,
  callCheck,
  canDraw,
  createGame,
  drawCard,
  type GameEvent,
  type GameState,
  legalPlays,
  maxCardsPerPlayer,
  type Placement,
  playCard,
  type Suit,
  SUITS,
  topCard,
  trimEvents,
} from "../cheque-games/engine";
import {
  CHAT_WINDOW,
  type GameView,
  MAX_SEATS,
  MIN_SEATS,
  MOVES_WINDOW,
  type MoveView,
  PILE_VISIBLE,
  type Phase,
  REACTIONS,
  REACTIONS_WINDOW,
  type RoomSettings,
  type RoomView,
  type SeatView,
  type Standing,
  type TournamentView,
  type VoteKind,
  type VoteView,
} from "../multiplayer/protocol";
import {
  addWin,
  castBallot,
  closeVote,
  ensureSocial,
  forgetSeat,
  openVote,
  postChat,
  postReaction,
  rulesVote,
  setReady,
  type Social,
  socialOf,
  systemMessage,
  tally,
  type Vote,
  voteIsDone,
  winningOption,
  yesNo,
  newSocial,
} from "./social";

export type Seat = {
  id: string;
  name: string;
  kind: "human" | "bot";
  /** Secret that proves a browser owns this seat. Bots have none. */
  token: string | null;
  /**
   * When this player's browser last asked for the state. Browsers ask every
   * second or so, so someone who has not asked for a few seconds has left.
   */
  polledAt: number;
};

/** A browser counts as connected for this long after its last request. */
const POLL_FRESH_MS = 8000;
/** Presence is only saved when it is at least this old (saves writes). */
const PRESENCE_WRITE_MS = 4000;

const isOnline = (seat: Seat, now: number) => now - seat.polledAt < POLL_FRESH_MS;

/** Sets played in a row, with who is out and who won the final. */
export type Tournament = {
  /** 1 for the first set. */
  set: number;
  /** Seats knocked out until the next final is over. */
  eliminated: string[];
  championId: string | null;
};

export type Room = {
  code: string;
  hostId: string;
  phase: Phase;
  seats: Seat[];
  settings: RoomSettings;
  tournament: Tournament;
  /** Counts every game started in this room (the browsers use it to reset). */
  gameCount: number;
  game: GameState | null;
  version: number;
  /** When the next bot may move, or null when no bot is up. */
  botDueAt: number | null;
  botCounter: number;
  lastActive: number;
  /** Chat, stickers, ready-ups, wins and votes. Rooms made earlier lack it until they are touched. */
  social: Social;
  /** Set when the last human left: the service deletes the room. */
  closed?: boolean;
};

type Config = {
  botDelayMin: number;
  botDelayMax: number;
  /** How long the results stay up before the table goes back to the lobby. */
  returnDelay: number;
  /** How long a vote runs when not everybody has voted. */
  voteDuration: number;
};

export type Failure = { ok: false; error: string };
export type Done = { ok: true };

const config: Config = {
  botDelayMax: 850,
  botDelayMin: 450,
  returnDelay: 25_000,
  voteDuration: 30_000,
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const NAME_MAX = 16;
const DEFAULT_CARDS = 7;
/** Chance that a bot throws a sticker after its move. */
const BOT_REACT_CHANCE = 0.07;

const fail = (error: string): Failure => ({ error, ok: false });

export function configureRooms(next: Partial<Config>) {
  Object.assign(config, next);
}

export function normalizeCode(code: unknown) {
  return String(code ?? "")
    .trim()
    .toUpperCase();
}

/** A random room code. The store makes sure it is not taken. */
export function makeCode() {
  let code = "";

  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }

  return code;
}

const newId = () => crypto.randomUUID().slice(0, 8);
const newToken = () => crypto.randomUUID();

function cleanName(raw: unknown, fallback: string) {
  const name = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);

  return name || fallback;
}

function uniqueName(room: Room, name: string) {
  const taken = new Set(room.seats.map((seat) => seat.name.toLowerCase()));

  if (!taken.has(name.toLowerCase())) {
    return name;
  }

  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, NAME_MAX - 3)} ${n}`;

    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

function maxCardsFor(room: Room) {
  return maxCardsPerPlayer(
    Math.max(MIN_SEATS, room.seats.length),
    room.settings.jokers,
  );
}

/** Keep the rules legal as people come and go and settings change. */
function normalizeSettings(room: Room) {
  room.settings.cardsPerPlayer = Math.min(
    Math.max(1, Math.floor(room.settings.cardsPerPlayer)),
    maxCardsFor(room),
  );

  // Knocking out the loser only makes sense when everyone gets ranked.
  if (room.settings.endMode !== "ranking") {
    room.settings.elimination = false;
  }
}

const freshTournament = (): Tournament => ({
  championId: null,
  eliminated: [],
  set: 1,
});

/** Seats that play the next set (everybody, minus the eliminated). */
const activeSeats = (room: Room) =>
  room.seats.filter((seat) => !room.tournament.eliminated.includes(seat.id));

function authSeat(room: Room, seatId: unknown, token: unknown) {
  return room.seats.find(
    (seat) =>
      seat.kind === "human" &&
      seat.token !== null &&
      seat.id === seatId &&
      seat.token === token,
  );
}

const nameOf = (room: Room, id: string) =>
  room.seats.find((seat) => seat.id === id)?.name ?? "Someone";

// --- plain-words log ---------------------------------------------------------

const rankWords: Record<string, string> = {
  "10": "ten",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
  A: "ace",
  J: "jack",
  K: "king",
  Q: "queen",
  joker: "joker",
};

const ordinal = (n: number) => {
  const tens = n % 100;

  if (tens >= 11 && tens <= 13) {
    return `${n}th`;
  }

  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

function describeEvent(room: Room, event: GameEvent): string | null {
  const name = (id: string) => nameOf(room, id);

  switch (event.type) {
    case "start":
      return "Game on!";
    case "play": {
      const who = name(event.playerId);

      if (event.card.rank === "joker") {
        return `${who} played the ${event.card.suit} joker.`;
      }

      const card = `${rankWords[event.card.rank]} of ${event.card.suit}`;

      if (event.placement === "under") {
        return `${who} slipped the ${card} under the pile.`;
      }

      return event.demand
        ? `${who} played the ${card} and asks for ${event.demand}.`
        : `${who} played the ${card}.`;
    }
    case "draw":
      // The penalty line says it for forced cards.
      return event.forced
        ? null
        : `${name(event.playerId)} took a card from the bank.`;
    case "penalty":
      return `${name(event.playerId)} had to take ${event.count} card${event.count === 1 ? "" : "s"}.`;
    case "skip":
      return `${name(event.playerId)} is stopped.`;
    case "reshuffle":
      return "The bank is finished. The pile was mixed and is the new bank.";
    case "bank-empty":
      return `${name(event.playerId)} had nothing to take.`;
    case "check":
      return `${name(event.playerId)} says CHECK!`;
    case "games":
      return `${name(event.playerId)} says GAMES! (${ordinal(event.rank)})`;
    case "tie": {
      const names = event.playerIds.map(name).join(" and ");

      return `${names} finished in the same round! Each takes ${event.cards} cards and they play on.`;
    }
    case "stalemate":
      return "Nobody can move any more. The set ends.";
  }
}

/** One event as the viewer may see it. Only the taker learns which card was drawn. */
function toMove(event: GameEvent, seq: number, viewerId: string): MoveView | null {
  switch (event.type) {
    case "play":
      return {
        card: event.card,
        demand: event.demand,
        placement: event.placement,
        seatId: event.playerId,
        seq,
        type: "play",
      };
    case "draw":
      return {
        ...(event.playerId === viewerId ? { card: event.card } : {}),
        forced: event.forced,
        seatId: event.playerId,
        seq,
        type: "draw",
      };
    case "penalty":
      return { count: event.count, seatId: event.playerId, seq, type: "penalty" };
    case "skip":
      return { seatId: event.playerId, seq, type: "skip" };
    case "reshuffle":
      return { count: event.count, seq, type: "reshuffle" };
    case "check":
      return { seatId: event.playerId, seq, type: "check" };
    case "games":
      return { rank: event.rank, seatId: event.playerId, seq, type: "games" };
    case "tie":
      return { cards: event.cards, seatIds: event.playerIds, seq, type: "tie" };
    default:
      return null;
  }
}

// --- votes -------------------------------------------------------------------

/** Humans who may vote: everybody sitting at the table, except who a "remove" vote is about. */
function eligibleVoters(room: Room, vote: Vote) {
  return room.seats
    .filter((seat) => seat.kind === "human" && seat.id !== vote.targetId)
    .map((seat) => seat.id);
}

function voteView(room: Room, social: Social, seatId: string, now: number): VoteView | null {
  const vote = social.vote;

  if (!vote) {
    return null;
  }

  const eligible = eligibleVoters(room, vote);
  const { counts, voted } = tally(vote, eligible);

  return {
    byId: vote.by,
    canCancel: seatId === vote.by || seatId === room.hostId,
    canVote: eligible.includes(seatId),
    endsInMs: Math.max(0, vote.endsAt - now),
    id: vote.id,
    kind: vote.kind,
    options: vote.options.map((option) => ({
      count: counts[option.id] ?? 0,
      id: option.id,
      label: option.label,
    })),
    title: vote.title,
    voted,
    voters: eligible.length,
    yourChoice: vote.ballots[seatId] ?? null,
  };
}

/** The table is in the middle of a tournament that has not had its final yet. */
const inTournament = (room: Room) =>
  room.settings.elimination && room.tournament.championId === null;

/** When the results end and the table goes back to the lobby by itself, or null. */
function returnDueAt(room: Room): number | null {
  const social = socialOf(room);

  if (
    room.phase !== "finished" ||
    !social.autoReturn ||
    social.finishedAt === null ||
    social.vote !== null ||
    inTournament(room)
  ) {
    return null;
  }

  return social.finishedAt + config.returnDelay;
}

/** Back to the lobby with everybody still seated. */
function goToLobby(room: Room) {
  const social = ensureSocial(room);

  room.game = null;
  room.phase = "lobby";
  room.tournament = freshTournament();
  social.ready = {};
  social.finishedAt = null;
  social.vote = null;
  scheduleBots(room);
  normalizeSettings(room);
}

/** Another set right away: the next one of a tournament, or a fresh start. */
function startAnother(room: Room) {
  if (inTournament(room) && activeSeats(room).length >= MIN_SEATS) {
    room.tournament.set += 1;
  } else {
    room.tournament = freshTournament();
    normalizeSettings(room);
  }

  startSet(room);
}

function removeSeatNow(room: Room, seatId: string) {
  room.seats = room.seats.filter((seat) => seat.id !== seatId);
  room.tournament.eliminated = room.tournament.eliminated.filter((id) => id !== seatId);
  forgetSeat(ensureSocial(room), seatId);
  normalizeSettings(room);
}

/** A vote is over (everybody voted, or time ran out): count it and do what it decided. */
function resolveVote(room: Room, now: number) {
  const social = ensureSocial(room);
  const vote = social.vote;

  if (!vote) {
    return;
  }

  const eligible = eligibleVoters(room, vote);
  const winner = winningOption(vote, eligible);
  const option = vote.options.find((candidate) => candidate.id === winner);

  closeVote(social, now);

  let message = `Vote ended with no result: ${vote.title}`;

  if (option && vote.kind === "rules" && room.phase === "lobby" && option.patch) {
    const { patch } = option;

    if (patch.cardsPerPlayer !== undefined) {
      room.settings.cardsPerPlayer = patch.cardsPerPlayer;
    }

    if (patch.jokers !== undefined) {
      room.settings.jokers = patch.jokers;
    }

    if (patch.endMode !== undefined) {
      room.settings.endMode = patch.endMode;
    }

    normalizeSettings(room);
    message = `Vote passed: ${option.label}.`;
  } else if (option?.id === "yes" && vote.kind === "kick") {
    const target = room.seats.find((seat) => seat.id === vote.targetId);

    if (target && target.kind === "human" && target.id !== room.hostId && room.phase !== "playing") {
      removeSeatNow(room, target.id);
      message = `${target.name} was removed by vote.`;
    }
  } else if (option?.id === "yes" && vote.kind === "rematch" && room.phase === "finished") {
    message = "Vote passed: another game!";
    startAnother(room);
  } else if (vote.kind === "kick" || vote.kind === "rematch") {
    message = `Vote failed: ${vote.title}`;
  }

  systemMessage(social, message, now);
  commit(room, now);
}

/** Close votes that are done, and send the table back to the lobby when the results are old. */
function tickSocial(room: Room, now: number): boolean {
  const social = ensureSocial(room);
  let changed = false;

  if (room.phase === "finished" && social.finishedAt === null) {
    social.finishedAt = now;
    changed = true;
  }

  const vote = social.vote;

  if (vote) {
    const eligible = eligibleVoters(room, vote);
    const online = room.seats
      .filter((seat) => eligible.includes(seat.id) && isOnline(seat, now))
      .map((seat) => seat.id);

    if (voteIsDone(vote, eligible, online, now)) {
      resolveVote(room, now);
      changed = true;
    }
  }

  const due = returnDueAt(room);

  if (due !== null && now >= due) {
    goToLobby(room);
    systemMessage(social, "Back in the lobby. Ready for the next game?", now);
    commit(room, now);
    changed = true;
  }

  return changed;
}

// --- personal views ----------------------------------------------------------

function standingsOf(room: Room, game: GameState): Standing[] {
  return game.finished.map((id, index) => ({
    name: nameOf(room, id),
    rank: index + 1,
    seatId: id,
  }));
}

function tournamentView(room: Room): TournamentView {
  const { tournament, settings } = room;
  const playing = room.game ? room.game.players.length : activeSeats(room).length;

  return {
    championId: tournament.championId,
    eliminatedIds: [...tournament.eliminated],
    finalSet: settings.elimination && playing === 2,
    nextSetAvailable:
      room.phase === "finished" &&
      tournament.championId === null &&
      activeSeats(room).length >= MIN_SEATS,
    set: tournament.set,
  };
}

export function viewFor(room: Room, seatId: string, now: number): RoomView {
  const game = room.game;
  const showGame = game !== null && room.phase !== "lobby";
  const social = socialOf(room);

  const seats: SeatView[] = room.seats.map((seat) => {
    const player = showGame
      ? game.players.find((candidate) => candidate.id === seat.id)
      : undefined;
    const place = showGame ? game.finished.indexOf(seat.id) : -1;

    return {
      checked: showGame ? game.checked.includes(seat.id) : false,
      connected: seat.kind === "bot" || seat.id === seatId || isOnline(seat, now),
      eliminated: room.tournament.eliminated.includes(seat.id),
      handCount: player ? player.hand.length : 0,
      id: seat.id,
      inGame: showGame ? player !== undefined : false,
      isCurrent:
        showGame &&
        !game.over &&
        game.players[game.current].id === seat.id,
      isHost: seat.id === room.hostId,
      kind: seat.kind,
      name: seat.name,
      rank: place === -1 ? null : place + 1,
      ready: seat.kind === "bot" || social.ready[seat.id] === true,
      sittingOut: showGame ? (game.benched ?? []).includes(seat.id) : false,
      wins: social.wins[seat.id] ?? 0,
    };
  });

  let gameView: GameView | null = null;

  if (showGame) {
    const me = game.players.find((candidate) => candidate.id === seatId);
    const currentSeatId = game.players[game.current].id;
    const firstMove = Math.max(0, game.events.length - MOVES_WINDOW);
    // Old events are trimmed away, but move numbers keep counting up.
    const base = (game.eventBase ?? 0) + firstMove;
    const moves: MoveView[] = [];

    game.events.slice(firstMove).forEach((event, offset) => {
      const move = toMove(event, base + offset, seatId);

      if (move) {
        moves.push(move);
      }
    });

    const log = game.events
      .slice(-MOVES_WINDOW)
      .map((event) => describeEvent(room, event))
      .filter((line): line is string => line !== null)
      .slice(-6);

    gameView = {
      bankCount: game.bank.length,
      // On your turn the bank is open even if you have a card to play.
      canDraw: canDraw(game, seatId),
      centre: topCard(game),
      currentSeatId,
      demand: game.demand,
      gameId: room.gameCount,
      hand: me ? me.hand : [],
      log,
      moves,
      over: game.over,
      pending: game.pending,
      pile: game.pile.slice(-PILE_VISIBLE),
      playableIds:
        me && !game.over && currentSeatId === seatId
          ? legalPlays(game, seatId).map((card) => card.id)
          : [],
      standings: game.over ? standingsOf(room, game) : [],
      winnerId: game.winner,
    };
  }

  const returnAt = returnDueAt(room);

  return {
    autoReturn: social.autoReturn,
    botInMs: room.botDueAt === null ? null : Math.max(0, room.botDueAt - now),
    chat: social.chat.slice(-CHAT_WINDOW),
    code: room.code,
    game: gameView,
    hostId: room.hostId,
    maxCardsPerPlayer: maxCardsFor(room),
    phase: room.phase,
    reactions: social.reactions.slice(-REACTIONS_WINDOW),
    returnInMs: returnAt === null ? null : Math.max(0, returnAt - now),
    seats,
    settings: { ...room.settings },
    tournament: tournamentView(room),
    version: room.version,
    vote: voteView(room, social, seatId, now),
    you: seatId,
  };
}

/** Something changed: browsers can tell by the new version number. */
function commit(room: Room, now = Date.now()) {
  room.version += 1;
  room.lastActive = now;
}

/** The room is finished: the service deletes it from the store. */
function destroyRoom(room: Room) {
  room.closed = true;
  room.botDueAt = null;
}

/** Add `count` to the room's version when somebody's presence flipped. */
export function etagOf(room: Room, now: number) {
  // Who is connected is part of what a browser shows, so it is part of the tag.
  const online = room.seats
    .map((seat) => (seat.kind === "bot" || isOnline(seat, now) ? "1" : "0"))
    .join("");

  return `${room.version}.${online}`;
}

// --- bots --------------------------------------------------------------------

/**
 * A set just ended. With elimination on, the player who came last is out for
 * the next set, until two are left: that set is the final, and its winner is
 * the champion. Then everybody can come back.
 */
function concludeSet(room: Room, game: GameState) {
  if (!room.settings.elimination) {
    return;
  }

  const ranking = game.finished;

  if (game.players.length <= 2) {
    room.tournament.championId = ranking[0] ?? null;

    return;
  }

  const loser = ranking[ranking.length - 1];

  if (loser && !room.tournament.eliminated.includes(loser)) {
    room.tournament.eliminated.push(loser);
  }
}

function afterGameChange(room: Room, now = Date.now()) {
  if (room.game?.over && room.phase === "playing") {
    const social = ensureSocial(room);

    room.phase = "finished";
    concludeSet(room, room.game);
    social.finishedAt = now;

    if (room.game.winner) {
      addWin(social, room.game.winner);
    }
  }

  scheduleBots(room, now);
}

/** Deal a new set to everybody who has not been eliminated. */
function startSet(room: Room) {
  const seats = activeSeats(room);
  const social = ensureSocial(room);

  room.gameCount += 1;
  room.game = createGame({
    cardsPerPlayer: Math.min(
      room.settings.cardsPerPlayer,
      maxCardsPerPlayer(seats.length, room.settings.jokers),
    ),
    includeJokers: room.settings.jokers,
    mode: room.settings.endMode,
    playerIds: seats.map((s) => s.id),
    playerNames: seats.map((s) => s.name),
    randomStart: true,
  });
  room.phase = "playing";
  social.ready = {};
  social.finishedAt = null;
  social.vote = null;
  afterGameChange(room);
}

const currentSeat = (room: Room) => {
  const game = room.game;

  if (room.phase !== "playing" || !game || game.over) {
    return undefined;
  }

  const id = game.players[game.current]?.id;

  return room.seats.find((seat) => seat.id === id);
};

/** If a bot is up, note when it may move. Nobody sets a timer: see tickBots. */
function scheduleBots(room: Room, now = Date.now()) {
  const current = currentSeat(room);

  if (!current || current.kind !== "bot") {
    room.botDueAt = null;

    return;
  }

  room.botDueAt =
    now +
    config.botDelayMin +
    Math.random() * (config.botDelayMax - config.botDelayMin);
}

function tickBotTurn(room: Room, now: number): boolean {
  const current = currentSeat(room);

  if (!current || current.kind !== "bot") {
    if (room.botDueAt !== null) {
      room.botDueAt = null;

      return true;
    }

    return false;
  }

  if (room.botDueAt === null) {
    scheduleBots(room, now);

    return true;
  }

  if (now < room.botDueAt || !room.game) {
    return false;
  }

  room.game = trimEvents(botTurn(room.game));

  // Now and then a bot throws a sticker, so the table feels alive.
  if (Math.random() < BOT_REACT_CHANCE) {
    postReaction(
      ensureSocial(room),
      current.id,
      REACTIONS[Math.floor(Math.random() * REACTIONS.length)],
      now,
    );
  }

  afterGameChange(room, now);
  commit(room, now);

  return true;
}

/**
 * Let a bot move if it is its turn and its thinking time is over, close a vote
 * that is done, and send an old results screen back to the lobby. Nothing has a
 * timer of its own (a serverless function cannot keep one): whoever asks about
 * the room next does this. Returns true if the room changed.
 */
export function tickBots(room: Room, now: number): boolean {
  const social = tickSocial(room, now);
  const bots = tickBotTurn(room, now);

  return social || bots;
}

/**
 * The next moment something in this room is due (a bot's move, the end of a
 * vote, the return to the lobby), or null. The realtime server sets its timer
 * for it, so nobody has to ask.
 */
export function nextWakeAt(room: Room): number | null {
  const times: number[] = [];
  const social = socialOf(room);

  if (room.botDueAt !== null) {
    times.push(room.botDueAt);
  }

  if (social.vote) {
    times.push(social.vote.endsAt);
  }

  const due = returnDueAt(room);

  if (due !== null) {
    times.push(due);
  }

  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * A browser asked about the room. Notes that this player is here, and says
 * whether that has to be saved (it is not saved every time, to save writes).
 */
export function touchSeat(room: Room, seatId: string, now: number): boolean {
  const seat = room.seats.find((candidate) => candidate.id === seatId);

  if (!seat) {
    return false;
  }

  const stale = now - seat.polledAt;

  if (stale < PRESENCE_WRITE_MS) {
    return false;
  }

  seat.polledAt = now;
  room.lastActive = now;

  // Everyone sees this player come back.
  if (stale >= POLL_FRESH_MS) {
    room.version += 1;
  }

  return true;
}

/**
 * For the realtime server, which knows exactly when a socket opens or closes.
 * A player who just closed the page shows as offline at once. Returns true if
 * what the others see changed.
 */
export function setPresence(room: Room, seatId: string, online: boolean, now: number): boolean {
  const seat = room.seats.find((candidate) => candidate.id === seatId);

  if (!seat || seat.kind !== "human") {
    return false;
  }

  const was = isOnline(seat, now);

  seat.polledAt = online ? now : 0;

  if (was !== online) {
    commit(room, now);

    return true;
  }

  return false;
}

function firstHuman(room: Room, except?: string) {
  return room.seats.find(
    (seat) => seat.kind === "human" && seat.id !== except,
  );
}

function turnIntoBot(seat: Seat) {
  seat.kind = "bot";
  seat.token = null;
  seat.polledAt = 0;
  seat.name = `${seat.name.slice(0, NAME_MAX - 6)} (bot)`;
}

// --- public API --------------------------------------------------------------

/** A new room with its host seated. The service saves it. */
export function newRoom(code: string, rawName: unknown, now: number) {
  const token = newToken();
  const host: Seat = {
    id: newId(),
    kind: "human",
    name: cleanName(rawName, "Host"),
    polledAt: now,
    token,
  };

  const room: Room = {
    botCounter: 0,
    botDueAt: null,
    code,
    game: null,
    gameCount: 0,
    hostId: host.id,
    lastActive: now,
    phase: "lobby",
    seats: [host],
    settings: {
      cardsPerPlayer: DEFAULT_CARDS,
      elimination: false,
      endMode: "first",
      jokers: true,
    },
    social: newSocial(),
    tournament: freshTournament(),
    version: 1,
  };

  normalizeSettings(room);

  return { room, seatId: host.id, token };
}

/** Take a seat, or get your old one back with the token you saved. */
export function joinInto(
  room: Room,
  rawName: unknown,
  token: unknown,
  now: number,
): Failure | { ok: true; code: string; seatId: string; token: string; changed: boolean } {
  // Coming back with a saved token gives you your old seat.
  if (typeof token === "string") {
    const existing = room.seats.find(
      (seat) =>
        seat.kind === "human" && seat.token !== null && seat.token === token,
    );

    if (existing) {
      const changed = touchSeat(room, existing.id, now);

      return { changed, code: room.code, ok: true, seatId: existing.id, token };
    }
  }

  if (room.phase !== "lobby") {
    return fail("That game has already started.");
  }

  if (room.seats.length >= MAX_SEATS) {
    return fail("This table is full.");
  }

  const seat: Seat = {
    id: newId(),
    kind: "human",
    name: uniqueName(room, cleanName(rawName, `Player ${room.seats.length + 1}`)),
    polledAt: now,
    token: newToken(),
  };

  room.seats.push(seat);
  normalizeSettings(room);
  systemMessage(ensureSocial(room), `${seat.name} joined.`, now);
  commit(room, now);

  return {
    changed: true,
    code: room.code,
    ok: true,
    seatId: seat.id,
    token: seat.token as string,
  };
}

/** Is this seat/token pair really a player in the room? */
export function checkSeat(room: Room, seatId: unknown, token: unknown) {
  return authSeat(room, seatId, token) !== undefined;
}

export function applyAction(
  room: Room,
  seatId: unknown,
  token: unknown,
  rawAction: unknown,
  now = Date.now(),
): Failure | Done {
  const seat = authSeat(room, seatId, token);

  if (!seat) {
    return fail("You are not part of this game.");
  }

  if (typeof rawAction !== "object" || rawAction === null) {
    return fail("Unknown action.");
  }

  const action = rawAction as Record<string, unknown>;
  const isHost = room.hostId === seat.id;

  const needHost = () => (isHost ? null : fail("Only the host can do that."));

  switch (action.type) {
    case "addBot": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      if (room.phase !== "lobby") {
        return fail("Bots can only be added in the lobby.");
      }

      if (room.seats.length >= MAX_SEATS) {
        return fail("This table is full.");
      }

      room.botCounter += 1;
      room.seats.push({
        id: newId(),
        kind: "bot",
        name: uniqueName(room, `Bot ${room.botCounter}`),
        polledAt: 0,
        token: null,
      });
      normalizeSettings(room);
      commit(room);

      return { ok: true };
    }

    case "removeSeat": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      if (room.phase !== "lobby") {
        return fail("Players can only be removed in the lobby.");
      }

      if (action.seatId === seat.id) {
        return fail("Use Leave to leave your own game.");
      }

      const index = room.seats.findIndex((s) => s.id === action.seatId);

      if (index === -1) {
        return fail("That player is not here.");
      }

      removeSeatNow(room, room.seats[index].id);
      commit(room);

      return { ok: true };
    }

    case "setSettings": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      if (room.phase !== "lobby") {
        return fail("Rules can only be changed in the lobby.");
      }

      const { cardsPerPlayer, elimination, endMode, jokers } = action;

      if (cardsPerPlayer !== undefined) {
        if (typeof cardsPerPlayer !== "number" || !Number.isFinite(cardsPerPlayer)) {
          return fail("Choose a number of cards.");
        }
      }

      if (jokers !== undefined && typeof jokers !== "boolean") {
        return fail("Jokers can only be on or off.");
      }

      if (endMode !== undefined && endMode !== "first" && endMode !== "ranking") {
        return fail("Choose how the game ends.");
      }

      if (elimination !== undefined && typeof elimination !== "boolean") {
        return fail("Elimination can only be on or off.");
      }

      if (typeof cardsPerPlayer === "number") {
        room.settings.cardsPerPlayer = cardsPerPlayer;
      }

      if (typeof jokers === "boolean") {
        room.settings.jokers = jokers;
      }

      if (endMode === "first" || endMode === "ranking") {
        room.settings.endMode = endMode;
      }

      if (typeof elimination === "boolean") {
        room.settings.elimination = elimination;
      }

      normalizeSettings(room);
      commit(room);

      return { ok: true };
    }

    case "setAutoReturn": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      if (typeof action.value !== "boolean") {
        return fail("Auto return can only be on or off.");
      }

      ensureSocial(room).autoReturn = action.value;
      commit(room, now);

      return { ok: true };
    }

    case "makeHost": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      const target = room.seats.find((s) => s.id === action.seatId);

      if (!target || target.kind !== "human" || target.id === seat.id) {
        return fail("Pick another player to be the host.");
      }

      room.hostId = target.id;
      systemMessage(ensureSocial(room), `${target.name} is the host now.`, now);
      commit(room, now);

      return { ok: true };
    }

    case "start": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      if (room.phase !== "lobby") {
        return fail("The game has already started.");
      }

      if (room.seats.length < MIN_SEATS) {
        return fail("You need at least 2 players. Add a bot or wait for a friend.");
      }

      if (room.settings.cardsPerPlayer > maxCardsFor(room)) {
        return fail("Too many cards each for this many players.");
      }

      room.tournament = freshTournament();
      startSet(room);
      commit(room);

      return { ok: true };
    }

    case "replaceWithBot": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      if (room.phase !== "playing") {
        return fail("Players can only be swapped for a bot during a game.");
      }

      const target = room.seats.find((s) => s.id === action.seatId);

      if (!target || target.kind !== "human" || target.id === seat.id) {
        return fail("That player cannot be replaced.");
      }

      turnIntoBot(target);
      scheduleBots(room);
      commit(room);

      return { ok: true };
    }

    case "backToLobby": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      if (room.phase !== "finished") {
        return fail("The game is not over yet.");
      }

      goToLobby(room);
      commit(room);

      return { ok: true };
    }

    case "nextSet": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      if (room.phase !== "finished") {
        return fail("The set is not over yet.");
      }

      if (room.tournament.championId !== null) {
        return fail("The final is over. Play again to bring everyone back.");
      }

      if (activeSeats(room).length < MIN_SEATS) {
        return fail("Not enough players left for another set.");
      }

      room.tournament.set += 1;
      startSet(room);
      commit(room);

      return { ok: true };
    }

    case "playAgain": {
      const denied = needHost();

      if (denied) {
        return denied;
      }

      if (room.phase !== "finished") {
        return fail("The set is not over yet.");
      }

      if (room.seats.length < MIN_SEATS) {
        return fail("You need at least 2 players.");
      }

      // Everybody is back, eliminated players included.
      room.tournament = freshTournament();
      normalizeSettings(room);
      startSet(room);
      commit(room);

      return { ok: true };
    }

    case "play":
    case "draw":
    case "check": {
      if (room.phase !== "playing" || !room.game) {
        return fail("There is no game in progress.");
      }

      let result;

      if (action.type === "play") {
        if (typeof action.cardId !== "string") {
          return fail("Choose a card to play.");
        }

        const placement: Placement | undefined =
          action.placement === "top" || action.placement === "under"
            ? action.placement
            : undefined;
        const suit: Suit | undefined = (SUITS as readonly unknown[]).includes(
          action.suit,
        )
          ? (action.suit as Suit)
          : undefined;

        result = playCard(room.game, seat.id, action.cardId, {
          placement,
          suit,
        });
      } else if (action.type === "draw") {
        result = drawCard(room.game, seat.id);
      } else {
        result = callCheck(room.game, seat.id);
      }

      if (!result.ok) {
        return fail(result.reason);
      }

      room.game = trimEvents(result.state);
      afterGameChange(room, now);
      commit(room);

      return { ok: true };
    }

    case "chat": {
      const posted = postChat(ensureSocial(room), seat.id, seat.name, action.text, now);

      if (!posted.ok) {
        return fail(posted.error);
      }

      commit(room, now);

      return { ok: true };
    }

    case "react": {
      const posted = postReaction(ensureSocial(room), seat.id, action.emoji, now);

      if (!posted.ok) {
        return fail(posted.error);
      }

      commit(room, now);

      return { ok: true };
    }

    case "ready": {
      if (room.phase !== "lobby") {
        return fail("Ready is only for the lobby.");
      }

      setReady(ensureSocial(room), seat.id, action.ready === true);
      commit(room, now);

      return { ok: true };
    }

    case "startVote": {
      const social = ensureSocial(room);
      const kind = action.kind as VoteKind;
      let title = "";
      let options = yesNo();
      let targetId: string | null = null;

      if (kind === "rules") {
        if (room.phase !== "lobby") {
          return fail("Votes on the rules are held in the lobby.");
        }

        const topic = rulesVote(action.topic, maxCardsFor(room));

        if (!topic) {
          return fail("Choose what to vote on.");
        }

        ({ options, title } = topic);
      } else if (kind === "kick") {
        const target = room.seats.find((s) => s.id === action.seatId);
        const humans = room.seats.filter((s) => s.kind === "human").length;

        if (room.phase === "playing") {
          return fail("Players can only be removed in the lobby.");
        }

        if (!target || target.kind !== "human" || target.id === seat.id || target.id === room.hostId) {
          return fail("That player cannot be voted out.");
        }

        if (humans < 3) {
          return fail("A vote to remove someone needs at least 3 players.");
        }

        title = `Remove ${target.name}?`;
        targetId = target.id;
      } else if (kind === "rematch") {
        if (room.phase !== "finished") {
          return fail("A rematch vote is held after a game.");
        }

        title = "Play again?";
      } else {
        return fail("Unknown vote.");
      }

      const opened = openVote(
        social,
        { by: seat.id, kind, options, targetId, title },
        now,
        config.voteDuration,
      );

      if (!opened.ok) {
        return fail(opened.error);
      }

      systemMessage(social, `${seat.name} started a vote: ${title}`, now);
      commit(room, now);

      return { ok: true };
    }

    case "castVote": {
      const social = ensureSocial(room);
      const vote = social.vote;

      if (!vote) {
        return fail("There is no vote right now.");
      }

      const eligible = eligibleVoters(room, vote);
      const cast = castBallot(social, seat.id, action.choice, eligible);

      if (!cast.ok) {
        return fail(cast.error);
      }

      const online = room.seats
        .filter((s) => eligible.includes(s.id) && (s.id === seat.id || isOnline(s, now)))
        .map((s) => s.id);

      if (voteIsDone(vote, eligible, online, now)) {
        resolveVote(room, now);
      } else {
        commit(room, now);
      }

      return { ok: true };
    }

    case "cancelVote": {
      const social = ensureSocial(room);

      if (!social.vote) {
        return fail("There is no vote right now.");
      }

      if (social.vote.by !== seat.id && !isHost) {
        return fail("Only who started the vote, or the host, can call it off.");
      }

      closeVote(social, now, 0);
      systemMessage(social, `${seat.name} called off the vote.`, now);
      commit(room, now);

      return { ok: true };
    }

    case "leave": {
      const inTheSet = room.game?.players.some((p) => p.id === seat.id) ?? false;
      const social = ensureSocial(room);

      if (room.phase === "playing" && inTheSet) {
        // The game goes on without them: a bot takes the seat.
        const was = seat.name;

        turnIntoBot(seat);
        systemMessage(social, `${was} left. A bot took the seat.`, now);
      } else {
        // In the lobby, between sets, or only watching: they just go.
        systemMessage(social, `${seat.name} left.`, now);
        removeSeatNow(room, seat.id);
      }

      if (!room.seats.some((s) => s.kind === "human")) {
        destroyRoom(room);

        return { ok: true };
      }

      if (room.hostId === seat.id) {
        const next = firstHuman(room, seat.id);

        if (next) {
          room.hostId = next.id;
          systemMessage(social, `${next.name} is the host now.`, now);
        }
      }

      normalizeSettings(room);
      scheduleBots(room);
      commit(room);

      return { ok: true };
    }

    default:
      return fail("Unknown action.");
  }
}
