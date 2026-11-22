/**
 * Matchmaking over plain requests, against the shared store (memory here): two
 * players are put at a table, a player alone is given the computer, results are
 * counted into the profiles, and the table is set up as a quick match.
 */
import assert from "node:assert/strict";
import { ensureQueue, type Queue } from "./matchmaking";
import { joinQueue, leaveQueue, pollQueue } from "./matchService";
import { createMemoryProfileStore, useProfileStore } from "./profileStore";
import { hello } from "./profiles";
import { configureRooms } from "./rooms";
import { act, pollRoom } from "./service";
import { createMemoryStore, getStore, useStore } from "./store";

configureRooms({ botDelayMax: 2, botDelayMin: 0 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  useStore(createMemoryStore());
  useProfileStore(createMemoryProfileStore());

  const A = { id: "device-aaaaaaaa", secret: "secret-aaaaaaaa" };
  const B = { id: "device-bbbbbbbb", secret: "secret-bbbbbbbb" };
  const C = { id: "device-cccccccc", secret: "secret-cccccccc" };

  await hello({ ...A, name: "Amina" });
  await hello({ ...B, name: "Paul" });
  await hello({ ...C, name: "Rita" });

  // you need a profile to play online
  const guest = await joinQueue({ id: undefined, secret: undefined }, {});

  assert.ok(!guest.ok);

  // one player waits; a second one makes a table at once
  const a = await joinQueue(A, { fillBots: false, sizes: [2], turn: 10 });

  assert.ok(a.ok);

  const waiting = await pollQueue(a.ok ? a.ticket : "");

  assert.ok(waiting.ok && waiting.state === "waiting" && waiting.searching === 1);

  const b = await joinQueue(B, { fillBots: false, sizes: [2], turn: 10 });

  assert.ok(b.ok);

  const gotA = await pollQueue(a.ok ? a.ticket : "");
  const gotB = await pollQueue(b.ok ? b.ticket : "");

  assert.ok(gotA.ok && gotA.state === "matched", JSON.stringify(gotA));
  assert.ok(gotB.ok && gotB.state === "matched");

  const matchA = gotA.ok && gotA.state === "matched" ? gotA.match : null;
  const matchB = gotB.ok && gotB.state === "matched" ? gotB.match : null;

  assert.ok(matchA && matchB);
  assert.equal(matchA.code, matchB.code, "the same table");
  assert.notEqual(matchA.seatId, matchB.seatId);

  // the table exists, is a quick match, and the game is on
  const polled = await pollRoom(matchA.code, matchA.seatId, matchA.token, "");

  assert.ok(polled.ok && polled.view);

  const view = polled.ok ? polled.view : null;

  assert.equal(view?.phase, "playing");
  assert.equal(view?.matchmade, true);
  assert.equal(view?.turnSeconds, 10, "the clock they both asked for");
  assert.deepEqual(view?.seats.map((s) => s.name).sort(), ["Amina", "Paul"], "names come from the profiles");
  assert.equal((await act(matchA.code, matchA.seatId, matchA.token, { type: "addBot" })).ok, false);

  // a player who changed their mind is gone from the queue
  const c = await joinQueue(C, { fillBots: false, sizes: [2] });

  assert.ok(c.ok);
  assert.ok((await leaveQueue(c.ok ? c.ticket : "")).ok);

  const gone = await pollQueue(c.ok ? c.ticket : "");

  assert.ok(gone.ok && gone.state === "gone");

  // alone for 20 seconds: the computer plays instead (the wait is faked by making the ticket older)
  const c2 = await joinQueue(C, { fillBots: true, sizes: [3] });

  assert.ok(c2.ok);

  const loaded = await getStore().get("QUEUE");

  assert.ok(loaded);

  const queue: Queue = ensureQueue(loaded.room as unknown as Partial<Queue>);

  for (const ticket of queue.tickets) {
    ticket.joinedAt -= 25_000;
  }

  assert.equal(await getStore().save("QUEUE", loaded.rev, queue as never), "ok");

  const alone = await pollQueue(c2.ok ? c2.ticket : "");

  assert.ok(alone.ok && alone.state === "matched", JSON.stringify(alone));

  const mine = alone.ok && alone.state === "matched" ? alone.match : null;

  assert.ok(mine);

  const solo = await pollRoom(mine.code, mine.seatId, mine.token, "");

  assert.equal(solo.ok && solo.view?.seats.length, 3, "Rita and two computer players");
  assert.equal(solo.ok && solo.view?.seats.filter((s) => s.kind === "bot").length, 2);

  // the game is played over plain requests, and the result lands in the profile
  let steps = 0;
  let latest = solo.ok ? solo.view : null;

  while (latest && latest.phase !== "finished") {
    steps += 1;
    assert.ok(steps < 6000, "the game should finish");

    const game = latest.game;

    if (game && !game.over && game.currentSeatId === mine.seatId) {
      const playable = game.hand.find((card) => game.playableIds.includes(card.id));
      const result = await act(
        mine.code,
        mine.seatId,
        mine.token,
        playable
          ? { cardId: playable.id, suit: playable.rank === "J" ? "hearts" : undefined, type: "play" }
          : { type: "draw" },
      );

      assert.ok(result.ok, JSON.stringify(result));
      latest = result.ok && result.view ? result.view : latest;
    } else {
      await sleep(2);

      const again = await pollRoom(mine.code, mine.seatId, mine.token, "");

      latest = again.ok && again.view ? again.view : latest;
    }
  }

  const rita = await hello(C);

  assert.ok(rita.ok);
  assert.equal(rita.ok && rita.profile.stats.played, 1, "the set was counted");
  assert.equal(rita.ok && rita.profile.stats.modes.online.played, 1, "as an online game");
  assert.equal(rita.ok && rita.profile.history.length, 1);

  // a quick match does not trap anybody afterwards
  assert.equal(latest?.canLeave, true);
  assert.ok((await act(mine.code, mine.seatId, mine.token, { type: "leave" })).ok);

  useStore(null);
  useProfileStore(null);
  console.log("All match service checks passed.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
