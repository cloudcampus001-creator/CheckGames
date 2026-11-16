"use client";

import { cn } from "@/helpers/classname-helper";
import { useMuted } from "./sound";

/** The round buttons next to "Leave": sound, chat, stickers. */
export const dockButton =
  "relative grid size-10 shrink-0 place-items-center rounded-full bg-white/15 text-lg leading-none shadow-[0_3px_0_rgba(0,0,0,0.25)] transition-transform hover:bg-white/25 active:translate-y-[3px] active:shadow-none";

export function SoundButton() {
  const [muted, toggle] = useMuted();

  return (
    <button
      aria-label={muted ? "Turn sound on" : "Turn sound off"}
      aria-pressed={!muted}
      className={cn(dockButton, muted && "opacity-60")}
      onClick={toggle}
      type="button"
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}

export function ChatButton({
  onClick,
  unread,
}: {
  onClick: () => void;
  unread: number;
}) {
  return (
    <button
      aria-label={unread > 0 ? `Chat, ${unread} new` : "Chat"}
      className={dockButton}
      onClick={onClick}
      type="button"
    >
      💬
      {unread > 0 ? (
        <span className="display pop absolute -top-1 -right-1 grid min-w-5 place-items-center rounded-full bg-rose-500 px-1 text-[11px] leading-5">
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </button>
  );
}
