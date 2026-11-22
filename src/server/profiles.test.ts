import assert from "node:assert/strict";
import {
  ACHIEVEMENTS,
  adoptBackup,
  type GameResult,
  levelInfo,
  newProfile,
  ratingDelta,
  recordResult,
  tierFor,
  touchDay,
  xpFor,
} from "../multiplayer/profile";
import { cleanPrefs, DEFAULT_PREFS } from "../multiplayer/prefs";
import { createMemoryProfileStore, useProfileStore } from "./profileStore";
import { applyResults, hello, leaderboard, resolveIdentity, updateProfile } from "./profiles";

const tally = { attacks: 2, checks: 1, drawn: 3, jacks: 1, penalty: 2, played: 7, stops: 1, timeouts: 0 };
const result = (id: string, winner: string, others: string[], extra: Partial<GameResult> = {}): GameResult => ({
  at: Date.now(),
  humans: others.length + 1,
  id,
  mode: "online",
  players: [winner, ...others].map((profileId, index) => ({
    champion: false,
    left: false,
    name: profileId.slice(0, 4),
    profileId,
    rank: index === 0 ? 1 : null,
    seatId: `s${index}`,
    tally,
    won: index === 0,
  })),
  size: others.length + 1,
  ...extra,
});

// --- levels, tiers and rewards ------------------------------------------------------------
assert.equal(levelInfo(0).level, 1);
assert.equal(levelInfo(39).level, 1);
assert.equal(levelInfo(40).level, 2);
assert.equal(levelInfo(160).level, 3);
assert.equal(levelInfo(40).floor, 40);
assert.equal(levelInfo(100).pct, Math.round(((100 - 40) / (160 - 40)) * 100));
assert.equal(tierFor(1000).name, "Silver");
assert.equal(tierFor(900).name, "Bronze");
assert.equal(tierFor(1700).name, "Legend");

assert.equal(xpFor({ left: false, mode: "computer", rank: 1, won: true }), 35);
assert.equal(xpFor({ left: false, mode: "online", rank: 1, won: true }), 45);
assert.equal(xpFor({ left: false, mode: "friends", rank: 2, won: false }), 18);
assert.equal(xpFor({ left: false, mode: "friends", rank: null, won: false }), 10);
assert.equal(xpFor({ left: true, mode: "online", rank: null, won: false }), 0, "nothing for quitting");
assert.equal(ratingDelta({ left: false, mode: "online", size: 2, won: true }), 20);
assert.equal(ratingDelta({ left: false, mode: "online", size: 4, won: true }), 32);
assert.equal(ratingDelta({ left: false, mode: "online", size: 4, won: false }), -10);
assert.equal(ratingDelta({ left: true, mode: "online", size: 4, won: false }), -25);
assert.equal(ratingDelta({ left: false, mode: "friends", size: 4, won: true }), 0, "only online games move the rating");

// --- counting sets -------------------------------------------------------------------------------
{
  let me = newProfile("player-aaaaaa", "secret-aaaaaa", "Amina", 1);
  const r1 = result("R-1", "player-aaaaaa", ["player-bbbbbb"]);
  const first = recordResult(me, r1)!;

  me = first.profile;
  assert.equal(me.stats.played, 1);
  assert.equal(me.stats.wins, 1);
  assert.equal(me.stats.streak, 1);
  assert.equal(me.stats.cardsPlayed, 7);
  assert.equal(me.stats.cardsDrawn, 3);
  assert.equal(me.stats.penalty, 2);
  assert.equal(me.stats.modes.online.wins, 1);
  assert.equal(me.xp, 45);
  assert.equal(me.rating, 1020);
  assert.deepEqual(first.gain, { achievements: ["first-win", "online-win"], rating: 20, xp: 45 });
  assert.deepEqual(me.history[0].with, ["play"]);
  assert.equal(me.history[0].won, true);

  // the same result twice changes nothing
  assert.equal(recordResult(me, r1), null);
  // a result they are not in changes nothing
  assert.equal(recordResult(me, result("R-x", "player-cccccc", ["player-dddddd"])), null);

  // a loss ends the streak; the best one is kept
  me = recordResult(me, result("R-2", "player-bbbbbb", ["player-aaaaaa"]))!.profile;
  assert.equal(me.stats.losses, 1);
  assert.equal(me.stats.streak, 0);
  assert.equal(me.stats.bestStreak, 1);
  assert.equal(me.rating, 1010);

  for (let i = 3; i < 8; i++) {
    me = recordResult(me, result(`R-${i}`, "player-aaaaaa", ["player-bbbbbb"], { mode: "friends" }))!.profile;
  }

  assert.equal(me.stats.streak, 5);
  assert.equal(me.stats.bestStreak, 5);
  assert.equal(me.stats.modes.friends.played, 5);
  assert.equal(me.rating, 1010, "friends games do not move the rating");
  assert.ok(["streak-3", "streak-5", "five-wins", "games-10"].filter((id) => me.achievements.includes(id)).length === 3, me.achievements.join());
  assert.ok(me.history.length === 7 && me.history[0].at >= me.history[6].at);

  // quitting
  const quit = recordResult(me, result("R-q", "player-bbbbbb", ["player-aaaaaa"]).players.length ? { ...result("R-q", "player-bbbbbb", []), players: [{ champion: false, left: true, name: "A", profileId: "player-aaaaaa", rank: null, seatId: "s", tally, won: false }] } : result("x", "y", []))!;

  assert.equal(quit.profile.stats.left, 1);
  assert.equal(quit.profile.stats.streak, 0);
  assert.equal(quit.gain.xp, 0);
  assert.equal(quit.gain.rating, -25);

  // history and the list of counted results stay short
  let busy = newProfile("player-aaaaaa", "secret-aaaaaa", "Amina", 1);

  for (let i = 0; i < 80; i++) {
    busy = recordResult(busy, result(`B-${i}`, "player-aaaaaa", ["player-bbbbbb"]))!.profile;
  }

  assert.equal(busy.history.length, 15);
  assert.ok(busy.recent.length <= 40);
  assert.ok(busy.achievements.includes("games-50") && busy.achievements.includes("cards-200"));
  assert.equal(busy.achievements.length, new Set(busy.achievements).size);
  assert.ok(ACHIEVEMENTS.length >= 12);

  // the rating never falls through the floor
  let low = { ...newProfile("player-aaaaaa", "secret-aaaaaa", "Amina", 1), rating: 110 };

  low = recordResult(low, result("L-1", "player-bbbbbb", ["player-aaaaaa"]))!.profile;
  assert.equal(low.rating, 100);
}

// --- days ------------------------------------------------------------------------------------------------
{
  const day = (d: number) => Date.UTC(2026, 10, d, 12);
  let me = newProfile("player-aaaaaa", "secret-aaaaaa", "Amina", day(1));
  const first = touchDay(me, day(1));

  assert.equal(first.bonus, 10);
  assert.equal(first.profile.dayStreak, 1);
  assert.equal(touchDay(first.profile, day(1)).bonus, 0, "once a day");

  me = touchDay(first.profile, day(2)).profile;
  assert.equal(me.dayStreak, 2);
  me = touchDay(me, day(3)).profile;
  assert.equal(me.dayStreak, 3);
  assert.ok(me.achievements.includes("daily-3"));
  assert.equal(touchDay(me, day(6)).profile.dayStreak, 1, "a missed day starts again");
  assert.equal(me.xp, 30, "a bonus of 10 on each of the three days");
}

// --- what a device sends is cleaned -----------------------------------------------------------------------------
{
  const base = newProfile("player-aaaaaa", "secret-aaaaaa", "Amina", 1);
  const adopted = adoptBackup(base, {
    avatar: "💩",
    history: [{ at: 1, mode: "online", rank: 1, rating: 5, size: 2, with: [], won: true, xp: 45 }, "junk", null],
    name: "   Paul\u0007  the great and powerful ",
    rating: 99999,
    stats: { modes: { online: { played: 4, wins: 3 } }, played: 10, wins: -5, bestStreak: "x" },
    xp: 1e12,
  });

  assert.equal(adopted.avatar, "😀", "unknown faces are refused");
  assert.equal(adopted.name, "Paul the great a", "cleaned and cut to 16 letters");
  assert.equal(adopted.rating, 5000);
  assert.equal(adopted.xp, 10_000_000);
  assert.equal(adopted.stats.played, 10);
  assert.equal(adopted.stats.wins, 0);
  assert.equal(adopted.stats.bestStreak, 0);
  assert.equal(adopted.stats.modes.online.wins, 3);
  assert.equal(adopted.history.length, 1);
  assert.equal(adoptBackup(base, "nope"), base);

  assert.deepEqual(cleanPrefs(null), DEFAULT_PREFS);
  assert.deepEqual(cleanPrefs({ board: "ocean", back: "gold", deck: "four", font: "bungee", lite: true, boardHue: 999, face: "evil", pattern: "x" }), {
    ...DEFAULT_PREFS,
    back: "gold",
    board: "ocean",
    boardHue: 360,
    deck: "four",
    font: "bungee",
    lite: true,
  });
  assert.equal(cleanPrefs({ board: "custom", boardHue: 200 }).board, "custom");
}

// --- the profile service ---------------------------------------------------------------------------------------------
async function main() {
  useProfileStore(createMemoryProfileStore());

  const A = { id: "device-aaaaaaaa", secret: "secret-aaaaaaaa" };
  const B = { id: "device-bbbbbbbb", secret: "secret-bbbbbbbb" };

  // a new device
  const made = await hello({ ...A, name: "  Amina  " });

  assert.ok(made.ok && made.created);
  assert.equal(made.ok && made.profile.name, "Amina");
  assert.equal(made.ok && made.bonus, 10, "the first visit pays the daily bonus");
  assert.ok(made.ok && !("secret" in made.profile), "the secret is never sent back");
  assert.ok(made.ok && !("recent" in made.profile));

  const again = await hello({ ...A, name: "Someone else" });

  assert.ok(again.ok && !again.created && again.bonus === 0);
  assert.equal(again.ok && again.profile.name, "Amina", "the name chosen first is kept");

  // another device cannot take this profile over
  const thief = await hello({ id: A.id, secret: "secret-wrongwrong" });

  assert.ok(!thief.ok && thief.fatal === true);
  assert.equal((await hello({ id: "x", secret: "y" })).ok, false);
  assert.equal((await hello({ id: A.id, secret: undefined })).ok, false);

  // a server that lost its data takes what the device remembers
  const restored = await hello({
    ...B,
    backup: { avatar: "🦁", name: "Paul", stats: { played: 12, wins: 7 }, xp: 500 },
    name: "Paul",
  });

  assert.ok(restored.ok && restored.created);
  assert.equal(restored.ok && restored.profile.stats.wins, 7);
  assert.equal(restored.ok && restored.profile.avatar, "🦁");
  assert.equal(restored.ok && restored.profile.xp, 510, "500 remembered + the daily bonus");

  // changing the profile needs the secret
  assert.equal((await updateProfile({ ...A, patch: { name: "Hacked" }, secret: "secret-wrongwrong" })).ok, false);

  const changed = await updateProfile({ ...A, patch: { avatar: "🦄", name: "  Amina B  ", prefs: { board: "ruby", face: "neon", junk: 1 } } });

  assert.ok(changed.ok);
  assert.equal(changed.ok && changed.profile.name, "Amina B");
  assert.equal(changed.ok && changed.profile.avatar, "🦄");
  assert.equal(changed.ok && changed.profile.prefs?.board, "ruby");
  assert.equal(changed.ok && changed.profile.prefs?.face, "neon");
  assert.ok(changed.ok && changed.profile.prefs && !("junk" in changed.profile.prefs));
  assert.equal((await updateProfile({ ...A, patch: { avatar: "💩" } })).ok && true, true);
  assert.equal(((await hello(A)) as { profile: { avatar: string } }).profile.avatar, "😀", "a bad face falls back");

  // who is at the table
  const seat = await resolveIdentity(A);

  assert.ok(seat);
  assert.equal(seat.name, "Amina B");
  assert.equal(seat.identity.profileId, A.id);
  assert.equal(await resolveIdentity({ id: A.id, secret: "secret-wrongwrong" }), null, "a wrong secret is a guest");
  assert.equal(await resolveIdentity({ id: undefined, secret: undefined }), null);
  assert.ok(await resolveIdentity({ id: "device-cccccccc", secret: "secret-cccccccc" }), "an unknown device gets a profile");

  // a finished set is counted once for everybody
  const set = result("ROOM-1", A.id, [B.id]);
  const counted = await applyResults(set);

  assert.equal(counted.length, 2);
  assert.equal(counted.find((c) => c.profile.id === A.id)?.gain.xp, 45);
  assert.deepEqual(await applyResults(set), [], "never twice");

  const a = ((await hello(A)) as { profile: { stats: { wins: number }; xp: number } }).profile;
  const b = ((await hello(B)) as { profile: { stats: { losses: number } } }).profile;

  assert.equal(a.stats.wins, 1);
  assert.equal(b.stats.losses, 1 + 0);

  // the best players
  const board = await leaderboard(10);

  assert.equal(board[0].id, B.id, "Paul has the most XP");
  assert.ok(board.every((entry, i) => i === 0 || board[i - 1].xp >= entry.xp));
  assert.ok(board.every((entry) => !("secret" in entry)));
  assert.ok(board[0].level >= 1);
  assert.equal((await leaderboard(1)).length, 1);

  useProfileStore(null);
  console.log("All profile checks passed.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
