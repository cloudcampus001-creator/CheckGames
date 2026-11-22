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
  events: Record<string, unknown>[] = [];
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
      } else if (typeof data.t === "string") {
        this.events.push(data);
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

  /** Wait for a pushed message of this kind (matched, gain, queue...). */
  async event(kind: string, ms = 5000) {
    const started = Date.now();

    for (;;) {
      const found = this.events.find((event) => event.t === kind);

      if (found) {
        return found;
      }

      if (Date.now() - started > ms) {
        throw new Error(`Timed out waiting for the ${kind} message`);
      }

      await sleep(2);
    }
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

/** Profiles, matchmaking, the turn clock and the rewards, over real WebSockets. */
async function profilesAndMatches(url: string, running: { rooms: Map<string, unknown>; queue: { tickets: unknown[] } }) {
  const x = await connect(url);
  const y = await connect(url);
  const idX = { profileId: "device-xxxxxxxx", secret: "secret-xxxxxxxx" };
  const idY = { profileId: "device-yyyyyyyy", secret: "secret-yyyyyyyy" };

  // each device is known as a player
  const helloX = await x.request("profile", { ...idX, name: "Xavier" });
  const helloY = await y.request("profile", { ...idY, name: "Yaya" });

  assert.ok(helloX.ok && helloY.ok);
  assert.equal((helloX.profile as { name: string }).name, "Xavier");
  assert.equal((await x.request("profile", { ...idX, secret: "secret-wrongwrong" })).ok, false);

  const renamed = await x.request("profile", { ...idX, op: "update", patch: { avatar: "🦁", name: "Xavi" } });

  assert.ok(renamed.ok);
  assert.equal((renamed.profile as { avatar: string }).avatar, "🦁");
  assert.equal((await x.request("leaderboard")).ok, true);

  // a private room remembers the device: its name comes from the profile, and it gets its seat back
  const created = await x.request("create", { ...idX, name: "ignored" });

  assert.ok(created.ok);

  const code = String(created.code);
  const joinedY = await y.request("join", { ...idY, code, name: "ignored" });

  assert.ok(joinedY.ok);

  const again = await y.request("join", { ...idY, code, name: "whatever" });

  assert.equal(again.seatId, joinedY.seatId, "the same device gets the same seat, no token needed");
  assert.equal(again.token, joinedY.token);

  const watcher = await connect(url);

  watcher.creds = { code, seatId: String(created.seatId), token: String(created.token) };
  assert.ok((await watcher.watch()).ok);

  const lobby = await watcher.until((v) => v.seats.length === 2, "two seats");

  assert.deepEqual(lobby.seats.map((s) => s.name).sort(), ["Xavi", "Yaya"]);
  assert.equal(lobby.seats.find((s) => s.name === "Xavi")?.avatar, "🦁");

  // online: both ask for a duel with a short clock, and the system sets the table
  const queueStart = Date.now();
  const qx = await x.request("queueJoin", { ...idX, fillBots: false, sizes: [2], turn: 3 });
  const qy = await y.request("queueJoin", { ...idY, fillBots: false, sizes: [2], turn: 3 });

  assert.ok(qx.ok && qy.ok);

  const matchX = await x.event("matched");
  const matchY = await y.event("matched");

  assert.ok(Date.now() - queueStart < 2500, "matched at once");
  assert.equal(matchX.code, matchY.code);
  assert.notEqual(matchX.seatId, matchY.seatId);
  assert.equal(running.queue.tickets.length, 0, "both left the queue");

  x.creds = { code: String(matchX.code), seatId: String(matchX.seatId), token: String(matchX.token) };
  y.creds = { code: String(matchY.code), seatId: String(matchY.seatId), token: String(matchY.token) };
  assert.ok((await x.watch()).ok && (await y.watch()).ok);

  const started = await x.until((v) => v.phase === "playing", "the quick match is on");

  assert.equal(started.matchmade, true);
  assert.equal(started.turnSeconds, 3);
  assert.ok(started.turnEndsInMs !== null && started.turnEndsInMs > 3000, "grace before the first turn");
  assert.equal((await x.act({ type: "addBot" })).ok, false, "no host controls");

  // nobody moves: the clock runs out and the table moves on (at the exact moment, nobody asked)
  const clockStart = Date.now();

  await x.until(
    (v) => !!v.game && v.game.moves.some((m) => m.type === "timeout"),
    "the clock ran out",
    9000,
  );
  assert.ok(Date.now() - clockStart >= 2500 && Date.now() - clockStart < 8000, `a timeout after about 6 s (${Date.now() - clockStart} ms)`);

  // now they play it out
  const humans = [x, y];
  const gameStart = Date.now();

  while (x.view?.phase !== "finished") {
    assert.ok(Date.now() - gameStart < 30_000, "the game should finish");

    for (const human of humans) {
      const game = human.view?.game;

      if (!game || game.over || game.currentSeatId !== human.creds?.seatId) {
        continue;
      }

      const playable = game.hand.find((card) => game.playableIds.includes(card.id));

      await human.act(
        playable
          ? { cardId: playable.id, suit: playable.rank === "J" ? "hearts" : undefined, type: "play" }
          : { type: "draw" },
      );
    }

    await sleep(1);
  }

  // the result was counted and each player was told what they got
  const gainX = (await x.event("gain")) as { gain: { xp: number }; profile: { stats: { played: number } } };
  const gainY = (await y.event("gain")) as { gain: { xp: number }; profile: { stats: { played: number } } };

  assert.ok(gainX.gain.xp >= 10 && gainY.gain.xp >= 10);
  assert.equal(gainX.profile.stats.played, 1);
  assert.equal(gainY.profile.stats.played, 1);
  assert.ok(Math.abs(gainX.gain.xp - gainY.gain.xp) >= 25 - 8, "the winner got more");

  const after = await x.request("profile", idX);

  assert.equal((after.profile as { stats: { played: number; modes: { online: { played: number } } } }).stats.modes.online.played, 1);
  assert.equal((await x.request("leaderboard")).ok, true);

  // after a quick match nobody is held, and the room goes when the last one leaves
  assert.equal(x.view?.canLeave, true);
  assert.ok((await x.act({ type: "leave" })).ok);
  assert.ok((await y.act({ type: "leave" })).ok);

  for (const client of [x, y, watcher]) {
    client.socket.close();
  }
}

/** The same game over plain requests, for phones where WebSockets are blocked. */
async function plainRequests(port: number) {
  const base = `http://127.0.0.1:${port}`;
  const rpc = async (sid: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/rpc?sid=${sid}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: "https://my-game.vercel.app" },
      method: "POST",
    });

    return (await response.json()) as { reply: Record<string, unknown>; pushes: Record<string, unknown>[] };
  };
  const poll = async (sid: string) =>
    ((await (await fetch(`${base}/poll?sid=${sid}`)).json()) as { pushes: Record<string, unknown>[] }).pushes;

  // a browser's preflight is answered
  const preflight = await fetch(`${base}/rpc?sid=session-aaaaaaaa`, { headers: { origin: "https://x.app" }, method: "OPTIONS" });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/);
  assert.equal((await fetch(`${base}/rpc?sid=x`, { body: "{}", method: "POST" })).status, 400, "a bad session id");

  const a = "session-aaaaaaaa";
  const b = "session-bbbbbbbb";
  const created = await rpc(a, { id: 1, name: "Amina", type: "create" });

  assert.ok(created.reply.ok);

  const code = String(created.reply.code);
  const creds = { code, seatId: created.reply.seatId, token: created.reply.token };
  const watching = await rpc(a, { id: 2, type: "watch", ...creds });

  assert.ok(watching.reply.ok);
  assert.ok(
    watching.pushes.some((push) => push.t === "view" && (push.view as { phase: string }).phase === "lobby"),
    "the room comes back with the answer",
  );

  const joined = await rpc(b, { code, id: 1, name: "Paul", type: "join" });

  assert.ok(joined.reply.ok);
  assert.ok((await rpc(b, { code, id: 2, seatId: joined.reply.seatId, token: joined.reply.token, type: "watch" })).reply.ok);

  // a long poll returns as soon as something happens
  const started = Date.now();

  assert.ok((await rpc(b, { action: { text: "hello over plain requests", type: "chat" }, code, id: 3, seatId: joined.reply.seatId, token: joined.reply.token, type: "act" })).reply.ok);

  let heard = false;

  for (let round = 0; round < 6 && !heard; round++) {
    const pushed = await poll(a);

    heard = pushed.some(
      (push) =>
        push.t === "view" &&
        (push.view as { chat: { text: string }[] }).chat.some((m) => m.text === "hello over plain requests"),
    );
  }

  assert.ok(heard, "Amina's page is told about Paul's message");
  assert.ok(Date.now() - started < 2500, "and at once, not after the long wait");

  // a poll with nothing to say waits, and a new event ends it
  const quiet = poll(a);
  const waitedFrom = Date.now();

  await sleep(80);
  await rpc(b, { action: { emoji: "🔥", type: "react" }, code, id: 4, seatId: joined.reply.seatId, token: joined.reply.token, type: "act" });
  assert.ok((await quiet).length > 0);
  assert.ok(Date.now() - waitedFrom < 1500, "a waiting poll is woken by the next change");

  // a wrong token is final, like over a WebSocket
  const refused = await rpc(a, { id: 9, type: "watch", code, seatId: creds.seatId, token: "wrong" });

  assert.equal(refused.reply.ok, false);
  assert.equal(refused.reply.fatal, true);
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

  await profilesAndMatches(url, running);
  await plainRequests(running.port);
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
