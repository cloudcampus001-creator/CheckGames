/**
 * Matchmaking over plain requests (no realtime server): the queue lives in the
 * same shared store as the games, as one more document, and every player's
 * page asks about it about once a second. Whoever asks next does the matching
 * (see matchmaking.ts), so nothing has to keep running between requests.
 */
import {
  cleanSizes,
  cleanTurn,
  ensureQueue,
  join,
  leave,
  newQueue,
  plan,
  prune,
  type Queue,
  status,
  type Ticket,
} from "./matchmaking";
import { resolveIdentity } from "./profiles";
import { makeCode, newMatchRoom, type Room } from "./rooms";
import { getStore } from "./store";

const QUEUE_CODE = "QUEUE";
/** A page that is still waiting says so at least this often. */
const HEARTBEAT_MS = 3000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type MatchFailure = { ok: false; error: string };
export type MatchStatus =
  | { ok: true; state: "waiting"; searching: number; waitedMs: number }
  | { ok: true; state: "matched"; match: { code: string; seatId: string; token: string } }
  | { ok: true; state: "gone" };

/** Make the tables that can be made now; the new rooms are added to `made`. */
function settle(queue: Queue, now: number, made: Room[]) {
  for (const table of plan(queue, now)) {
    const code = makeCode();
    const entries = table.tickets.map((ticket) => ({
      identity: {
        avatar: ticket.avatar,
        profileId: ticket.profileId,
        rating: ticket.rating,
        xp: ticket.xp,
      },
      name: ticket.name,
      ticketId: ticket.id,
    }));
    const { creds, room } = newMatchRoom(
      code,
      entries,
      { bots: table.bots, cardsPerPlayer: table.cardsPerPlayer, turnSeconds: table.turnSeconds },
      now,
    );

    made.push(room);

    for (const [ticketId, seat] of Object.entries(creds)) {
      queue.matches[ticketId] = { at: now, code, seatId: seat.seatId, token: seat.token };
    }
  }
}

/**
 * Load the queue, let `run` change it, and save it if it changed. Rooms made on
 * the way are stored first, so nobody is ever told about a table that is not there.
 */
async function mutate<T>(
  run: (queue: Queue, now: number, made: Room[]) => { dirty: boolean; result: T },
): Promise<T | null> {
  const store = getStore();

  for (let attempt = 0; attempt < 6; attempt++) {
    let loaded = await store.get(QUEUE_CODE);

    if (!loaded) {
      await store.create(QUEUE_CODE, newQueue() as unknown as Room);
      loaded = await store.get(QUEUE_CODE);

      if (!loaded) {
        continue;
      }
    }

    const queue = ensureQueue(loaded.room as unknown as Partial<Queue>);
    const made: Room[] = [];
    const { dirty, result } = run(queue, Date.now(), made);

    if (!dirty && made.length === 0) {
      return result;
    }

    for (const room of made) {
      await store.create(room.code, room);
    }

    const saved = await store.save(QUEUE_CODE, loaded.rev, queue as unknown as Room);

    if (saved === "ok") {
      return result;
    }

    await pause(10 + Math.random() * 40 * (attempt + 1));
  }

  return null;
}

export async function joinQueue(
  auth: { id: unknown; secret: unknown },
  wants: { sizes?: unknown; turn?: unknown; fillBots?: unknown },
): Promise<{ ok: true; ticket: string } | MatchFailure> {
  const who = await resolveIdentity(auth);

  if (!who) {
    return { error: "Open your profile first, then find a match.", ok: false };
  }

  const result = await mutate((queue, now, made) => {
    prune(queue, now);

    const ticket: Ticket = join(queue, {
      avatar: who.identity.avatar,
      fillBots: wants.fillBots !== false,
      id: crypto.randomUUID(),
      joinedAt: now,
      name: who.name,
      profileId: who.identity.profileId,
      rating: who.identity.rating,
      seenAt: now,
      sizes: cleanSizes(wants.sizes),
      turn: cleanTurn(wants.turn),
      xp: who.identity.xp,
    });

    settle(queue, now, made);

    return { dirty: true, result: ticket.id };
  });

  return result ? { ok: true, ticket: result } : { error: "The game server is busy. Please try again.", ok: false };
}

export async function pollQueue(ticketId: unknown): Promise<MatchStatus | MatchFailure> {
  const id = String(ticketId ?? "");
  const result = await mutate<MatchStatus>((queue, now, made) => {
    let dirty = prune(queue, now);
    const ticket = queue.tickets.find((candidate) => candidate.id === id);

    // A page that waits says so now and then (not every time: that would be a write per second each).
    if (ticket && now - ticket.seenAt > HEARTBEAT_MS) {
      ticket.seenAt = now;
      dirty = true;
    }

    const before = made.length;

    settle(queue, now, made);
    dirty = dirty || made.length > before;

    const match = queue.matches[id];

    if (match) {
      return { dirty, result: { match: { code: match.code, seatId: match.seatId, token: match.token }, ok: true, state: "matched" } };
    }

    if (!ticket) {
      return { dirty, result: { ok: true, state: "gone" } };
    }

    return { dirty, result: { ok: true, state: "waiting", ...status(queue, id, now) } };
  });

  return result ?? { error: "The game server is busy. Please try again.", ok: false };
}

export async function leaveQueue(ticketId: unknown): Promise<{ ok: true }> {
  const id = String(ticketId ?? "");

  await mutate((queue) => ({ dirty: leave(queue, id), result: null }));

  return { ok: true };
}
