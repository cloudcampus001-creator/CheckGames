/**
 * The browser side of the realtime server (realtime/server.ts). One
 * WebSocket per page: requests get answers, and the server pushes the room
 * whenever it changes. If the connection drops it reconnects by itself and
 * picks the game up again.
 *
 * It is only used when NEXT_PUBLIC_REALTIME_URL is set. Without it the game
 * keeps working over plain requests (see useRoom.ts).
 */
import type { Creds } from "./api";
import type { RoomView } from "./protocol";

export const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? "";
export const realtimeEnabled = REALTIME_URL.trim() !== "";

export type Reply = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  fatal?: boolean;
};

export type Watcher = {
  code: string;
  creds: Creds;
  onView: (view: RoomView) => void;
  onFatal: (message: string) => void;
  onStatus: (connected: boolean) => void;
};

const CONNECT_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 8000;
const KEEPALIVE_MS = 15_000;
const MAX_BACKOFF_MS = 4000;

const UNREACHABLE: Reply = { error: "Could not reach the game server.", ok: false };

let socket: WebSocket | null = null;
let connecting: Promise<boolean> | null = null;
let watcher: Watcher | null = null;
let failures = 0;
let nextId = 1;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let keepAlive: ReturnType<typeof setInterval> | null = null;
const pending = new Map<number, (reply: Reply) => void>();

function address() {
  const base = REALTIME_URL.trim().replace(/\/+$/, "");

  if (/^wss?:\/\//i.test(base)) {
    return base;
  }

  return base.replace(/^http/i, "ws");
}

function onMessage(text: string) {
  let data: Record<string, unknown>;

  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }

  if (data.t === "view") {
    watcher?.onView(data.view as RoomView);
  } else if (data.t === "fatal") {
    const current = watcher;

    watcher = null;
    current?.onFatal(String(data.error ?? "The connection to this game was closed."));
  } else if (typeof data.id === "number") {
    const resolve = pending.get(data.id);

    pending.delete(data.id);
    resolve?.(data as Reply);
  }
}

function connect(): Promise<boolean> {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve(true);
  }

  if (connecting) {
    return connecting;
  }

  connecting = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        connecting = null;
        resolve(ok);
      }
    };

    let ws: WebSocket;

    try {
      ws = new WebSocket(address());
    } catch {
      finish(false);

      return;
    }

    socket = ws;

    const timeout = setTimeout(() => {
      finish(false);
      ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(timeout);
      failures = 0;
      finish(true);
    };
    ws.onmessage = (event) => onMessage(String(event.data));
    ws.onerror = () => {
      // onclose follows
    };
    ws.onclose = () => {
      clearTimeout(timeout);

      if (socket === ws) {
        socket = null;
      }

      finish(false);

      for (const resolve of pending.values()) {
        resolve(UNREACHABLE);
      }

      pending.clear();

      if (watcher) {
        watcher.onStatus(false);
        scheduleResume();
      }
    };
  });

  return connecting;
}

/** Ask the server something and wait for its answer. */
export async function rtRequest(
  type: string,
  body: Record<string, unknown> = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Reply> {
  const open = await connect();

  if (!open || !socket) {
    return UNREACHABLE;
  }

  const ws = socket;
  const id = nextId++;

  return new Promise<Reply>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: "The game server did not answer.", ok: false });
    }, timeoutMs);

    pending.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });

    try {
      ws.send(JSON.stringify({ id, type, ...body }));
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve(UNREACHABLE);
    }
  });
}

/** (Re)connect if needed and tell the server which room this page follows. */
async function resume() {
  const current = watcher;

  if (!current) {
    return;
  }

  const open = await connect();

  if (!open || watcher !== current) {
    return;
  }

  const reply = await rtRequest("watch", { ...current.creds, code: current.code });

  if (watcher !== current) {
    return;
  }

  if (reply.ok) {
    current.onStatus(true);
  } else if (reply.fatal) {
    watcher = null;
    current.onFatal(reply.error ?? "The connection to this game was closed.");
  }
}

function scheduleResume() {
  if (retryTimer || !watcher) {
    return;
  }

  failures += 1;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      void resume();
    },
    Math.min(MAX_BACKOFF_MS, 400 * 2 ** (failures - 1)),
  );
}

function wake() {
  if (watcher && (!socket || socket.readyState !== WebSocket.OPEN)) {
    void resume();
  }
}

/**
 * Follow a room: every change is pushed to `onView` the moment it happens.
 * Returns a function that stops following.
 */
export function rtWatch(next: Watcher) {
  watcher = next;
  void resume();

  if (keepAlive) {
    clearInterval(keepAlive);
  }

  // A connection that died quietly (a phone changing network) is noticed and replaced.
  keepAlive = setInterval(() => {
    if (!watcher || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const ws = socket;

    void rtRequest("ping", {}, 6000).then((reply) => {
      if (!reply.ok && socket === ws) {
        ws.close();
      }
    });
  }, KEEPALIVE_MS);

  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);

  return () => {
    if (watcher === next) {
      watcher = null;
    }

    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }

    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
  };
}
