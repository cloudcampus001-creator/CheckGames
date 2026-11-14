"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  createRoomRequest,
  joinRoomRequest,
  loadName,
  postAction,
  saveCreds,
  saveName,
} from "./api";
import { inputClass, primaryButton, quietButton, Shell } from "./ui";

export function HomeScreen() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(loadName());
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
      <div className="space-y-1 text-center">
        <h1 className="font-bold text-4xl tracking-wide">Cheque-games</h1>
        <p className="text-white/70">Finish your cards. Say check. Win.</p>
      </div>

      <label className="block space-y-2">
        <span className="text-sm text-white/70">Your name</span>
        <input
          autoComplete="nickname"
          className={inputClass}
          maxLength={16}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Amina"
          value={name}
        />
      </label>

      <section className="space-y-3 rounded-2xl bg-white/5 p-5">
        <h2 className="font-semibold text-lg">Start a game</h2>
        <p className="text-sm text-white/70">
          You get a code to share. You choose the rules and add computer
          players.
        </p>
        <button
          className={`${primaryButton} w-full`}
          disabled={busy}
          onClick={createGame}
          type="button"
        >
          Create game
        </button>
      </section>

      <section className="space-y-3 rounded-2xl bg-white/5 p-5">
        <h2 className="font-semibold text-lg">Join a game</h2>
        <input
          aria-label="Game code"
          autoCapitalize="characters"
          autoComplete="off"
          className={`${inputClass} text-center font-semibold text-2xl uppercase tracking-[0.4em]`}
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
          className={`${primaryButton} w-full`}
          disabled={busy || !canJoin}
          onClick={joinGame}
          type="button"
        >
          Join game
        </button>
      </section>

      {error ? (
        <p className="rounded-xl bg-red-500/20 px-4 py-3 text-center text-red-200 text-sm">
          {error}
        </p>
      ) : null}

      <div className="space-y-2 text-center">
        <p className="text-sm text-white/60">Just want to practise?</p>
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
