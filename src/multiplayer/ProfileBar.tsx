"use client";

import Link from "next/link";
import { cn } from "@/helpers/classname-helper";
import { useProfile } from "./identity";
import { levelInfo, tierFor } from "./profile";

/** Who you are, how far you have come: a card that opens the profile. */
export function ProfileBar({ className }: { className?: string }) {
  const { profile } = useProfile();

  if (!profile) {
    return (
      <div className={cn("panel h-[88px] animate-pulse p-4", className)} data-profile-bar="loading" />
    );
  }

  const level = levelInfo(profile.xp);
  const tier = tierFor(profile.rating);

  return (
    <Link
      className={cn("panel block p-4 transition-transform active:scale-[0.98]", className)}
      data-profile-bar="ready"
      href="/profile"
    >
      <div className="flex items-center gap-3">
        <span className="grid size-14 shrink-0 place-items-center rounded-full bg-amber-300 text-3xl shadow-[0_4px_0_#b87d00]">
          {profile.avatar}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="display truncate text-xl">{profile.name}</p>
            <span className="display rounded-full bg-black/25 px-2 py-0.5 text-xs">Lv {level.level}</span>
            {profile.dayStreak > 1 ? (
              <span className="rounded-full bg-black/25 px-2 py-0.5 font-bold text-xs" title="Days in a row">
                🔥 {profile.dayStreak}
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-black/30">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-300 to-lime-300"
              style={{ width: `${level.pct}%` }}
            />
          </div>
          <p className="mt-1 font-semibold text-white/70 text-xs">
            {level.into}/{level.needed} XP · {tier.emoji} {tier.name} {profile.rating} · {profile.stats.wins} wins
          </p>
        </div>
      </div>
    </Link>
  );
}
