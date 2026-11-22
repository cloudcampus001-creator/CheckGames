/**
 * Player profiles: who a device is, and everything it has done. Plain data and
 * plain functions, shared by the server (which keeps the truth) and the
 * browser (which shows it).
 */
import type { Prefs } from "./prefs";

export type Mode = "online" | "friends" | "computer";

/** The faces a player can pick. */
export const AVATARS = [
  "😀",
  "😎",
  "🤠",
  "🥳",
  "🦁",
  "🐯",
  "🦊",
  "🐼",
  "🐸",
  "🦄",
  "🐙",
  "🦅",
  "🔥",
  "⚡",
  "👑",
  "🎯",
  "🍀",
  "🌟",
  "🚀",
  "🎲",
] as const;

export const DEFAULT_AVATAR = "😀";
export const NAME_MAX = 16;
export const START_RATING = 1000;
const MIN_RATING = 100;
const HISTORY_KEEP = 15;
const RECENT_KEEP = 40;

/** What one player did during one set. */
export type Tally = {
  played: number;
  drawn: number;
  attacks: number;
  stops: number;
  jacks: number;
  checks: number;
  timeouts: number;
  penalty: number;
};

export const emptyTally = (): Tally => ({
  attacks: 0,
  checks: 0,
  drawn: 0,
  jacks: 0,
  penalty: 0,
  played: 0,
  stops: 0,
  timeouts: 0,
});

export type ResultPlayer = {
  profileId: string;
  seatId: string;
  name: string;
  won: boolean;
  /** 1 for the first one out, or null if they never went out. */
  rank: number | null;
  /** Quit in the middle of the set. */
  left: boolean;
  /** Won the final of an elimination tournament. */
  champion: boolean;
  tally: Tally;
};

/** How a set ended, once, for everybody who has a profile. */
export type GameResult = {
  /** Unique, so the same result is never counted twice. */
  id: string;
  at: number;
  mode: Mode;
  /** Players at the table. */
  size: number;
  /** Real people at the table. */
  humans: number;
  players: ResultPlayer[];
};

export type ModeStats = { played: number; wins: number };

export type Stats = {
  played: number;
  wins: number;
  losses: number;
  /** Quit games. */
  left: number;
  streak: number;
  bestStreak: number;
  cardsPlayed: number;
  cardsDrawn: number;
  /** 7s and jokers played. */
  attacks: number;
  /** Aces played. */
  stops: number;
  jacks: number;
  checks: number;
  /** Times the clock ran out. */
  timeouts: number;
  /** Cards taken because of somebody's 7 or joker. */
  penalty: number;
  /** Tournaments won. */
  champion: number;
  modes: Record<Mode, ModeStats>;
};

export const emptyStats = (): Stats => ({
  attacks: 0,
  bestStreak: 0,
  cardsDrawn: 0,
  cardsPlayed: 0,
  champion: 0,
  checks: 0,
  jacks: 0,
  left: 0,
  losses: 0,
  modes: {
    computer: { played: 0, wins: 0 },
    friends: { played: 0, wins: 0 },
    online: { played: 0, wins: 0 },
  },
  penalty: 0,
  played: 0,
  stops: 0,
  streak: 0,
  timeouts: 0,
  wins: 0,
});

export type HistoryEntry = {
  at: number;
  mode: Mode;
  won: boolean;
  rank: number | null;
  size: number;
  /** A few of the other players. */
  with: string[];
  xp: number;
  /** Rating change (online games only). */
  rating: number;
};

export type Profile = {
  id: string;
  /** Proves this device owns the profile. Never sent to anybody else. */
  secret: string;
  name: string;
  avatar: string;
  createdAt: number;
  lastSeen: number;
  xp: number;
  rating: number;
  /** Last day played, "YYYY-MM-DD" (UTC). */
  day: string;
  dayStreak: number;
  stats: Stats;
  achievements: string[];
  history: HistoryEntry[];
  prefs: Prefs | null;
  /** Ids of the results already counted. */
  recent: string[];
};

export type PublicProfile = Omit<Profile, "secret" | "recent">;

export function newProfile(id: string, secret: string, name: string, now: number): Profile {
  return {
    achievements: [],
    avatar: DEFAULT_AVATAR,
    createdAt: now,
    day: "",
    dayStreak: 0,
    history: [],
    id,
    lastSeen: now,
    name,
    prefs: null,
    rating: START_RATING,
    recent: [],
    secret,
    stats: emptyStats(),
    xp: 0,
  };
}

export function publicProfile(profile: Profile): PublicProfile {
  const { recent: _recent, secret: _secret, ...rest } = profile;

  return rest;
}

// --- levels, ratings, rewards -------------------------------------------------------

export type LevelInfo = {
  level: number;
  /** XP at the start of this level and of the next. */
  floor: number;
  next: number;
  /** XP earned in this level, and how many this level takes. */
  into: number;
  needed: number;
  pct: number;
};

export function levelInfo(xp: number): LevelInfo {
  const safe = Math.max(0, Math.floor(xp));
  const level = Math.floor(Math.sqrt(safe / 40)) + 1;
  const floor = 40 * (level - 1) ** 2;
  const next = 40 * level ** 2;
  const into = safe - floor;
  const needed = next - floor;

  return { floor, into, level, needed, next, pct: Math.min(100, Math.round((into / needed) * 100)) };
}

export const TIERS = [
  { emoji: "🥉", min: 0, name: "Bronze" },
  { emoji: "🥈", min: 950, name: "Silver" },
  { emoji: "🥇", min: 1100, name: "Gold" },
  { emoji: "💠", min: 1250, name: "Platinum" },
  { emoji: "💎", min: 1400, name: "Diamond" },
  { emoji: "👑", min: 1600, name: "Legend" },
] as const;

export function tierFor(rating: number) {
  let tier: (typeof TIERS)[number] = TIERS[0];

  for (const candidate of TIERS) {
    if (rating >= candidate.min) {
      tier = candidate;
    }
  }

  return tier;
}

export const modeOf = (matchmade: boolean, humans: number): Mode =>
  matchmade ? "online" : humans >= 2 ? "friends" : "computer";

/** XP for one set: for playing, a bonus for winning, a bigger one online. Nothing for quitting. */
export function xpFor(input: { won: boolean; left: boolean; mode: Mode; rank: number | null }) {
  if (input.left) {
    return 0;
  }

  return 10 + (input.won ? 25 : 0) + (!input.won && input.rank === 2 ? 8 : 0) + (input.mode === "online" ? 10 : 0);
}

/** Rating moves only for online games; a bigger table pays more for a win. */
export function ratingDelta(input: { won: boolean; left: boolean; mode: Mode; size: number }) {
  if (input.mode !== "online") {
    return 0;
  }

  if (input.left) {
    return -25;
  }

  return input.won ? 20 + 6 * Math.max(0, input.size - 2) : -10;
}

// --- days and streaks ----------------------------------------------------------------

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

function yesterdayOf(day: string) {
  const date = new Date(`${day}T00:00:00Z`);

  date.setUTCDate(date.getUTCDate() - 1);

  return date.toISOString().slice(0, 10);
}

export const DAILY_BONUS_XP = 10;

/** The first visit of a new day: the day streak goes up and a small bonus is paid. */
export function touchDay(profile: Profile, now: number): { profile: Profile; bonus: number } {
  const today = dayOf(now);

  if (profile.day === today) {
    return { bonus: 0, profile };
  }

  const streak = profile.day === yesterdayOf(today) ? profile.dayStreak + 1 : 1;
  const next = {
    ...profile,
    day: today,
    dayStreak: streak,
    lastSeen: now,
    xp: profile.xp + DAILY_BONUS_XP,
  };

  return { bonus: DAILY_BONUS_XP, profile: { ...next, achievements: unlocked(next) } };
}

// --- achievements ------------------------------------------------------------------------

export type Achievement = {
  id: string;
  name: string;
  emoji: string;
  text: string;
  test: (profile: Profile) => boolean;
};

export const ACHIEVEMENTS: readonly Achievement[] = [
  { emoji: "🎉", id: "first-win", name: "First win", test: (p) => p.stats.wins >= 1, text: "Win a game." },
  { emoji: "🏅", id: "five-wins", name: "On a roll", test: (p) => p.stats.wins >= 5, text: "Win 5 games." },
  { emoji: "🏆", id: "25-wins", name: "Table boss", test: (p) => p.stats.wins >= 25, text: "Win 25 games." },
  { emoji: "🔥", id: "streak-3", name: "Hot streak", test: (p) => p.stats.bestStreak >= 3, text: "Win 3 games in a row." },
  { emoji: "☄️", id: "streak-5", name: "Unstoppable", test: (p) => p.stats.bestStreak >= 5, text: "Win 5 games in a row." },
  { emoji: "🎴", id: "games-10", name: "Regular", test: (p) => p.stats.played >= 10, text: "Play 10 games." },
  { emoji: "🃏", id: "games-50", name: "Card veteran", test: (p) => p.stats.played >= 50, text: "Play 50 games." },
  { emoji: "✋", id: "cards-200", name: "Quick hands", test: (p) => p.stats.cardsPlayed >= 200, text: "Play 200 cards." },
  { emoji: "💥", id: "attacker", name: "Attacker", test: (p) => p.stats.attacks >= 25, text: "Play 25 sevens or jokers." },
  { emoji: "🛑", id: "stopper", name: "Stopper", test: (p) => p.stats.stops >= 25, text: "Stop 25 players with an ace." },
  { emoji: "📣", id: "checker", name: "Check!", test: (p) => p.stats.checks >= 20, text: "Get down to one card 20 times." },
  { emoji: "🌍", id: "online-win", name: "World stage", test: (p) => p.stats.modes.online.wins >= 1, text: "Win an online game." },
  { emoji: "🤝", id: "friends-10", name: "Friends night", test: (p) => p.stats.modes.friends.played >= 10, text: "Play 10 games with friends." },
  { emoji: "👑", id: "champion", name: "Champion", test: (p) => p.stats.champion >= 1, text: "Win an elimination final." },
  { emoji: "📈", id: "level-5", name: "Level 5", test: (p) => levelInfo(p.xp).level >= 5, text: "Reach level 5." },
  { emoji: "📅", id: "daily-3", name: "Back again", test: (p) => p.dayStreak >= 3, text: "Play 3 days in a row." },
];

function unlocked(profile: Profile) {
  const have = new Set(profile.achievements);

  for (const achievement of ACHIEVEMENTS) {
    if (achievement.test(profile)) {
      have.add(achievement.id);
    }
  }

  return ACHIEVEMENTS.filter((a) => have.has(a.id)).map((a) => a.id);
}

// --- counting a finished set ----------------------------------------------------------------

export type Gain = { xp: number; rating: number; achievements: string[] };

/**
 * Add one finished set to a profile. Returns null if the profile was not in
 * it, or if the very same result was already counted.
 */
export function recordResult(
  profile: Profile,
  result: GameResult,
): { profile: Profile; gain: Gain } | null {
  const mine = result.players.find((player) => player.profileId === profile.id);

  if (!mine || profile.recent.includes(result.id)) {
    return null;
  }

  const stats: Stats = {
    ...profile.stats,
    modes: {
      ...profile.stats.modes,
      [result.mode]: {
        played: profile.stats.modes[result.mode].played + 1,
        wins: profile.stats.modes[result.mode].wins + (mine.won ? 1 : 0),
      },
    },
  };

  stats.played += 1;
  stats.cardsPlayed += mine.tally.played;
  stats.cardsDrawn += mine.tally.drawn;
  stats.attacks += mine.tally.attacks;
  stats.stops += mine.tally.stops;
  stats.jacks += mine.tally.jacks;
  stats.checks += mine.tally.checks;
  stats.timeouts += mine.tally.timeouts;
  stats.penalty += mine.tally.penalty;

  if (mine.left) {
    stats.left += 1;
    stats.losses += 1;
    stats.streak = 0;
  } else if (mine.won) {
    stats.wins += 1;
    stats.streak += 1;
    stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
  } else {
    stats.losses += 1;
    stats.streak = 0;
  }

  if (mine.champion) {
    stats.champion += 1;
  }

  const xp = xpFor({ left: mine.left, mode: result.mode, rank: mine.rank, won: mine.won });
  const rating = ratingDelta({ left: mine.left, mode: result.mode, size: result.size, won: mine.won });
  const entry: HistoryEntry = {
    at: result.at,
    mode: result.mode,
    rating,
    rank: mine.rank,
    size: result.size,
    with: result.players
      .filter((player) => player.profileId !== profile.id)
      .map((player) => player.name)
      .slice(0, 3),
    won: mine.won,
    xp,
  };
  const next: Profile = {
    ...profile,
    history: [entry, ...profile.history].slice(0, HISTORY_KEEP),
    lastSeen: result.at,
    rating: Math.max(MIN_RATING, profile.rating + rating),
    recent: [result.id, ...profile.recent].slice(0, RECENT_KEEP),
    stats,
    xp: profile.xp + xp,
  };
  const all = unlocked(next);
  const fresh = all.filter((id) => !profile.achievements.includes(id));

  return { gain: { achievements: fresh, rating, xp }, profile: { ...next, achievements: all } };
}

// --- cleaning what a device sends ----------------------------------------------------------------

const num = (value: unknown, max = 10_000_000) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0;

export function cleanName(raw: unknown, fallback = "Player") {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return Array.from(name).slice(0, NAME_MAX).join("") || fallback;
}

export const cleanAvatar = (raw: unknown) =>
  (AVATARS as readonly unknown[]).includes(raw) ? (raw as string) : DEFAULT_AVATAR;

export const validId = (raw: unknown): raw is string =>
  typeof raw === "string" && /^[A-Za-z0-9-]{8,64}$/.test(raw);

/**
 * A device that has a profile the server does not know (the server lost its
 * data) can hand back what it remembers. Only plain numbers and names are
 * taken, and clamped.
 */
export function adoptBackup(base: Profile, raw: unknown): Profile {
  if (typeof raw !== "object" || raw === null) {
    return base;
  }

  const backup = raw as Partial<Profile> & { stats?: Partial<Stats> };
  const from: Partial<Stats> = backup.stats ?? {};
  const stats = emptyStats();

  for (const key of Object.keys(stats) as (keyof Stats)[]) {
    if (key !== "modes" && typeof from[key] === "number") {
      (stats[key] as number) = num(from[key]);
    }
  }

  for (const mode of ["online", "friends", "computer"] as const) {
    const value = from.modes?.[mode];

    stats.modes[mode] = { played: num(value?.played), wins: num(value?.wins) };
  }

  const history = Array.isArray(backup.history) ? backup.history.slice(0, HISTORY_KEEP) : [];

  return {
    ...base,
    achievements: [],
    avatar: cleanAvatar(backup.avatar),
    dayStreak: num(backup.dayStreak, 3650),
    history: history.filter((entry): entry is HistoryEntry => typeof entry === "object" && entry !== null),
    name: cleanName(backup.name, base.name),
    rating: Math.max(MIN_RATING, num(backup.rating, 5000) || START_RATING),
    stats,
    xp: num(backup.xp),
  };
}

export function refreshAchievements(profile: Profile): Profile {
  return { ...profile, achievements: unlocked(profile) };
}
