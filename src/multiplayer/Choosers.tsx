"use client";

import type { Placement, Suit } from "@/cheque-games/engine";
import { cn } from "@/helpers/classname-helper";
import { quietButton } from "./ui";

export const SUIT_SYMBOL: Record<Suit, string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

const SUIT_ORDER: readonly Suit[] = ["spades", "hearts", "clubs", "diamonds"];

export const isRedSuit = (suit: Suit) => suit === "hearts" || suit === "diamonds";

/** What the player is being asked about the card they just tapped. */
export type Choice = { kind: "two" | "jack"; cardId: string };

/**
 * A small panel above the hand. A 2 can go on top of the pile or under it; a
 * jack needs the player to name a sign. Tapping outside, or Cancel, puts the
 * card back in the hand.
 */
export function Chooser({
  choice,
  onCancel,
  onPlacement,
  onSuit,
}: {
  choice: Choice;
  onCancel: () => void;
  onPlacement: (placement: Placement) => void;
  onSuit: (suit: Suit) => void;
}) {
  return (
    <div
      className="absolute inset-0 z-[220] flex items-end justify-center bg-black/35 pb-[270px]"
      data-chooser={choice.kind}
      onClick={onCancel}
      role="presentation"
    >
      <div
        aria-label={choice.kind === "two" ? "Where does the 2 go?" : "Which sign do you ask for?"}
        aria-modal="true"
        className="w-[min(92vw,22rem)] space-y-3 rounded-2xl bg-emerald-900 p-4 text-center shadow-2xl ring-1 ring-white/15"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        {choice.kind === "two" ? (
          <>
            <p className="font-semibold">Where does the 2 go?</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                className="rounded-xl bg-amber-300 px-3 py-3 font-semibold text-emerald-950 hover:opacity-90"
                data-choose="top"
                onClick={() => onPlacement("top")}
                type="button"
              >
                On top
                <span className="block font-normal text-emerald-900/80 text-xs">
                  the 2 becomes the centre card
                </span>
              </button>
              <button
                className="rounded-xl bg-white/15 px-3 py-3 font-semibold hover:bg-white/25"
                data-choose="under"
                onClick={() => onPlacement("under")}
                type="button"
              >
                Under
                <span className="block font-normal text-white/70 text-xs">
                  the centre card stays
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="font-semibold">Ask for which sign?</p>
            <div className="grid grid-cols-4 gap-2">
              {SUIT_ORDER.map((suit) => (
                <button
                  aria-label={`Ask for ${suit}`}
                  className={cn(
                    "rounded-xl bg-white py-3 font-bold text-4xl leading-none hover:scale-105 active:scale-95",
                    isRedSuit(suit) ? "text-[#c22f2f]" : "text-[#23262d]",
                  )}
                  data-choose={suit}
                  key={suit}
                  onClick={() => onSuit(suit)}
                  type="button"
                >
                  {SUIT_SYMBOL[suit]}
                </button>
              ))}
            </div>
            <p className="text-white/60 text-xs">
              The next player must play this sign, a 2 or a J.
            </p>
          </>
        )}
        <button className={quietButton} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
