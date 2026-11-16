"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Creds, postActionFull } from "./api";
import type { ClientAction, RoomView } from "./protocol";
import { realtimeEnabled, rtWatch } from "./rt";

export type UseRoom = {
  /** True while the connection to the game is working. */
  connected: boolean;
  /** Set when the room is gone or you were removed. The connection stops. */
  fatal: string | null;
  /** Do something. Resolves to an error message, or null if it worked. */
  send: (action: ClientAction) => Promise<string | null>;
  view: RoomView | null;
};

/** Asking again after somebody else's move: quick, so their card shows up fast. */
const WATCHING_MS = 550;
/** Asking while it is your own turn (only chat and stickers can arrive). */
const MY_TURN_MS = 1000;
/** Lobby and results change rarely. */
const CALM_MS = 1000;
/** A page in a background tab only needs to say "still here". */
const HIDDEN_MS = 5000;
/** A request that has not answered by now is given up and repeated. */
const REQUEST_TIMEOUT_MS = 8000;
/** After a failure, wait a little longer each time, up to this. */
const MAX_BACKOFF_MS = 4000;
/** Ask a hair after a bot is due, so its move is waiting. */
const BOT_SLACK_MS = 60;
const MIN_WAIT_MS = 120;

function pace(view: RoomView | null, hidden: boolean, ageMs: number) {
  if (hidden) {
    return HIDDEN_MS;
  }

  if (!view || view.phase !== "playing" || !view.game || view.game.over) {
    return CALM_MS;
  }

  const current = view.seats.find((seat) => seat.id === view.game?.currentSeatId);

  // A bot is up: ask exactly when it is due instead of guessing.
  if (current?.kind === "bot" && view.botInMs !== null) {
    return Math.max(MIN_WAIT_MS, view.botInMs - ageMs + BOT_SLACK_MS);
  }

  return current?.id === view.you ? MY_TURN_MS : WATCHING_MS;
}

/**
 * Keeps a view of one room and lets the player act in it.
 *
 * With a realtime server (NEXT_PUBLIC_REALTIME_URL) every change is pushed the
 * instant it happens. Without one, the page asks the server about every half
 * second while somebody else is playing; a failed request is simply repeated,
 * and only "this game no longer exists" or "you were removed" stops it. Either
 * way an action shows its result straight away: over plain requests the answer
 * to the action carries the new view.
 */
export function useRoom(code: string, creds: Creds | null): UseRoom {
  const [view, setView] = useState<RoomView | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  // Ask again right now (plain requests only).
  const askNow = useRef<(() => void) | null>(null);
  // Take in a view that came with an action's answer (plain requests only).
  const take = useRef<((view: RoomView, etag: string | null) => void) | null>(null);

  const seatId = creds?.seatId ?? null;
  const token = creds?.token ?? null;

  useEffect(() => {
    if (!seatId || !token) {
      return;
    }

    setFatal(null);

    let latest: RoomView | null = null;

    function accept(next: RoomView) {
      // Ignore an update that arrives late and is older than what we show.
      if (latest && latest.version > next.version) {
        return;
      }

      latest = next;
      setView(next);
    }

    // --- realtime: the server pushes ---------------------------------------------------
    if (realtimeEnabled) {
      const stop = rtWatch({
        code,
        creds: { seatId, token },
        onFatal: (message) => {
          setFatal(message);
          setConnected(false);
        },
        onStatus: setConnected,
        onView: (next) => {
          setConnected(true);
          accept(next);
        },
      });

      return () => {
        stop();
        setConnected(false);
      };
    }

    // --- plain requests: ask, and ask again -----------------------------------------------
    let stopped = false;
    let inFlight = false;
    let again = false;
    let failures = 0;
    let etag = "";
    let latestAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const query = `seat=${encodeURIComponent(seatId)}&token=${encodeURIComponent(token)}`;
    const isHidden = () => typeof document !== "undefined" && document.hidden;

    function acceptAt(next: RoomView) {
      accept(next);
      latestAt = Date.now();
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
          acceptAt(body.view);
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
            : pace(latest, isHidden(), Date.now() - latestAt);

      later(wait);
    }

    askNow.current = () => void ask();
    take.current = (next, nextEtag) => {
      if (stopped) {
        return;
      }

      acceptAt(next);

      if (nextEtag) {
        etag = nextEtag;
      }

      setConnected(true);
      // The next question is timed from this fresh view.
      later(pace(next, isHidden(), 0));
    };

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
      take.current = null;
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

      const result = await postActionFull(code, { seatId, token }, action);

      if (result.fatal) {
        setFatal(result.error ?? "The connection to this game was closed.");
      } else if (result.view) {
        // The answer already holds what the move did: show it now.
        take.current?.(result.view, result.etag);
      } else if (!realtimeEnabled) {
        askNow.current?.();
      }

      return result.error;
    },
    [code, seatId, token],
  );

  return { connected, fatal, send, view };
}
