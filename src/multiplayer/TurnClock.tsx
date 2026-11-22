"use client";

import { cn } from "@/helpers/classname-helper";
import { TIMER_WARNING_SECONDS } from "./protocol";
import { buzz, playSfx } from "./sound";
import { useCountdown } from "./useCountdown";
import { useEffect } from "react";

/**
 * The clock of the player whose turn it is: a bar that runs down under the top
 * bar and, in the last seconds, big numbers counted out on the screen. It keeps
 * its own count, so the table is not redrawn every quarter of a second.
 */
export function TurnClock({
  endsInMs,
  mine,
  name,
  resetKey,
  totalSeconds,
}: {
  endsInMs: number | null;
  mine: boolean;
  name: string;
  /** A new value starts the count again from `endsInMs`. */
  resetKey: unknown;
  totalSeconds: number;
}) {
  const left = useCountdown(endsInMs, resetKey);
  const seconds = left === null ? null : Math.ceil(left / 1000);
  const warning = seconds !== null && seconds >= 1 && seconds <= TIMER_WARNING_SECONDS;

  // A tick for every counted second (and a buzz on your own phone).
  useEffect(() => {
    if (warning) {
      playSfx("tick");

      if (mine) {
        buzz(25);
      }
    }
  }, [warning, seconds, mine]);

  if (endsInMs === null || totalSeconds <= 0 || left === null || seconds === null) {
    return null;
  }

  const percent = Math.min(100, Math.max(0, (left / (totalSeconds * 1000)) * 100));

  return (
    <>
      <div className="mx-4 flex items-center gap-3" data-turn-clock>
        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-black/25">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300 ease-linear",
              warning ? "bg-rose-400" : "bg-amber-300",
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="display w-24 shrink-0 text-right text-sm tabular-nums">
          {mine ? "You" : name} · {seconds}s
        </span>
      </div>
      {warning ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[250] flex items-center justify-center"
          data-countdown={seconds}
        >
          <span
            className={cn(
              "display count-pop text-[11rem] leading-none [text-shadow:0_8px_0_rgba(0,0,0,0.35)]",
              mine ? "text-amber-300" : "text-white",
            )}
            key={seconds}
          >
            {seconds}
          </span>
        </div>
      ) : null}
    </>
  );
}
