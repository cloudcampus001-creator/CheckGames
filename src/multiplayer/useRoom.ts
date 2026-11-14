"use client";

import { useCallback, useEffect, useState } from "react";
import { type Creds, postAction } from "./api";
import type { ClientAction, RoomView } from "./protocol";

export type UseRoom = {
  /** True while the live connection is open. */
  connected: boolean;
  /** Set when the room is gone or you were removed. The connection stops. */
  fatal: string | null;
  /** Do something. Resolves to an error message, or null if it worked. */
  send: (action: ClientAction) => Promise<string | null>;
  view: RoomView | null;
};

/** Keeps a live view of one room and lets the player act in it. */
export function useRoom(code: string, creds: Creds | null): UseRoom {
  const [view, setView] = useState<RoomView | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const seatId = creds?.seatId ?? null;
  const token = creds?.token ?? null;

  useEffect(() => {
    if (!seatId || !token) {
      return;
    }

    setFatal(null);

    const source = new EventSource(
      `/api/rooms/${encodeURIComponent(code)}/events?seat=${encodeURIComponent(seatId)}&token=${encodeURIComponent(token)}`,
    );

    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("state", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as RoomView;

      // Ignore an update that arrives late and is older than what we show.
      setView((current) =>
        current && current.version > next.version ? current : next,
      );
    });
    source.addEventListener("fatal", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        reason?: string;
      };

      setFatal(data.reason ?? "The connection to this game was closed.");
      setConnected(false);
      source.close();
    });

    return () => {
      source.close();
      setConnected(false);
    };
  }, [code, seatId, token]);

  const send = useCallback(
    async (action: ClientAction): Promise<string | null> => {
      if (!seatId || !token) {
        return "You are not in this game.";
      }

      return postAction(code, { seatId, token }, action);
    },
    [code, seatId, token],
  );

  return { connected, fatal, send, view };
}
