/**
 * The parts that make the game dependable on serverless hosting: many
 * requests at once, requests answered by different "instances", bots that move
 * only when somebody asks, and games that run long.
 */
import assert from "node:assert/strict";
import type { RoomView } from "../multiplayer/protocol";
import { configureRooms } from "./rooms";
import { act, createRoom, joinRoom, pollRoom } from "./service";
import { createMemoryStore, createRedisStore, type RoomStore, useStore } from "./store";
import { startFakeUpstash } from "./test-support/fake-upstash";

configureRooms({ botDelayMax: 2, botDelayMin: 0 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Creds = { code: string; seatId: string; token: string };

async function mustCreate(name: string): Promise<Creds> {
  const result = await createRoom(name);

  assert.ok(result.ok, "room created");

  return result as Creds & { ok: true };
}

async function mustJoin(code: string, name: string): Promise<Creds> {
  const result = await joinRoom(code, name);

  assert.ok(result.ok, `join: ${JSON.stringify(result)}`);

  return result as Creds & { ok: true };
}

async function view(who: Creds): Promise<RoomView> {
  const result = await pollRoom(who.code, who.seatId, who.token, "");

  assert.ok(result.ok && result.view, `poll: ${JSON.stringify(result)}`);

  return result.view as RoomView;
}

async function run(label: string, makeStore: () => RoomStore, afterwards?: () => void) {
  useStore(makeStore());

  // --- many people join at the same moment: nobody is lost --------------------------------
  {
    const host = await mustCreate("Host");
    const joiners = await Promise.all(
      Array.from({ length: 9 }, (_, i) => mustJoin(host.code, `Guest${i}`)),
    );
    const seen = await view(host);

    assert.equal(seen.seats.length, 10, `${label}: ten seats, none overwritten`);
    assert.equal(new Set(seen.seats.map((s) => s.id)).size, 10);
    assert.equal(new Set(seen.seats.map((s) => s.name)).size, 10, "names made unique");

    for (const joiner of joiners) {
      assert.ok(seen.seats.some((s) => s.id === joiner.seatId));
    }

    // everybody polling and the host changing settings at once: every change survives
    const noise = Array.from({ length: 30 }, (_, i) => view(joiners[i % joiners.length]));
    const changes = [
      act(host.code, host.seatId, host.token, { cardsPerPlayer: 3, type: "setSettings" }),
      act(host.code, host.seatId, host.token, { jokers: false, type: "setSettings" }),
      act(host.code, host.seatId, host.token, { endMode: "ranking", type: "setSettings" }),
    ];

    const results = await Promise.all([...changes, ...noise]);

    assert.ok(results.slice(0, 3).every((r) => "ok" in r && r.ok), "settings accepted");

    const after = await view(host);

    assert.equal(after.settings.cardsPerPlayer, 3);
    assert.equal(after.settings.jokers, false);
    assert.equal(after.settings.endMode, "ranking");
    assert.equal(after.seats.length, 10);
  }

  // --- a game with bots is played only by asking: bots move when polled --------------------
  {
    const human = await mustCreate("Solo");

    for (let i = 0; i < 3; i++) {
      assert.ok((await act(human.code, human.seatId, human.token, { type: "addBot" })).ok);
    }

    assert.ok((await act(human.code, human.seatId, human.token, { endMode: "ranking", type: "setSettings" })).ok);
    assert.ok((await act(human.code, human.seatId, human.token, { cardsPerPlayer: 4, type: "setSettings" })).ok);
    assert.ok((await act(human.code, human.seatId, human.token, { type: "start" })).ok);

    let latest = await view(human);
    const started = Date.now();
    let steps = 0;
    let longestMoves = 0;

    while (latest.phase !== "finished") {
      steps += 1;
      assert.ok(steps < 20000 && Date.now() - started < 60000, `${label}: the game should finish`);

      const game = latest.game;

      if (game && game.currentSeatId === human.seatId && !game.over) {
        const playable = game.hand.find((card) => game.playableIds.includes(card.id));
        const result = await act(human.code, human.seatId, human.token, playable
          ? { cardId: playable.id, suit: playable.rank === "J" ? "hearts" : undefined, type: "play" }
          : { type: "draw" });

        assert.ok(result.ok, JSON.stringify(result));
      } else {
        await sleep(1);
      }

      latest = await view(human);
      longestMoves = Math.max(longestMoves, latest.game?.moves.length ?? 0);
    }

    assert.equal(latest.game?.standings.length, 4);
    assert.ok(longestMoves <= 40);

    // the saved room never grows without limit, however long the game
    const stored = await (await import("./store")).getStore().get(human.code);
    const events = stored?.room.game?.events.length ?? 0;

    assert.ok(events <= 130, `${label}: events are trimmed (${events})`);
  }

  // --- a different server instance (empty memory) sees the same room -------------------------
  if (afterwards) {
    const host = await mustCreate("Host");
    const guest = await mustJoin(host.code, "Paul");
    const first = await view(host);

    // a brand new "instance": the shared store is the only thing it has
    afterwards();

    const second = await view(guest);

    assert.equal(second.seats.length, 2);
    assert.equal(second.hostId, first.hostId);
    assert.ok((await act(host.code, host.seatId, host.token, { type: "addBot" })).ok);
    assert.equal((await view(guest)).seats.length, 3);
  }
}

async function main() {
  await run("memory", () => createMemoryStore());

  const redis = await startFakeUpstash();

  // a database that answers at random speeds, so requests really overlap
  redis.jitter(6);

  const connect = () => createRedisStore({ token: redis.token, url: redis.url });

  await run("redis", connect, () => useStore(connect()));
  assert.ok(redis.conflicts() > 0, "requests really collided, and the collisions were resolved");
  console.log(`(Redis stand-in: ${redis.commands()} commands, ${redis.conflicts()} collisions resolved)`);

  // everything the game stores lives under its own key prefix
  assert.ok(redis.keys().every((key) => key.startsWith("cheque:")));

  await redis.close();
  useStore(null);
  console.log("All service checks passed.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
