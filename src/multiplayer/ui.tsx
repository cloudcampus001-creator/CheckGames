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
      <span className="text-white/80">{label}</span>
      <div className="flex items-center gap-3">
        <button
          aria-label={`Fewer: ${label}`}
          className="size-9 rounded-full bg-white/10 text-lg hover:bg-white/20 disabled:opacity-30"
          disabled={disabled || value <= min}
          onClick={() => onChange(value - 1)}
          type="button"
        >
          −
        </button>
        <span
          className={cn(
            "w-8 text-center font-semibold text-xl tabular-nums",
            disabled && "text-white/70",
          )}
        >
          {value}
        </span>
        <button
          aria-label={`More: ${label}`}
          className="size-9 rounded-full bg-white/10 text-lg hover:bg-white/20 disabled:opacity-30"
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
    <div className="flex min-h-screen items-center justify-center bg-emerald-950 p-6 text-white">
      <div className="w-full max-w-md space-y-5">{children}</div>
    </div>
  );
}

export const primaryButton =
  "rounded-full bg-amber-300 px-6 py-3 font-semibold text-emerald-950 transition-opacity hover:opacity-90 disabled:opacity-40";

export const quietButton =
  "rounded-full bg-white/10 px-5 py-2 text-sm hover:bg-white/20 disabled:opacity-40";

export const inputClass =
  "w-full rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-white placeholder:text-white/40 focus:border-amber-300 focus:outline-none";
