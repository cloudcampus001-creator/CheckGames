/**
 * The realtime server. It runs the very same room rules as the website
 * (src/server/rooms.ts), but it stays running, so it can:
 *  - keep every game in memory (no per-move storage trips),
 *  - push every change to every player the instant it happens (WebSocket),
 *  - move the bots, run the turn clocks, close votes and return to the lobby at
 *    the exact moment they are due, with real timers,
 *  - match players who want to play against real people (a live queue),
 *  - know each device as a player (profiles, stats, the leaderboard).
 *
 * Messages are JSON. A browser sends {id, type, ...} and gets {id, ok, ...}
 * back; the server pushes {t: "view", view} whenever the room changes, and
 * {t: "matched"}, {t: "queue"}, {t: "gain"} for matchmaking and rewards.
 */
import { createServer, type Server } from "node:http";
import { newQueue, plan, prune, join, leave, status, cleanSizes, cleanTurn, type Queue } from "../src/server/matchmaking";
import { applyResults, hello, leaderboard, resolveIdentity, updateProfile } from "../src/server/profiles";
import {
  applyAction,
  checkSeat,
  etagOf,
  joinInto,
  makeCode,
  newMatchRoom,
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
  /** The matchmaking ticket this page is waiting with. */
  ticket: string | null;
};

const GONE = "This game no longer exists. Ask the host for a new code.";
const REMOVED = "You are no longer at this table. The host may have removed you.";
/** A room nobody has been in for this long is forgotten. */
const EMPTY_ROOM_MS = 30 * 60 * 1000;
const OLD_ROOM_MS = 6 * 60 * 60 * 1000;
/** Players count as present for this long after the last sign of life. */
const HEARTBEAT_MS = 3000;
const QUEUE_TICK_MS = 1000;

export type RealtimeServer = {
  server: Server;
  port: number;
  rooms: Map<string, Room>;
  queue: Queue;
  close: () => Promise<void>;
};

export async function startServer(
  port: number,
  options: { allowedOrigins?: string[] } = {},
): Promise<RealtimeServer> {
  const rooms = new Map<string, Room>();
  const watchers = new Map<string, Set<Client>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const counted = new Set<string>();
  const queue = newQueue();
  const waiting = new Map<string, Client>();
  const allowed = options.allowedOrigins ?? [];

  // Plain-request sessions, for phones and networks where WebSockets are blocked.
  type Session = {
    client: Client;
    outbox: string[];
    wake: (() => void) | null;
    lastSeen: number;
  };

  const sessions = new Map<string, Session>();
  const SESSION_IDLE_MS = 30_000;
  const POLL_HOLD_MS = 20_000;
  const SID = /^[A-Za-z0-9-]{8,64}$/;

  const corsHeaders = (origin: string | undefined): Record<string, string> => ({
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": allowed.length === 0 ? "*" : (origin ?? ""),
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
  });

  const http = createServer((request, response) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const cors = corsHeaders(origin);
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { ...cors, "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();

      return;
    }

    if (allowed.length > 0 && origin !== undefined && !allowed.includes(origin)) {
      send(403, { error: "This website may not use this server.", ok: false });

      return;
    }

    if (url.pathname === "/rpc" || url.pathname === "/poll") {
      const sid = url.searchParams.get("sid") ?? "";

      if (!SID.test(sid)) {
        send(400, { error: "Bad session.", ok: false });

        return;
      }

      const session = sessionFor(sid, request);

      session.lastSeen = Date.now();

      if (url.pathname === "/rpc" && request.method === "POST") {
        readBody(request).then(
          async (text) => {
            let message: Message;

            try {
              message = JSON.parse(text) as Message;
            } catch {
              send(400, { error: "That request was not understood.", ok: false });

              return;
            }

            try {
              await handle(session.client, message);
            } catch (error) {
              console.error("request failed", error);
              session.outbox.push(
                JSON.stringify({ id: message.id, ...failure("The game server hit a problem. Please try again.") }),
              );
            }

            // The answer comes back right here, with whatever was pushed in the meantime.
            const all = session.outbox.splice(0).map((line) => JSON.parse(line) as Record<string, unknown>);
            const mine = all.findIndex((entry) => entry.id === message.id && entry.t === undefined);
            const reply = mine === -1 ? { ok: true } : all.splice(mine, 1)[0];

            send(200, { pushes: all, reply });
          },
          () => send(400, { error: "That request was not understood.", ok: false }),
        );

        return;
      }

      if (url.pathname === "/poll" && request.method === "GET") {
        // A newer poll replaces an older one that is still waiting.
        session.wake?.();

        let finished = false;
        const finish = () => {
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(hold);
          session.wake = null;
          send(200, {
            pushes: session.outbox.splice(0).map((line) => JSON.parse(line)),
            // False after a server restart: the page then re-opens its room.
            watching: session.client.code !== null || session.client.ticket !== null,
          });
        };
        const hold = setTimeout(finish, POLL_HOLD_MS);

        if (session.outbox.length > 0) {
          finish();
        } else {
          session.wake = finish;
        }

        request.on("close", () => {
          if (session.wake === finish) {
            session.wake = null;
          }

          clearTimeout(hold);
          finished = true;
        });

        return;
      }
    }

    // Something for uptime checks and for "is it on?" in a browser.
    send(200, {
      ok: true,
      rooms: rooms.size,
      searching: queue.tickets.length,
      service: "cheque-games-realtime",
    });
  });

  function readBody(request: import("node:http").IncomingMessage) {
    return new Promise<string>((resolve, reject) => {
      let text = "";

      request.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");

        if (text.length > 64 * 1024) {
          reject(new Error("too big"));
          request.destroy();
        }
      });
      request.on("end", () => resolve(text));
      request.on("error", reject);
    });
  }

  function sessionFor(sid: string, request: import("node:http").IncomingMessage): Session {
    const existing = sessions.get(sid);

    if (existing) {
      return existing;
    }

    const session: Session = {
      client: null as unknown as Client,
      lastSeen: Date.now(),
      outbox: [],
      wake: null,
    };
    const socket: WsSocket = {
      close() {},
      onClose: null,
      onMessage: null,
      request,
      send(text) {
        session.outbox.push(text);
        session.wake?.();
      },
    };

    session.client = { code: null, lastEtag: "", seatId: null, socket, ticket: null };
    sessions.set(sid, session);

    return session;
  }

  // --- pushing changes ---------------------------------------------------------------

  function push(client: Client, payload: unknown) {
    client.socket.send(JSON.stringify(payload));
  }

  /** Count a set that just ended for the profiles, and tell the players what they won. */
  async function settleResults(room: Room) {
    const result = room.social?.results;

    if (!result || counted.has(result.id)) {
      return;
    }

    counted.add(result.id);

    if (counted.size > 5000) {
      counted.clear();
    }

    const done = await applyResults(result);

    for (const client of watchers.get(room.code) ?? []) {
      const seat = room.seats.find((candidate) => candidate.id === client.seatId);
      const mine = done.find((entry) => entry.profile.id === seat?.profileId);

      if (mine) {
        push(client, { gain: mine.gain, profile: mine.profile, t: "gain" });
      }
    }
  }

  /** Send every watcher the room as they may see it, if it changed for them. */
  function broadcast(room: Room) {
    const now = Date.now();
    const etag = etagOf(room, now);
    const removed: Client[] = [];

    for (const client of watchers.get(room.code) ?? []) {
      if (!client.seatId) {
        continue;
      }

      // Taken off the table (kicked, voted out): told once, then let go.
      if (!room.seats.some((seat) => seat.id === client.seatId)) {
        removed.push(client);

        continue;
      }

      if (client.lastEtag === etag) {
        continue;
      }

      client.lastEtag = etag;
      push(client, { etag, t: "view", view: viewFor(room, client.seatId, now) });
    }

    for (const client of removed) {
      push(client, { error: REMOVED, fatal: true, t: "fatal" });
      watchers.get(room.code)?.delete(client);
      client.code = null;
      client.seatId = null;
    }

    void settleResults(room).catch((error) => console.error("results failed", error));
  }

  /** Set a timer for the next thing that is due in the room (a bot's move, a clock, a vote...). */
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

  /** A table made by matchmaking: tell each player where to go. */
  function openMatch(table: ReturnType<typeof plan>[number]) {
    let code = makeCode();

    for (let tries = 0; rooms.has(code) && tries < 50; tries++) {
      code = makeCode();
    }

    const now = Date.now();
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

    rooms.set(code, room);
    arm(room);

    for (const [ticketId, seat] of Object.entries(creds)) {
      const client = waiting.get(ticketId);

      waiting.delete(ticketId);

      if (client) {
        client.ticket = null;
        push(client, { code, seatId: seat.seatId, t: "matched", token: seat.token });
      }
    }
  }

  /** Make the tables that can be made, and tell everybody who is waiting how it is going. */
  function runQueue() {
    const now = Date.now();

    // Pages that are open count as still waiting.
    for (const ticket of queue.tickets) {
      if (waiting.has(ticket.id)) {
        ticket.seenAt = now;
      }
    }

    prune(queue, now);

    for (const table of plan(queue, now)) {
      openMatch(table);
    }

    for (const [ticketId, client] of waiting) {
      if (queue.tickets.some((ticket) => ticket.id === ticketId)) {
        push(client, { t: "queue", ...status(queue, ticketId, now) });
      } else {
        waiting.delete(ticketId);
        client.ticket = null;
      }
    }
  }

  // --- what browsers ask for -----------------------------------------------------------

  type Message = Record<string, unknown> & { id?: unknown; type?: unknown };

  function reply(client: Client, message: Message, body: Record<string, unknown>) {
    push(client, { id: message.id, ...body });
  }

  const failure = (error: string, fatal = false) => ({ error, fatal, ok: false });

  function stopWaiting(client: Client) {
    if (client.ticket) {
      leave(queue, client.ticket);
      waiting.delete(client.ticket);
      client.ticket = null;
    }
  }

  function forget(client: Client) {
    stopWaiting(client);

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

  async function handle(client: Client, message: Message) {
    const now = Date.now();
    const auth = { id: message.profileId, secret: message.secret };

    switch (message.type) {
      case "ping":
        reply(client, message, { ok: true });

        return;

      case "profile": {
        const result =
          message.op === "update"
            ? await updateProfile({ id: message.profileId, patch: message.patch, secret: message.secret })
            : await hello({
                backup: message.backup,
                id: message.profileId,
                name: message.name,
                secret: message.secret,
              });

        reply(client, message, result);

        return;
      }

      case "leaderboard":
        reply(client, message, { ok: true, players: await leaderboard(20) });

        return;

      case "create": {
        const who = await resolveIdentity(auth);
        let code = makeCode();

        for (let tries = 0; rooms.has(code) && tries < 50; tries++) {
          code = makeCode();
        }

        if (rooms.has(code)) {
          reply(client, message, failure("Could not make a game code. Please try again."));

          return;
        }

        const made = newRoom(code, who?.name ?? message.name, Date.now(), who?.identity);

        rooms.set(code, made.room);
        reply(client, message, { code, ok: true, seatId: made.seatId, token: made.token });

        return;
      }

      case "join": {
        const who = await resolveIdentity(auth);
        const room = rooms.get(normalizeCode(message.code));

        if (!room) {
          reply(client, message, failure("No game found with that code. Check it and try again."));

          return;
        }

        const joined = joinInto(room, who?.name ?? message.name, message.token, Date.now(), who?.identity);

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

      case "queueJoin": {
        const who = await resolveIdentity(auth);

        if (!who) {
          reply(client, message, failure("Open your profile first, then find a match."));

          return;
        }

        stopWaiting(client);

        const ticket = join(queue, {
          avatar: who.identity.avatar,
          fillBots: message.fillBots !== false,
          id: crypto.randomUUID(),
          joinedAt: Date.now(),
          name: who.name,
          profileId: who.identity.profileId,
          rating: who.identity.rating,
          seenAt: Date.now(),
          sizes: cleanSizes(message.sizes),
          turn: cleanTurn(message.turn),
          xp: who.identity.xp,
        });

        // The same profile searching from another page: that page is the one that waits now.
        const other = waiting.get(ticket.id);

        if (other && other !== client) {
          other.ticket = null;
        }

        client.ticket = ticket.id;
        waiting.set(ticket.id, client);
        reply(client, message, { ok: true, ticket: ticket.id });
        runQueue();

        return;
      }

      case "queueLeave":
        stopWaiting(client);
        reply(client, message, { ok: true });

        return;

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
      const client: Client = { code: null, lastEtag: "", seatId: null, socket, ticket: null };

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

        handle(client, message).catch((error) => {
          console.error("request failed", error);
          reply(client, message, failure("The game server hit a problem. Please try again."));
        });
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

  // A page on plain requests that stopped asking has left.
  const sessionTimer = setInterval(() => {
    const now = Date.now();

    for (const [sid, session] of sessions) {
      if (now - session.lastSeen > SESSION_IDLE_MS) {
        sessions.delete(sid);
        session.wake?.();
        forget(session.client);
      }
    }
  }, 5000);
  const queueTimer = setInterval(runQueue, QUEUE_TICK_MS);

  housekeeping.unref();
  queueTimer.unref();
  sessionTimer.unref();

  await new Promise<void>((resolve) => http.listen(port, "0.0.0.0", resolve));

  const address = http.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(housekeeping);
        clearInterval(queueTimer);
        clearInterval(sessionTimer);

        for (const timer of timers.values()) {
          clearTimeout(timer);
        }

        http.closeAllConnections();
        http.close(() => resolve());
      }),
    port: actualPort,
    queue,
    rooms,
    server: http,
  };
}
