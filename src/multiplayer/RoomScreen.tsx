"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  clearCreds,
  type Creds,
  joinRoomRequest,
  loadCreds,
  loadName,
  saveCreds,
  saveName,
} from "./api";
import { Lobby } from "./Lobby";
import { Table } from "./Table";
import { inputClass, primaryButton, quietButton, Shell } from "./ui";
import { useRoom } from "./useRoom";

function JoinForm({
  code,
  onJoined,
}: {
  code: string;
  onJoined: (creds: Creds) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(loadName());
  }, []);

  async function join() {
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
    onJoined(result.creds);
  }

  return (
    <Shell>
      <div className="space-y-3 text-center">
        <h1 className="display text-4xl text-[var(--cream)] [text-shadow:0_4px_0_rgba(0,0,0,0.28)]">
          Join game
        </h1>
        <p className="display mx-auto w-fit rounded-2xl border-[3px] border-amber-300 border-dashed bg-amber-300/15 px-6 py-2 text-6xl text-amber-300 tracking-[0.25em]">
          {code}
        </p>
      </div>
      <input
        aria-label="Your name"
        autoComplete="nickname"
        className={inputClass}
        maxLength={16}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !busy) {
            void join();
          }
        }}
        placeholder="Your name"
        value={name}
      />
      <button
        className={`${primaryButton} w-full text-xl`}
        disabled={busy}
        onClick={join}
        type="button"
      >
        Join
      </button>
      {error ? (
        <p className="pop rounded-2xl border-2 border-rose-300/50 bg-rose-500/30 px-4 py-3 text-center font-semibold text-rose-50 text-sm">
          {error}
        </p>
      ) : null}
      <button
        className={`${quietButton} w-full`}
        onClick={() => router.push("/")}
        type="button"
      >
        Back
      </button>
    </Shell>
  );
}

export function RoomScreen({ code }: { code: string }) {
  const router = useRouter();
  const [creds, setCreds] = useState<Creds | null>(null);
  const [loaded, setLoaded] = useState(false);
  const room = useRoom(code, creds);

  // Saved seats live in this browser, so read them after the page loads.
  useEffect(() => {
    setCreds(loadCreds(code));
    setLoaded(true);
  }, [code]);

  function backToStart() {
    clearCreds(code);
    router.push("/");
  }

  async function leave() {
    await room.send({ type: "leave" });
    backToStart();
  }

  if (!loaded) {
    return (
      <Shell>
        <p className="display text-center text-2xl text-white/80">Loading…</p>
      </Shell>
    );
  }

  if (!creds) {
    return <JoinForm code={code} onJoined={setCreds} />;
  }

  if (room.fatal) {
    return (
      <Shell>
        <p className="panel p-5 text-center font-semibold text-lg">{room.fatal}</p>
        <button
          className={`${primaryButton} w-full`}
          onClick={backToStart}
          type="button"
        >
          Back to start
        </button>
      </Shell>
    );
  }

  if (!room.view) {
    return (
      <Shell>
        <p className="display text-center text-2xl text-white/80">
          Connecting to the game…
        </p>
      </Shell>
    );
  }

  if (room.view.phase === "lobby") {
    return (
      <Lobby
        connected={room.connected}
        onAction={room.send}
        onLeave={leave}
        view={room.view}
      />
    );
  }

  return (
    <Table
      connected={room.connected}
      onAction={room.send}
      onLeave={leave}
      view={room.view}
    />
  );
}
