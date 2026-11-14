/** Browser-side helpers: remembering who you are, and creating/joining games. */

import type { ClientAction } from "./protocol";

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

export async function createRoomRequest(name: string): Promise<Joined> {
  try {
    const response = await fetch("/api/rooms", {
      body: JSON.stringify({ name }),
      headers: jsonHeaders,
      method: "POST",
    });
    const data = await readJson(response);

    if (!response.ok || !data || data.ok !== true) {
      return { error: String(data?.error ?? "Could not start a game."), ok: false };
    }

    return {
      code: String(data.code),
      creds: { seatId: String(data.seatId), token: String(data.token) },
      ok: true,
    };
  } catch {
    return { error: "Could not reach the game server.", ok: false };
  }
}

/** Do something in a game. Resolves to an error message, or null if it worked. */
export async function postAction(
  code: string,
  creds: Creds,
  action: ClientAction,
): Promise<string | null> {
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/action`, {
      body: JSON.stringify({ action, seatId: creds.seatId, token: creds.token }),
      headers: jsonHeaders,
      method: "POST",
    });
    const data = await readJson(response);

    return data?.ok === true ? null : String(data?.error ?? "That did not work.");
  } catch {
    return "Could not reach the game server.";
  }
}

export async function joinRoomRequest(code: string, name: string): Promise<Joined> {
  const clean = code.trim().toUpperCase();

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(clean)}/join`, {
      // An old token for this game gives you your old seat back.
      body: JSON.stringify({ name, token: loadCreds(clean)?.token }),
      headers: jsonHeaders,
      method: "POST",
    });
    const data = await readJson(response);

    if (!response.ok || !data || data.ok !== true) {
      return { error: String(data?.error ?? "Could not join that game."), ok: false };
    }

    return {
      code: String(data.code),
      creds: { seatId: String(data.seatId), token: String(data.token) },
      ok: true,
    };
  } catch {
    return { error: "Could not reach the game server.", ok: false };
  }
}
