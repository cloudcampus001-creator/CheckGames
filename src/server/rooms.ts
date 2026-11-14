/**
 * In-memory rooms for multiplayer cheque-games.
 *
 * The server owns the game. Browsers send actions ("play this card") and
 * receive a personal view of the room, so nobody ever receives another
 * player's hand. Rooms live in this Node process only: restarting the server
 * clears them.
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
} from "../cheque-games/engine";
import {
  type GameView,
  MAX_SEATS,
  MIN_SEATS,
  MOVES_WINDOW,
  type MoveView,
  PILE_VISIBLE,
  type Phase,
  type RoomSettings,
  type RoomView,
  type SeatView,
  type Standing,
  type TournamentView,
} from "../multiplayer/protocol";

type Seat = {
  id: string;
  name: string;
  kind: "human" | "bot";
  /** Secret that proves a browser owns this seat. Bots have none. */
  token: string | null;
  /** Open event streams (a player can have several tabs). */
  connections: number;
};

type Subscriber = {
  seatId: string;
  token: string;
  send: (view: RoomView) => void;
  close: (reason: string) => void;
};

/** Sets played in a row, with who is out and who won the final. */
type Tournament = {
  /** 1 for the first set. */
  set: number;
  /** Seats knocked out until the next final is over. */
  eliminated: string[];
  championId: string | null;
};

type Room = {
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
  subscribers: Set<Subscriber>;
  botTimer: ReturnType<typeof setTimeout> | null;
  botCounter: number;
  lastActive: number;
};

type Config = { botDelayMin: number; botDelayMax: number };

export type Failure = { ok: false; error: string };
export type Done = { ok: true };

// Next.js can load this file more than once (hot reload, separate routes), so
// the rooms live on globalThis to stay one shared set.
const store = globalThis as typeof globalThis & {
  __chequeRooms?: Map<string, Room>;
  __chequeConfig?: Config;
  __chequeSweeper?: ReturnType<typeof setInterval>;
};

const rooms = (store.__chequeRooms ??= new Map<string, Room>());
const config = (store.__chequeConfig ??= {
  botDelayMax: 1300,
  botDelayMin: 700,
});

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const IDLE_ROOM_MS = 30 * 60 * 1000;
const NAME_MAX = 16;
const DEFAULT_CARDS = 7;

const fail = (error: string): Failure => ({ error, ok: false });

export function configureRooms(next: Partial<Config>) {
  Object.assign(config, next);
}

/** For tests: forget every room. */
export function resetRooms() {
  for (const room of [...rooms.values()]) {
    destroyRoom(room);
  }
}

/** For tests: look inside a room (including hands). Never used by the routes. */
export function peekRoom(code: string) {
  return rooms.get(normalizeCode(code));
}

if (!store.__chequeSweeper) {
  store.__chequeSweeper = setInterval(sweep, 5 * 60 * 1000);
  store.__chequeSweeper.unref?.();
}

function sweep() {
  const now = Date.now();

  for (const room of [...rooms.values()]) {
    const online = room.seats.reduce((sum, seat) => sum + seat.connections, 0);

    if (online === 0 && now - room.lastActive > IDLE_ROOM_MS) {
      destroyRoom(room);
    }
  }
}

function normalizeCode(code: unknown) {
  return String(code ?? "")
    .trim()
    .toUpperCase();
}

function makeCode() {
  for (;;) {
    let code = "";

    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }

    if (!rooms.has(code)) {
      return code;
    }
  }
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
  const nameOf = (id: string) =>
    room.seats.find((seat) => seat.id === id)?.name ?? "Someone";

  switch (event.type) {
    case "start":
      return "Game on!";
    case "play": {
      const who = nameOf(event.playerId);

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
        : `${nameOf(event.playerId)} took a card from the bank.`;
    case "penalty":
      return `${nameOf(event.playerId)} had to take ${event.count} card${event.count === 1 ? "" : "s"}.`;
    case "skip":
      return `${nameOf(event.playerId)} is stopped.`;
    case "reshuffle":
      return "The bank is finished. The pile was mixed and is the new bank.";
    case "bank-empty":
      return `${nameOf(event.playerId)} had nothing to take.`;
    case "check":
      return `${nameOf(event.playerId)} says CHECK!`;
    case "games":
      return `${nameOf(event.playerId)} says GAMES! (${ordinal(event.rank)})`;
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
    default:
      return null;
  }
}

// --- personal views ----------------------------------------------------------

function standingsOf(room: Room, game: GameState): Standing[] {
  return game.finished.map((id, index) => ({
    name: room.seats.find((seat) => seat.id === id)?.name ?? "Someone",
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

function viewFor(room: Room, seatId: string): RoomView {
  const game = room.game;
  const showGame = game !== null && room.phase !== "lobby";

  const seats: SeatView[] = room.seats.map((seat) => {
    const player = showGame
      ? game.players.find((candidate) => candidate.id === seat.id)
      : undefined;
    const place = showGame ? game.finished.indexOf(seat.id) : -1;

    return {
      checked: showGame ? game.checked.includes(seat.id) : false,
      connected: seat.kind === "bot" || seat.connections > 0,
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
    };
  });

  let gameView: GameView | null = null;

  if (showGame) {
    const me = game.players.find((candidate) => candidate.id === seatId);
    const currentSeatId = game.players[game.current].id;
    const firstMove = Math.max(0, game.events.length - MOVES_WINDOW);
    const moves: MoveView[] = [];

    game.events.slice(firstMove).forEach((event, offset) => {
      const move = toMove(event, firstMove + offset, seatId);

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
      canCheck:
        !game.over &&
        me !== undefined &&
        me.hand.length === 1 &&
        !game.checked.includes(seatId),
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

  return {
    code: room.code,
    game: gameView,
    hostId: room.hostId,
    maxCardsPerPlayer: maxCardsFor(room),
    phase: room.phase,
    seats,
    settings: { ...room.settings },
    tournament: tournamentView(room),
    version: room.version,
    you: seatId,
  };
}

/** Bump the version and push every connected player their own view. */
function commit(room: Room) {
  room.version += 1;
  room.lastActive = Date.now();

  for (const sub of [...room.subscribers]) {
    const seat = authSeat(room, sub.seatId, sub.token);

    if (!seat) {
      // Kicked, replaced by a bot, or left: end their stream.
      room.subscribers.delete(sub);
      sub.close("You are no longer part of this game.");
      continue;
    }

    sub.send(viewFor(room, sub.seatId));
  }
}

function destroyRoom(room: Room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }

  rooms.delete(room.code);

  for (const sub of [...room.subscribers]) {
    room.subscribers.delete(sub);
    sub.close("This game was closed.");
  }
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

function afterGameChange(room: Room) {
  if (room.game?.over && room.phase === "playing") {
    room.phase = "finished";
    concludeSet(room, room.game);
  }

  scheduleBots(room);
}

/** Deal a new set to everybody who has not been eliminated. */
function startSet(room: Room) {
  const seats = activeSeats(room);

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
  afterGameChange(room);
}

function scheduleBots(room: Room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }

  const game = room.game;

  if (room.phase !== "playing" || !game || game.over) {
    return;
  }

  const current = room.seats.find(
    (seat) => seat.id === game.players[game.current].id,
  );

  if (!current || current.kind !== "bot") {
    return;
  }

  const delay =
    config.botDelayMin +
    Math.random() * (config.botDelayMax - config.botDelayMin);

  room.botTimer = setTimeout(() => {
    room.botTimer = null;

    const live = room.game;

    if (!rooms.has(room.code) || room.phase !== "playing" || !live || live.over) {
      return;
    }

    const seat = room.seats.find(
      (candidate) => candidate.id === live.players[live.current].id,
    );

    // The turn may have changed hands (a player was swapped for a bot, say).
    if (!seat || seat.kind !== "bot") {
      return;
    }

    room.game = botTurn(live);
    afterGameChange(room);
    commit(room);
  }, delay);
}

function firstHuman(room: Room, except?: string) {
  return room.seats.find(
    (seat) => seat.kind === "human" && seat.id !== except,
  );
}

function turnIntoBot(seat: Seat) {
  seat.kind = "bot";
  seat.token = null;
  seat.connections = 0;
  seat.name = `${seat.name.slice(0, NAME_MAX - 6)} (bot)`;
}

// --- public API --------------------------------------------------------------

export function createRoom(rawName: unknown) {
  const code = makeCode();
  const token = newToken();
  const host: Seat = {
    connections: 0,
    id: newId(),
    kind: "human",
    name: cleanName(rawName, "Host"),
    token,
  };

  const room: Room = {
    botCounter: 0,
    botTimer: null,
    code,
    game: null,
    gameCount: 0,
    hostId: host.id,
    lastActive: Date.now(),
    phase: "lobby",
    seats: [host],
    settings: {
      cardsPerPlayer: DEFAULT_CARDS,
      elimination: false,
      endMode: "first",
      jokers: true,
    },
    subscribers: new Set(),
    tournament: freshTournament(),
    version: 0,
  };

  normalizeSettings(room);
  rooms.set(code, room);

  return { code, seatId: host.id, token };
}

export function joinRoom(
  code: unknown,
  rawName: unknown,
  token?: unknown,
): Failure | { ok: true; code: string; seatId: string; token: string } {
  const room = rooms.get(normalizeCode(code));

  if (!room) {
    return fail("No game found with that code. Check it and try again.");
  }

  // Coming back with a saved token gives you your old seat.
  if (typeof token === "string") {
    const existing = room.seats.find(
      (seat) =>
        seat.kind === "human" && seat.token !== null && seat.token === token,
    );

    if (existing) {
      return { code: room.code, ok: true, seatId: existing.id, token };
    }
  }

  if (room.phase !== "lobby") {
    return fail("That game has already started.");
  }

  if (room.seats.length >= MAX_SEATS) {
    return fail("This table is full.");
  }

  const seat: Seat = {
    connections: 0,
    id: newId(),
    kind: "human",
    name: uniqueName(room, cleanName(rawName, `Player ${room.seats.length + 1}`)),
    token: newToken(),
  };

  room.seats.push(seat);
  normalizeSettings(room);
  commit(room);

  return { code: room.code, ok: true, seatId: seat.id, token: seat.token as string };
}

export function subscribe(
  code: unknown,
  seatId: unknown,
  token: unknown,
  send: (view: RoomView) => void,
  close: (reason: string) => void,
): Failure | { ok: true; unsubscribe: () => void } {
  const room = rooms.get(normalizeCode(code));

  if (!room) {
    return fail("This game no longer exists.");
  }

  const seat = authSeat(room, seatId, token);

  if (!seat) {
    return fail("You are not part of this game.");
  }

  const sub: Subscriber = {
    close,
    seatId: seat.id,
    send,
    token: seat.token as string,
  };

  seat.connections += 1;
  room.subscribers.add(sub);
  // Everyone (including the newcomer) gets a fresh view.
  commit(room);

  return {
    ok: true,
    unsubscribe: () => {
      if (!room.subscribers.delete(sub)) {
        return;
      }

      seat.connections = Math.max(0, seat.connections - 1);

      if (rooms.has(room.code)) {
        commit(room);
      }
    },
  };
}

export function applyAction(
  code: unknown,
  seatId: unknown,
  token: unknown,
  rawAction: unknown,
): Failure | Done {
  const room = rooms.get(normalizeCode(code));

  if (!room) {
    return fail("This game no longer exists.");
  }

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
        connections: 0,
        id: newId(),
        kind: "bot",
        name: uniqueName(room, `Bot ${room.botCounter}`),
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

      room.seats.splice(index, 1);
      normalizeSettings(room);
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

      room.game = null;
      room.phase = "lobby";
      room.tournament = freshTournament();
      scheduleBots(room);
      normalizeSettings(room);
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

      room.game = result.state;
      afterGameChange(room);
      commit(room);

      return { ok: true };
    }

    case "leave": {
      const inTheSet = room.game?.players.some((p) => p.id === seat.id) ?? false;

      if (room.phase === "playing" && inTheSet) {
        // The game goes on without them: a bot takes the seat.
        turnIntoBot(seat);
      } else {
        // In the lobby, between sets, or only watching: they just go.
        room.seats = room.seats.filter((s) => s.id !== seat.id);
        room.tournament.eliminated = room.tournament.eliminated.filter(
          (id) => id !== seat.id,
        );
      }

      if (!room.seats.some((s) => s.kind === "human")) {
        destroyRoom(room);

        return { ok: true };
      }

      if (room.hostId === seat.id) {
        const next = firstHuman(room, seat.id);

        if (next) {
          room.hostId = next.id;
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
