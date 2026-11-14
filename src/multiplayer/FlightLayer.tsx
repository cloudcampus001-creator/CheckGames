"use client";

import { motion, useReducedMotion } from "motion/react";
import {
  type JokerColour,
  PlayingCard,
  type PlayingCardRank,
  type PlayingCardSuit,
} from "@/components/PlayingCard";
import type { Point } from "./flights";

/** The face a flying card shows once it has turned over. */
export type GhostFace = {
  rank: PlayingCardRank | "joker";
  suit: PlayingCardSuit | JokerColour;
};

/** A card that flies across the screen and then disappears. Face down unless it has a `face`. */
export type Ghost = {
  key: string;
  /** Card width in pixels while it is at its start position. */
  width: number;
  from: Point;
  to: Point;
  fromScale: number;
  toScale: number;
  fromRotate: number;
  toRotate: number;
  /** Seconds to wait before moving. */
  delay: number;
  /** Seconds the flight takes. */
  duration: number;
  /** Sideways swing in pixels halfway through, so cards look like they are being mixed. */
  wiggle?: number;
  /** Fade out at the end, for a card that turns into one in someone's hand. */
  fadeOut?: boolean;
  /**
   * The card turns over on its way, revealing this face. Used for the player
   * who took the card: they see it turn and slide into their hand.
   */
  face?: GhostFace;
  /** The card in the player's hand that this flight ends at. It stays hidden until the flight lands. */
  revealId?: string;
  /** Scale reached halfway, so a revealed card rises towards the player. */
  lift?: number;
};

/**
 * Draws flying cards on top of everything. Used for a card taken from the
 * bank (turning over for the person who took it) and for the pile being
 * mixed back into the bank.
 */
export function FlightLayer({
  ghosts,
  onDone,
}: {
  ghosts: readonly Ghost[];
  onDone: (key: string) => void;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      data-flight-layer
      style={{
        inset: 0,
        pointerEvents: "none",
        position: "fixed",
        zIndex: 250,
      }}
    >
      {ghosts.map((ghost) => {
        const height = (ghost.width * 7) / 5;
        const fromX = ghost.from.x - ghost.width / 2;
        const fromY = ghost.from.y - height / 2;
        const toX = ghost.to.x - ghost.width / 2;
        const toY = ghost.to.y - height / 2;
        const swing = ghost.wiggle ?? 0;
        const midX = (fromX + toX) / 2 + swing;
        const midY = (fromY + toY) / 2 - Math.abs(swing) * 0.35;
        const delay = reduceMotion ? 0 : ghost.delay;
        const duration = reduceMotion ? 0.1 : ghost.duration;
        const lifted = ghost.lift !== undefined && !reduceMotion;

        return (
          <motion.div
            animate={{
              // Opacity is only touched for a card that fades away, so a card
              // that turns over keeps its 3D flip.
              ...(ghost.fadeOut ? { opacity: [1, 1, 0] } : {}),
              rotate: ghost.toRotate,
              scale: lifted
                ? [ghost.fromScale, ghost.lift as number, ghost.toScale]
                : ghost.toScale,
              x: swing ? [fromX, midX, toX] : toX,
              y: swing ? [fromY, midY, toY] : toY,
            }}
            data-ghost={ghost.key}
            data-ghost-face={ghost.face ? "true" : "false"}
            initial={{
              ...(ghost.fadeOut ? { opacity: 1 } : {}),
              rotate: ghost.fromRotate,
              scale: ghost.fromScale,
              x: fromX,
              y: fromY,
            }}
            key={ghost.key}
            onAnimationComplete={() => onDone(ghost.key)}
            style={{ left: 0, position: "absolute", top: 0, width: ghost.width }}
            transition={{
              delay,
              duration,
              ease: "easeInOut",
            }}
          >
            {ghost.face ? (
              <motion.div
                animate={{ rotateY: [0, 0, 180, 180] }}
                data-flip
                initial={{ rotateY: 0 }}
                style={{
                  height,
                  position: "relative",
                  transformPerspective: 900,
                  transformStyle: "preserve-3d",
                  width: ghost.width,
                }}
                transition={{
                  delay,
                  duration,
                  ease: "easeInOut",
                  times: [0, 0.12, 0.62, 1],
                }}
              >
                <div
                  data-face="back"
                  style={{
                    WebkitBackfaceVisibility: "hidden",
                    backfaceVisibility: "hidden",
                    inset: 0,
                    position: "absolute",
                  }}
                >
                  <PlayingCard faceDown rank="A" suit="spades" width={ghost.width} />
                </div>
                <div
                  data-face="front"
                  style={{
                    WebkitBackfaceVisibility: "hidden",
                    backfaceVisibility: "hidden",
                    inset: 0,
                    position: "absolute",
                    transform: "rotateY(180deg)",
                  }}
                >
                  <PlayingCard
                    rank={ghost.face.rank}
                    suit={ghost.face.suit}
                    width={ghost.width}
                  />
                </div>
              </motion.div>
            ) : (
              <PlayingCard faceDown rank="A" suit="spades" width={ghost.width} />
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
