"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useEffect, useRef } from "react";
import {
  type JokerColour,
  PlayingCard,
  type PlayingCardRank,
  type PlayingCardSuit,
} from "@/components/PlayingCard";
import { type FlightOrigin, pileTilt } from "./flights";

// A card face never changes, so it is drawn once and reused.
const Face = memo(PlayingCard);

export type PileCard = {
  id: string;
  rank: PlayingCardRank | "joker";
  suit: PlayingCardSuit | JokerColour;
};

type CentrePileProps = {
  /** Oldest first. The last card is on top. */
  cards: readonly PileCard[];
  /** Card width in pixels. */
  cardWidth?: number;
  /**
   * Where a card that has just arrived flies in from, in screen coordinates.
   * Return null to let it drop in from just above instead.
   */
  originFor?: (cardId: string) => FlightOrigin | null;
};

/**
 * The pile in the middle of the table. Every card sits at its own angle and
 * offset, so the cards underneath show at the edges, like cards tossed on a
 * real table. A new card flies in from wherever it was played.
 */
function CentrePileBase({
  cardWidth = 112,
  cards,
  originFor,
}: CentrePileProps) {
  const reduceMotion = useReducedMotion();
  const boxRef = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);

  // Cards already on the pile when it first appears do not fly in.
  if (seen.current === null) {
    seen.current = new Set(cards.map((card) => card.id));
  }

  // Remember what is here now. A card that leaves the pile (it was mixed back
  // into the bank) is forgotten, so it flies in again if it is played later.
  useEffect(() => {
    seen.current = new Set(cards.map((card) => card.id));
  }, [cards]);

  const cardHeight = Math.round((cardWidth * 7) / 5);

  // Measuring the screen forces the browser to lay the page out, so it is only
  // done when a card really is arriving (not on every redraw).
  let centre: { x: number; y: number } | null | undefined;
  const readCentre = () => {
    if (centre === undefined) {
      const rect = boxRef.current?.getBoundingClientRect();

      centre = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : null;
    }

    return centre;
  };

  const flight = reduceMotion
    ? ({ duration: 0.12 } as const)
    : ({ duration: 0.4, ease: [0.2, 0.8, 0.25, 1], type: "tween" } as const);

  return (
    <div
      data-pile
      ref={boxRef}
      style={{
        flexShrink: 0,
        height: Math.round(cardHeight * 1.28),
        position: "relative",
        width: Math.round(cardWidth * 1.75),
      }}
    >
      <AnimatePresence initial={false}>
        {cards.map((card, index) => {
          const tilt = pileTilt(card.id);
          const isNew = !seen.current?.has(card.id);
          const middle = isNew ? readCentre() : null;
          const origin = isNew && middle ? (originFor?.(card.id) ?? null) : null;

          let initial:
            | false
            | { opacity: number; rotate: number; scale: number; x: number; y: number } =
            false;

          if (isNew && origin && middle) {
            // Start where the card was played from.
            initial = {
              opacity: 1,
              rotate: origin.rotate,
              scale: origin.scale,
              x: origin.x - middle.x,
              y: origin.y - middle.y,
            };
          } else if (isNew) {
            initial = {
              opacity: 0,
              rotate: tilt.rotate - 12,
              scale: 1.1,
              x: tilt.x,
              y: tilt.y - 28,
            };
          }

          return (
            <motion.div
              animate={{
                opacity: 1,
                rotate: tilt.rotate,
                scale: 1,
                x: tilt.x,
                y: tilt.y,
              }}
              exit={{ opacity: 0, transition: { duration: 0.3 } }}
              initial={initial}
              key={card.id}
              style={{
                left: "50%",
                marginLeft: -cardWidth / 2,
                marginTop: -cardHeight / 2,
                position: "absolute",
                top: "50%",
                willChange: "transform",
                zIndex: index,
              }}
              transition={flight}
            >
              <Face rank={card.rank} suit={card.suit} width={cardWidth} />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/** Redrawn only when the cards on the pile change. */
export const CentrePile = memo(
  CentrePileBase,
  (before, after) =>
    before.cardWidth === after.cardWidth &&
    before.cards.length === after.cards.length &&
    before.cards.every((card, index) => card.id === after.cards[index].id),
);
