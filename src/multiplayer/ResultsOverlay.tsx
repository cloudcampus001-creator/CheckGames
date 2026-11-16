"use client";

import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/helpers/classname-helper";
import type { ClientAction, RoomView } from "./protocol";
import { playSfx } from "./sound";
import { primaryButton, quietButton } from "./ui";
import { useCountdown } from "./useCountdown";
import { StartVote, VoteCard } from "./VotePanel";

const ordinal = (n: number) => {
  const tens = n % 100;

  if (tens >= 11 && tens <= 13) {
    return `${n}th`;
  }

  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** Gold, silver and bronze for the podium; plain for everyone else. */
const medal = (rank: number) =>
  rank === 1
    ? "bg-amber-300 text-emerald-950"
    : rank === 2
      ? "bg-slate-200 text-emerald-950"
      : rank === 3
        ? "bg-orange-300 text-emerald-950"
        : "bg-white/15 text-white";

const CONFETTI_COLOURS = ["#ffd23f", "#ff5a5f", "#38d6ff", "#7cfc8a", "#ff8bd5"];

/** Fixed pieces (no randomness, so the server and browser always agree). */
const CONFETTI = Array.from({ length: 22 }, (_, index) => ({
  colour: CONFETTI_COLOURS[index % CONFETTI_COLOURS.length],
  delay: 0.9 + (index % 7) * 0.13,
  drift: ((index * 37) % 120) - 60,
  duration: 2.6 + (index % 5) * 0.35,
  left: (index * 47) % 100,
}));

/** "Back to the lobby in 12s". Counts on its own so the rest does not redraw. */
function BackToLobby({ ms }: { ms: number }) {
  const left = useCountdown(ms);

  return (
    <p className="font-semibold text-sm text-white/70" data-return>
      Back to the lobby in {Math.ceil((left ?? 0) / 1000)}s
    </p>
  );
}

/**
 * Shown when a set is over: who won, the ranking when the host chose to play
 * on, who is eliminated, the champion after a final, the scoreboard of the
 * room, a vote for a rematch, and the host's buttons. The table goes back to
 * the lobby by itself after a few seconds (the host can switch that off).
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
  const announced = useRef(false);
  const champion = view.tournament.championId;
  const iWon = game ? (champion ? champion === view.you : game.winnerId === view.you) : false;

  // A little fanfare when the results appear.
  useEffect(() => {
    if (announced.current) {
      return;
    }

    announced.current = true;

    const timer = setTimeout(() => playSfx(iWon ? "win" : "games"), 900);

    return () => clearTimeout(timer);
  }, [iWon]);

  if (!game) {
    return null;
  }

  const isHost = view.hostId === view.you;
  const { tournament, settings } = view;
  const nameOf = (id: string) => view.seats.find((seat) => seat.id === id)?.name ?? "Someone";
  const ranking = settings.endMode === "ranking";
  const last = game.standings[game.standings.length - 1];
  const eliminatedNow =
    settings.elimination && !champion && ranking && last ? last.seatId : null;
  const stillIn = view.seats.filter((seat) => !tournament.eliminatedIds.includes(seat.id)).length;
  const nextIsFinal = settings.elimination && stillIn === 2;
  const scores = view.seats
    .filter((seat) => seat.wins > 0)
    .sort((a, b) => b.wins - a.wins);

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
      className="absolute inset-x-0 top-16 bottom-0 z-[300] flex flex-col items-center justify-center gap-3 overflow-y-auto overflow-x-hidden bg-[#033d24]/95 px-6 py-4 text-center"
      data-results
      initial={{ opacity: 0 }}
      transition={{ delay: 0.9, duration: 0.4 }}
    >
      {iWon
        ? CONFETTI.map((piece, index) => (
            <span
              aria-hidden="true"
              className="confetti"
              key={index}
              style={{
                ["--dx" as string]: `${piece.drift}px`,
                animationDelay: `${piece.delay}s`,
                animationDuration: `${piece.duration}s`,
                background: piece.colour,
                left: `${piece.left}%`,
              }}
            />
          ))
        : null}

      {settings.elimination ? (
        <p className="display rounded-full bg-white/15 px-4 py-1 text-sm text-white/80">
          {tournament.finalSet ? "THE FINAL" : `SET ${tournament.set}`}
        </p>
      ) : null}

      <motion.p
        animate={{ opacity: 1, scale: 1 }}
        className="display text-6xl text-amber-300 [text-shadow:0_5px_0_rgba(0,0,0,0.35)]"
        initial={{ opacity: 0, scale: 0.6 }}
        transition={{ damping: 14, delay: 1, stiffness: 260, type: "spring" }}
      >
        {title}
      </motion.p>
      {subtitle ? <p className="font-bold text-lg text-white/85">{subtitle}</p> : null}

      {ranking && game.standings.length > 0 ? (
        <ol className="w-full max-w-xs space-y-2 text-left">
          {game.standings.map((entry) => {
            const out = entry.seatId === eliminatedNow;

            return (
              <li
                className={cn(
                  "flex items-center justify-between gap-3 rounded-2xl px-3 py-2 shadow-[0_3px_0_rgba(0,0,0,0.2)]",
                  entry.seatId === view.you ? "bg-amber-300/25" : "bg-white/10",
                  out && "bg-rose-400/30",
                )}
                key={entry.seatId}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      "display grid h-8 w-11 shrink-0 place-items-center rounded-full text-sm tabular-nums",
                      medal(entry.rank),
                    )}
                  >
                    {ordinal(entry.rank)}
                  </span>
                  <span className="truncate font-bold">{entry.name}</span>
                </span>
                {out ? (
                  <span className="display text-rose-200 text-xs">OUT</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {scores.length > 0 ? (
        <p className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-sm text-white/75" data-scores>
          {scores.map((seat) => (
            <span key={seat.id}>
              🏆 <span className="font-bold">{seat.name}</span> {seat.wins}
            </span>
          ))}
        </p>
      ) : null}

      {eliminatedNow ? (
        <p className="font-semibold text-sm text-white/75">
          {eliminatedNow === view.you
            ? "You are out for the next set. You will be back after the final."
            : `${nameOf(eliminatedNow)} is out for the next set.`}
        </p>
      ) : null}
      {champion ? (
        <p className="font-semibold text-sm text-white/75">
          Everybody, eliminated players included, can play again.
        </p>
      ) : null}

      {view.vote ? (
        <div className="w-full max-w-sm text-left">
          <VoteCard nameOf={nameOf} onAction={onAction} vote={view.vote} />
        </div>
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
        <p className="font-semibold text-sm text-white/65">Waiting for the host…</p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        {!isHost || (!tournament.nextSetAvailable && !champion) ? (
          <StartVote onAction={onAction} view={view} />
        ) : null}
        <button className={quietButton} onClick={onLeave} type="button">
          Leave
        </button>
      </div>

      {view.returnInMs !== null ? <BackToLobby ms={view.returnInMs} /> : null}
    </motion.div>
  );
}
