"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/helpers/classname-helper";
import { dockButton } from "./Dock";
import { REACTIONS, type ReactionEvent } from "./protocol";
import { playSfx } from "./sound";

/** "GG!", "WOW!"... are drawn as a badge; everything else is an emoji. */
export const isWord = (sticker: string) => /^[A-Z!]+$/.test(sticker);

const BADGES = [
  "bg-amber-300 text-emerald-950",
  "bg-rose-500 text-white",
  "bg-sky-300 text-emerald-950",
  "bg-lime-300 text-emerald-950",
];

/** The button that opens the sticker tray. */
export function ReactionTray({ onSend }: { onSend: (sticker: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        aria-expanded={open}
        aria-label="Send a sticker"
        className={dockButton}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        😀
      </button>
      {open ? (
        <>
          <div aria-hidden="true" className="fixed inset-0 z-[480]" onClick={() => setOpen(false)} />
          <div
            className="pop absolute top-12 right-0 z-[490] grid w-[15.5rem] grid-cols-4 gap-1.5 rounded-3xl border-2 border-white/20 bg-[#06683c] p-2.5 shadow-[0_8px_0_rgba(0,0,0,0.25),0_20px_40px_rgba(0,0,0,0.4)]"
            role="menu"
          >
            {REACTIONS.map((sticker, index) => (
              <button
                aria-label={`Send ${sticker}`}
                className="grid h-12 place-items-center rounded-2xl bg-white/10 text-3xl transition-transform hover:bg-white/20 active:scale-90"
                key={sticker}
                onClick={() => {
                  onSend(sticker);
                  setOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                {isWord(sticker) ? (
                  <span
                    className={cn(
                      "display rounded-full px-2 py-0.5 text-[11px]",
                      BADGES[index % BADGES.length],
                    )}
                  >
                    {sticker}
                  </span>
                ) : (
                  sticker
                )}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

type Floater = {
  key: string;
  sticker: string;
  x: number;
  y: number;
  variant: number;
  name: string | null;
};

/**
 * Stickers that were just thrown, floating up from whoever threw them. Each
 * one is a short CSS animation (movement and fading only), removed when done.
 * Elements that carry `data-react-anchor="<seat id>"` say where a player is.
 */
export function ReactionLayer({
  nameOf,
  reactions,
  you,
}: {
  nameOf: (seatId: string) => string;
  reactions: readonly ReactionEvent[];
  you: string;
}) {
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const last = useRef<number | null>(null);

  useEffect(() => {
    const newest = reactions.length > 0 ? reactions[reactions.length - 1].seq : 0;

    // What was already there when the page opened is not replayed.
    if (last.current === null) {
      last.current = newest;

      return;
    }

    const fresh = reactions.filter((reaction) => reaction.seq > (last.current as number));

    last.current = newest;

    if (fresh.length === 0) {
      return;
    }

    const made = fresh.slice(-4).map((reaction): Floater => {
      const anchor = document.querySelector<HTMLElement>(
        `[data-react-anchor="${reaction.seatId}"]`,
      );
      const rect = anchor?.getBoundingClientRect();
      const mine = reaction.seatId === you;
      const jitter = ((reaction.seq * 37) % 41) - 20;

      return {
        key: `${reaction.seq}`,
        name: mine ? null : nameOf(reaction.seatId),
        sticker: reaction.emoji,
        variant: reaction.seq % 4,
        x:
          (rect && rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2) + jitter,
        y: rect && rect.height > 0
          ? rect.top + rect.height / 2
          : mine
            ? window.innerHeight - 160
            : 150,
      };
    });

    setFloaters((current) => [...current.slice(-8), ...made]);

    if (fresh.some((reaction) => reaction.seatId !== you)) {
      playSfx("pop");
    }

    const keys = new Set(made.map((floater) => floater.key));
    const timer = setTimeout(
      () => setFloaters((current) => current.filter((floater) => !keys.has(floater.key))),
      2500,
    );

    return () => clearTimeout(timer);
  }, [reactions, you, nameOf]);

  if (floaters.length === 0) {
    return null;
  }

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[500] overflow-hidden">
      {floaters.map((floater, index) => (
        <div className="absolute" key={floater.key} style={{ left: floater.x, top: floater.y }}>
          <div className={`react react-${floater.variant} flex flex-col items-center`}>
            {isWord(floater.sticker) ? (
              <span
                className={cn(
                  "display rounded-full px-4 py-1.5 text-3xl shadow-[0_4px_0_rgba(0,0,0,0.3)]",
                  BADGES[(floater.variant + index) % BADGES.length],
                )}
              >
                {floater.sticker}
              </span>
            ) : (
              <span className="text-7xl leading-none drop-shadow-[0_4px_6px_rgba(0,0,0,0.35)]">
                {floater.sticker}
              </span>
            )}
            {floater.name ? (
              <span className="mt-1 rounded-full bg-black/50 px-2 py-0.5 font-bold text-[11px]">
                {floater.name}
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
