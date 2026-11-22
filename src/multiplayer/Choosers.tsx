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
export type Choice = {
  kind: "two" | "jack";
  cardId: string;
  /** Doubling: every card of the stack, bottom first. */
  cardIds?: string[];
};

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
      className="absolute inset-0 z-[220] flex items-end justify-center bg-black/45 pb-[270px]"
      data-chooser={choice.kind}
      onClick={onCancel}
      role="presentation"
    >
      <div
        aria-label={choice.kind === "two" ? "Where does the 2 go?" : "Which sign do you ask for?"}
        aria-modal="true"
        className="pop w-[min(92vw,23rem)] space-y-4 rounded-3xl border-2 border-white/25 bg-[#06683c] p-5 text-center shadow-[0_8px_0_rgba(0,0,0,0.25),0_20px_40px_rgba(0,0,0,0.4)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        {choice.kind === "two" ? (
          <>
            <p className="display text-2xl">Where does the 2 go?</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                className="btn btn-gold flex-col gap-1 rounded-2xl py-3"
                data-choose="top"
                onClick={() => onPlacement("top")}
                type="button"
              >
                On top
                <span className="block font-semibold text-emerald-900/80 text-xs tracking-normal">
                  the 2 becomes the centre card
                </span>
              </button>
              <button
                className="btn btn-sky flex-col gap-1 rounded-2xl py-3"
                data-choose="under"
                onClick={() => onPlacement("under")}
                type="button"
              >
                Under
                <span className="block font-semibold text-emerald-900/80 text-xs tracking-normal">
                  the centre card stays
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="display text-2xl">Ask for which sign?</p>
            <div className="grid grid-cols-4 gap-2">
              {SUIT_ORDER.map((suit) => (
                <button
                  aria-label={`Ask for ${suit}`}
                  className={cn(
                    "rounded-2xl bg-white py-3 text-4xl leading-none shadow-[0_5px_0_#b9b29c] transition-transform hover:-translate-y-0.5 active:translate-y-1 active:shadow-[0_1px_0_#b9b29c]",
                    isRedSuit(suit) ? "text-[#d6303a]" : "text-[#23262d]",
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
            <p className="font-semibold text-white/75 text-xs">
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
