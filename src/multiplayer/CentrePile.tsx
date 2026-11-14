"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import {
  type JokerColour,
  PlayingCard,
  type PlayingCardRank,
  type PlayingCardSuit,
} from "@/components/PlayingCard";
import { type FlightOrigin, pileTilt } from "./flights";

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
export function CentrePile({
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
  const rect = boxRef.current?.getBoundingClientRect();
  const centre = rect
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : null;

  const flight = reduceMotion
    ? ({ duration: 0.12 } as const)
    : ({ duration: 0.46, ease: [0.2, 0.8, 0.25, 1], type: "tween" } as const);

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
          const origin = isNew && centre ? (originFor?.(card.id) ?? null) : null;

          let initial:
            | false
            | { opacity: number; rotate: number; scale: number; x: number; y: number } =
            false;

          if (isNew && origin && centre) {
            // Start where the card was played from.
            initial = {
              opacity: 1,
              rotate: origin.rotate,
              scale: origin.scale,
              x: origin.x - centre.x,
              y: origin.y - centre.y,
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
                zIndex: index,
              }}
              transition={flight}
            >
              <PlayingCard rank={card.rank} suit={card.suit} width={cardWidth} />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
