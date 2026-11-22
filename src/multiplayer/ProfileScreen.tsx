"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PlayingCard } from "@/components/PlayingCard";
import { cn } from "@/helpers/classname-helper";
import { ConnectionBanner } from "./ConnectionBanner";
import { refreshProfile, saveProfile, setPrefs, usePrefs, useProfile } from "./identity";
import { LeaderboardCard } from "./LeaderboardCard";
import {
  ACHIEVEMENTS,
  AVATARS,
  levelInfo,
  type Mode,
  tierFor,
} from "./profile";
import {
  BACKS,
  BODY_FONTS,
  BOARDS,
  DEFAULT_PREFS,
  FACES,
  FONTS,
  PATTERNS,
} from "./prefs";
import { inputClass, primaryButton, quietButton } from "./ui";

const MODE_NAMES: Record<Mode, string> = {
  computer: "🤖 Computer",
  friends: "🤝 Friends",
  online: "🌍 Online",
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl bg-black/20 px-3 py-2.5 text-center">
      <p className="display text-2xl tabular-nums">{value}</p>
      <p className="text-white/60 text-xs">{label}</p>
    </div>
  );
}

const chip = (active: boolean) =>
  cn(
    "btn px-4 py-2 text-sm",
    active ? "btn-gold" : "btn-soft",
  );

/** Your profile: who you are, what you have done, and how the game looks for you. */
export function ProfileScreen() {
  const router = useRouter();
  const { error, loading, profile } = useProfile();
  const prefs = usePrefs();
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void refreshProfile();
  }, []);

  useEffect(() => {
    if (profile && !name) {
      setName(profile.name);
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: only fill the name in once
  }, [profile]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = setTimeout(() => setNotice(null), 2500);

    return () => clearTimeout(timer);
  }, [notice]);

  async function save(patch: { name?: string; avatar?: string }) {
    const failure = await saveProfile(patch);

    setNotice(failure ?? "Saved");
  }

  if (!profile) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6 text-white">
        <div className="w-full max-w-md space-y-4 text-center">
          <p className="display text-2xl text-white/80">{loading ? "Loading your profile…" : "Your profile"}</p>
          {error ? <p className="text-amber-200 text-sm">{error}</p> : null}
          <ConnectionBanner onRetry={() => void refreshProfile()} />
          <button className={quietButton} onClick={() => router.push("/")} type="button">
            Back
          </button>
        </div>
      </div>
    );
  }

  const level = levelInfo(profile.xp);
  const tier = tierFor(profile.rating);
  const stats = profile.stats;
  const winRate = stats.played > 0 ? Math.round((stats.wins / stats.played) * 100) : 0;
  const have = new Set(profile.achievements);

  return (
    <div className="flex min-h-dvh justify-center p-5 text-white">
      <div className="w-full max-w-lg space-y-5 py-3">
        <div className="flex items-center justify-between">
          <h1 className="display text-4xl text-[var(--cream)] [text-shadow:0_4px_0_rgba(0,0,0,0.28)]">
            Profile
          </h1>
          <button className={quietButton} onClick={() => router.push("/")} type="button">
            Back
          </button>
        </div>

        <ConnectionBanner onRetry={() => void refreshProfile()} />

        <section className="panel space-y-4 p-5">
          <div className="flex items-center gap-4">
            <span className="grid size-20 shrink-0 place-items-center rounded-full bg-amber-300 text-5xl shadow-[0_5px_0_#b87d00]">
              {profile.avatar}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="display truncate text-3xl">{profile.name}</p>
              <p className="font-semibold text-sm text-white/75">
                Level {level.level} · {tier.emoji} {tier.name} {profile.rating}
              </p>
              {profile.dayStreak > 0 ? (
                <p className="text-sm text-white/70">🔥 {profile.dayStreak} {profile.dayStreak === 1 ? "day" : "days"} in a row</p>
              ) : null}
            </div>
          </div>
          <div>
            <div className="h-3 overflow-hidden rounded-full bg-black/30">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-300 to-lime-300"
                style={{ width: `${level.pct}%` }}
              />
            </div>
            <p className="mt-1 text-white/65 text-xs">
              {level.into}/{level.needed} XP to level {level.level + 1} · {profile.xp} XP in all
            </p>
          </div>

          <div className="space-y-2">
            <p className="font-bold text-sm text-white/80">Your name</p>
            <div className="flex gap-2">
              <input
                className={inputClass}
                maxLength={16}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              <button
                className={primaryButton}
                disabled={!name.trim() || name.trim() === profile.name}
                onClick={() => void save({ name: name.trim() })}
                type="button"
              >
                Save
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="font-bold text-sm text-white/80">Your face</p>
            <div className="grid grid-cols-5 gap-2">
              {AVATARS.map((avatar) => (
                <button
                  aria-label={`Face ${avatar}`}
                  aria-pressed={profile.avatar === avatar}
                  className={cn(
                    "grid h-12 place-items-center rounded-2xl text-3xl transition-transform active:scale-90",
                    profile.avatar === avatar ? "bg-amber-300 shadow-[0_4px_0_#b87d00]" : "bg-black/20 hover:bg-white/15",
                  )}
                  key={avatar}
                  onClick={() => void save({ avatar })}
                  type="button"
                >
                  {avatar}
                </button>
              ))}
            </div>
          </div>
          {notice ? <p className="pop text-center font-bold text-amber-300 text-sm">{notice}</p> : null}
        </section>

        <section className="panel space-y-3 p-5" data-stats>
          <h2 className="display text-2xl">Stats</h2>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Games" value={stats.played} />
            <Stat label="Wins" value={stats.wins} />
            <Stat label="Losses" value={stats.losses} />
            <Stat label="Win rate" value={`${winRate}%`} />
            <Stat label="Win streak" value={stats.streak} />
            <Stat label="Best streak" value={stats.bestStreak} />
            <Stat label="Cards played" value={stats.cardsPlayed} />
            <Stat label="Cards taken" value={stats.cardsDrawn} />
            <Stat label="Check!" value={stats.checks} />
            <Stat label="7s & jokers" value={stats.attacks} />
            <Stat label="Aces" value={stats.stops} />
            <Stat label="Jacks" value={stats.jacks} />
            <Stat label="Penalty cards" value={stats.penalty} />
            <Stat label="Clock ran out" value={stats.timeouts} />
            <Stat label="Titles" value={stats.champion} />
          </div>
          <div className="space-y-1.5">
            {(Object.keys(MODE_NAMES) as Mode[]).map((mode) => (
              <div className="flex items-center justify-between rounded-2xl bg-black/20 px-4 py-2 text-sm" key={mode}>
                <span className="font-bold">{MODE_NAMES[mode]}</span>
                <span className="text-white/75">
                  {stats.modes[mode].played} played · {stats.modes[mode].wins} won
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel space-y-3 p-5" data-achievements>
          <h2 className="display text-2xl">
            Badges{" "}
            <span className="text-base text-white/60">
              {have.size}/{ACHIEVEMENTS.length}
            </span>
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {ACHIEVEMENTS.map((achievement) => (
              <div
                className={cn(
                  "flex items-center gap-3 rounded-2xl px-3 py-2.5",
                  have.has(achievement.id) ? "bg-amber-300/20" : "bg-black/20 opacity-55",
                )}
                key={achievement.id}
              >
                <span className={cn("text-3xl", !have.has(achievement.id) && "grayscale")}>{achievement.emoji}</span>
                <span className="min-w-0">
                  <span className="block truncate font-bold text-sm">{achievement.name}</span>
                  <span className="block text-white/60 text-xs">{achievement.text}</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel space-y-3 p-5" data-history>
          <h2 className="display text-2xl">Recent games</h2>
          {profile.history.length === 0 ? <p className="text-sm text-white/60">No games yet.</p> : null}
          <ul className="space-y-1.5">
            {profile.history.map((entry) => (
              <li className="flex items-center justify-between gap-3 rounded-2xl bg-black/20 px-3 py-2" key={`${entry.at}-${entry.mode}`}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "display rounded-full px-2.5 py-0.5 text-xs",
                      entry.won ? "bg-lime-300 text-emerald-950" : "bg-white/15",
                    )}
                  >
                    {entry.won ? "WIN" : "LOSS"}
                  </span>
                  <span className="truncate text-sm">
                    {MODE_NAMES[entry.mode]} · {entry.size} players
                    {entry.with.length > 0 ? ` · ${entry.with.join(", ")}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-right text-white/70 text-xs">
                  +{entry.xp} XP{entry.rating !== 0 ? ` · ${entry.rating > 0 ? "+" : ""}${entry.rating}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel space-y-4 p-5" data-customise>
          <h2 className="display text-2xl">Make it yours</h2>

          {/* A live look at the cards: they change as you choose. */}
          <div className="relative mx-auto h-[150px] w-[280px]">
            {(
              [
                { faceDown: true, rank: "A", rotate: -18, shift: -90, suit: "spades" },
                { rank: "A", rotate: -6, shift: -30, suit: "spades" },
                { rank: "K", rotate: 6, shift: 30, suit: "hearts" },
                { rank: "7", rotate: 18, shift: 90, suit: "diamonds" },
                { rank: "J", rotate: 0, shift: 0, suit: "clubs" },
              ] as const
            ).map((card, index) => (
              <div
                className="absolute top-3 left-1/2"
                key={index}
                style={{ marginLeft: card.shift - 38, transform: `rotate(${card.rotate}deg)`, zIndex: index }}
              >
                <PlayingCard
                  className="shadow-[0_6px_14px_rgba(0,0,0,0.35)]"
                  faceDown={"faceDown" in card}
                  rank={card.rank}
                  suit={card.suit}
                  width={76}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <p className="font-bold text-sm text-white/80">Board colour</p>
            <div className="flex flex-wrap gap-2">
              {BOARDS.map((board) => (
                <button
                  aria-label={board.name}
                  aria-pressed={prefs.board === board.id}
                  className={cn(
                    "size-11 rounded-full border-4 transition-transform active:scale-90",
                    prefs.board === board.id ? "border-white" : "border-transparent",
                  )}
                  key={board.id}
                  onClick={() => setPrefs({ board: board.id })}
                  style={{ background: `linear-gradient(135deg, ${board.hi}, ${board.lo})` }}
                  title={board.name}
                  type="button"
                />
              ))}
            </div>
            <label className="flex items-center gap-3 text-sm text-white/75">
              <span className="shrink-0 font-semibold">Your own colour</span>
              <input
                className="w-full accent-amber-300"
                max={360}
                min={0}
                onChange={(event) => setPrefs({ board: "custom", boardHue: Number(event.target.value) })}
                type="range"
                value={prefs.boardHue}
              />
            </label>
          </div>

          <div className="space-y-2">
            <p className="font-bold text-sm text-white/80">Board style</p>
            <div className="flex flex-wrap gap-2">
              {PATTERNS.map((pattern) => (
                <button
                  className={chip(prefs.pattern === pattern.id)}
                  key={pattern.id}
                  onClick={() => setPrefs({ pattern: pattern.id })}
                  type="button"
                >
                  {pattern.name}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="font-bold text-sm text-white/80">Card style</p>
            <div className="flex flex-wrap gap-2">
              {FACES.map((face) => (
                <button
                  aria-label={face.name}
                  aria-pressed={prefs.face === face.id}
                  className={cn(
                    "flex h-14 w-12 flex-col items-center justify-center rounded-xl border-4 text-lg font-bold leading-tight transition-transform active:scale-90",
                    prefs.face === face.id ? "border-amber-300" : "border-transparent",
                  )}
                  key={face.id}
                  onClick={() => setPrefs({ face: face.id })}
                  style={{ background: face.bg }}
                  title={face.name}
                  type="button"
                >
                  <span style={{ color: face.hearts }}>♥</span>
                  <span style={{ color: face.spades }}>♠</span>
                </button>
              ))}
            </div>
            <label className="flex items-center justify-between gap-3 text-sm text-white/80">
              <span>
                <span className="block font-semibold">Four-colour deck</span>
                <span className="block text-white/55 text-xs">Clubs green, diamonds blue: easier to tell apart.</span>
              </span>
              <input
                checked={prefs.deck === "four"}
                className="size-6 accent-amber-300"
                onChange={(event) => setPrefs({ deck: event.target.checked ? "four" : "classic" })}
                type="checkbox"
              />
            </label>
          </div>

          <div className="space-y-2">
            <p className="font-bold text-sm text-white/80">Card back</p>
            <div className="flex flex-wrap gap-2">
              {BACKS.map((back) => (
                <button
                  aria-label={back.name}
                  aria-pressed={prefs.back === back.id}
                  className={cn(
                    "h-14 w-10 rounded-lg border-4 transition-transform active:scale-90",
                    prefs.back === back.id ? "border-amber-300" : "border-white/80",
                  )}
                  key={back.id}
                  onClick={() => setPrefs({ back: back.id })}
                  style={{ backgroundColor: back.color, backgroundImage: back.image, backgroundSize: back.size }}
                  title={back.name}
                  type="button"
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="font-bold text-sm text-white/80">Title font</p>
            <div className="flex flex-wrap gap-2">
              {FONTS.map((font) => (
                <button
                  className={chip(prefs.font === font.id)}
                  key={font.id}
                  onClick={() => setPrefs({ font: font.id })}
                  style={{ fontFamily: `var(--f-${font.id})` }}
                  type="button"
                >
                  {font.name}
                </button>
              ))}
            </div>
            <p className="font-bold text-sm text-white/80">Text font</p>
            <div className="flex flex-wrap gap-2">
              {BODY_FONTS.map((font) => (
                <button
                  className={chip(prefs.bodyFont === font.id)}
                  key={font.id}
                  onClick={() => setPrefs({ bodyFont: font.id })}
                  style={{ fontFamily: `var(--f-${font.id})` }}
                  type="button"
                >
                  {font.name}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center justify-between gap-3 text-sm text-white/80">
            <span>
              <span className="block font-semibold">Fewer effects</span>
              <span className="block text-white/55 text-xs">Switches off confetti and extra animations on a slow phone.</span>
            </span>
            <input
              checked={prefs.lite}
              className="size-6 accent-amber-300"
              onChange={(event) => setPrefs({ lite: event.target.checked })}
              type="checkbox"
            />
          </label>

          <button className={`${quietButton} w-full`} onClick={() => setPrefs(DEFAULT_PREFS)} type="button">
            Back to the original look
          </button>
        </section>

        <LeaderboardCard />
      </div>
    </div>
  );
}
