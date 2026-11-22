import assert from "node:assert/strict";
import {
  cleanSizes,
  cleanTurn,
  FILL_MS,
  join,
  leave,
  newQueue,
  PATIENCE_MS,
  plan,
  prune,
  RELAX_MS,
  ratingWindow,
  STALE_MS,
  type Ticket,
} from "./matchmaking";

const T = 1_000_000;

let counter = 0;
function ticket(rating: number, extra: Partial<Ticket> = {}, at = T): Ticket {
  counter += 1;

  return {
    avatar: "😀",
    fillBots: true,
    id: `t${counter}`,
    joinedAt: at,
    name: `P${counter}`,
    profileId: `profile-${counter}-xxxx`,
    rating,
    seenAt: at,
    sizes: [2, 3, 4],
    turn: null,
    xp: 0,
    ...extra,
  };
}

// --- cleaning what a device asks for -------------------------------------------------
assert.deepEqual(cleanSizes([4, 2, 9, "x", 2]), [2, 4]);
assert.deepEqual(cleanSizes([]), [2, 3, 4]);
assert.deepEqual(cleanSizes("nope"), [2, 3, 4]);
assert.equal(cleanTurn(null), null);
assert.equal(cleanTurn(0), 0);
assert.equal(cleanTurn(15), 15);
assert.equal(cleanTurn(2), null);
assert.equal(cleanTurn(500), null);
assert.ok(ratingWindow(0) < ratingWindow(10_000) && ratingWindow(10_000) < ratingWindow(30_000));
assert.equal(ratingWindow(60_000), Number.POSITIVE_INFINITY);

// --- nobody to play with: wait, then the computer ------------------------------------------
{
  const q = newQueue();
  const alone = join(q, ticket(1000));

  assert.deepEqual(plan(q, T + 1000), [], "one player cannot make a table yet");
  assert.deepEqual(plan(q, T + FILL_MS - 1), []);

  const plans = plan(q, T + FILL_MS);

  assert.equal(plans.length, 1);
  assert.equal(plans[0].bots, 2, "a table of 3: the player and two computers");
  assert.deepEqual(plans[0].tickets.map((x) => x.id), [alone.id]);
  assert.equal(q.tickets.length, 0, "and they are out of the queue");

  // a player who does not want the computer keeps waiting
  const q2 = newQueue();

  join(q2, ticket(1000, { fillBots: false }));
  assert.deepEqual(plan(q2, T + 600_000), []);
}

// --- full tables as soon as there are enough players ----------------------------------------
{
  const q = newQueue();

  join(q, ticket(1000, { sizes: [2] }));
  join(q, ticket(1010, { sizes: [2] }));

  const plans = plan(q, T);

  assert.equal(plans.length, 1, "two who both want a duel start at once");
  assert.equal(plans[0].tickets.length, 2);
  assert.equal(plans[0].bots, 0);
  assert.equal(plans[0].cardsPerPlayer, 7);
  assert.equal(plans[0].turnSeconds, 15, "default clock");
}
{
  // four players who all like 4: one table of four, not two duels
  const q = newQueue();

  for (const rating of [1000, 1005, 1010, 1020]) {
    join(q, ticket(rating, { sizes: [2, 4] }));
  }

  const plans = plan(q, T);

  assert.equal(plans.length, 1);
  assert.equal(plans[0].tickets.length, 4);
}
{
  // nobody is put at a table of a size they did not ask for (before the wait runs long)
  const q = newQueue();

  join(q, ticket(1000, { sizes: [4] }));
  join(q, ticket(1000, { sizes: [2] }));
  assert.deepEqual(plan(q, T), [], "a 4-table and a duel do not mix");
  assert.deepEqual(plan(q, T + PATIENCE_MS), [], "still not");

  const relaxed = plan(q, T + RELAX_MS);

  assert.equal(relaxed.length, 1, "after a long wait anything goes");
  assert.equal(relaxed[0].tickets.length, 2);
}

// --- a smaller table after a few seconds, with whoever is there ---------------------------------------
{
  const q = newQueue();

  join(q, ticket(1000, { sizes: [4] }));
  join(q, ticket(1000, { sizes: [3, 4] }));
  assert.deepEqual(plan(q, T + 1000), [], "wait a little for more people");

  // the first wanted 4 only, so a table of 3 is not what they asked for; the two of them need a size both like
  const q2 = newQueue();

  join(q2, ticket(1000, { sizes: [2, 3, 4] }));
  join(q2, ticket(1000, { sizes: [2, 3, 4] }));
  join(q2, ticket(1000, { sizes: [2, 3, 4] }));

  const quick = plan(q2, T);

  assert.equal(quick.length, 1);
  assert.equal(quick[0].tickets.length, 3, "three players who like 3 start right away");
}
{
  // 5 players, everybody likes 2-4: a table of 4 and the fifth waits (then plays with newcomers)
  const q = newQueue();

  for (let i = 0; i < 5; i++) {
    join(q, ticket(1000 + i));
  }

  const plans = plan(q, T);

  assert.equal(plans.length, 1);
  assert.equal(plans[0].tickets.length, 4);
  assert.equal(q.tickets.length, 1, "one is left waiting");

  join(q, ticket(1001, {}, T + 500));
  assert.equal(plan(q, T + 600).length, 1, "and a new player makes a duel with them");
  assert.equal(q.tickets.length, 0);
}

// --- rating: similar players first, the range widens with the wait ---------------------------------------
{
  const q = newQueue();
  const strong = join(q, ticket(1600, { sizes: [2] }));

  join(q, ticket(900, { sizes: [2] }));
  assert.deepEqual(plan(q, T), [], "a beginner and a legend are not matched at once");
  assert.deepEqual(plan(q, T + 10_000), [], "not after 10 s either");

  const plans = plan(q, T + 40_000);

  assert.equal(plans.length, 1, "after a long wait they are");
  assert.ok(plans[0].tickets.some((x) => x.id === strong.id));
}
{
  // the closest rating is picked, not the first in line
  const q = newQueue();
  const me = join(q, ticket(1200, { sizes: [2] }, T));

  join(q, ticket(1000, { sizes: [2] }, T + 1));
  const near = join(q, ticket(1190, { sizes: [2] }, T + 2));
  const plans = plan(q, T + 10);

  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].tickets.map((x) => x.id).sort(), [me.id, near.id].sort());
}

// --- who is served first, and the clock chosen ------------------------------------------------------------------
{
  const q = newQueue();
  const old = join(q, ticket(1000, { sizes: [2] }, T));

  join(q, ticket(1000, { sizes: [2], turn: 10 }, T + 100));
  join(q, ticket(1000, { sizes: [2], turn: 10 }, T + 200));
  join(q, ticket(1000, { sizes: [2], turn: 30 }, T + 300));

  const plans = plan(q, T + 400);

  assert.equal(plans.length, 2);
  assert.ok(plans[0].tickets.some((x) => x.id === old.id), "who waited longest is placed first");
  assert.equal(q.tickets.length, 0);

  const q2 = newQueue();

  join(q2, ticket(1000, { sizes: [3], turn: 10 }));
  join(q2, ticket(1000, { sizes: [3], turn: 10 }));
  join(q2, ticket(1000, { sizes: [3], turn: 5 }));
  assert.equal(plan(q2, T)[0].turnSeconds, 10, "the clock most of them asked for");

  const q3 = newQueue();

  join(q3, ticket(1000, { sizes: [2], turn: 0 }));
  join(q3, ticket(1000, { sizes: [2], turn: null }));
  assert.equal(plan(q3, T)[0].turnSeconds, 0, "one asked for no clock and the other does not mind");
}

// --- the same person is never put against themselves; leaving; stale pages ---------------------------------------
{
  const q = newQueue();
  const a = join(q, ticket(1000, { sizes: [2] }));
  const again = join(q, { ...ticket(1000, { sizes: [2] }), id: "other", profileId: a.profileId });

  assert.equal(q.tickets.length, 1, "joining twice is one place in the queue");
  assert.equal(again.id, a.id);
  assert.equal(again.joinedAt, a.joinedAt, "they keep the time they waited");
  assert.deepEqual(plan(q, T + 1000), []);

  assert.equal(leave(q, a.id), true);
  assert.equal(leave(q, a.id), false);
  assert.equal(q.tickets.length, 0);
}
{
  const q = newQueue();

  join(q, ticket(1000, { seenAt: T }));
  join(q, ticket(1000, { seenAt: T + 10_000 }));
  q.matches.x = { at: T, code: "ABCD", seatId: "s", token: "t" };

  assert.equal(prune(q, T + 5000), false);
  assert.equal(prune(q, T + STALE_MS + 1), true, "the one who stopped asking is dropped");
  assert.equal(q.tickets.length, 1);
  assert.equal(prune(q, T + 100_000), true);
  assert.deepEqual(q.matches, {}, "tables nobody picked up are forgotten");
}

// --- a crowd: everybody ends up somewhere, nobody twice -------------------------------------------------------------
{
  const q = newQueue();
  const all: Ticket[] = [];

  for (let i = 0; i < 37; i++) {
    all.push(join(q, ticket(900 + ((i * 53) % 400), { sizes: i % 3 === 0 ? [2] : i % 3 === 1 ? [3, 4] : [2, 3, 4], turn: i % 2 ? 10 : null }, T + i * 100)));
  }

  const seated = new Set<string>();
  let now = T + 5000;

  for (let step = 0; step < 100; step++) {
    for (const made of plan(q, now)) {
      assert.ok(made.tickets.length + made.bots >= 2 && made.tickets.length + made.bots <= 6);
      assert.equal(new Set(made.tickets.map((x) => x.profileId)).size, made.tickets.length);

      for (const seat of made.tickets) {
        assert.equal(seated.has(seat.id), false, "nobody at two tables");
        seated.add(seat.id);
      }
    }

    for (const waiting of q.tickets) {
      waiting.seenAt = now;
    }

    now += 2000;
  }

  assert.equal(seated.size, all.length, "everybody was seated in the end");
  assert.equal(q.tickets.length, 0);
}

console.log("All matchmaking checks passed.");
