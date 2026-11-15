/**
 * Where rooms are kept between requests.
 *
 * Why this exists: on Vercel (and any serverless host) every request may be
 * answered by a different, short-lived server instance, so a room kept in one
 * instance's memory "no longer exists" a moment later. Rooms therefore live in
 * a shared store. Two kinds are supported:
 *
 *  - Redis over HTTP (Upstash), used when its environment variables are set.
 *    This is what you want online.
 *  - Memory, used otherwise. Fine on your own computer (one process), not on
 *    Vercel.
 *
 * Every saved room carries a revision number. A save only succeeds when the
 * revision is still the one that was loaded, so two requests that change the
 * same room at the same moment can never overwrite each other: the loser
 * simply loads the newer room and tries again (see service.ts).
 */
import type { Room } from "./rooms";

export type Loaded = { rev: number; room: Room };
export type SaveResult = "ok" | "conflict" | "missing";

export interface RoomStore {
  readonly kind: "memory" | "redis";
  get(code: string): Promise<Loaded | null>;
  /** Saves a brand new room. False if that code is already taken. */
  create(code: string, room: Room): Promise<boolean>;
  /** Saves `room` only if the stored revision is still `rev`. */
  save(code: string, rev: number, room: Room): Promise<SaveResult>;
  remove(code: string): Promise<void>;
  /** A round trip to the store, for the health check. */
  ping(): Promise<void>;
}

/** A room that nobody touches for this long is forgotten. */
export const ROOM_TTL_SECONDS = 24 * 60 * 60;

const roomKey = (code: string) => `cheque:room:${code}`;

/** The stored text is "<revision>|<json>", so one key holds both. */
const pack = (rev: number, room: Room) => `${rev}|${JSON.stringify(room)}`;

function unpack(text: string): Loaded {
  const cut = text.indexOf("|");

  return { rev: Number(text.slice(0, cut)), room: JSON.parse(text.slice(cut + 1)) as Room };
}

// --- memory ------------------------------------------------------------------

type Entry = { expires: number; value: string };

export function createMemoryStore(): RoomStore {
  const entries = new Map<string, Entry>();

  const read = (code: string) => {
    const entry = entries.get(code);

    if (entry && entry.expires < Date.now()) {
      entries.delete(code);

      return undefined;
    }

    return entry;
  };
  const expiry = () => Date.now() + ROOM_TTL_SECONDS * 1000;

  return {
    async create(code, room) {
      if (read(code)) {
        return false;
      }

      entries.set(code, { expires: expiry(), value: pack(1, room) });

      return true;
    },
    async get(code) {
      const entry = read(code);

      return entry ? unpack(entry.value) : null;
    },
    kind: "memory",
    async ping() {},
    async remove(code) {
      entries.delete(code);
    },
    async save(code, rev, room) {
      const entry = read(code);

      if (!entry) {
        return "missing";
      }

      if (unpack(entry.value).rev !== rev) {
        return "conflict";
      }

      entries.set(code, { expires: expiry(), value: pack(rev + 1, room) });

      return "ok";
    },
  };
}

// --- Redis over HTTP (Upstash) ------------------------------------------------

/**
 * Compare the revision and write, in one step the database performs without
 * anyone else getting in between. Returns 1 saved, 0 revision changed,
 * -1 the room is gone.
 */
export const SAVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return -1 end
local cut = string.find(current, '|', 1, true)
if string.sub(current, 1, cut - 1) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

type RedisOptions = { token: string; url: string; timeoutMs?: number };

export function createRedisStore({ token, url, timeoutMs = 5000 }: RedisOptions): RoomStore {
  const endpoint = url.replace(/\/+$/, "");

  async function run(args: (string | number)[]): Promise<unknown> {
    const response = await fetch(endpoint, {
      body: JSON.stringify(args),
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: { error?: string; result?: unknown } = {};

    try {
      body = (await response.json()) as typeof body;
    } catch {
      // not JSON: handled below
    }

    if (!response.ok || body.error) {
      throw new Error(`Storage error (${response.status}): ${body.error ?? "no answer"}`);
    }

    return body.result;
  }

  /** Reads are safe to repeat, so one hiccup does not fail a request. */
  async function readKey(key: string) {
    try {
      return await run(["GET", key]);
    } catch {
      return run(["GET", key]);
    }
  }

  return {
    async create(code, room) {
      const result = await run([
        "SET",
        roomKey(code),
        pack(1, room),
        "NX",
        "EX",
        ROOM_TTL_SECONDS,
      ]);

      return result === "OK";
    },
    async get(code) {
      const text = await readKey(roomKey(code));

      return typeof text === "string" ? unpack(text) : null;
    },
    kind: "redis",
    async ping() {
      const key = "cheque:health";

      await run(["SET", key, String(Date.now()), "EX", 60]);

      if ((await readKey(key)) === null) {
        throw new Error("Storage did not keep what was written.");
      }
    },
    async remove(code) {
      await run(["DEL", roomKey(code)]);
    },
    async save(code, rev, room) {
      const result = await run([
        "EVAL",
        SAVE_SCRIPT,
        1,
        roomKey(code),
        String(rev),
        pack(rev + 1, room),
        ROOM_TTL_SECONDS,
      ]);

      if (result === 1) {
        return "ok";
      }

      return result === -1 ? "missing" : "conflict";
    },
  };
}

// --- choosing the store --------------------------------------------------------

type Globals = typeof globalThis & { __chequeStore?: RoomStore };
const shared = globalThis as Globals;

function redisSettings() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

  return url && token ? { token, url } : null;
}

export function getStore(): RoomStore {
  if (!shared.__chequeStore) {
    const settings = redisSettings();

    shared.__chequeStore = settings ? createRedisStore(settings) : createMemoryStore();
  }

  return shared.__chequeStore;
}

/** For tests: use this store (or, with null, choose again from the environment). */
export function useStore(store: RoomStore | null) {
  shared.__chequeStore = store ?? undefined;
}

/** For the health check and the warning on the home screen. */
export function storageInfo() {
  const onVercel = Boolean(process.env.VERCEL);
  const kind = getStore().kind;

  return {
    kind,
    onVercel,
    // Memory is only safe when one process serves everybody.
    persistent: kind === "redis" || !onVercel,
  };
}
