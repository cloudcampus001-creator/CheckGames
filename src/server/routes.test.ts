/**
 * End-to-end check of the HTTP layer: calls the route handlers with real
 * Request objects and reads the live event stream like a browser would.
 */
import assert from "node:assert/strict";
import { POST as actionRoute } from "@/app/api/rooms/[code]/action/route";
import { GET as eventsRoute } from "@/app/api/rooms/[code]/events/route";
import { POST as joinRoute } from "@/app/api/rooms/[code]/join/route";
import { POST as createRoute } from "@/app/api/rooms/route";
import type { RoomView } from "@/multiplayer/protocol";
import { configureRooms, resetRooms } from "./rooms";

configureRooms({ botDelayMax: 2, botDelayMin: 0 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, label: string, ms = 5000) {
  const started = Date.now();

  while (!condition()) {
    if (Date.now() - started > ms) {
      throw new Error(`Timed out waiting for: ${label}`);
    }

    await sleep(2);
  }
}

type Json = Record<string, unknown>;

async function post(
  handler: (request: Request, context: { params: Promise<{ code: string }> }) => Promise<Response>,
  code: string,
  body: unknown,
) {
  const response = await handler(
    new Request("http://localhost:3000/api", {
      body: typeof body === "string" ? body : JSON.stringify(body),
      method: "POST",
    }),
    { params: Promise.resolve({ code }) },
  );

  return { body: (await response.json()) as Json, status: response.status };
}

type Stream = {
  close: () => void;
  ended: () => boolean;
  fatal: string | null;
  headers: Headers;
  latest: () => RoomView | null;
};

async function openStream(code: string, seat: string, token: string): Promise<Stream> {
  const abort = new AbortController();
  const response = await eventsRoute(
    new Request(
      `http://localhost:3000/api/rooms/${code}/events?seat=${seat}&token=${token}`,
      { signal: abort.signal },
    ),
    { params: Promise.resolve({ code }) },
  );
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let latest: RoomView | null = null;
  let ended = false;
  const stream: Stream = {
    close: () => abort.abort(),
    ended: () => ended,
    fatal: null,
    headers: response.headers,
    latest: () => latest,
  };

  void (async () => {
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        ended = true;

        return;
      }

      buffer += decoder.decode(value, { stream: true });

      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);

        buffer = buffer.slice(end + 2);

        const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));

        if (!eventLine || !dataLine) {
          continue;
        }

        const event = eventLine.slice(7);
        const data = JSON.parse(dataLine.slice(6));

        if (event === "state") {
          latest = data as RoomView;
        } else if (event === "fatal") {
          stream.fatal = (data as { reason: string }).reason;
        }
      }
    }
  })();

  return stream;
}

async function main() {
  // create a game
  const created = await post(
    createRoute as never,
    "",
    { name: "Amina" },
  );

  assert.equal(created.status, 200);

  const code = String(created.body.code);
  const host = { seat: String(created.body.seatId), token: String(created.body.token) };

  assert.match(code, /^[A-Z2-9]{4}$/);

  // host connects and sees the lobby
  const hostStream = await openStream(code, host.seat, host.token);

  assert.match(hostStream.headers.get("content-type") ?? "", /text\/event-stream/);
  await waitFor(() => hostStream.latest()?.phase === "lobby", "host sees the lobby");
  assert.equal(hostStream.latest()?.seats.length, 1);
  assert.equal(hostStream.latest()?.you, host.seat);

  // a friend joins by code, host's stream updates live
  const joined = await post(joinRoute, code.toLowerCase(), { name: "Paul" });

  assert.equal(joined.status, 200);

  const guest = { seat: String(joined.body.seatId), token: String(joined.body.token) };
  const guestStream = await openStream(code, guest.seat, guest.token);

  await waitFor(() => hostStream.latest()?.seats.length === 2, "host sees Paul arrive");
  await waitFor(() => guestStream.latest()?.seats.length === 2, "Paul sees the table");
  assert.equal(guestStream.latest()?.you, guest.seat);
  assert.equal(guestStream.latest()?.hostId, host.seat);

  // bad inputs
  assert.equal((await post(joinRoute, "ZZZZ", { name: "x" })).status, 400);
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

  assert.equal(forged.status, 400, "a token only works for its own seat");

  const hostBot = await post(actionRoute, code, {
    action: { type: "addBot" },
    seatId: host.seat,
    token: host.token,
  });

  assert.equal(hostBot.status, 200);
  await waitFor(() => guestStream.latest()?.seats.length === 3, "Paul sees the bot");

  // host launches; each player gets only their own cards
  const started = await post(actionRoute, code, {
    action: { type: "start" },
    seatId: host.seat,
    token: host.token,
  });

  assert.equal(started.status, 200);
  await waitFor(() => guestStream.latest()?.phase === "playing", "Paul sees the game start");
  await waitFor(() => hostStream.latest()?.phase === "playing", "host sees the game start");

  const hostHand = hostStream.latest()?.game?.hand.map((c) => c.id) ?? [];
  const guestHand = guestStream.latest()?.game?.hand.map((c) => c.id) ?? [];

  assert.equal(hostHand.length, 7);
  assert.equal(guestHand.length, 7);
  assert.ok(hostHand.every((id) => !guestHand.includes(id)), "hands are different");

  const guestJson = JSON.stringify(guestStream.latest());

  for (const id of hostHand) {
    assert.ok(!guestJson.includes(`"${id}"`), `Paul must not see ${id}`);
  }

  // someone who is not in the game gets a clear fatal message, not a hang
  const stranger = await openStream(code, "nobody", "wrong");

  await waitFor(() => stranger.fatal !== null, "stranger is told no");
  await waitFor(() => stranger.ended(), "stranger's stream ends");

  const missing = await openStream("ZZZZ", "a", "b");

  await waitFor(() => missing.fatal !== null, "unknown room is reported");

  // closing a tab shows that player as offline to the others
  guestStream.close();
  await waitFor(
    () => hostStream.latest()?.seats.find((s) => s.id === guest.seat)?.connected === false,
    "Paul shown offline",
  );

  // ...and coming back with the saved token restores the seat
  const back = await post(joinRoute, code, { token: guest.token });

  assert.equal(back.status, 200);
  assert.equal(back.body.seatId, guest.seat);

  const guestAgain = await openStream(code, guest.seat, guest.token);

  await waitFor(() => guestAgain.latest()?.game?.hand.length === 7, "Paul is back with his hand");
  assert.deepEqual(
    guestAgain.latest()?.game?.hand.map((c) => c.id),
    guestHand,
    "same cards after reconnecting",
  );

  hostStream.close();
  guestAgain.close();
  resetRooms();
  console.log("All route checks passed.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
