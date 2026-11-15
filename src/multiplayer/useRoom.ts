"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Creds, postAction } from "./api";
import type { ClientAction, RoomView } from "./protocol";

export type UseRoom = {
  /** True while the connection to the game is working. */
  connected: boolean;
  /** Set when the room is gone or you were removed. The connection stops. */
  fatal: string | null;
  /** Do something. Resolves to an error message, or null if it worked. */
  send: (action: ClientAction) => Promise<string | null>;
  view: RoomView | null;
};

/** How often to ask while a game is on and a bot or a person is about to move. */
const PLAYING_MS = 900;
/** How often to ask when a bot is up (it moves as soon as it is asked). */
const BOT_MS = 600;
/** Lobby and results change rarely. */
const CALM_MS = 1500;
/** A page in a background tab only needs to say "still here". */
const HIDDEN_MS = 5000;
/** A request that has not answered by now is given up and repeated. */
const REQUEST_TIMEOUT_MS = 8000;
/** After a failure, wait a little longer each time, up to this. */
const MAX_BACKOFF_MS = 4000;

function pace(view: RoomView | null, hidden: boolean) {
  if (hidden) {
    return HIDDEN_MS;
  }

  if (!view || view.phase !== "playing" || !view.game || view.game.over) {
    return CALM_MS;
  }

  const current = view.seats.find((seat) => seat.id === view.game?.currentSeatId);

  return current?.kind === "bot" ? BOT_MS : PLAYING_MS;
}

/**
 * Keeps a view of one room by asking the server for it every moment, and lets
 * the player act in it.
 *
 * Asking (rather than keeping a stream open) is deliberate: it works the same
 * on every network and on serverless hosting like Vercel, where a connection
 * cannot be kept open. A request that fails is simply repeated; only "this
 * game no longer exists" or "you were removed" stops it.
 */
export function useRoom(code: string, creds: Creds | null): UseRoom {
  const [view, setView] = useState<RoomView | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  // Ask again right now (after the player did something).
  const askNow = useRef<(() => void) | null>(null);

  const seatId = creds?.seatId ?? null;
  const token = creds?.token ?? null;

  useEffect(() => {
    if (!seatId || !token) {
      return;
    }

    setFatal(null);

    let stopped = false;
    let inFlight = false;
    let again = false;
    let failures = 0;
    let etag = "";
    let latest: RoomView | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const query = `seat=${encodeURIComponent(seatId)}&token=${encodeURIComponent(token)}`;
    const isHidden = () => typeof document !== "undefined" && document.hidden;

    function accept(next: RoomView) {
      // Ignore an update that arrives late and is older than what we show.
      if (latest && latest.version > next.version) {
        return;
      }

      latest = next;
      setView(next);
    }

    function halt(reason: string) {
      stopped = true;
      setFatal(reason);
      setConnected(false);

      if (timer) clearTimeout(timer);
    }

    function later(ms: number) {
      if (stopped) {
        return;
      }

      if (timer) clearTimeout(timer);

      timer = setTimeout(() => void ask(), ms);
    }

    async function ask() {
      if (stopped) {
        return;
      }

      if (inFlight) {
        again = true;

        return;
      }

      inFlight = true;
      again = false;

      const controller = new AbortController();
      const giveUp = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(
          `/api/rooms/${encodeURIComponent(code)}/state?${query}&since=${encodeURIComponent(etag)}`,
          { cache: "no-store", signal: controller.signal },
        );
        let body: {
          error?: string;
          etag?: string;
          fatal?: boolean;
          view?: RoomView | null;
        } | null = null;

        try {
          body = await response.json();
        } catch {
          // not JSON (a gateway error page, say): treated as a hiccup
        }

        if (stopped) {
          return;
        }

        if (body?.fatal) {
          halt(body.error ?? "The connection to this game was closed.");

          return;
        }

        if (!response.ok || !body) {
          throw new Error("hiccup");
        }

        failures = 0;
        setConnected(true);

        if (typeof body.etag === "string") {
          etag = body.etag;
        }

        if (body.view) {
          accept(body.view);
        }
      } catch {
        if (!stopped) {
          failures += 1;
          setConnected(false);
        }
      } finally {
        clearTimeout(giveUp);
        inFlight = false;
      }

      if (stopped) {
        return;
      }

      const wait =
        failures > 0
          ? Math.min(MAX_BACKOFF_MS, 500 * 2 ** (failures - 1))
          : again
            ? 0
            : pace(latest, isHidden());

      later(wait);
    }

    askNow.current = () => void ask();

    const onVisible = () => {
      if (!document.hidden) {
        void ask();
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    void ask();

    return () => {
      stopped = true;
      askNow.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);

      if (timer) clearTimeout(timer);

      setConnected(false);
    };
  }, [code, seatId, token]);

  const send = useCallback(
    async (action: ClientAction): Promise<string | null> => {
      if (!seatId || !token) {
        return "You are not in this game.";
      }

      const error = await postAction(code, { seatId, token }, action);

      // Show what just happened without waiting for the next round of asking.
      askNow.current?.();

      return error;
    },
    [code, seatId, token],
  );

  return { connected, fatal, send, view };
}
