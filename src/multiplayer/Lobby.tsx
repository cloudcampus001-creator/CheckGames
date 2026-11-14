"use client";

import { useEffect, useState } from "react";
import { cn } from "@/helpers/classname-helper";
import { type ClientAction, MAX_SEATS, MIN_SEATS, type RoomView } from "./protocol";
import { copyText, inputClass, primaryButton, quietButton, Stepper } from "./ui";

type LobbyProps = {
  connected: boolean;
  onAction: (action: ClientAction) => Promise<string | null>;
  onLeave: () => void;
  view: RoomView;
};

export function Lobby({ connected, onAction, onLeave, view }: LobbyProps) {
  const isHost = view.hostId === view.you;
  const [shareUrl, setShareUrl] = useState("");
  const [isLocalAddress, setIsLocalAddress] = useState(false);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setShareUrl(`${window.location.origin}/room/${view.code}`);
    setIsLocalAddress(
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
        window.location.hostname,
      ),
    );
  }, [view.code]);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timer = setTimeout(() => setCopied(null), 1600);

    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = setTimeout(() => setNotice(null), 3000);

    return () => clearTimeout(timer);
  }, [notice]);

  async function run(action: ClientAction) {
    const error = await onAction(action);

    if (error) {
      setNotice(error);
    }
  }

  async function copy(kind: "code" | "link") {
    const ok = await copyText(kind === "code" ? view.code : shareUrl);

    setCopied(ok ? kind : null);

    if (!ok) {
      setNotice("Could not copy. Select the text and copy it by hand.");
    }
  }

  const seatCount = view.seats.length;
  const canStart = seatCount >= MIN_SEATS;

  return (
    <div className="flex min-h-screen justify-center bg-emerald-950 p-6 text-white">
      <div className="w-full max-w-lg space-y-5 py-4">
        <div className="flex items-center justify-between">
          <h1 className="font-bold text-2xl">Game lobby</h1>
          <div className="flex items-center gap-3">
            {connected ? null : (
              <span className="text-amber-300 text-xs">Reconnecting…</span>
            )}
            <button className={quietButton} onClick={onLeave} type="button">
              Leave
            </button>
          </div>
        </div>

        <section className="space-y-3 rounded-2xl bg-white/5 p-5 text-center">
          <p className="text-sm text-white/70">Share this code with your friends</p>
          <button
            className="font-bold text-5xl tracking-[0.3em]"
            onClick={() => copy("code")}
            title="Copy code"
            type="button"
          >
            {view.code}
          </button>
          <p className="h-4 text-amber-300 text-xs">
            {copied === "code" ? "Code copied" : ""}
          </p>
          <div className="flex gap-2">
            <input
              aria-label="Link to this game"
              className={cn(inputClass, "py-2 text-sm")}
              onFocus={(event) => event.target.select()}
              readOnly
              value={shareUrl}
            />
            <button
              className={quietButton}
              onClick={() => copy("link")}
              type="button"
            >
              {copied === "link" ? "Copied" : "Copy link"}
            </button>
          </div>
          {isLocalAddress && isHost ? (
            <p className="rounded-lg bg-amber-300/15 px-3 py-2 text-amber-200 text-xs">
              You opened this page as “localhost”, so this link only works on
              this computer. Open the game with this computer&apos;s network
              address instead (like http://192.168.1.20:3000), then share the
              new link or just the code.
            </p>
          ) : (
            <p className="text-white/50 text-xs">
              They need to be on the same network as this computer.
            </p>
          )}
        </section>

        <section className="space-y-3 rounded-2xl bg-white/5 p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-lg">
              Players{" "}
              <span className="text-sm text-white/60">
                ({seatCount}/{MAX_SEATS})
              </span>
            </h2>
            {isHost ? (
              <button
                className={quietButton}
                disabled={seatCount >= MAX_SEATS}
                onClick={() => run({ type: "addBot" })}
                type="button"
              >
                + Add bot
              </button>
            ) : null}
          </div>

          <ul className="space-y-2">
            {view.seats.map((seat) => (
              <li
                className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-4 py-2.5"
                key={seat.id}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full font-semibold text-sm",
                      seat.kind === "bot"
                        ? "bg-white/15"
                        : "bg-amber-300 text-emerald-950",
                    )}
                  >
                    {seat.kind === "bot" ? "AI" : seat.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate">{seat.name}</span>
                  {seat.id === view.you ? (
                    <span className="text-white/50 text-xs">you</span>
                  ) : null}
                  {seat.isHost ? (
                    <span className="rounded-full bg-amber-300/20 px-2 py-0.5 text-amber-300 text-xs">
                      host
                    </span>
                  ) : null}
                  {seat.connected ? null : (
                    <span className="text-white/50 text-xs">offline</span>
                  )}
                </div>
                {isHost && seat.id !== view.you ? (
                  <button
                    aria-label={`Remove ${seat.name}`}
                    className="size-8 shrink-0 rounded-full text-white/60 hover:bg-white/10 hover:text-white"
                    onClick={() => run({ seatId: seat.id, type: "removeSeat" })}
                    type="button"
                  >
                    ✕
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-4 rounded-2xl bg-white/5 p-5" data-rules>
          <h2 className="font-semibold text-lg">Rules</h2>
          <Stepper
            disabled={!isHost}
            label="Cards each"
            max={view.maxCardsPerPlayer}
            min={1}
            onChange={(cardsPerPlayer) => run({ cardsPerPlayer, type: "setSettings" })}
            value={view.settings.cardsPerPlayer}
          />
          <p className="text-white/50 text-xs">
            With {Math.max(seatCount, MIN_SEATS)} players the most is{" "}
            {view.maxCardsPerPlayer}. One card goes in the centre and the rest
            is the bank. On your turn, play a card with the same number or sign
            as the centre, or take a card from the bank (you can do that any
            time, and it ends your turn).
          </p>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-white/80">Jokers</p>
              <p className="text-white/50 text-xs">
                Red and black joker (54 cards). A joker makes the next player
                take 4.
              </p>
            </div>
            <Switch
              checked={view.settings.jokers}
              disabled={!isHost}
              label="Jokers"
              onChange={(jokers) => run({ jokers, type: "setSettings" })}
            />
          </div>

          <div className="space-y-2">
            <p className="text-white/80">When someone plays their last card</p>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How a set ends">
              <Choice
                active={view.settings.endMode === "first"}
                description="The game stops. They win."
                disabled={!isHost}
                label="Stop"
                onClick={() => run({ endMode: "first", type: "setSettings" })}
              />
              <Choice
                active={view.settings.endMode === "ranking"}
                description="The others carry on. Everyone is ranked 1st, 2nd, 3rd…"
                disabled={!isHost}
                label="Keep going"
                onClick={() => run({ endMode: "ranking", type: "setSettings" })}
              />
            </div>
          </div>

          {view.settings.endMode === "ranking" ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-white/80">Eliminate the loser</p>
                <p className="text-white/50 text-xs">
                  After each set the last player is out for the next one, until
                  two are left: the final. The eliminated come back for the
                  next round after the final.
                  {seatCount < 3 ? " Needs at least 3 players to be useful." : ""}
                </p>
              </div>
              <Switch
                checked={view.settings.elimination}
                disabled={!isHost}
                label="Eliminate the loser"
                onChange={(elimination) => run({ elimination, type: "setSettings" })}
              />
            </div>
          ) : null}

          <details className="rounded-xl bg-white/5 px-4 py-3 text-sm text-white/70">
            <summary className="cursor-pointer font-medium text-white/80">
              Special cards
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              <li>A: the next player is stopped; the one after plays.</li>
              <li>2: goes on anything, on top of the pile or under it (the centre card then stays).</li>
              <li>
                7: the next player takes 2 from the bank. Joker: takes 4. They
                can answer with a 7 or a joker to add 2 or 4 for the following
                player.
              </li>
              <li>
                Joker: any colour goes on a 7. Otherwise the red joker goes on a
                red card and the black one on a black card.
              </li>
              <li>
                J: goes on anything. The player names a sign; the next player
                must play that sign, a 2 or a J.
              </li>
            </ul>
          </details>
        </section>

        {notice ? (
          <p className="rounded-xl bg-amber-300/15 px-4 py-3 text-center text-amber-200 text-sm">
            {notice}
          </p>
        ) : null}

        {isHost ? (
          <button
            className={`${primaryButton} w-full text-lg`}
            disabled={!canStart}
            onClick={() => run({ type: "start" })}
            type="button"
          >
            {canStart ? "Start the game" : "Add a bot or wait for a friend"}
          </button>
        ) : (
          <p className="rounded-xl bg-white/5 px-4 py-4 text-center text-white/70">
            Waiting for the host to start the game…
          </p>
        )}
      </div>
    </div>
  );
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60",
        checked ? "bg-amber-300" : "bg-white/20",
      )}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-6 rounded-full bg-white shadow transition-transform",
          checked && "translate-x-5",
        )}
      />
    </button>
  );
}

function Choice({
  active,
  description,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-checked={active}
      className={cn(
        "rounded-xl px-3 py-3 text-left transition-colors disabled:cursor-default",
        active ? "bg-amber-300 text-emerald-950" : "bg-white/10 hover:bg-white/15",
      )}
      disabled={disabled}
      onClick={onClick}
      role="radio"
      type="button"
    >
      <span className="block font-semibold">{label}</span>
      <span className={cn("block text-xs", active ? "text-emerald-900/80" : "text-white/60")}>
        {description}
      </span>
    </button>
  );
}
