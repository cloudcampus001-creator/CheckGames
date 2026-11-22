"use client";

import { motion } from "motion/react";
import { PlayingCard } from "@/components/PlayingCard";
import type { FanCard } from "@/components/PlayingCardFan";
import { cn } from "@/helpers/classname-helper";

/**
 * Doubling: the cards lifted out of the hand to be played together, bottom
 * first. Tap a card to put it back, drag the stack up to the table to play it
 * (or press the button). When a card that does not belong is tapped, the stack
 * shakes its head.
 */
export function StackTray({
  cards,
  onCancel,
  onPlay,
  onRemove,
  shakeKey,
}: {
  cards: readonly FanCard[];
  onCancel: () => void;
  onPlay: () => void;
  onRemove: (cardId: string) => void;
  shakeKey: number;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 -top-[196px] z-[210] flex justify-center"
      data-stack
    >
      <div className={cn(shakeKey > 0 && "shake")} key={shakeKey}>
        <motion.div
          className="pointer-events-auto flex touch-none flex-col items-center gap-2"
          drag="y"
          dragConstraints={{ bottom: 0, top: -260 }}
          dragElastic={0.15}
          dragSnapToOrigin
          onDragEnd={(_event, info) => {
            if (info.offset.y < -70 || info.velocity.y < -600) {
              onPlay();
            }
          }}
        >
          <div className="flex items-end pl-9">
            {cards.map((card, index) => (
              <button
                aria-label={`Put the ${card.rank} of ${card.suit} back`}
                className="-ml-9 relative -translate-y-2 rounded-[8px] drop-shadow-[0_8px_10px_rgba(0,0,0,0.4)] transition-transform active:scale-95"
                data-card-id={card.id}
                key={card.id}
                onClick={() => onRemove(card.id)}
                style={{ zIndex: index }}
                type="button"
              >
                <PlayingCard rank={card.rank} suit={card.suit} width={84} />
                <span className="display absolute -bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-[10px]">
                  {index === 0 ? "bottom" : index === cards.length - 1 ? "top" : index + 1}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button className="btn btn-gold px-5 py-2 text-sm" disabled={cards.length < 2} onClick={onPlay} type="button">
              Play together
            </button>
            <button className="btn btn-soft" onClick={onCancel} type="button">
              Cancel
            </button>
          </div>
          <p className="rounded-full bg-black/40 px-3 py-1 font-semibold text-[11px] text-white/85">
            Tap another card of the same number to add it · drag up to play
          </p>
        </motion.div>
      </div>
    </div>
  );
}
