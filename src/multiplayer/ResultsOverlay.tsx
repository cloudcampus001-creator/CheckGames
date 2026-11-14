"use client";

import { motion } from "motion/react";
import { cn } from "@/helpers/classname-helper";
import type { ClientAction, RoomView } from "./protocol";
import { primaryButton, quietButton } from "./ui";

const ordinal = (n: number) => {
  const tens = n % 100;

  if (tens >= 11 && tens <= 13) {
    return `${n}th`;
  }

  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/**
 * Shown when a set is over: who won, the ranking when the host chose to play
 * on, who is eliminated, the champion after a final, and the host's buttons.
 */
export function ResultsOverlay({
  onAction,
  onLeave,
  view,
}: {
  onAction: (action: ClientAction) => void;
  onLeave: () => void;
  view: RoomView;
}) {
  const game = view.game;

  if (!game) {
    return null;
  }

  const isHost = view.hostId === view.you;
  const { tournament, settings } = view;
  const nameOf = (id: string) => view.seats.find((seat) => seat.id === id)?.name ?? "Someone";
  const champion = tournament.championId;
  const ranking = settings.endMode === "ranking";
  const last = game.standings[game.standings.length - 1];
  const eliminatedNow =
    settings.elimination && !champion && ranking && last ? last.seatId : null;
  const stillIn = view.seats.filter((seat) => !tournament.eliminatedIds.includes(seat.id)).length;
  const nextIsFinal = settings.elimination && stillIn === 2;

  let title = "GAMES!";
  let subtitle = "";

  if (champion) {
    title = champion === view.you ? "You are the champion!" : `${nameOf(champion)} is the champion!`;
    subtitle = "They won the final.";
  } else if (game.winnerId) {
    subtitle =
      game.winnerId === view.you
        ? "You finished your cards. You win!"
        : `${nameOf(game.winnerId)} finished first.`;
  }

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="absolute inset-0 z-[300] flex flex-col items-center justify-center gap-4 bg-emerald-950/90 px-6 text-center backdrop-blur-sm"
      data-results
      initial={{ opacity: 0 }}
      transition={{ delay: 0.9, duration: 0.4 }}
    >
      {settings.elimination ? (
        <p className="rounded-full bg-white/10 px-3 py-1 text-white/70 text-xs tracking-widest">
          {tournament.finalSet ? "THE FINAL" : `SET ${tournament.set}`}
        </p>
      ) : null}
      <p className="font-bold text-4xl tracking-wide">{title}</p>
      {subtitle ? <p className="text-lg text-white/80">{subtitle}</p> : null}

      {ranking && game.standings.length > 0 ? (
        <ol className="w-full max-w-xs space-y-1.5 text-left">
          {game.standings.map((entry) => {
            const out = entry.seatId === eliminatedNow;

            return (
              <li
                className={cn(
                  "flex items-center justify-between gap-3 rounded-xl px-4 py-2",
                  entry.seatId === view.you ? "bg-amber-300/20" : "bg-white/10",
                  out && "bg-red-400/20",
                )}
                key={entry.seatId}
              >
                <span className="flex items-center gap-3">
                  <span className="w-9 font-bold text-amber-300 tabular-nums">
                    {ordinal(entry.rank)}
                  </span>
                  <span className="truncate">{entry.name}</span>
                </span>
                {out ? (
                  <span className="font-semibold text-red-200 text-xs tracking-wider">OUT</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {eliminatedNow ? (
        <p className="text-sm text-white/70">
          {eliminatedNow === view.you
            ? "You are out for the next set. You will be back after the final."
            : `${nameOf(eliminatedNow)} is out for the next set.`}
        </p>
      ) : null}
      {champion ? (
        <p className="text-sm text-white/70">Everybody, eliminated players included, can play again.</p>
      ) : null}

      {isHost ? (
        <div className="flex flex-wrap justify-center gap-3">
          {tournament.nextSetAvailable ? (
            <button
              className={primaryButton}
              data-action="nextSet"
              onClick={() => onAction({ type: "nextSet" })}
              type="button"
            >
              {nextIsFinal ? "Start the final" : "Next set"}
            </button>
          ) : champion ? (
            <button
              className={primaryButton}
              data-action="playAgain"
              onClick={() => onAction({ type: "playAgain" })}
              type="button"
            >
              Play again
            </button>
          ) : null}
          <button
            className={tournament.nextSetAvailable || champion ? quietButton : primaryButton}
            data-action="backToLobby"
            onClick={() => onAction({ type: "backToLobby" })}
            type="button"
          >
            Back to lobby
          </button>
        </div>
      ) : (
        <p className="text-sm text-white/60">Waiting for the host…</p>
      )}
      <button className={quietButton} onClick={onLeave} type="button">
        Leave
      </button>
    </motion.div>
  );
}
