/**
 * Plays real games over real WebSockets against the realtime server:
 * pushes arrive at once, bots and timers work with nobody asking, and a
 * player who closes the page shows as offline immediately.
 */
import assert from "node:assert/strict";
import { configureRooms } from "../src/server/rooms";
import type { RoomView } from "../src/multiplayer/protocol";
import { startServer } from "./server";

configureRooms({ botDelayMax: 6, botDelayMin: 2, returnDelay: 400, voteDuration: 500 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Reply = Record<string, unknown> & { ok?: boolean; error?: string; fatal?: boolean };

class Client {
  socket: WebSocket;
  view: RoomView | null = null;
  views = 0;
  fatal: string | null = null;
  private next = 1;
  private waiting = new Map<number, (reply: Reply) => void>();
  creds: { code: string; seatId: string; token: string } | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => {
      const data = JSON.parse(String(event.data)) as Record<string, unknown>;

      if (data.t === "view") {
        this.view = data.view as RoomView;
        this.views += 1;
      } else if (data.t === "fatal") {
        this.fatal = String(data.error);
      } else if (typeof data.id === "number") {
        this.waiting.get(data.id)?.(data as Reply);
        this.waiting.delete(data.id);
      }
    };
  }

  opened() {
    return new Promise<void>((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error("could not connect"));
    });
  }

  request(type: string, body: Record<string, unknown> = {}) {
    const id = this.next++;

    return new Promise<Reply>((resolve) => {
      this.waiting.set(id, resolve);
      this.socket.send(JSON.stringify({ id, type, ...body }));
    });
  }

  act(action: object) {
    assert.ok(this.creds);

    return this.request("act", { action, ...this.creds });
  }

  watch() {
    assert.ok(this.creds);

    return this.request("watch", this.creds);
  }

  async until(condition: (view: RoomView) => boolean, label: string, ms = 5000) {
    const started = Date.now();

    while (!(this.view && condition(this.view))) {
      if (Date.now() - started > ms) {
        throw new Error(`Timed out waiting for: ${label}`);
      }

      await sleep(2);
    }

    return this.view;
  }
}

async function connect(url: string) {
  const client = new Client(url);

  await client.opened();

  return client;
}

async function main() {
  const running = await startServer(0);
  const url = `ws://127.0.0.1:${running.port}`;

  // health check over plain http
  const health = (await (await fetch(`http://127.0.0.1:${running.port}`)).json()) as { ok: boolean };

  assert.equal(health.ok, true);

  const amina = await connect(url);
  const paul = await connect(url);

  // --- create, join, watch: changes are pushed, nobody asks --------------------------------
  const created = await amina.request("create", { name: "Amina" });

  assert.ok(created.ok);
  amina.creds = { code: String(created.code), seatId: String(created.seatId), token: String(created.token) };
  assert.ok((await amina.watch()).ok);
  await amina.until((v) => v.phase === "lobby" && v.seats.length === 1, "Amina sees the lobby");

  assert.equal((await paul.request("join", { code: "ZZZZ", name: "x" })).ok, false);

  const joined = await paul.request("join", { code: amina.creds.code.toLowerCase(), name: "Paul" });

  assert.ok(joined.ok);
  paul.creds = { code: amina.creds.code, seatId: String(joined.seatId), token: String(joined.token) };

  const before = Date.now();

  assert.ok((await paul.watch()).ok);
  await amina.until((v) => v.seats.length === 2 && v.seats.every((s) => s.connected), "Amina is told Paul came");
  assert.ok(Date.now() - before < 150, `pushed at once (${Date.now() - before} ms)`);
  await paul.until((v) => v.seats.length === 2, "Paul sees the lobby");
  assert.equal(paul.view?.you, paul.creds.seatId);

  // wrong credentials are final, and so is a missing room
  const intruder = await connect(url);
  const refused = await intruder.request("watch", { ...paul.creds, token: "wrong" });

  assert.equal(refused.ok, false);
  assert.equal(refused.fatal, true);
  assert.equal((await intruder.request("watch", { code: "ZZZZ", seatId: "x", token: "y" })).fatal, true);
  assert.equal((await intruder.request("act", { ...paul.creds, token: "wrong", action: { type: "chat", text: "x" } })).ok, false);
  intruder.socket.close();

  // --- chat and stickers reach the other player straight away --------------------------------
  const t0 = Date.now();

  assert.ok((await paul.act({ text: "Hello Amina", type: "chat" })).ok);
  await amina.until((v) => v.chat.some((m) => m.text === "Hello Amina"), "chat arrives");
  assert.ok(Date.now() - t0 < 150, `chat is instant (${Date.now() - t0} ms)`);
  await sleep(900);
  assert.ok((await amina.act({ emoji: "🔥", type: "react" })).ok);
  await paul.until((v) => v.reactions.some((r) => r.emoji === "🔥"), "sticker arrives");

  // --- a game: the bot plays by itself, on its own timer ----------------------------------------
  assert.ok((await amina.act({ type: "addBot" })).ok);
  assert.ok((await amina.act({ cardsPerPlayer: 3, type: "setSettings" })).ok);
  assert.ok((await amina.act({ type: "start" })).ok);
  await paul.until((v) => v.phase === "playing", "the game starts for Paul");

  const started = Date.now();
  let moves = 0;
  const humans = [amina, paul];

  while (amina.view?.phase !== "finished") {
    assert.ok(Date.now() - started < 30_000, "the game should finish");

    for (const human of humans) {
      const game = human.view?.game;

      if (!game || game.over || game.currentSeatId !== human.creds?.seatId) {
        continue;
      }

      const playable = game.hand.find((card) => game.playableIds.includes(card.id));
      const result = await human.act(
        playable
          ? { cardId: playable.id, suit: playable.rank === "J" ? "hearts" : undefined, type: "play" }
          : { type: "draw" },
      );

      assert.ok(result.ok, JSON.stringify(result));
      moves += 1;
    }

    await sleep(1);
  }

  await paul.until((v) => v.phase === "finished", "Paul sees the end");
  assert.ok(moves > 0);
  assert.equal(amina.view?.seats.reduce((sum, s) => sum + s.wins, 0), 1, "a win was counted");
  console.log(`(a full game with a bot over WebSockets: ${Date.now() - started} ms, ${moves} human moves)`);

  // --- results go back to the lobby on their own timer (400 ms in this test) --------------------------
  const finishedAt = Date.now();

  await amina.until((v) => v.phase === "lobby", "back in the lobby by itself", 3000);
  await paul.until((v) => v.phase === "lobby", "Paul too", 3000);
  assert.ok(Date.now() - finishedAt < 1500, "nobody asked: a timer did it");
  assert.equal(amina.view?.seats.length, 3, "everybody is still seated");

  // --- a vote that nobody finishes is closed by its timer ------------------------------------------------
  assert.ok((await amina.act({ kind: "rules", topic: "jokers", type: "startVote" })).ok);
  await paul.until((v) => v.vote !== null, "Paul sees the vote");
  assert.ok((await paul.act({ choice: "off", type: "castVote" })).ok);
  await amina.until((v) => v.vote === null, "the vote closes by itself (500 ms)", 3000);
  assert.equal(amina.view?.settings.jokers, false, "one ballot is a result when the rest did not vote");

  // --- closing a page shows as offline at once, coming back restores the seat ---------------------------------
  paul.socket.close();
  await amina.until((v) => v.seats.find((s) => s.id === paul.creds?.seatId)?.connected === false, "Paul shows offline");

  const paulAgain = await connect(url);

  paulAgain.creds = paul.creds;
  assert.ok((await paulAgain.watch()).ok);
  await amina.until((v) => v.seats.find((s) => s.id === paul.creds?.seatId)?.connected === true, "Paul is back");
  await paulAgain.until((v) => v.you === paul.creds?.seatId, "same seat");

  // --- the last human leaves: the room is gone and everybody is told ----------------------------------------------
  assert.ok((await paulAgain.act({ type: "leave" })).ok);
  assert.ok((await amina.act({ type: "leave" })).ok);
  await sleep(20);
  assert.equal(running.rooms.size, 0, "an empty room is deleted");

  for (const client of [amina, paulAgain]) {
    client.socket.close();
  }

  await running.close();
  console.log("All realtime checks passed.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
