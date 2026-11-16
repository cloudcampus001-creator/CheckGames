/**
 * The realtime server. It runs the very same room rules as the website
 * (src/server/rooms.ts), but it stays running, so it can:
 *  - keep every game in memory (no database, no per-move storage trips),
 *  - push every change to every player the instant it happens (WebSocket),
 *  - move the bots, close votes and return to the lobby at the exact moment
 *    they are due, with real timers, without anybody having to ask.
 *
 * Messages are JSON. A browser sends {id, type, ...} and gets {id, ok, ...}
 * back; the server pushes {t: "view", view} whenever the room changes.
 */
import { createServer, type Server } from "node:http";
import {
  applyAction,
  checkSeat,
  etagOf,
  joinInto,
  makeCode,
  newRoom,
  nextWakeAt,
  normalizeCode,
  type Room,
  setPresence,
  tickBots,
  viewFor,
} from "../src/server/rooms";
import { acceptWebSockets, type WsSocket } from "./ws";

type Client = {
  socket: WsSocket;
  code: string | null;
  seatId: string | null;
  lastEtag: string;
};

const GONE = "This game no longer exists. Ask the host for a new code.";
/** A room nobody has been in for this long is forgotten. */
const EMPTY_ROOM_MS = 30 * 60 * 1000;
const OLD_ROOM_MS = 6 * 60 * 60 * 1000;
/** Players count as present for this long after the last sign of life. */
const HEARTBEAT_MS = 3000;

export type RealtimeServer = {
  server: Server;
  port: number;
  rooms: Map<string, Room>;
  close: () => Promise<void>;
};

export async function startServer(
  port: number,
  options: { allowedOrigins?: string[] } = {},
): Promise<RealtimeServer> {
  const rooms = new Map<string, Room>();
  const watchers = new Map<string, Set<Client>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const allowed = options.allowedOrigins ?? [];

  const http = createServer((request, response) => {
    // Something for uptime checks and for "is it on?" in a browser.
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, service: "cheque-games-realtime" }));
  });

  // --- pushing changes ---------------------------------------------------------------

  function push(client: Client, payload: unknown) {
    client.socket.send(JSON.stringify(payload));
  }

  /** Send every watcher the room as they may see it, if it changed for them. */
  function broadcast(room: Room) {
    const now = Date.now();
    const etag = etagOf(room, now);

    for (const client of watchers.get(room.code) ?? []) {
      if (!client.seatId || client.lastEtag === etag) {
        continue;
      }

      client.lastEtag = etag;
      push(client, { etag, t: "view", view: viewFor(room, client.seatId, now) });
    }
  }

  /** Set a timer for the next thing that is due in the room (a bot's move, a vote...). */
  function arm(room: Room) {
    const old = timers.get(room.code);

    if (old) {
      clearTimeout(old);
      timers.delete(room.code);
    }

    const at = nextWakeAt(room);

    if (at === null || room.closed) {
      return;
    }

    const timer = setTimeout(
      () => {
        timers.delete(room.code);

        if (!rooms.has(room.code)) {
          return;
        }

        if (tickBots(room, Date.now())) {
          broadcast(room);
        }

        arm(room);
      },
      Math.max(15, at - Date.now()),
    );

    timers.set(room.code, timer);
  }

  function changed(room: Room) {
    broadcast(room);
    arm(room);
  }

  function dropRoom(code: string, error = GONE) {
    const room = rooms.get(code);

    rooms.delete(code);

    const timer = timers.get(code);

    if (timer) {
      clearTimeout(timer);
      timers.delete(code);
    }

    for (const client of watchers.get(code) ?? []) {
      push(client, { error, fatal: true, t: "fatal" });
      client.code = null;
      client.seatId = null;
    }

    watchers.delete(code);

    return room;
  }

  // --- what browsers ask for -----------------------------------------------------------

  type Message = Record<string, unknown> & { id?: unknown; type?: unknown };

  function reply(client: Client, message: Message, body: Record<string, unknown>) {
    push(client, { id: message.id, ...body });
  }

  const failure = (error: string, fatal = false) => ({ error, fatal, ok: false });

  function forget(client: Client) {
    if (!client.code) {
      return;
    }

    const set = watchers.get(client.code);

    set?.delete(client);

    const room = rooms.get(client.code);

    // Closing the page shows as "offline" to the others at once (unless another tab is still open).
    if (room && client.seatId) {
      const stillHere = [...(set ?? [])].some((other) => other.seatId === client.seatId);

      if (!stillHere && setPresence(room, client.seatId, false, Date.now())) {
        changed(room);
      }
    }

    client.code = null;
    client.seatId = null;
  }

  function handle(client: Client, message: Message) {
    const now = Date.now();

    switch (message.type) {
      case "ping":
        reply(client, message, { ok: true });

        return;

      case "create": {
        let code = makeCode();

        for (let tries = 0; rooms.has(code) && tries < 50; tries++) {
          code = makeCode();
        }

        if (rooms.has(code)) {
          reply(client, message, failure("Could not make a game code. Please try again."));

          return;
        }

        const made = newRoom(code, message.name, now);

        rooms.set(code, made.room);
        reply(client, message, { code, ok: true, seatId: made.seatId, token: made.token });

        return;
      }

      case "join": {
        const room = rooms.get(normalizeCode(message.code));

        if (!room) {
          reply(client, message, failure("No game found with that code. Check it and try again."));

          return;
        }

        const joined = joinInto(room, message.name, message.token, now);

        if (!joined.ok) {
          reply(client, message, failure(joined.error));

          return;
        }

        reply(client, message, {
          code: joined.code,
          ok: true,
          seatId: joined.seatId,
          token: joined.token,
        });

        if (joined.changed) {
          changed(room);
        }

        return;
      }

      case "watch": {
        const code = normalizeCode(message.code);
        const room = rooms.get(code);

        if (!room) {
          reply(client, message, failure(GONE, true));

          return;
        }

        if (!checkSeat(room, message.seatId, message.token)) {
          reply(client, message, failure("You are not part of this game.", true));

          return;
        }

        forget(client);

        const set = watchers.get(code) ?? new Set<Client>();

        client.code = code;
        client.seatId = String(message.seatId);
        client.lastEtag = "";
        set.add(client);
        watchers.set(code, set);

        // The others see this player come back; this player gets the room straight away.
        setPresence(room, client.seatId, true, now);
        tickBots(room, now);
        reply(client, message, { ok: true });
        changed(room);

        // `changed` skips a watcher whose tag has not moved, so make sure the new one is served.
        if (client.lastEtag === "") {
          const etag = etagOf(room, now);

          client.lastEtag = etag;
          push(client, { etag, t: "view", view: viewFor(room, client.seatId, now) });
        }

        return;
      }

      case "act": {
        const room = rooms.get(normalizeCode(message.code));

        if (!room) {
          reply(client, message, failure(GONE, true));

          return;
        }

        if (!checkSeat(room, message.seatId, message.token)) {
          reply(client, message, failure("You are not part of this game.", true));

          return;
        }

        // A bot whose time is up goes first, so the order of play is respected.
        tickBots(room, now);

        const done = applyAction(room, message.seatId, message.token, message.action, now);

        if (!done.ok) {
          reply(client, message, failure(done.error));

          // The bots may have moved above: everybody gets that too.
          changed(room);

          return;
        }

        if (room.closed) {
          dropRoom(room.code);
          reply(client, message, { ok: true });

          return;
        }

        // The new room first (the player sees their move at once), then the answer.
        changed(room);
        reply(client, message, { ok: true });

        return;
      }

      default:
        reply(client, message, failure("Unknown request."));
    }
  }

  acceptWebSockets(
    http,
    (request) => {
      if (allowed.length === 0) {
        return true;
      }

      const origin = request.headers.origin;

      return typeof origin === "string" && allowed.includes(origin);
    },
    (socket) => {
      const client: Client = { code: null, lastEtag: "", seatId: null, socket };

      socket.onMessage = (text) => {
        let message: Message;

        try {
          message = JSON.parse(text) as Message;
        } catch {
          return;
        }

        if (typeof message !== "object" || message === null) {
          return;
        }

        try {
          handle(client, message);
        } catch (error) {
          console.error("request failed", error);
          reply(client, message, failure("The game server hit a problem. Please try again."));
        }
      };

      socket.onClose = () => forget(client);
    },
  );

  // --- housekeeping --------------------------------------------------------------------------

  // Everybody with the page open counts as present, and old rooms are cleared away.
  const housekeeping = setInterval(() => {
    const now = Date.now();

    for (const [code, room] of rooms) {
      const set = watchers.get(code);

      for (const client of set ?? []) {
        const seat = room.seats.find((candidate) => candidate.id === client.seatId);

        if (seat) {
          seat.polledAt = now;
        }
      }

      const empty = !set || set.size === 0;

      if ((empty && now - room.lastActive > EMPTY_ROOM_MS) || now - room.lastActive > OLD_ROOM_MS) {
        dropRoom(code);
      }
    }
  }, HEARTBEAT_MS);

  housekeeping.unref();

  await new Promise<void>((resolve) => http.listen(port, "0.0.0.0", resolve));

  const address = http.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(housekeeping);

        for (const timer of timers.values()) {
          clearTimeout(timer);
        }

        http.closeAllConnections();
        http.close(() => resolve());
      }),
    port: actualPort,
    rooms,
    server: http,
  };
}
