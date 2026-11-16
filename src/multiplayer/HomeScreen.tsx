"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PlayingCard } from "@/components/PlayingCard";
import {
  createRoomRequest,
  joinRoomRequest,
  loadName,
  postAction,
  saveCreds,
  saveName,
} from "./api";
import { realtimeEnabled } from "./rt";
import { inputClass, primaryButton, quietButton, Shell, skyButton } from "./ui";

/** Three cards dealt onto the page when it opens. Pure CSS, no scripts. */
function Hero() {
  const cards = [
    { delay: "0s", rank: "A", rotate: "-16deg", shift: "-62px", suit: "spades" },
    { delay: "0.12s", rank: "K", rotate: "0deg", shift: "0px", suit: "hearts" },
    { delay: "0.24s", rank: "7", rotate: "16deg", shift: "62px", suit: "diamonds" },
  ] as const;

  return (
    <div className="relative mx-auto h-[150px] w-[260px]">
      {cards.map((card) => (
        <div
          className="absolute top-2 left-1/2"
          key={card.rank}
          style={{
            animation: `deal 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.15) ${card.delay} both`,
            ["--r" as string]: card.rotate,
            marginLeft: `calc(${card.shift} - 42px)`,
          }}
        >
          <PlayingCard
            className="shadow-[0_8px_18px_rgba(0,0,0,0.35)]"
            rank={card.rank}
            suit={card.suit}
            width={84}
          />
        </div>
      ))}
    </div>
  );
}

export function HomeScreen() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server cannot keep games safely (see /api/health).
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  useEffect(() => {
    setName(loadName());
  }, []);

  useEffect(() => {
    // With the realtime server the games live there, not in the website's storage.
    if (realtimeEnabled) {
      return;
    }

    let cancelled = false;

    fetch("/api/health", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { error?: string; warning?: string | null }) => {
        if (!cancelled) {
          setStorageWarning(body.warning ?? body.error ?? null);
        }
      })
      .catch(() => {
        // the check itself is optional
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function createGame() {
    setBusy(true);
    setError(null);
    saveName(name);

    const result = await createRoomRequest(name);

    if (!result.ok) {
      setError(result.error);
      setBusy(false);

      return;
    }

    saveCreds(result.code, result.creds);
    router.push(`/room/${result.code}`);
  }

  /** A normal game with two bots, started straight away. */
  async function practise() {
    setBusy(true);
    setError(null);
    saveName(name);

    const result = await createRoomRequest(name);

    if (!result.ok) {
      setError(result.error);
      setBusy(false);

      return;
    }

    saveCreds(result.code, result.creds);

    for (const action of [
      { type: "addBot" },
      { type: "addBot" },
      { type: "start" },
    ] as const) {
      const failure = await postAction(result.code, result.creds, action);

      if (failure) {
        setError(failure);
        setBusy(false);

        return;
      }
    }

    router.push(`/room/${result.code}`);
  }

  async function joinGame() {
    setBusy(true);
    setError(null);
    saveName(name);

    const result = await joinRoomRequest(code, name);

    if (!result.ok) {
      setError(result.error);
      setBusy(false);

      return;
    }

    saveCreds(result.code, result.creds);
    router.push(`/room/${result.code}`);
  }

  const canJoin = code.trim().length === 4;

  return (
    <Shell>
      <div className="space-y-2 text-center">
        <Hero />
        <h1 className="display text-6xl text-[var(--cream)] [text-shadow:0_5px_0_rgba(0,0,0,0.28)]">
          Cheque-games
        </h1>
        <p className="font-bold text-lg text-amber-200">
          Finish your cards. Say check. Win.
        </p>
      </div>

      <label className="block space-y-2">
        <span className="font-bold text-sm text-white/80">Your name</span>
        <input
          autoComplete="nickname"
          className={inputClass}
          maxLength={16}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Amina"
          value={name}
        />
      </label>

      <section className="panel space-y-3 p-5">
        <h2 className="display text-2xl">Start a game</h2>
        <p className="text-sm text-white/75">
          You get a code to share. You choose the rules and add computer
          players.
        </p>
        <button
          className={`${primaryButton} w-full text-xl`}
          disabled={busy}
          onClick={createGame}
          type="button"
        >
          Create game
        </button>
      </section>

      <section className="panel space-y-3 p-5">
        <h2 className="display text-2xl">Join a game</h2>
        <input
          aria-label="Game code"
          autoCapitalize="characters"
          autoComplete="off"
          className={`${inputClass} display text-center text-4xl uppercase tracking-[0.35em]`}
          maxLength={4}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canJoin && !busy) {
              void joinGame();
            }
          }}
          placeholder="CODE"
          value={code}
        />
        <button
          className={`${skyButton} w-full text-xl`}
          disabled={busy || !canJoin}
          onClick={joinGame}
          type="button"
        >
          Join game
        </button>
      </section>

      {storageWarning ? (
        <p
          className="rounded-2xl border-2 border-amber-300/50 bg-amber-300/20 px-4 py-3 text-center font-semibold text-amber-100 text-sm"
          data-storage-warning
        >
          {storageWarning}
        </p>
      ) : null}

      {error ? (
        <p className="pop rounded-2xl border-2 border-rose-300/50 bg-rose-500/30 px-4 py-3 text-center font-semibold text-rose-50 text-sm">
          {error}
        </p>
      ) : null}

      <div className="space-y-2 text-center">
        <p className="font-semibold text-sm text-white/70">Just want to practise?</p>
        <button
          className={quietButton}
          disabled={busy}
          onClick={practise}
          type="button"
        >
          Play against 2 bots
        </button>
      </div>
    </Shell>
  );
}
