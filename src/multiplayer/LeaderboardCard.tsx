"use client";

import { useEffect, useState } from "react";
import { cn } from "@/helpers/classname-helper";
import { leaderboardRequest } from "./api";
import { getDevice } from "./device";

type Entry = {
  id: string;
  name: string;
  avatar: string;
  level: number;
  xp: number;
  rating: number;
  wins: number;
  played: number;
};

/** The players with the most XP. */
export function LeaderboardCard({ limit = 10 }: { limit?: number }) {
  const [players, setPlayers] = useState<Entry[] | null>(null);
  const me = typeof window === "undefined" ? "" : getDevice().id;

  useEffect(() => {
    let cancelled = false;

    void leaderboardRequest().then((reply) => {
      if (!cancelled) {
        setPlayers(reply.ok === true ? ((reply.players as Entry[]) ?? []) : []);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="panel space-y-3 p-5" data-leaderboard>
      <h2 className="display text-2xl">Top players</h2>
      {players === null ? <p className="text-sm text-white/60">Loading…</p> : null}
      {players?.length === 0 ? (
        <p className="text-sm text-white/60">Nobody yet. Play a game and be the first!</p>
      ) : null}
      <ol className="space-y-1.5">
        {(players ?? []).slice(0, limit).map((player, index) => (
          <li
            className={cn(
              "flex items-center gap-3 rounded-2xl px-3 py-2",
              player.id === me ? "bg-amber-300/25" : "bg-black/20",
            )}
            key={player.id}
          >
            <span
              className={cn(
                "display grid size-8 shrink-0 place-items-center rounded-full text-sm",
                index === 0
                  ? "bg-amber-300 text-emerald-950"
                  : index === 1
                    ? "bg-slate-200 text-emerald-950"
                    : index === 2
                      ? "bg-orange-300 text-emerald-950"
                      : "bg-white/15",
              )}
            >
              {index + 1}
            </span>
            <span className="text-2xl">{player.avatar}</span>
            <span className="min-w-0 flex-1 truncate font-bold">{player.name}</span>
            <span className="text-right text-white/70 text-xs">
              Lv {player.level} · {player.wins}W
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
