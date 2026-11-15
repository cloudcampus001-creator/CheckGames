/**
 * What the API routes call. Every function here is stateless: it loads the
 * room from the store, runs the plain rules from rooms.ts on it, and saves it
 * again. Whichever server instance receives a request can serve it.
 *
 * Saving is optimistic. If somebody else saved the room in between, the save
 * is refused and the work is redone on the fresh room (a few times, with a
 * short random pause so two requests do not collide again and again).
 */
import type { RoomView } from "../multiplayer/protocol";
import {
  applyAction,
  checkSeat,
  etagOf,
  joinInto,
  makeCode,
  newRoom,
  normalizeCode,
  type Room,
  tickBots,
  touchSeat,
  viewFor,
} from "./rooms";
import { getStore } from "./store";

export type Failure = {
  ok: false;
  error: string;
  /** The game is gone for good (or you are not in it): stop asking. */
  fatal?: boolean;
  /** Suggested HTTP status. */
  status: number;
};

const failure = (error: string, status = 400, fatal = false): Failure => ({
  error,
  fatal,
  ok: false,
  status,
});

const GONE = "This game no longer exists. Ask the host for a new code.";
const BUSY = "The game server is busy. Please try again.";
const TRIES = 6;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Step<T> = { dirty: boolean; result: T };
type Outcome<T> = { kind: "ok"; result: T } | { kind: "missing" } | { kind: "busy" };

/**
 * Load a room, let `run` change it, save it if it did. Retries when somebody
 * else saved first. `readOnly` is the last resort for plain reads: it answers
 * from the newest room without saving anything.
 */
async function update<T>(
  code: string,
  run: (room: Room, now: number) => Step<T>,
  readOnly?: (room: Room, now: number) => T,
): Promise<Outcome<T>> {
  const store = getStore();

  for (let attempt = 0; attempt < TRIES; attempt++) {
    const loaded = await store.get(code);

    if (!loaded) {
      return { kind: "missing" };
    }

    const now = Date.now();
    const { dirty, result } = run(loaded.room, now);

    if (!dirty) {
      return { kind: "ok", result };
    }

    if (loaded.room.closed) {
      await store.remove(code);

      return { kind: "ok", result };
    }

    const saved = await store.save(code, loaded.rev, loaded.room);

    if (saved === "ok") {
      return { kind: "ok", result };
    }

    if (saved === "missing") {
      return { kind: "missing" };
    }

    await pause(15 + Math.random() * 45 * (attempt + 1));
  }

  if (readOnly) {
    const loaded = await getStore().get(code);

    return loaded
      ? { kind: "ok", result: readOnly(loaded.room, Date.now()) }
      : { kind: "missing" };
  }

  return { kind: "busy" };
}

// --- the operations -------------------------------------------------------------

export async function createRoom(
  rawName: unknown,
): Promise<{ ok: true; code: string; seatId: string; token: string } | Failure> {
  const store = getStore();

  for (let attempt = 0; attempt < 12; attempt++) {
    const code = makeCode();
    const { room, seatId, token } = newRoom(code, rawName, Date.now());

    if (await store.create(code, room)) {
      return { code, ok: true, seatId, token };
    }
  }

  return failure("Could not make a game code. Please try again.", 503);
}

export async function joinRoom(
  code: unknown,
  rawName: unknown,
  token?: unknown,
): Promise<{ ok: true; code: string; seatId: string; token: string } | Failure> {
  const clean = normalizeCode(code);

  if (!clean) {
    return failure("Enter the game code.");
  }

  const outcome = await update(clean, (room, now) => {
    const joined = joinInto(room, rawName, token, now);

    return { dirty: joined.ok && joined.changed, result: joined };
  });

  if (outcome.kind === "missing") {
    return failure("No game found with that code. Check it and try again.", 404);
  }

  if (outcome.kind === "busy") {
    return failure(BUSY, 503);
  }

  const joined = outcome.result;

  if (!joined.ok) {
    return failure(joined.error);
  }

  return { code: joined.code, ok: true, seatId: joined.seatId, token: joined.token };
}

/**
 * A browser asking how the room looks. `since` is the tag it already has; if
 * nothing changed the answer is short. Asking also tells the room this player
 * is here, and gives any bot whose turn it is the chance to move.
 */
export async function pollRoom(
  code: unknown,
  seatId: unknown,
  token: unknown,
  since: string,
): Promise<{ ok: true; etag: string; view: RoomView | null } | Failure> {
  const clean = normalizeCode(code);
  const answer = (room: Room, now: number) => {
    const etag = etagOf(room, now);

    return { etag, view: etag === since ? null : viewFor(room, String(seatId), now) };
  };

  const outcome = await update(
    clean,
    (room, now) => {
      if (!checkSeat(room, seatId, token)) {
        return { dirty: false, result: null };
      }

      const touched = touchSeat(room, String(seatId), now);
      const moved = tickBots(room, now);

      return { dirty: touched || moved, result: answer(room, now) };
    },
    (room, now) => (checkSeat(room, seatId, token) ? answer(room, now) : null),
  );

  if (outcome.kind === "missing") {
    return failure(GONE, 404, true);
  }

  if (outcome.kind === "busy") {
    return failure(BUSY, 503);
  }

  if (!outcome.result) {
    return failure("You are not part of this game.", 404, true);
  }

  return { etag: outcome.result.etag, ok: true, view: outcome.result.view };
}

export async function act(
  code: unknown,
  seatId: unknown,
  token: unknown,
  action: unknown,
): Promise<{ ok: true } | Failure> {
  const clean = normalizeCode(code);
  const outcome = await update(clean, (room, now) => {
    if (!checkSeat(room, seatId, token)) {
      return { dirty: false, result: failure("You are not part of this game.", 403, true) };
    }

    const touched = touchSeat(room, String(seatId), now);
    // A bot whose time is up goes first, so the order of play is respected.
    const moved = tickBots(room, now);
    const done = applyAction(room, seatId, token, action, now);

    return {
      dirty: touched || moved || done.ok,
      result: done.ok ? ({ ok: true } as const) : failure(done.error),
    };
  });

  if (outcome.kind === "missing") {
    return failure(GONE, 404, true);
  }

  if (outcome.kind === "busy") {
    return failure(BUSY, 503);
  }

  return outcome.result;
}

/** Checks the store answers. Used by /api/health. */
export async function pingStore() {
  const started = Date.now();

  await getStore().ping();

  return Date.now() - started;
}
