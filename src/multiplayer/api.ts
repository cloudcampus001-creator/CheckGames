/** Browser-side helpers: remembering who you are, and creating/joining games. */

import { getDevice } from "./device";
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

/** Who is asking, so the table knows this device as a player. */
function who() {
  const device = getDevice();

  return { profileId: device.id, secret: device.secret };
}

export async function createRoomRequest(name: string): Promise<Joined> {
  if (realtimeEnabled) {
    return joinedFrom(await rtRequest("create", { name, ...who() }), "Could not start a game.");
  }

  try {
    const response = await fetch("/api/rooms", {
      body: JSON.stringify({ name, ...who() }),
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
      await rtRequest("join", { code: clean, name, token, ...who() }),
      "Could not join that game.",
    );
  }

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(clean)}/join`, {
      body: JSON.stringify({ name, token, ...who() }),
      headers: jsonHeaders,
      method: "POST",
    });
    const data = await readJson(response);

    return joinedFrom(response.ok ? data : { error: data?.error }, "Could not join that game.");
  } catch {
    return { error: "Could not reach the game server.", ok: false };
  }
}

// --- profiles, the leaderboard and matchmaking -------------------------------------------------------

type Json = Record<string, unknown>;

const UNREACHABLE = { error: "Could not reach the game server. Check your connection and try again.", ok: false };

async function post(url: string, body: Json): Promise<Json> {
  try {
    const response = await fetch(url, { body: JSON.stringify(body), headers: jsonHeaders, method: "POST" });

    return (await readJson(response)) ?? UNREACHABLE;
  } catch {
    return UNREACHABLE;
  }
}

/** Open ("hello") or change ("update") this device's profile. */
export async function profileRequest(body: Json): Promise<Json> {
  const device = getDevice();
  const full = { profileId: device.id, secret: device.secret, ...body };

  return realtimeEnabled
    ? await rtRequest("profile", full)
    : await post("/api/profile", { ...full, id: device.id });
}

/** The players with the most XP. */
export async function leaderboardRequest(): Promise<Json> {
  if (realtimeEnabled) {
    return await rtRequest("leaderboard");
  }

  try {
    const response = await fetch("/api/leaderboard", { cache: "no-store" });

    return (await readJson(response)) ?? UNREACHABLE;
  } catch {
    return UNREACHABLE;
  }
}

export type MatchWants = { sizes: number[]; turn: number | null; fillBots: boolean };

export async function queueJoinRequest(wants: MatchWants): Promise<Json> {
  const auth = who();

  return realtimeEnabled
    ? await rtRequest("queueJoin", { ...auth, ...wants })
    : await post("/api/match", { action: "join", id: auth.profileId, secret: auth.secret, ...wants });
}

/** Plain-request matchmaking: how is the search going? */
export async function queuePollRequest(ticket: string): Promise<Json> {
  return await post("/api/match", { action: "poll", ticket });
}

export async function queueLeaveRequest(ticket: string): Promise<Json> {
  return realtimeEnabled
    ? await rtRequest("queueLeave", { ticket })
    : await post("/api/match", { action: "leave", ticket });
}
