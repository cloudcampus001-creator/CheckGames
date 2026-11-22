/**
 * Where player profiles are kept: Upstash Redis when it is set up (the same
 * variables as the games use), otherwise memory. In memory they can also be
 * written to a file (PROFILES_FILE), which is enough on your own computer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Profile } from "../multiplayer/profile";

export interface ProfileStore {
  readonly kind: "memory" | "redis";
  get(id: string): Promise<Profile | null>;
  set(profile: Profile): Promise<void>;
  /** The players with the most XP, best first. */
  top(limit: number): Promise<Profile[]>;
}

// --- memory (and an optional file) ------------------------------------------------------------

export function createMemoryProfileStore(file?: string): ProfileStore {
  const profiles = new Map<string, Profile>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  if (file && existsSync(file)) {
    try {
      for (const profile of JSON.parse(readFileSync(file, "utf8")) as Profile[]) {
        profiles.set(profile.id, profile);
      }
    } catch {
      // an unreadable file just means starting fresh
    }
  }

  const save = () => {
    if (!file || timer) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;

      try {
        writeFileSync(file, JSON.stringify([...profiles.values()]));
      } catch {
        // not being able to write must not stop the game
      }
    }, 1000);
    timer.unref?.();
  };

  return {
    async get(id) {
      return profiles.get(id) ?? null;
    },
    kind: "memory",
    async set(profile) {
      profiles.set(profile.id, profile);
      save();
    },
    async top(limit) {
      return [...profiles.values()].sort((a, b) => b.xp - a.xp).slice(0, limit);
    },
  };
}

// --- Redis over HTTP (Upstash) ---------------------------------------------------------------------

const profileKey = (id: string) => `cheque:profile:${id}`;
const BOARD_KEY = "cheque:leaderboard";

export function createRedisProfileStore({
  timeoutMs = 5000,
  token,
  url,
}: {
  token: string;
  url: string;
  timeoutMs?: number;
}): ProfileStore {
  const endpoint = url.replace(/\/+$/, "");

  async function run(args: (string | number)[]): Promise<unknown> {
    const response = await fetch(endpoint, {
      body: JSON.stringify(args),
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
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

  return {
    async get(id) {
      const text = await run(["GET", profileKey(id)]);

      return typeof text === "string" ? (JSON.parse(text) as Profile) : null;
    },
    kind: "redis",
    async set(profile) {
      await run(["SET", profileKey(profile.id), JSON.stringify(profile)]);
      await run(["ZADD", BOARD_KEY, profile.xp, profile.id]);
    },
    async top(limit) {
      const ids = await run(["ZREVRANGE", BOARD_KEY, 0, limit - 1]);

      if (!Array.isArray(ids) || ids.length === 0) {
        return [];
      }

      const texts = await run(["MGET", ...ids.map((id) => profileKey(String(id)))]);

      return (Array.isArray(texts) ? texts : [])
        .filter((text): text is string => typeof text === "string")
        .map((text) => JSON.parse(text) as Profile);
    },
  };
}

// --- choosing the store ---------------------------------------------------------------------------------

type Globals = typeof globalThis & { __chequeProfiles?: ProfileStore };
const shared = globalThis as Globals;

export function getProfileStore(): ProfileStore {
  if (!shared.__chequeProfiles) {
    const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

    shared.__chequeProfiles =
      url && token
        ? createRedisProfileStore({ token, url })
        : createMemoryProfileStore(process.env.PROFILES_FILE);
  }

  return shared.__chequeProfiles;
}

/** For tests: use this store (or, with null, choose again from the environment). */
export function useProfileStore(store: ProfileStore | null) {
  shared.__chequeProfiles = store ?? undefined;
}
