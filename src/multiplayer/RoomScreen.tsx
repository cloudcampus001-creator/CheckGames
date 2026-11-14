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
      <div className="space-y-1 text-center">
        <h1 className="font-bold text-3xl">Join game</h1>
        <p className="font-bold text-5xl tracking-[0.3em]">{code}</p>
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
        className={`${primaryButton} w-full`}
        disabled={busy}
        onClick={join}
        type="button"
      >
        Join
      </button>
      {error ? (
        <p className="rounded-xl bg-red-500/20 px-4 py-3 text-center text-red-200 text-sm">
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
        <p className="text-center text-white/70">Loading…</p>
      </Shell>
    );
  }

  if (!creds) {
    return <JoinForm code={code} onJoined={setCreds} />;
  }

  if (room.fatal) {
    return (
      <Shell>
        <p className="text-center text-lg">{room.fatal}</p>
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
        <p className="text-center text-white/70">Connecting to the game…</p>
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
