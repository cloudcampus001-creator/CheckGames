"use client";

import { useState } from "react";
import { cn } from "@/helpers/classname-helper";
import {
  type ClientAction,
  CUSTOM_VOTE_MAX_OPTIONS,
  CUSTOM_VOTE_MIN_OPTIONS,
  type RoomView,
  type VoteView,
} from "./protocol";
import { useCountdown } from "./useCountdown";

/** A vote that is running: the choices, how many picked each, and the time left. */
export function VoteCard({
  nameOf,
  onAction,
  vote,
}: {
  nameOf: (seatId: string) => string;
  onAction: (action: ClientAction) => void;
  vote: VoteView;
}) {
  const left = useCountdown(vote.endsInMs, vote.id);
  const seconds = Math.ceil((left ?? 0) / 1000);

  return (
    <section className="panel pop space-y-3 p-4" data-vote>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="display text-xl leading-tight">{vote.title}</p>
          <p className="text-white/60 text-xs">
            {nameOf(vote.byId)} called a vote · {vote.voted}/{vote.voters} voted
          </p>
        </div>
        <span className="display rounded-full bg-black/25 px-3 py-1 text-sm tabular-nums">
          {seconds}s
        </span>
      </div>

      <div className={cn("grid gap-2", vote.options.length > 2 ? "grid-cols-2" : "grid-cols-2")}>
        {vote.options.map((option) => {
          const mine = vote.yourChoice === option.id;
          const share = vote.voters > 0 ? (option.count / vote.voters) * 100 : 0;

          return (
            <button
              className={cn(
                "relative overflow-hidden rounded-2xl px-3 py-2.5 text-left font-bold transition-transform active:scale-[0.97] disabled:opacity-50",
                mine
                  ? "bg-amber-300 text-emerald-950 shadow-[0_4px_0_#b87d00]"
                  : "bg-white/12 shadow-[0_4px_0_rgba(0,0,0,0.2)] hover:bg-white/20",
              )}
              data-vote-option={option.id}
              disabled={!vote.canVote}
              key={option.id}
              onClick={() => onAction({ choice: option.id, type: "castVote" })}
              type="button"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-y-0 left-0 origin-left",
                  mine ? "bg-emerald-950/10" : "bg-white/10",
                )}
                style={{ width: `${share}%`, transition: "width 0.3s ease" }}
              />
              <span className="relative flex items-center justify-between gap-2">
                <span className="text-sm">{option.label}</span>
                <span className="display text-base tabular-nums">{option.count}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-white/55 text-xs">
          {vote.canVote ? "Tap a choice. You can change it until the end." : "You do not vote in this one."}
        </p>
        {vote.canCancel ? (
          <button className="btn btn-soft" onClick={() => onAction({ type: "cancelVote" })} type="button">
            Call off
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** The menu for calling a vote: the rules in the lobby, a rematch after a game. */
export function StartVote({
  onAction,
  view,
}: {
  onAction: (action: ClientAction) => void;
  view: RoomView;
}) {
  if (view.vote) {
    return null;
  }

  const humans = view.seats.filter((seat) => seat.kind === "human");

  if (view.phase === "finished") {
    return (
      <button
        className="btn btn-sky"
        data-start-vote="rematch"
        onClick={() => onAction({ kind: "rematch", type: "startVote" })}
        type="button"
      >
        Vote to play again
      </button>
    );
  }

  if (view.phase !== "lobby") {
    return null;
  }

  const removable = humans.filter((seat) => !seat.isHost && seat.id !== view.you);
  const buttons: { label: string; action: ClientAction }[] = [
    { action: { kind: "rules", topic: "cards", type: "startVote" }, label: "Cards each" },
    { action: { kind: "rules", topic: "jokers", type: "startVote" }, label: "Jokers" },
    { action: { kind: "rules", topic: "ending", type: "startVote" }, label: "How a game ends" },
    { action: { kind: "rules", topic: "doubling", type: "startVote" }, label: "Doubling" },
  ];

  return (
    <details className="rounded-2xl bg-black/20 px-4 py-3 text-sm" data-start-vote="menu">
      <summary className="cursor-pointer font-bold text-white/90">Call a vote</summary>
      <div className="mt-3 flex flex-wrap gap-2">
        {buttons.map((button) => (
          <button
            className="btn btn-soft"
            key={button.label}
            onClick={() => onAction(button.action)}
            type="button"
          >
            {button.label}
          </button>
        ))}
      </div>
      {humans.length >= 3 && removable.length > 0 ? (
        <div className="mt-3 space-y-2">
          <p className="text-white/60 text-xs">Remove a player:</p>
          <div className="flex flex-wrap gap-2">
            {removable.map((seat) => (
              <button
                className="btn btn-soft"
                key={seat.id}
                onClick={() => onAction({ kind: "kick", seatId: seat.id, type: "startVote" })}
                type="button"
              >
                {seat.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </details>
  );
}

/**
 * The host writes a question and the choices. Everybody votes, and the result
 * is announced in the chat: nothing changes by itself, the host acts on it.
 */
export function CustomVoteForm({ onAction }: { onAction: (action: ClientAction) => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const filled = options.map((option) => option.trim()).filter(Boolean);
  const ready = question.trim().length >= 3 && new Set(filled.map((o) => o.toLowerCase())).size >= CUSTOM_VOTE_MIN_OPTIONS;

  return (
    <details className="rounded-2xl bg-black/20 px-4 py-3 text-sm" data-custom-vote>
      <summary className="cursor-pointer font-bold text-white/90">Write your own vote (host)</summary>
      <div className="mt-3 space-y-2">
        <input
          aria-label="Your question"
          className="input py-2.5 text-sm"
          maxLength={80}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Your question, e.g. Who pays for the drinks?"
          value={question}
        />
        {options.map((option, index) => (
          <input
            aria-label={`Choice ${index + 1}`}
            className="input py-2.5 text-sm"
            key={index}
            maxLength={40}
            onChange={(event) =>
              setOptions((current) => current.map((value, at) => (at === index ? event.target.value : value)))
            }
            placeholder={`Choice ${index + 1}`}
            value={option}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          {options.length < CUSTOM_VOTE_MAX_OPTIONS ? (
            <button className="btn btn-soft" onClick={() => setOptions((current) => [...current, ""])} type="button">
              + Add a choice
            </button>
          ) : null}
          <button
            className="btn btn-gold"
            disabled={!ready}
            onClick={() => {
              onAction({ kind: "custom", options: filled, question: question.trim(), type: "startVote" });
              setQuestion("");
              setOptions(["", ""]);
            }}
            type="button"
          >
            Start the vote
          </button>
        </div>
        <p className="text-white/55 text-xs">
          Everybody at the table votes and the result is shown in the chat. Nothing changes by itself.
        </p>
      </div>
    </details>
  );
}
