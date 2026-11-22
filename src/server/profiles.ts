/**
 * What the API calls to know a device as a player: create or load its profile,
 * change its name, face and look, count finished games, and show the best
 * players. Every change needs the device's secret.
 */
import { cleanPrefs } from "../multiplayer/prefs";
import {
  adoptBackup,
  cleanAvatar,
  cleanName,
  type GameResult,
  type Gain,
  levelInfo,
  newProfile,
  type Profile,
  type PublicProfile,
  publicProfile,
  recordResult,
  refreshAchievements,
  touchDay,
  validId,
} from "../multiplayer/profile";
import type { Identity } from "./rooms";
import { getProfileStore } from "./profileStore";

export type ProfileFailure = { ok: false; error: string; fatal?: boolean };

const WRONG_DEVICE = "This profile belongs to another device.";

type Auth = { id: unknown; secret: unknown };

const validAuth = <T extends Auth>(input: T): input is T & { id: string; secret: string } =>
  validId(input.id) && validId(input.secret);

/**
 * Open the profile of this device (making it the first time). `backup` is what
 * the device remembers about itself: used only if the server has lost it.
 */
export async function hello(
  input: Auth & { name?: unknown; backup?: unknown },
): Promise<{ ok: true; created: boolean; bonus: number; profile: PublicProfile } | ProfileFailure> {
  if (!validAuth(input)) {
    return { error: "This device has no valid identity.", ok: false };
  }

  const store = getProfileStore();
  const now = Date.now();
  const existing = await store.get(input.id);

  if (!existing) {
    let profile = newProfile(input.id, input.secret, cleanName(input.name), now);

    profile = refreshAchievements(adoptBackup(profile, input.backup));

    const touched = touchDay(profile, now);

    await store.set(touched.profile);

    return { bonus: touched.bonus, created: true, ok: true, profile: publicProfile(touched.profile) };
  }

  if (existing.secret !== input.secret) {
    return { error: WRONG_DEVICE, fatal: true, ok: false };
  }

  const touched = touchDay(existing, now);

  if (touched.bonus > 0) {
    await store.set(touched.profile);
  }

  return { bonus: touched.bonus, created: false, ok: true, profile: publicProfile(touched.profile) };
}

/** Change the name, the face or the look of a profile. */
export async function updateProfile(
  input: Auth & { patch?: unknown },
): Promise<{ ok: true; profile: PublicProfile } | ProfileFailure> {
  if (!validAuth(input)) {
    return { error: "This device has no valid identity.", ok: false };
  }

  const store = getProfileStore();
  const profile = await store.get(input.id);

  if (!profile || profile.secret !== input.secret) {
    return { error: profile ? WRONG_DEVICE : "No such profile.", fatal: true, ok: false };
  }

  const patch = (typeof input.patch === "object" && input.patch !== null ? input.patch : {}) as Record<string, unknown>;
  const next: Profile = {
    ...profile,
    avatar: patch.avatar === undefined ? profile.avatar : cleanAvatar(patch.avatar),
    name: patch.name === undefined ? profile.name : cleanName(patch.name, profile.name),
    prefs: patch.prefs === undefined ? profile.prefs : cleanPrefs(patch.prefs),
  };

  await store.set(next);

  return { ok: true, profile: publicProfile(next) };
}

/**
 * Who a device is, for a table: its name, face and level. Makes the profile if
 * it is new. Null for a guest (no identity, or a wrong secret).
 */
export async function resolveIdentity(
  input: Auth,
): Promise<{ identity: Identity; name: string } | null> {
  if (!validAuth(input)) {
    return null;
  }

  const opened = await hello({ id: input.id, secret: input.secret });

  if (!opened.ok) {
    return null;
  }

  const { profile } = opened;

  return {
    identity: { avatar: profile.avatar, profileId: profile.id, rating: profile.rating, xp: profile.xp },
    name: profile.name,
  };
}

/** Count a finished set for everybody in it. Counting the same set twice does nothing. */
export async function applyResults(
  result: GameResult,
): Promise<{ profile: PublicProfile; gain: Gain }[]> {
  const store = getProfileStore();
  const done: { profile: PublicProfile; gain: Gain }[] = [];

  for (const player of result.players) {
    try {
      const profile = await store.get(player.profileId);
      const counted = profile ? recordResult(profile, result) : null;

      if (counted) {
        await store.set(counted.profile);
        done.push({ gain: counted.gain, profile: publicProfile(counted.profile) });
      }
    } catch (error) {
      // one profile failing must not stop the others
      console.error("could not count a result", error);
    }
  }

  return done;
}

export type LeaderEntry = {
  id: string;
  name: string;
  avatar: string;
  level: number;
  xp: number;
  rating: number;
  wins: number;
  played: number;
};

export async function leaderboard(limit = 20): Promise<LeaderEntry[]> {
  const top = await getProfileStore().top(Math.min(50, Math.max(1, limit)));

  return top.map((profile) => ({
    avatar: profile.avatar,
    id: profile.id,
    level: levelInfo(profile.xp).level,
    name: profile.name,
    played: profile.stats.played,
    rating: profile.rating,
    wins: profile.stats.wins,
    xp: profile.xp,
  }));
}
