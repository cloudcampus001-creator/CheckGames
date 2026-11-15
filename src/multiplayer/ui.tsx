"use client";

import type { ReactNode } from "react";
import { cn } from "@/helpers/classname-helper";

/** Copy text. Falls back for plain http pages, where the clipboard API is off. */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);

      return true;
    }
  } catch {
    // fall through to the old way
  }

  try {
    const area = document.createElement("textarea");

    area.value = text;
    area.style.opacity = "0";
    area.style.position = "fixed";
    document.body.appendChild(area);
    area.select();

    const ok = document.execCommand("copy");

    document.body.removeChild(area);

    return ok;
  } catch {
    return false;
  }
}

const roundButton =
  "display grid size-11 place-items-center rounded-full bg-white/15 text-2xl leading-none shadow-[0_3px_0_rgba(0,0,0,0.25)] transition-transform hover:bg-white/25 active:translate-y-[3px] active:shadow-none disabled:opacity-30";

export function Stepper({
  disabled = false,
  label,
  max,
  min,
  onChange,
  value,
}: {
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="font-semibold text-white/90">{label}</span>
      <div className="flex items-center gap-3">
        <button
          aria-label={`Fewer: ${label}`}
          className={roundButton}
          disabled={disabled || value <= min}
          onClick={() => onChange(value - 1)}
          type="button"
        >
          −
        </button>
        <span
          className={cn(
            "display w-10 text-center text-3xl tabular-nums",
            disabled ? "text-white/70" : "text-amber-300",
          )}
        >
          {value}
        </span>
        <button
          aria-label={`More: ${label}`}
          className={roundButton}
          disabled={disabled || value >= max}
          onClick={() => onChange(value + 1)}
          type="button"
        >
          +
        </button>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-5 text-white">
      <div className="w-full max-w-md space-y-5">{children}</div>
    </div>
  );
}

export const primaryButton = "btn btn-gold";

export const skyButton = "btn btn-sky";

export const quietButton = "btn btn-soft";

export const inputClass = "input";
