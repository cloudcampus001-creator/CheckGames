"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { onRtState, realtimeEnabled, rtState, type RtState } from "./rt";

/**
 * Says what is going on when the game server is slow or cannot be reached (a
 * free server that was asleep takes a while to wake up), instead of leaving a
 * silent screen. Only shown after a moment, so a normal connection never flashes it.
 */
export function ConnectionBanner({ onRetry }: { onRetry?: () => void }) {
  const state = useSyncExternalStore<RtState>(
    (listener) => onRtState(listener),
    rtState,
    () => "ready",
  );
  const [late, setLate] = useState(false);

  useEffect(() => {
    if (state === "ready") {
      setLate(false);

      return;
    }

    const timer = setTimeout(() => setLate(true), 1800);

    return () => clearTimeout(timer);
  }, [state]);

  if (!realtimeEnabled || state === "ready" || !late) {
    return null;
  }

  return (
    <div
      className="pop rounded-2xl border-2 border-amber-300/50 bg-amber-300/20 px-4 py-3 text-center font-semibold text-amber-100 text-sm"
      data-connection={state}
      role="status"
    >
      {state === "down"
        ? "Cannot reach the game server. Retrying…"
        : "Waking up the game server… the first time can take up to a minute."}
      {state === "down" && onRetry ? (
        <button className="btn btn-soft mt-2 w-full" onClick={onRetry} type="button">
          Try again
        </button>
      ) : null}
    </div>
  );
}
