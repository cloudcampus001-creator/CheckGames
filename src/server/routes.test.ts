/**
 * End-to-end check of the HTTP layer: calls the route handlers with real
 * Request objects and follows the game by asking for the state, like a browser
 * does. The whole scenario runs twice: against the in-memory store and against
 * a stand-in for Upstash Redis.
 */
import assert from "node:assert/strict";
import { POST as actionRoute } from "@/app/api/rooms/[code]/action/route";
import { POST as joinRoute } from "@/app/api/rooms/[code]/join/route";
import { GET as stateRoute } from "@/app/api/rooms/[code]/state/route";
import { GET as healthRoute } from "@/app/api/health/route";
import { POST as createRoute } from "@/app/api/rooms/route";
import type { RoomView } from "@/multiplayer/protocol";
import { configureRooms } from "./rooms";
import { createMemoryStore, createRedisStore, useStore } from "./store";
import { type FakeUpstash, startFakeUpstash } from "./test-support/fake-upstash";

configureRooms({ botDelayMax: 2, botDelayMin: 0 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Json = Record<string, unknown>;
type Handler = (
  request: Request,
  context: { params: Promise<{ code: string }> },
) => Promise<Response>;

async function post(handler: Handler, code: string, body: unknown) {
  const response = await handler(
    new Request("http://localhost:3000/api", {
      body: typeof body === "string" ? body : JSON.stringify(body),
      method: "POST",
    }),
    { params: Promise.resolve({ code }) },
  );

  return { body: (await response.json()) as Json, status: response.status };
}

type Poll = {
  body: { error?: string; etag?: string; fatal?: boolean; ok: boolean; view?: RoomView | null };
  cacheControl: string | null;
  status: number;
};

async function poll(code: string, seat: string, token: string, since: string): Promise<Poll> {
  const response = await stateRoute(
    new Request(
      `http://localhost:3000/api/rooms/${code}/state?seat=${seat}&token=${token}&since=${encodeURIComponent(since)}`,
    ),
    { params: Promise.resolve({ code }) },
  );

  return {
    body: (await response.json()) as Poll["body"],
    cacheControl: response.headers.get("cache-control"),
    status: response.status,
  };
}

/** A simulated browser: keeps the latest view, asks for news. */
function browser(code: string, seat: string, token: string) {
  const state = { etag: "", view: null as RoomView | null };

  return {
    code,
    get view() {
      return state.view;
    },
    seat,
    async refresh() {
      const result = await poll(code, seat, token, state.etag);

      assert.equal(result.status, 200, `poll should work: ${JSON.stringify(result.body)}`);

      if (result.body.etag) {
        state.etag = result.body.etag;
      }

      if (result.body.view) {
        state.view = result.body.view;
      }

      return state.view;
    },
    token,
  };
}

async function scenario(label: string) {
  // create a game
  const created = await post(createRoute as never, "", { name: "Amina" });

  assert.equal(created.status, 200, label);

  const code = String(created.body.code);
  const host = { seat: String(created.body.seatId), token: String(created.body.token) };

  assert.match(code, /^[A-Z2-9]{4}$/);

  // the host asks and sees the lobby
  const first = await poll(code, host.seat, host.token, "");

  assert.equal(first.status, 200);
  assert.equal(first.cacheControl, "no-store", "never cached by a proxy");
  assert.equal(first.body.view?.you, host.seat);
  assert.equal(first.body.view?.phase, "lobby");
  assert.equal(first.body.view?.seats.length, 1);

  // nothing new: a short answer
  const quiet = await poll(code, host.seat, host.token, first.body.etag ?? "");

  assert.equal(quiet.status, 200);
  assert.equal(quiet.body.view, null);

  // a change shows up on the next poll
  assert.equal(
    (
      await post(actionRoute, code, {
        action: { cardsPerPlayer: 3, type: "setSettings" },
        seatId: host.seat,
        token: host.token,
      })
    ).status,
    200,
  );

  const fresh = await poll(code, host.seat, host.token, first.body.etag ?? "");

  assert.equal(fresh.body.view?.settings.cardsPerPlayer, 3);
  assert.equal(
    (
      await post(actionRoute, code, {
        action: { cardsPerPlayer: 7, type: "setSettings" },
        seatId: host.seat,
        token: host.token,
      })
    ).status,
    200,
  );

  // wrong token / unknown room are final answers, everything else is retried by the browser
  const wrongToken = await poll(code, host.seat, "wrong-token", "");

  assert.equal(wrongToken.status, 404);
  assert.equal(wrongToken.body.fatal, true);

  const nowhere = await poll("ZZZZ", host.seat, host.token, "");

  assert.equal(nowhere.status, 404);
  assert.equal(nowhere.body.fatal, true);

  // a friend joins by code (lower case is fine)
  const joined = await post(joinRoute, code.toLowerCase(), { name: "Paul" });

  assert.equal(joined.status, 200);

  const guest = { seat: String(joined.body.seatId), token: String(joined.body.token) };
  const hostSees = browser(code, host.seat, host.token);
  const guestSees = browser(code, guest.seat, guest.token);

  await hostSees.refresh();
  await guestSees.refresh();
  assert.equal(hostSees.view?.seats.length, 2, "host sees Paul arrive");
  assert.equal(guestSees.view?.you, guest.seat);
  assert.equal(guestSees.view?.hostId, host.seat);

  // bad inputs
  assert.equal((await post(joinRoute, "ZZZZ", { name: "x" })).status, 404);
  assert.equal((await post(joinRoute, "", { name: "x" })).status, 400);
  assert.equal((await post(actionRoute, code, "not json")).status, 400);

  // host-only controls are enforced over HTTP
  const guestBot = await post(actionRoute, code, {
    action: { type: "addBot" },
    seatId: guest.seat,
    token: guest.token,
  });

  assert.equal(guestBot.status, 400);

  const forged = await post(actionRoute, code, {
    action: { type: "addBot" },
    seatId: host.seat,
    token: guest.token,
  });

  assert.equal(forged.status, 403, "a token only works for its own seat");

  for (let i = 0; i < 2; i++) {
    assert.equal(
      (
        await post(actionRoute, code, {
          action: { type: "addBot" },
          seatId: host.seat,
          token: host.token,
        })
      ).status,
      200,
    );
  }

  assert.equal(
    (
      await post(actionRoute, code, {
        action: { endMode: "ranking", type: "setSettings" },
        seatId: host.seat,
        token: host.token,
      })
    ).status,
    200,
  );

  await guestSees.refresh();
  assert.equal(guestSees.view?.seats.length, 4, "Paul sees the bots");

  // the host launches; each player gets only their own cards
  assert.equal(
    (
      await post(actionRoute, code, {
        action: { type: "start" },
        seatId: host.seat,
        token: host.token,
      })
    ).status,
    200,
  );
  await hostSees.refresh();
  await guestSees.refresh();
  assert.equal(guestSees.view?.phase, "playing");

  const hostHand = hostSees.view?.game?.hand.map((c) => c.id) ?? [];
  const guestHand = guestSees.view?.game?.hand.map((c) => c.id) ?? [];

  assert.equal(hostHand.length, 7);
  assert.equal(guestHand.length, 7);
  assert.ok(hostHand.every((id) => !guestHand.includes(id)), "hands are different");

  const guestJson = JSON.stringify(guestSees.view);

  for (const id of hostHand) {
    assert.ok(!guestJson.includes(`"${id}"`), `Paul must not see ${id}`);
  }

  // Paul closes the tab: after a while he shows as offline to the others...
  const realNow = Date.now;
  let offset = 0;

  Date.now = () => realNow() + offset;

  try {
    await hostSees.refresh();
    assert.equal(hostSees.view?.seats.find((s) => s.id === guest.seat)?.connected, true);
    offset = 20_000;
    await hostSees.refresh();
    assert.equal(
      hostSees.view?.seats.find((s) => s.id === guest.seat)?.connected,
      false,
      "Paul shown offline although nothing else changed",
    );

    // ...and coming back with the saved token restores the seat and the cards
    const back = await post(joinRoute, code, { token: guest.token });

    assert.equal(back.status, 200);
    assert.equal(back.body.seatId, guest.seat);

    const guestAgain = browser(code, guest.seat, guest.token);

    await guestAgain.refresh();
    assert.deepEqual(
      guestAgain.view?.game?.hand.map((c) => c.id),
      guestHand,
      "same cards after reconnecting",
    );
    await hostSees.refresh();
    assert.equal(hostSees.view?.seats.find((s) => s.id === guest.seat)?.connected, true);
  } finally {
    Date.now = realNow;
  }

  // The two humans play, the bots play when asked: a whole set through HTTP only.
  let steps = 0;

  while (hostSees.view?.phase !== "finished") {
    steps += 1;
    assert.ok(steps < 4000, `${label}: the game should finish`);

    for (const who of [
      { b: hostSees, creds: host },
      { b: guestSees, creds: guest },
    ]) {
      const view = await who.b.refresh();
      const game = view?.game;

      if (!game || game.over || game.currentSeatId !== who.creds.seat) {
        continue;
      }

      const playable = game.hand.find((card) => game.playableIds.includes(card.id));
      const result = await post(actionRoute, code, {
        action: playable
          ? { cardId: playable.id, suit: playable.rank === "J" ? "hearts" : undefined, type: "play" }
          : { type: "draw" },
        seatId: who.creds.seat,
        token: who.creds.token,
      });

      assert.equal(result.status, 200, JSON.stringify(result.body));
    }

    await sleep(1);
  }

  const done = hostSees.view?.game;

  assert.ok(done?.over);
  assert.equal(done.standings.length, 4, "everybody is ranked");
  assert.ok(
    (done.moves.length ?? 0) <= 40,
    "only the latest moves are sent, however long the game was",
  );

  // the host leaves, then the last person leaves: the room is gone for good
  await post(actionRoute, code, {
    action: { type: "leave" },
    seatId: host.seat,
    token: host.token,
  });
  await post(actionRoute, code, {
    action: { type: "leave" },
    seatId: guest.seat,
    token: guest.token,
  });

  const gone = await poll(code, guest.seat, guest.token, "");

  assert.equal(gone.status, 404);
  assert.equal(gone.body.fatal, true);
  assert.equal((await post(joinRoute, code, { name: "Late" })).status, 404);

  // two rooms never mix
  const other = await post(createRoute as never, "", { name: "Someone" });

  assert.notEqual(other.body.code, code);
}

async function main() {
  // --- in memory ---------------------------------------------------------------------------
  useStore(createMemoryStore());
  await scenario("memory");

  // --- Redis (stand-in) ---------------------------------------------------------------------
  const redis: FakeUpstash = await startFakeUpstash();

  useStore(createRedisStore({ token: redis.token, url: redis.url }));
  await scenario("redis");
  assert.ok(redis.commands() > 50, "the scenario really went through the Redis stand-in");

  // health: reports where games are kept
  const health = await (await healthRoute()).json();

  assert.equal(health.ok, true);
  assert.equal(health.storage, "redis");
  assert.equal(health.warning, null);

  // a storage hiccup is a retryable 503, never "game no longer exists"
  const created = await post(createRoute as never, "", { name: "Amina" });
  const code = String(created.body.code);
  const seat = String(created.body.seatId);
  const token = String(created.body.token);

  redis.failNext(3);

  const hiccup = await poll(code, seat, token, "");

  assert.equal(hiccup.status, 503);
  assert.notEqual(hiccup.body.fatal, true, "a failing database is not a missing game");

  const after = await poll(code, seat, token, "");

  assert.equal(after.status, 200, "and the room is still there afterwards");
  assert.equal(after.body.view?.phase, "lobby");

  redis.failNext(3);
  assert.equal((await (await healthRoute()).json()).ok, false, "health notices a broken database");

  // wrong credentials for the database are reported, not hidden
  useStore(createRedisStore({ token: "wrong", url: redis.url }));

  const denied = await poll(code, seat, token, "");

  assert.equal(denied.status, 503);
  assert.notEqual(denied.body.fatal, true);

  await redis.close();
  useStore(null);
  console.log("All route checks passed.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
