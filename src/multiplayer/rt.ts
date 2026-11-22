/**
 * The browser side of the realtime server (realtime/server.ts).
 *
 * It talks over a WebSocket, so every change is pushed the instant it happens.
 * Some phones and networks block WebSockets (and a sleeping free server can take
 * a minute to wake up), so when a WebSocket cannot be opened it switches, by
 * itself, to plain requests to the same server: one request per action and a
 * "long poll" that returns the moment something happens. The rest of the game
 * does not know the difference.
 *
 * It is only used when NEXT_PUBLIC_REALTIME_URL is set. Without it the game
 * talks to the website's own API (see useRoom.ts).
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

/** How the connection to the game server is doing, for a banner. */
export type RtState = "connecting" | "ready" | "waking" | "down";

const CONNECT_TIMEOUT_MS = 7000;
const REQUEST_TIMEOUT_MS = 12_000;
/** The first request to a server that was asleep can take this long. */
const WAKE_TIMEOUT_MS = 60_000;
const KEEPALIVE_MS = 15_000;
const MAX_BACKOFF_MS = 4000;
const POLL_TIMEOUT_MS = 30_000;
const MODE_KEY = "cheque-games:rt-mode";

const UNREACHABLE: Reply = { error: "Could not reach the game server. Check your connection and try again.", ok: false };

// --- addresses ---------------------------------------------------------------------------

function address(kind: "http" | "ws") {
  const raw = REALTIME_URL.trim().replace(/\/+$/, "");
  const host = raw.replace(/^(wss?|https?):\/\//i, "");
  const local = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(host);
  const pageSecure = typeof location !== "undefined" && location.protocol === "https:";
  // A secure page may only talk to secure addresses, so "http://" typed by mistake is upgraded.
  const secure = /^(https|wss):/i.test(raw) || (pageSecure && !local);

  return `${kind === "ws" ? (secure ? "wss" : "ws") : secure ? "https" : "http"}://${host}`;
}

// --- state ---------------------------------------------------------------------------------

let mode: "ws" | "http" = "ws";
let socket: WebSocket | null = null;
let connecting: Promise<boolean> | null = null;
let watcher: Watcher | null = null;
let wsFailures = 0;
let failures = 0;
let nextId = 1;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let keepAlive: ReturnType<typeof setInterval> | null = null;
let state: RtState = "connecting";
let pollRunning = false;
let resuming = false;
let everWorked = false;
const pending = new Map<number, (reply: Reply) => void>();
const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
const stateListeners = new Set<(state: RtState) => void>();

const sid = (() => {
  const bytes = new Uint8Array(12);

  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return `s-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
})();

function setState(next: RtState) {
  if (state !== next) {
    state = next;

    for (const listener of stateListeners) {
      listener(next);
    }
  }
}

export const rtState = () => state;

export function onRtState(listener: (state: RtState) => void) {
  stateListeners.add(listener);

  return () => {
    stateListeners.delete(listener);
  };
}

/** Listen for pushed messages of one kind ("matched", "queue", "gain"). */
export function rtOn(kind: string, handler: (data: Record<string, unknown>) => void) {
  const set = listeners.get(kind) ?? new Set();

  set.add(handler);
  listeners.set(kind, set);
  ensurePolling();

  return () => {
    set.delete(handler);
  };
}

const needsPush = () =>
  watcher !== null || [...listeners.values()].some((set) => set.size > 0);

function dispatch(data: Record<string, unknown>) {
  if (data.t === "view") {
    watcher?.onView(data.view as RoomView);
  } else if (data.t === "fatal") {
    const current = watcher;

    watcher = null;
    current?.onFatal(String(data.error ?? "The connection to this game was closed."));
  } else if (typeof data.t === "string") {
    for (const handler of listeners.get(data.t) ?? []) {
      handler(data);
    }
  }
}

function useHttp(why: string) {
  if (mode === "http") {
    return;
  }

  mode = "http";
  console.info(`Realtime: switching to plain requests (${why}).`);

  try {
    sessionStorage.setItem(MODE_KEY, "http");
  } catch {
    // not important
  }
}

// --- WebSocket ---------------------------------------------------------------------------------

function onMessage(text: string) {
  let data: Record<string, unknown>;

  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }

  if (typeof data.t === "string") {
    dispatch(data);
  } else if (typeof data.id === "number") {
    const resolve = pending.get(data.id);

    pending.delete(data.id);
    resolve?.(data as Reply);
  }
}

function connectSocket(): Promise<boolean> {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve(true);
  }

  if (connecting) {
    return connecting;
  }

  connecting = new Promise<boolean>((resolve) => {
    let settled = false;
    let opened = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        connecting = null;
        resolve(ok);
      }
    };

    let ws: WebSocket;

    try {
      ws = new WebSocket(address("ws"));
    } catch {
      wsFailures += 2;
      useHttp("no WebSocket");
      finish(false);

      return;
    }

    socket = ws;
    setState(everWorked ? "connecting" : "waking");

    const timeout = setTimeout(() => {
      finish(false);
      ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      opened = true;
      clearTimeout(timeout);
      failures = 0;
      wsFailures = 0;
      everWorked = true;
      setState("ready");
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

      if (!opened) {
        // Could not even open: after two tries this network is not letting WebSockets through.
        wsFailures += 1;

        if (wsFailures >= 2) {
          useHttp("WebSocket blocked or server asleep");
        }
      }

      if (needsPush()) {
        watcher?.onStatus(false);
        scheduleResume();
      }
    };
  });

  return connecting;
}

async function socketRequest(type: string, body: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
  const open = await connectSocket();

  if (!open || !socket) {
    return mode === "http" ? httpRequest(type, body, timeoutMs) : UNREACHABLE;
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

// --- plain requests (the fallback) ---------------------------------------------------------------

async function fetchJson(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });

    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

async function httpRequest(type: string, body: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
  const first = !everWorked;
  // A server that was asleep needs a long first wait; after that a request should be quick.
  const wait = first ? WAKE_TIMEOUT_MS : timeoutMs;
  const slow = first ? setTimeout(() => setState("waking"), 2500) : null;

  try {
    const data = await fetchJson(
      `${address("http")}/rpc?sid=${sid}`,
      {
        body: JSON.stringify({ id: nextId++, type, ...body }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      wait,
    );

    everWorked = true;
    failures = 0;
    setState("ready");

    for (const push of (data.pushes as Record<string, unknown>[] | undefined) ?? []) {
      dispatch(push);
    }

    ensurePolling();

    return (data.reply as Reply | undefined) ?? { ok: true };
  } catch {
    setState("down");

    return UNREACHABLE;
  } finally {
    if (slow) {
      clearTimeout(slow);
    }
  }
}

function ensurePolling() {
  if (mode !== "http" || pollRunning || !needsPush()) {
    return;
  }

  pollRunning = true;

  void (async () => {
    while (mode === "http" && needsPush()) {
      try {
        const data = await fetchJson(`${address("http")}/poll?sid=${sid}`, {}, POLL_TIMEOUT_MS);

        failures = 0;
        setState("ready");

        for (const push of (data.pushes as Record<string, unknown>[] | undefined) ?? []) {
          dispatch(push);
        }

        // The server forgot this page (it restarted): open the room again.
        if (data.watching === false && watcher && !resuming) {
          void resume();
        }
      } catch {
        failures += 1;
        setState("down");
        watcher?.onStatus(false);
        await new Promise((resolve) => setTimeout(resolve, Math.min(MAX_BACKOFF_MS, 500 * 2 ** failures)));
      }
    }

    pollRunning = false;
  })();
}

// --- one request API for both ---------------------------------------------------------------------------

/** Ask the server something and wait for its answer. */
export async function rtRequest(
  type: string,
  body: Record<string, unknown> = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Reply> {
  if (mode === "http") {
    return httpRequest(type, body, timeoutMs);
  }

  return socketRequest(type, body, timeoutMs);
}

/** (Re)connect if needed and tell the server which room this page follows. */
async function resume() {
  const current = watcher;

  if (!current || resuming) {
    return;
  }

  resuming = true;

  try {
    if (mode === "ws") {
      const open = await connectSocket();

      if (!open && mode === "ws") {
        return;
      }
    }

    if (watcher !== current) {
      return;
    }

    const reply = await rtRequest("watch", { ...current.creds, code: current.code });

    if (watcher !== current) {
      return;
    }

    if (reply.ok) {
      current.onStatus(true);
      ensurePolling();
    } else if (reply.fatal) {
      watcher = null;
      current.onFatal(reply.error ?? "The connection to this game was closed.");
    } else {
      scheduleResume();
    }
  } finally {
    resuming = false;
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
  if (!watcher) {
    return;
  }

  if (mode === "ws" && (!socket || socket.readyState !== WebSocket.OPEN)) {
    void resume();
  } else if (mode === "http") {
    ensurePolling();
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
    if (!watcher) {
      return;
    }

    if (mode === "ws") {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const ws = socket;

      void rtRequest("ping", {}, 6000).then((reply) => {
        if (!reply.ok && socket === ws) {
          ws.close();
        }
      });
    } else {
      ensurePolling();
    }
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

/** Wake a sleeping free server before anybody needs it, so the first tap is not the slow one. */
export function warmUp() {
  if (!realtimeEnabled || typeof window === "undefined") {
    return;
  }

  fetch(address("http"), { cache: "no-store", mode: "no-cors" }).catch(() => {
    // it will be tried again when something is asked
  });
}

if (typeof window !== "undefined" && realtimeEnabled) {
  try {
    if (sessionStorage.getItem(MODE_KEY) === "http") {
      mode = "http";
    }
  } catch {
    // not important
  }

  if (typeof WebSocket === "undefined") {
    mode = "http";
  }

  warmUp();
}
