/** Browser-side helpers: remembering who you are, and creating/joining games. */

import type { ClientAction, RoomView } from "./protocol";
import { realtimeEnabled, rtRequest } from "./rt";

export type Creds = { seatId: string; token: string };

export type Joined =
  | { ok: true; code: string; creds: Creds }
  | { ok: false; error: string };

const NAME_KEY = "cheque-games:name";
const credsKey = (code: string) => `cheque-games:room:${code.toUpperCase()}`;

export function loadCreds(code: string): Creds | null {
  try {
    const raw = localStorage.getItem(credsKey(code));
    const parsed = raw ? (JSON.parse(raw) as Partial<Creds>) : null;

    if (parsed && typeof parsed.seatId === "string" && typeof parsed.token === "string") {
      return { seatId: parsed.seatId, token: parsed.token };
    }
  } catch {
    // storage unavailable or corrupted: treat as not joined
  }

  return null;
}

export function saveCreds(code: string, creds: Creds) {
  try {
    localStorage.setItem(credsKey(code), JSON.stringify(creds));
  } catch {
    // private mode: the game still works until the page is closed
  }
}

export function clearCreds(code: string) {
  try {
    localStorage.removeItem(credsKey(code));
  } catch {
    // nothing to clear
  }
}

export function loadName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // not important
  }
}

async function readJson(response: Response) {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const jsonHeaders = { "content-type": "application/json" };

function joinedFrom(data: Record<string, unknown> | null, fallback: string): Joined {
  if (!data || data.ok !== true) {
    return { error: String(data?.error ?? fallback), ok: false };
  }

  return {
    code: String(data.code),
    creds: { seatId: String(data.seatId), token: String(data.token) },
    ok: true,
  };
}

export async function createRoomRequest(name: string): Promise<Joined> {
  if (realtimeEnabled) {
    return joinedFrom(await rtRequest("create", { name }), "Could not start a game.");
  }

  try {
    const response = await fetch("/api/rooms", {
      body: JSON.stringify({ name }),
      headers: jsonHeaders,
      method: "POST",
    });
    const data = await readJson(response);

    return joinedFrom(response.ok ? data : { error: data?.error }, "Could not start a game.");
  } catch {
    return { error: "Could not reach the game server.", ok: false };
  }
}

export type ActionResult = {
  /** An error message, or null if it worked. */
  error: string | null;
  /**
   * The player's new view, when the answer carries it (plain requests do; over
   * the realtime server the view is pushed instead).
   */
  view: RoomView | null;
  etag: string | null;
  fatal: boolean;
};

/** Do something in a game. */
export async function postActionFull(
  code: string,
  creds: Creds,
  action: ClientAction,
): Promise<ActionResult> {
  if (realtimeEnabled) {
    const reply = await rtRequest("act", {
      action,
      code,
      seatId: creds.seatId,
      token: creds.token,
    });

    return {
      error: reply.ok === true ? null : String(reply.error ?? "That did not work."),
      etag: null,
      fatal: reply.fatal === true,
      view: null,
    };
  }

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/action`, {
      body: JSON.stringify({ action, seatId: creds.seatId, token: creds.token }),
      headers: jsonHeaders,
      method: "POST",
    });
    const data = await readJson(response);

    if (data?.ok === true) {
      return {
        error: null,
        etag: typeof data.etag === "string" ? data.etag : null,
        fatal: false,
        view: (data.view as RoomView | null | undefined) ?? null,
      };
    }

    return {
      error: String(data?.error ?? "That did not work."),
      etag: null,
      fatal: data?.fatal === true,
      view: null,
    };
  } catch {
    return { error: "Could not reach the game server.", etag: null, fatal: false, view: null };
  }
}

/** Do something in a game. Resolves to an error message, or null if it worked. */
export async function postAction(
  code: string,
  creds: Creds,
  action: ClientAction,
): Promise<string | null> {
  return (await postActionFull(code, creds, action)).error;
}

export async function joinRoomRequest(code: string, name: string): Promise<Joined> {
  const clean = code.trim().toUpperCase();
  // An old token for this game gives you your old seat back.
  const token = loadCreds(clean)?.token;

  if (realtimeEnabled) {
    return joinedFrom(
      await rtRequest("join", { code: clean, name, token }),
      "Could not join that game.",
    );
  }

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(clean)}/join`, {
      body: JSON.stringify({ name, token }),
      headers: jsonHeaders,
      method: "POST",
    });
    const data = await readJson(response);

    return joinedFrom(response.ok ? data : { error: data?.error }, "Could not join that game.");
  } catch {
    return { error: "Could not reach the game server.", ok: false };
  }
}
