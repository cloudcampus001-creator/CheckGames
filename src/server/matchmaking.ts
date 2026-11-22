/**
 * Matchmaking: players ask to play against real people, and the system sets
 * the tables up. Plain functions on plain data (a queue), so the very same
 * code runs in the realtime server (queue in memory) and on the website
 * (queue in the shared store).
 *
 * How it decides:
 *  - Whoever has waited longest is looked after first.
 *  - Players are matched with others of a similar rating. The range starts
 *    narrow and widens the longer somebody waits, so a strong player is not
 *    thrown in with a beginner at once, and nobody waits forever either.
 *  - Everybody says which table sizes they like. A full table is made as soon
 *    as there are enough players who all like that size (bigger tables first).
 *  - After a few seconds a smaller table is started with whoever is there; after
 *    a longer wait the size preferences are relaxed too.
 *  - If nobody at all turns up, a player who agreed to it gets a game against
 *    the computer instead of staring at a screen.
 */

export type Ticket = {
  id: string;
  profileId: string;
  name: string;
  avatar: string;
  xp: number;
  rating: number;
  /** Table sizes this player is happy with (2 to 6). */
  sizes: number[];
  /** The clock this player likes (seconds, 0 = none), or null for "any". */
  turn: number | null;
  /** Play the computer if nobody comes. */
  fillBots: boolean;
  joinedAt: number;
  /** The last time this player's page said it is still waiting. */
  seenAt: number;
};

export type Assignment = { code: string; seatId: string; token: string; at: number };

export type Queue = {
  tickets: Ticket[];
  /** Tables that were made, by ticket, until each player has picked theirs up. */
  matches: Record<string, Assignment>;
};

export type Plan = {
  tickets: Ticket[];
  /** Computer players to add. */
  bots: number;
  turnSeconds: number;
  cardsPerPlayer: number;
};

/** A player whose page has not been heard from for this long has left. */
export const STALE_MS = 12_000;
export const MATCH_KEEP_MS = 90_000;
/** After this long a table is started with whoever is there. */
export const PATIENCE_MS = 5_000;
/** After this long the table-size choices are set aside. */
export const RELAX_MS = 15_000;
/** After this long a player who agreed gets the computer. */
export const FILL_MS = 20_000;
export const DEFAULT_SIZES = [2, 3, 4];
export const DEFAULT_TURN_SECONDS = 15;

export const newQueue = (): Queue => ({ matches: {}, tickets: [] });

/** Fill in anything a queue loaded from the store lacks. */
export function ensureQueue(queue: Partial<Queue> | null | undefined): Queue {
  return { matches: queue?.matches ?? {}, tickets: queue?.tickets ?? [] };
}

export function cleanSizes(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  const sizes = [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n >= 2 && n <= 6))];

  return sizes.length > 0 ? sizes.sort((a, b) => a - b) : [...DEFAULT_SIZES];
}

export function cleanTurn(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const seconds = Math.round(Number(raw));

  return seconds === 0 || (seconds >= 3 && seconds <= 120) ? seconds : null;
}

/** Drop players who stopped asking, and old tables nobody picked up. Returns true if anything changed. */
export function prune(queue: Queue, now: number) {
  const tickets = queue.tickets.filter((ticket) => now - ticket.seenAt < STALE_MS);
  let changed = tickets.length !== queue.tickets.length;

  queue.tickets = tickets;

  for (const [id, match] of Object.entries(queue.matches)) {
    if (now - match.at > MATCH_KEEP_MS) {
      delete queue.matches[id];
      changed = true;
    }
  }

  return changed;
}

/**
 * Put a player in the queue. A player who is already there keeps their place
 * (the time they have waited) and just updates what they asked for.
 */
export function join(queue: Queue, ticket: Ticket): Ticket {
  const existing = queue.tickets.find((other) => other.profileId === ticket.profileId);

  if (existing) {
    Object.assign(existing, { ...ticket, id: existing.id, joinedAt: existing.joinedAt });

    return existing;
  }

  queue.tickets.push(ticket);

  return ticket;
}

export function leave(queue: Queue, ticketId: string) {
  const before = queue.tickets.length;

  queue.tickets = queue.tickets.filter((ticket) => ticket.id !== ticketId);

  return queue.tickets.length !== before;
}

/** How far apart in rating two players may be, for somebody who has waited this long. */
export function ratingWindow(waitedMs: number) {
  if (waitedMs >= 40_000) {
    return Number.POSITIVE_INFINITY;
  }

  return 120 + Math.floor(waitedMs / 5000) * 80;
}

const mostCommon = (values: number[]) => {
  const counts = new Map<number, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let best = values[0];

  for (const [value, count] of counts) {
    if (count > (counts.get(best) ?? 0) || (count === counts.get(best) && value < best)) {
      best = value;
    }
  }

  return best;
};

function makePlan(group: Ticket[], bots: number): Plan {
  const size = group.length + bots;
  const turns = group.map((ticket) => ticket.turn).filter((turn): turn is number => turn !== null);

  return {
    bots,
    cardsPerPlayer: size <= 4 ? 7 : size === 5 ? 6 : 5,
    tickets: group,
    turnSeconds: turns.length > 0 ? mostCommon(turns) : DEFAULT_TURN_SECONDS,
  };
}

/** The group the player who has waited longest can be put in right now, or null. */
function pickGroup(first: Ticket, others: Ticket[], waited: number): Ticket[] | null {
  const relaxed = waited >= RELAX_MS;
  const likes = (ticket: Ticket, size: number) => relaxed || ticket.sizes.includes(size);
  const sizes = [...first.sizes].sort((a, b) => b - a);

  // A full table of a size everybody likes: the biggest one there are enough players for.
  for (const size of sizes) {
    const fit = others.filter((other) => likes(other, size));

    if (fit.length >= size - 1) {
      return [first, ...fit.slice(0, size - 1)];
    }
  }

  // Waited a while: start a smaller table with whoever is here.
  if (waited >= PATIENCE_MS && others.length > 0) {
    const biggest = Math.min(others.length + 1, Math.max(...first.sizes, 2));

    for (let size = biggest; size >= 2; size--) {
      if (!likes(first, size)) {
        continue;
      }

      const fit = others.filter((other) => likes(other, size));

      if (fit.length >= size - 1) {
        return [first, ...fit.slice(0, size - 1)];
      }
    }
  }

  return null;
}

/**
 * Make every table that can be made right now. The players put at a table
 * leave the queue; the plans say who plays with whom, and with which clock
 * and how many cards.
 */
export function plan(queue: Queue, now: number): Plan[] {
  const plans: Plan[] = [];
  let again = true;

  while (again) {
    again = false;

    const order = [...queue.tickets].sort((a, b) => a.joinedAt - b.joinedAt);

    for (const first of order) {
      const waited = now - first.joinedAt;
      const window = ratingWindow(waited);
      const others = queue.tickets
        .filter(
          (other) =>
            other.id !== first.id &&
            other.profileId !== first.profileId &&
            Math.abs(other.rating - first.rating) <= window,
        )
        .sort(
          (a, b) =>
            Math.abs(a.rating - first.rating) - Math.abs(b.rating - first.rating) ||
            a.joinedAt - b.joinedAt,
        );
      const group = pickGroup(first, others, waited);

      if (group) {
        const taken = new Set(group.map((ticket) => ticket.id));

        queue.tickets = queue.tickets.filter((ticket) => !taken.has(ticket.id));
        plans.push(makePlan(group, 0));
        again = true;
        break;
      }

      if (waited >= FILL_MS && first.fillBots) {
        const size = first.sizes.includes(3) ? 3 : Math.max(...first.sizes);

        queue.tickets = queue.tickets.filter((ticket) => ticket.id !== first.id);
        plans.push(makePlan([first], Math.max(1, size - 1)));
        again = true;
        break;
      }
    }
  }

  return plans;
}

/** What a waiting player is told. */
export function status(queue: Queue, ticketId: string, now: number) {
  const ticket = queue.tickets.find((candidate) => candidate.id === ticketId);

  return {
    searching: queue.tickets.length,
    waitedMs: ticket ? now - ticket.joinedAt : 0,
  };
}
