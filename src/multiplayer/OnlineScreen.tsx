"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/helpers/classname-helper";
import { ConnectionBanner } from "./ConnectionBanner";
import { refreshProfile } from "./identity";
import { ProfileBar } from "./ProfileBar";
import { useMatchmaking } from "./useMatchmaking";
import { primaryButton, quietButton, Shell } from "./ui";

const KEY = "cheque-games:match-wants";
const SIZES = [2, 3, 4, 5, 6];
const CLOCKS: { label: string; value: number | null }[] = [
  { label: "Any", value: null },
  { label: "None", value: 0 },
  { label: "5s", value: 5 },
  { label: "10s", value: 10 },
  { label: "15s", value: 15 },
  { label: "30s", value: 30 },
];

type Wants = { sizes: number[]; turn: number | null; fillBots: boolean };

function loadWants(): Wants {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Wants> | null;

    if (parsed && Array.isArray(parsed.sizes) && parsed.sizes.length > 0) {
      return {
        fillBots: parsed.fillBots !== false,
        sizes: parsed.sizes.filter((n) => SIZES.includes(n)),
        turn: typeof parsed.turn === "number" ? parsed.turn : null,
      };
    }
  } catch {
    // use the defaults
  }

  return { fillBots: true, sizes: [2, 3, 4], turn: null };
}

/** Play against real people: say what you like, and the game sets the table up. */
export function OnlineScreen() {
  const router = useRouter();
  const { cancel, search, start } = useMatchmaking();
  const [wants, setWants] = useState<Wants>({ fillBots: true, sizes: [2, 3, 4], turn: null });
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    setWants(loadWants());
    void refreshProfile();
  }, []);

  // Count the seconds of the search on this screen.
  useEffect(() => {
    if (search.state !== "searching") {
      setElapsed(0);

      return;
    }

    const began = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - began) / 1000)), 500);

    return () => clearInterval(timer);
  }, [search.state]);

  // A table was made: go to it.
  useEffect(() => {
    if (search.state === "matched") {
      const timer = setTimeout(() => router.push(`/room/${search.code}`), 900);

      return () => clearTimeout(timer);
    }
  }, [search, router]);

  function change(next: Partial<Wants>) {
    const merged = { ...wants, ...next };

    setWants(merged);

    try {
      localStorage.setItem(KEY, JSON.stringify(merged));
    } catch {
      // not important
    }
  }

  function toggleSize(size: number) {
    const has = wants.sizes.includes(size);
    const sizes = has ? wants.sizes.filter((n) => n !== size) : [...wants.sizes, size].sort();

    if (sizes.length > 0) {
      change({ sizes });
    }
  }

  const searching = search.state === "searching";
  const seconds = searching ? Math.max(elapsed, Math.floor(search.waitedMs / 1000)) : 0;

  return (
    <Shell>
      <div className="space-y-1 text-center">
        <h1 className="display text-5xl text-[var(--cream)] [text-shadow:0_5px_0_rgba(0,0,0,0.28)]">
          Play online
        </h1>
        <p className="font-bold text-amber-200">Real players, a fair table, set up for you.</p>
      </div>

      <ProfileBar />
      <ConnectionBanner onRetry={() => void refreshProfile()} />

      {search.state === "matched" ? (
        <section className="panel pop space-y-2 p-8 text-center" data-match="found">
          <p className="display text-5xl text-amber-300">Match found!</p>
          <p className="text-white/80">Taking you to the table…</p>
        </section>
      ) : searching ? (
        <section className="panel space-y-4 p-6 text-center" data-match="searching">
          <div className="relative mx-auto grid size-40 place-items-center">
            {[0, 0.8, 1.6].map((delay) => (
              <span
                aria-hidden="true"
                className="radar-ring absolute inset-0 rounded-full border-4 border-amber-300"
                key={delay}
                style={{ animationDelay: `${delay}s` }}
              />
            ))}
            <span className="display relative text-5xl text-amber-300">{seconds}s</span>
          </div>
          <p className="display text-2xl">Looking for players…</p>
          <p className="text-sm text-white/70">
            {search.searching} {search.searching === 1 ? "player is" : "players are"} searching.
            We match you with players of a similar level, and look wider the longer you wait.
          </p>
          {wants.fillBots ? (
            <p className="text-white/60 text-xs">
              If nobody turns up in about 20 seconds you will play against the computer instead.
            </p>
          ) : null}
          <button className={`${quietButton} w-full`} onClick={() => void cancel()} type="button">
            Cancel
          </button>
        </section>
      ) : (
        <>
          <section className="panel space-y-4 p-5">
            <div className="space-y-2">
              <p className="display text-xl">Table size</p>
              <div className="flex flex-wrap gap-2">
                {SIZES.map((size) => (
                  <button
                    aria-pressed={wants.sizes.includes(size)}
                    className={cn(
                      "display grid size-12 place-items-center rounded-2xl text-xl transition-transform active:scale-95",
                      wants.sizes.includes(size)
                        ? "bg-amber-300 text-emerald-950 shadow-[0_4px_0_#b87d00]"
                        : "bg-white/10 shadow-[0_4px_0_rgba(0,0,0,0.2)]",
                    )}
                    key={size}
                    onClick={() => toggleSize(size)}
                    type="button"
                  >
                    {size}
                  </button>
                ))}
              </div>
              <p className="text-white/55 text-xs">
                Pick the sizes you like. Bigger tables are filled first.
              </p>
            </div>

            <div className="space-y-2">
              <p className="display text-xl">Time to play a card</p>
              <div className="flex flex-wrap gap-2">
                {CLOCKS.map((clock) => (
                  <button
                    aria-pressed={wants.turn === clock.value}
                    className={cn(
                      "btn px-4 py-2.5 text-base",
                      wants.turn === clock.value ? "btn-gold" : "btn-soft",
                    )}
                    key={clock.label}
                    onClick={() => change({ turn: clock.value })}
                    type="button"
                  >
                    {clock.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block font-semibold text-white/90">Play the computer if nobody comes</span>
                <span className="block text-white/55 text-xs">After about 20 seconds.</span>
              </span>
              <input
                checked={wants.fillBots}
                className="size-6 accent-amber-300"
                onChange={(event) => change({ fillBots: event.target.checked })}
                type="checkbox"
              />
            </label>
          </section>

          {search.state === "error" ? (
            <p className="pop rounded-2xl border-2 border-rose-300/50 bg-rose-500/30 px-4 py-3 text-center font-semibold text-rose-50 text-sm">
              {search.error}
            </p>
          ) : null}

          <button
            className={`${primaryButton} w-full text-2xl`}
            data-action="find-match"
            onClick={() => void start(wants)}
            type="button"
          >
            Find a match
          </button>
          <button className={`${quietButton} w-full`} onClick={() => router.push("/")} type="button">
            Back
          </button>
        </>
      )}
    </Shell>
  );
}
