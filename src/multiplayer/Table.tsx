"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Placement, Suit } from "@/cheque-games/engine";
import { PlayingCard } from "@/components/PlayingCard";
import { type FanCard, PlayingCardFan } from "@/components/PlayingCardFan";
import { cn } from "@/helpers/classname-helper";
import { Chooser, type Choice, isRedSuit, SUIT_SYMBOL } from "./Choosers";
import { CentrePile } from "./CentrePile";
import { type FlightOrigin, queryBox, rotationOf } from "./flights";
import { FlightLayer, type Ghost } from "./FlightLayer";
import type { ClientAction, MoveView, RoomView } from "./protocol";
import { ResultsOverlay } from "./ResultsOverlay";
import { quietButton } from "./ui";

type TableProps = {
  connected: boolean;
  onAction: (action: ClientAction) => Promise<string | null>;
  onLeave: () => void;
  view: RoomView;
};

type Toast = { id: number; text: string; tone: "check" | "info" };

// Card sizes in pixels.
const PILE_CARD_W = 112;
const BANK_CARD_W = 96;
const MINI_CARD_W = 40;

/** More new moves than this at once means we were away: show the table as it is. */
const MAX_REPLAY = 24;
/** Seconds between the cards of a penalty, so each one is seen. */
const PENALTY_STEP = 0.28;

// The fan keeps no pile of its own: the server decides what has been played.
const NO_PLAYED: readonly string[] = [];

/**
 * The blink is plain CSS, so it keeps going whatever the animation library or
 * the browser does. The keyframes are defined once in the table.
 */
const BLINK = { animation: "cheque-blink 0.9s ease-in-out infinite" } as const;
const BLINK_CSS = "@keyframes cheque-blink{0%,100%{opacity:.15}50%{opacity:1}}";

const ordinal = (n: number) => {
  const tens = n % 100;

  if (tens >= 11 && tens <= 13) {
    return `${n}th`;
  }

  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

type DrawMove = Extract<MoveView, { type: "draw" }>;

/**
 * A card taken from the bank. The person who took it sees it rise, turn over
 * and slide into their hand; everybody else sees a face-down card fly to that
 * player.
 */
function drawGhost(
  move: DrawMove,
  you: string,
  delay: number,
  nextKey: () => string,
): Ghost | null {
  const bank = queryBox("[data-bank]");

  if (!bank) {
    return null;
  }

  if (move.seatId === you && move.card) {
    const slot = document.querySelector<HTMLElement>(
      `[data-card-id="${move.card.id}"]`,
    );
    const hand = queryBox("[data-hand]");
    const rect = slot?.getBoundingClientRect();
    const landing =
      slot && rect && rect.width > 0
        ? {
            rotate: rotationOf(slot.parentElement),
            scale: rect.width / BANK_CARD_W,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          }
        : hand
          ? {
              rotate: 0,
              scale: PILE_CARD_W / BANK_CARD_W,
              x: hand.x,
              y: hand.y + hand.height / 2 - 40,
            }
          : null;

    if (!landing) {
      return null;
    }

    return {
      delay,
      duration: 0.85,
      face: { rank: move.card.rank, suit: move.card.suit },
      from: { x: bank.x, y: bank.y },
      fromRotate: 0,
      fromScale: 1,
      key: nextKey(),
      lift: Math.max(1.3, landing.scale * 1.15),
      revealId: move.card.id,
      to: { x: landing.x, y: landing.y },
      toRotate: landing.rotate,
      toScale: landing.scale,
      width: BANK_CARD_W,
    };
  }

  const seat = queryBox(`[data-seat-card="${move.seatId}"]`);

  if (!seat) {
    return null;
  }

  return {
    delay,
    duration: 0.45,
    fadeOut: true,
    from: { x: bank.x, y: bank.y },
    fromRotate: 0,
    fromScale: 1,
    key: nextKey(),
    to: { x: seat.x, y: seat.y },
    toRotate: 0,
    toScale: seat.width / BANK_CARD_W,
    width: BANK_CARD_W,
  };
}

/** The pile is mixed back into the bank: up to eight cards gather, swing and settle on it. */
function mixGhosts(
  move: Extract<MoveView, { type: "reshuffle" }>,
  delay: number,
  nextKey: () => string,
): Ghost[] {
  const bank = queryBox("[data-bank]");
  const pile = queryBox("[data-pile]");

  if (!bank || !pile) {
    return [];
  }

  const count = Math.min(move.count, 8);

  return Array.from({ length: count }, (_, index) => ({
    delay: delay + index * 0.05,
    duration: 0.7,
    from: { x: pile.x, y: pile.y },
    fromRotate: (index % 2 === 0 ? 1 : -1) * (4 + index * 2),
    fromScale: PILE_CARD_W / BANK_CARD_W,
    key: nextKey(),
    to: { x: bank.x, y: bank.y },
    toRotate: 0,
    toScale: 1,
    width: BANK_CARD_W,
    wiggle: (index % 2 === 0 ? 1 : -1) * (34 + ((index * 11) % 28)),
  }));
}

export function Table({ connected, onAction, onLeave, view }: TableProps) {
  const game = view.game;
  const [notice, setNotice] = useState<string | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [stopped, setStopped] = useState<string[]>([]);
  const [choice, setChoice] = useState<Choice | null>(null);
  // Where the player's own cards were on screen when they were played.
  const handOrigins = useRef(
    new Map<string, { at: number; origin: FlightOrigin }>(),
  );
  const tapped = useRef<{ cardId: string; origin: FlightOrigin | null } | null>(null);
  const lastSeq = useRef<number | null>(null);
  const gameKey = useRef<number | null>(null);
  const ghostCount = useRef(0);
  const toastCount = useRef(0);
  const viewRef = useRef(view);

  viewRef.current = view;

  const isMyTurnNow =
    !!game && !game.over && game.currentSeatId === view.you;

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = setTimeout(() => setNotice(null), 2200);

    return () => clearTimeout(timer);
  }, [notice]);

  // The chooser only makes sense while it is still your turn.
  useEffect(() => {
    if (choice && !isMyTurnNow) {
      setChoice(null);
    }
  }, [choice, isMyTurnNow]);

  function toast(text: string, tone: Toast["tone"]) {
    const id = (toastCount.current += 1);

    setToasts((current) => [...current.slice(-2), { id, text, tone }]);
    setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      2600,
    );
  }

  // New moves since the last update. Cards leaving the bank (turning over for
  // the one who took them), the pile being mixed, and the calls: check, games,
  // and "stopped". Played cards are animated by the pile itself. This runs
  // before the screen is painted, so a card that is about to fly in is hidden
  // from the hand from its very first frame.
  useLayoutEffect(() => {
    if (!game) {
      return;
    }

    const moves = game.moves;
    const newest = moves.length > 0 ? moves[moves.length - 1].seq : -1;

    if (gameKey.current !== game.gameId) {
      const opened = gameKey.current === null;

      gameKey.current = game.gameId;
      // A brand new set: its moves start again from zero. Opening the page in
      // the middle of a game: nothing to replay.
      lastSeq.current = opened ? newest : -1;

      if (opened) {
        return;
      }
    }

    const previous = lastSeq.current ?? newest;

    lastSeq.current = newest;

    if (newest <= previous) {
      return;
    }

    const fresh = moves.filter((move) => move.seq > previous);

    // Back after a long gap: just show the table as it is.
    if (fresh.length > MAX_REPLAY) {
      return;
    }

    const current = viewRef.current;
    const nameOf = (id: string) =>
      current.seats.find((seat) => seat.id === id)?.name ?? "Someone";
    const nextKey = () => `ghost-${(ghostCount.current += 1)}`;
    const made: Ghost[] = [];
    const stops: string[] = [];
    let cursor = 0;

    for (const move of fresh) {
      if (move.type === "draw") {
        const ghost = drawGhost(move, current.you, cursor, nextKey);

        if (ghost) {
          made.push(ghost);
        }

        cursor += move.forced ? PENALTY_STEP : 0.2;
      } else if (move.type === "reshuffle") {
        made.push(...mixGhosts(move, 0.45 + cursor, nextKey));
      } else if (move.type === "skip") {
        stops.push(move.seatId);

        if (move.seatId === current.you) {
          toast("You are stopped! Your turn is skipped.", "info");
        }
      } else if (move.type === "check" && move.seatId !== current.you) {
        toast(`${nameOf(move.seatId)} says CHECK!`, "check");
      } else if (move.type === "games" && move.seatId !== current.you) {
        toast(`${nameOf(move.seatId)} says GAMES! (${ordinal(move.rank)})`, "info");
      } else if (move.type === "tie") {
        toast(
          `Tie! ${move.seatIds.map(nameOf).join(" and ")} take ${move.cards} cards each`,
          "info",
        );
      }
    }

    if (made.length > 0) {
      setGhosts((existing) => [...existing, ...made]);
    }

    if (stops.length > 0) {
      setStopped((existing) => [...existing, ...stops]);
      setTimeout(
        () =>
          setStopped((existing) => {
            const rest = [...existing];

            for (const id of stops) {
              const at = rest.indexOf(id);

              if (at !== -1) {
                rest.splice(at, 1);
              }
            }

            return rest;
          }),
        2000,
      );
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: moves are deduplicated by their number
  }, [game?.moves, game?.gameId]);

  if (!game) {
    return null;
  }

  const isHost = view.hostId === view.you;
  const others = view.seats.filter((seat) => seat.id !== view.you);
  const me = view.seats.find((seat) => seat.id === view.you);
  const iAmPlaying = me?.inGame ?? false;
  const iFinished = iAmPlaying && me?.rank != null && !game.over;
  const iAmSittingOut = iAmPlaying && (me?.sittingOut ?? false) && !game.over;
  const iAmWatching = !iAmPlaying || iFinished || iAmSittingOut;
  const isMyTurn = isMyTurnNow && iAmPlaying;
  const hasPlay = game.playableIds.length > 0;
  const currentName =
    view.seats.find((seat) => seat.id === game.currentSeatId)?.name ?? "Someone";
  const handCards: FanCard[] = game.hand;
  /** On check: down to their last card (the table announces it by itself). */
  const onCheck = (seat: (typeof view.seats)[number]) =>
    !game.over &&
    seat.inGame &&
    seat.rank === null &&
    !seat.sittingOut &&
    (seat.checked || seat.handCount === 1);
  const hiddenIds = ghosts.flatMap((ghost) => (ghost.revealId ? [ghost.revealId] : []));
  const unplayable = isMyTurn
    ? game.hand.filter((card) => !game.playableIds.includes(card.id)).map((card) => card.id)
    : [];
  const recent = game.log.slice(-3);
  const { tournament, settings } = view;

  async function run(action: ClientAction) {
    const error = await onAction(action);

    if (error) {
      setNotice(error);
    }
  }

  /** Where the card is on screen right now, so its flight starts from there. */
  function captureOrigin(cardId: string): FlightOrigin | null {
    const element = document.querySelector<HTMLElement>(
      `[data-card-id="${cardId}"]`,
    );
    const rect = element?.getBoundingClientRect();

    if (!element || !rect || rect.width === 0) {
      return null;
    }

    return {
      rotate: rotationOf(element.parentElement),
      scale: 1,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  async function sendPlay(
    cardId: string,
    extra: { placement?: Placement; suit?: Suit },
  ) {
    const origin =
      tapped.current?.cardId === cardId ? tapped.current.origin : captureOrigin(cardId);

    if (origin) {
      handOrigins.current.set(cardId, { at: Date.now(), origin });
    }

    tapped.current = null;

    const error = await onAction({ cardId, type: "play", ...extra });

    if (error) {
      handOrigins.current.delete(cardId);
      setNotice(error);
    }
  }

  /** A tap on a card. A 2 or a jack first asks what to do with it. */
  function playFromHand(card: FanCard) {
    tapped.current = { cardId: card.id, origin: captureOrigin(card.id) };

    const playable = game?.playableIds.includes(card.id) ?? false;

    if (playable && card.rank === "2") {
      setChoice({ cardId: card.id, kind: "two" });

      return;
    }

    if (playable && card.rank === "J") {
      setChoice({ cardId: card.id, kind: "jack" });

      return;
    }

    // Anything else goes straight away (or is refused with the reason).
    void sendPlay(card.id, {});
  }

  /** Where a card that just landed on the pile came from, in screen coordinates. */
  function originFor(cardId: string): FlightOrigin | null {
    const move = game?.moves.find(
      (candidate): candidate is Extract<MoveView, { type: "play" }> =>
        candidate.type === "play" && candidate.card.id === cardId,
    );

    if (!move || typeof document === "undefined") {
      return null;
    }

    if (move.seatId === view.you) {
      const saved = handOrigins.current.get(cardId);

      if (saved && Date.now() - saved.at < 6000) {
        return saved.origin;
      }

      // Played from another tab, say: come up from the middle of the hand.
      const hand = queryBox("[data-hand]");

      return hand
        ? { rotate: 0, scale: 1, x: hand.x, y: hand.y + hand.height / 2 - 40 }
        : null;
    }

    const seat = queryBox(`[data-seat-card="${move.seatId}"]`);

    return seat
      ? { rotate: 0, scale: seat.width / PILE_CARD_W, x: seat.x, y: seat.y }
      : null;
  }

  const penaltyForMe = isMyTurn && game.pending > 0;

  let hint = "";

  if (game.over) {
    hint = "";
  } else if (!iAmPlaying) {
    hint = `Watching. ${currentName} is playing…`;
  } else if (iFinished) {
    hint = `You finished ${ordinal(me?.rank ?? 1)}. Watching the others.`;
  } else if (isMyTurn) {
    if (game.pending > 0) {
      hint = hasPlay
        ? `Answer with a 7 or a joker to pass it on, or take ${game.pending} cards.`
        : `You have no 7 or joker. Take ${game.pending} cards from the bank.`;
    } else if (game.demand) {
      hint = hasPlay
        ? `${game.demand} were asked for. Play one, a 2 or a J, or take a card.`
        : `No ${game.demand}, 2 or J. Take a card from the bank.`;
    } else {
      hint = hasPlay
        ? "Your turn. Play a card, or tap the bank to take one instead."
        : "No card matches. Tap the bank to take one.";
    }
  } else {
    hint = `${currentName} is playing…`;
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-emerald-950 text-white">
      <style>{BLINK_CSS}</style>
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-white/10 px-3 py-1 font-semibold text-sm tracking-widest">
            {view.code}
          </span>
          {settings.elimination ? (
            <span
              className={cn(
                "rounded-full px-3 py-1 font-semibold text-xs tracking-widest",
                tournament.finalSet ? "bg-amber-300 text-emerald-950" : "bg-white/10",
              )}
              data-set-badge
            >
              {tournament.finalSet ? "FINAL" : `SET ${tournament.set}`}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {connected ? null : (
            <span className="text-amber-300 text-xs">Reconnecting…</span>
          )}
          <button className={quietButton} onClick={onLeave} type="button">
            Leave
          </button>
        </div>
      </div>

      <div className="flex flex-wrap justify-center gap-3 px-4 pt-1">
        {others.map((seat) => (
          <div
            className={cn(
              "relative flex min-w-[92px] flex-col items-center gap-2 rounded-2xl px-3 py-3 transition-colors",
              seat.isCurrent ? "bg-white/15" : "bg-white/5",
              seat.connected ? "" : "opacity-60",
              (!seat.inGame || seat.sittingOut) && "opacity-45",
            )}
            data-checked={onCheck(seat) ? "true" : "false"}
            data-seat={seat.id}
            key={seat.id}
          >
            {onCheck(seat) ? (
              <div
                className="pointer-events-none absolute inset-0 rounded-2xl bg-amber-300/15 ring-2 ring-amber-300"
                data-check-blink
                style={BLINK}
              />
            ) : null}
            <span className="max-w-[110px] truncate font-medium text-sm">
              {seat.name}
            </span>
            <div className="relative" data-seat-card={seat.id}>
              <PlayingCard faceDown rank="A" suit="spades" width={MINI_CARD_W} />
              <span className="absolute -right-2 -bottom-2 flex size-6 items-center justify-center rounded-full bg-white font-semibold text-emerald-950 text-xs tabular-nums">
                {seat.handCount}
              </span>
              {seat.rank !== null ? (
                <span
                  className="-left-3 -top-3 absolute rounded-full bg-amber-300 px-1.5 py-0.5 font-bold text-[10px] text-emerald-950"
                  data-rank-badge
                >
                  {ordinal(seat.rank)}
                </span>
              ) : null}
            </div>
            {onCheck(seat) ? (
              <span
                className="font-bold text-amber-300 text-xs tracking-wider"
                data-check-label
                style={BLINK}
              >
                CHECK!
              </span>
            ) : (
              <span className="invisible font-bold text-xs tracking-wider">CHECK!</span>
            )}
            {stopped.includes(seat.id) ? (
              <motion.span
                animate={{ opacity: 1, scale: 1 }}
                className="-bottom-2 absolute rounded-full bg-red-500 px-2 py-0.5 font-bold text-[10px] tracking-wider"
                data-stopped
                initial={{ opacity: 0, scale: 0.6 }}
              >
                STOPPED
              </motion.span>
            ) : null}
            {seat.eliminated ? (
              <span className="font-semibold text-red-200 text-[10px] tracking-wider">
                OUT
              </span>
            ) : seat.sittingOut && !game.over ? (
              <span
                className="font-semibold text-[10px] text-white/70 tracking-wider"
                data-sitting-out
              >
                WAITING
              </span>
            ) : null}
            {!seat.connected && seat.kind === "human" ? (
              <div className="flex flex-col items-center gap-1">
                <span className="text-white/60 text-xs">offline</span>
                {isHost && seat.inGame && !game.over ? (
                  <button
                    className="rounded-full bg-white/15 px-2.5 py-1 text-xs hover:bg-white/25"
                    onClick={() => run({ seatId: seat.id, type: "replaceWithBot" })}
                    type="button"
                  >
                    Replace with bot
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* Above the hand, so cards flying up from it are never hidden by it. */}
      <div className="relative z-30 flex flex-1 flex-col items-center justify-center gap-4 px-4 py-4">
        <div
          aria-live="assertive"
          className="flex min-h-[2.25rem] flex-col items-center justify-center gap-1"
          data-toasts
        >
          <AnimatePresence>
            {toasts.map((item) => (
              <motion.div
                animate={{ opacity: 1, scale: 1, y: 0 }}
                className={cn(
                  "rounded-full px-5 py-1.5 font-bold text-sm tracking-wide shadow-lg",
                  item.tone === "check"
                    ? "bg-amber-300 text-emerald-950"
                    : "bg-white/90 text-emerald-950",
                )}
                data-toast={item.tone}
                exit={{ opacity: 0 }}
                initial={{ opacity: 0, scale: 0.9, y: -10 }}
                key={item.id}
              >
                {item.text}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex flex-col items-center gap-2">
            <button
              aria-label={
                penaltyForMe
                  ? `Take ${game.pending} cards from the bank`
                  : "Take a card from the bank"
              }
              className={cn(
                "rounded-[10px] transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
                game.canDraw
                  ? hasPlay
                    ? "cursor-pointer ring-2 ring-white/50 hover:-translate-y-1"
                    : "cursor-pointer ring-4 ring-amber-300 hover:-translate-y-1"
                  : "cursor-default opacity-90",
              )}
              data-bank
              disabled={!game.canDraw}
              onClick={() => run({ type: "draw" })}
              type="button"
            >
              <PlayingCard faceDown rank="A" suit="spades" width={BANK_CARD_W} />
            </button>
            <span className="text-white/70 text-xs" data-bank-label>
              {penaltyForMe ? `Take ${game.pending}` : `Bank · ${game.bankCount}`}
            </span>
          </div>

          <CentrePile
            cardWidth={PILE_CARD_W}
            cards={game.pile}
            originFor={originFor}
          />
        </div>

        <div className="flex min-h-7 flex-wrap items-center justify-center gap-2">
          {game.pending > 0 ? (
            <span
              className="rounded-full bg-red-500/90 px-3 py-1 font-semibold text-xs"
              data-chip="pending"
            >
              {isMyTurn
                ? `You take ${game.pending}`
                : `${currentName} takes ${game.pending}`}
              {" "}· a 7 or joker passes it on
            </span>
          ) : null}
          {game.demand ? (
            <span
              className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1 font-semibold text-emerald-950 text-xs"
              data-chip="demand"
            >
              Asked for
              <span
                className={cn(
                  "text-base leading-none",
                  isRedSuit(game.demand) ? "text-[#c22f2f]" : "text-[#23262d]",
                )}
              >
                {SUIT_SYMBOL[game.demand]}
              </span>
              {game.demand}
            </span>
          ) : null}
        </div>

        <div aria-live="polite" className="min-h-[60px] space-y-0.5 text-center text-sm">
          {notice ? (
            <p className="font-medium text-amber-300">{notice}</p>
          ) : (
            recent.map((line, index) => (
              <p
                className={
                  index === recent.length - 1 ? "text-white/90" : "text-white/45"
                }
                key={`${recent.length - index}-${line}`}
              >
                {line}
              </p>
            ))
          )}
        </div>

        <p className="min-h-5 text-center text-white/60 text-xs" data-hint>
          {hint}
        </p>
      </div>

      <div className="relative z-20">
        {me && onCheck(me) ? (
          <div className="absolute inset-x-0 -top-2 z-[200] flex justify-center">
            <span
              className="rounded-full bg-white/15 px-5 py-2 font-bold text-amber-300 tracking-wider"
              data-my-check
              style={BLINK}
            >
              CHECK!
            </span>
          </div>
        ) : null}
        <div
          className={cn(
            iAmWatching ? "h-[150px]" : "h-[260px] overflow-hidden",
            !isMyTurn && !iAmWatching && "opacity-70",
          )}
          data-hand
        >
          {iAmWatching ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center"
              data-watching
            >
              <p className="font-semibold">
                {iAmSittingOut
                  ? "You are sitting this one out"
                  : iAmPlaying
                    ? `You played your last card (${ordinal(me?.rank ?? 1)})`
                    : me?.eliminated
                    ? "You are eliminated for this set"
                    : "You are watching"}
              </p>
              <p className="text-sm text-white/60">
                {iAmSittingOut
                  ? "Players who finished together are playing it off."
                  : iAmPlaying
                    ? settings.endMode === "first"
                      ? "The others finish the round."
                      : "The others are still playing."
                    : "You come back after the final."}
              </p>
            </div>
          ) : (
            <PlayingCardFan
              cards={handCards}
              dimmedIds={unplayable}
              hiddenIds={hiddenIds}
              onPlay={playFromHand}
              playedIds={NO_PLAYED}
            />
          )}
        </div>
      </div>

      <FlightLayer
        ghosts={ghosts}
        onDone={(key) =>
          setGhosts((current) => current.filter((ghost) => ghost.key !== key))
        }
      />

      {choice ? (
        <Chooser
          choice={choice}
          onCancel={() => {
            tapped.current = null;
            setChoice(null);
          }}
          onPlacement={(placement) => {
            setChoice(null);
            void sendPlay(choice.cardId, { placement });
          }}
          onSuit={(suit) => {
            setChoice(null);
            void sendPlay(choice.cardId, { suit });
          }}
        />
      ) : null}

      {game.over ? (
        <ResultsOverlay onAction={(action) => void run(action)} onLeave={onLeave} view={view} />
      ) : null}
    </div>
  );
}
