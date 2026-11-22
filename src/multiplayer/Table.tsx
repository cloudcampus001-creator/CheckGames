"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Placement, Suit } from "@/cheque-games/engine";
import { PlayingCard } from "@/components/PlayingCard";
import { type FanCard, PlayingCardFan } from "@/components/PlayingCardFan";
import { cn } from "@/helpers/classname-helper";
import { Chooser, type Choice, isRedSuit, SUIT_SYMBOL } from "./Choosers";
import { CentrePile } from "./CentrePile";
import { ChatDrawer, useUnread } from "./Chat";
import { ChatButton, SoundButton } from "./Dock";
import { type FlightOrigin, queryBox, rotationOf } from "./flights";
import { FlightLayer, type Ghost } from "./FlightLayer";
import type { ClientAction, MoveView, RoomView } from "./protocol";
import { ReactionLayer, ReactionTray } from "./Reactions";
import { ResultsOverlay } from "./ResultsOverlay";
import { StackTray } from "./StackTray";
import { TurnClock } from "./TurnClock";
import { buzz, playSfx, type Sfx } from "./sound";
import { quietButton } from "./ui";

type TableProps = {
  connected: boolean;
  onAction: (action: ClientAction) => Promise<string | null>;
  onLeave: () => void;
  view: RoomView;
};

type Toast = { id: number; text: string; tone: "check" | "info" };

/** A card the player just played, shown on the pile before the server has answered. */
type Pending = { cardIds: string[]; placement: Placement };

// Card sizes in pixels.
const PILE_CARD_W = 112;
const BANK_CARD_W = 96;
const MINI_CARD_W = 40;

/** More new moves than this at once means we were away: show the table as it is. */
const MAX_REPLAY = 24;
/** Seconds between the cards of a penalty, so each one is seen. */
const PENALTY_STEP = 0.28;
/** How long a chat bubble stays over a player. */
const BUBBLE_MS = 4500;

// The fan keeps no pile of its own: the server decides what has been played.
const NO_PLAYED: readonly string[] = [];

/**
 * The blink is plain CSS, so it keeps going whatever the animation library or
 * the browser does. It only changes opacity, which the graphics card can do
 * without repainting anything. The keyframes are defined once in the table.
 */
const BLINK = { animation: "cheque-blink 0.9s ease-in-out infinite" } as const;
const BLINK_CSS = "@keyframes cheque-blink{0%,100%{opacity:.15}50%{opacity:1}}";

/** A bright colour for each seat's initial, picked from the seat's position. */
const SEAT_COLOURS = [
  "bg-amber-300",
  "bg-rose-300",
  "bg-sky-300",
  "bg-lime-300",
  "bg-fuchsia-300",
  "bg-orange-300",
];

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
      duration: 0.75,
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
    duration: 0.4,
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
  const [pending, setPending] = useState<Pending | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Doubling: the cards lifted out of the hand to be played together (bottom first).
  const [stack, setStack] = useState<string[]>([]);
  const [shake, setShake] = useState(0);
  const [confirmKick, setConfirmKick] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Record<string, { id: number; text: string }>>({});
  // Where the player's own cards were on screen when they were played.
  const handOrigins = useRef(
    new Map<string, { at: number; origin: FlightOrigin }>(),
  );
  const tapped = useRef<{ cardId: string; origin: FlightOrigin | null } | null>(null);
  const lastSeq = useRef<number | null>(null);
  const gameKey = useRef<number | null>(null);
  const lastChat = useRef<number | null>(null);
  const wasMyTurn = useRef(false);
  const ghostCount = useRef(0);
  const toastCount = useRef(0);
  const viewRef = useRef(view);
  // The fan is only redrawn when its cards change, so it gets one function that never changes.
  const playRef = useRef<(card: FanCard) => void>(() => {});
  const onPlayStable = useCallback((card: FanCard) => playRef.current(card), []);
  const holdRef = useRef<(card: FanCard) => void>(() => {});
  const onHoldStable = useCallback((card: FanCard) => holdRef.current(card), []);

  viewRef.current = view;

  const isMyTurnNow =
    !!game && !game.over && game.currentSeatId === view.you;
  const unread = useUnread(view.chat, chatOpen, view.you);

  const nameOf = useCallback(
    (id: string) => view.seats.find((seat) => seat.id === id)?.name ?? "Someone",
    [view.seats],
  );
  const sendChat = useCallback(
    (text: string) => onAction({ text, type: "chat" }),
    [onAction],
  );

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

  // A played card shows on the pile at once. It stays that way until the
  // server's table has the card (it is gone from the hand), or the move failed.
  useEffect(() => {
    if (pending && !pending.cardIds.some((id) => game?.hand.some((card) => card.id === id))) {
      setPending(null);
    }
  }, [pending, game?.hand]);

  // A lifted stack only makes sense on your own turn.
  useEffect(() => {
    if (stack.length > 0 && !isMyTurnNow) {
      setStack([]);
    }
  }, [stack, isMyTurnNow]);

  useEffect(() => {
    if (!pending) {
      return;
    }

    const timer = setTimeout(() => setPending(null), 6000);

    return () => clearTimeout(timer);
  }, [pending]);

  // Your turn: a chime, a buzz on phones, and the tab title when the page is in the background.
  useEffect(() => {
    if (isMyTurnNow && !wasMyTurn.current) {
      playSfx("turn");
      buzz(35);
    }

    wasMyTurn.current = isMyTurnNow;
  }, [isMyTurnNow]);

  useEffect(() => {
    const base = "Cheque-games";
    const update = () => {
      document.title = isMyTurnNow && document.hidden ? "▶ Your turn! · Cheque-games" : base;
    };

    update();
    document.addEventListener("visibilitychange", update);

    return () => {
      document.removeEventListener("visibilitychange", update);
      document.title = base;
    };
  }, [isMyTurnNow]);

  // New chat lines show as a bubble over whoever wrote them.
  useEffect(() => {
    const newest = view.chat.length > 0 ? view.chat[view.chat.length - 1].id : 0;

    if (lastChat.current === null) {
      lastChat.current = newest;

      return;
    }

    const fresh = view.chat.filter(
      (message) => message.id > (lastChat.current as number) && message.seatId !== null,
    );

    lastChat.current = newest;

    if (fresh.length === 0) {
      return;
    }

    setBubbles((current) => {
      const next = { ...current };

      for (const message of fresh) {
        next[message.seatId as string] = { id: message.id, text: message.text };
      }

      return next;
    });

    if (fresh.some((message) => message.seatId !== view.you)) {
      playSfx("chat");
    }

    const timer = setTimeout(
      () =>
        setBubbles((current) => {
          const next = { ...current };

          for (const message of fresh) {
            if (next[message.seatId as string]?.id === message.id) {
              delete next[message.seatId as string];
            }
          }

          return next;
        }),
      BUBBLE_MS,
    );

    return () => clearTimeout(timer);
  }, [view.chat, view.you]);

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
    const nameFor = (id: string) =>
      current.seats.find((seat) => seat.id === id)?.name ?? "Someone";
    const nextKey = () => `ghost-${(ghostCount.current += 1)}`;
    const made: Ghost[] = [];
    const stops: string[] = [];
    const sounds = new Set<Sfx>();
    let cursor = 0;

    for (const move of fresh) {
      if (move.type === "play") {
        // Your own card already made its sound when you tapped it.
        if (move.seatId !== current.you) {
          sounds.add("play");
        }
      } else if (move.type === "draw") {
        const ghost = drawGhost(move, current.you, cursor, nextKey);

        sounds.add("draw");

        if (ghost) {
          made.push(ghost);
        }

        cursor += move.forced ? PENALTY_STEP : 0.2;
      } else if (move.type === "reshuffle") {
        made.push(...mixGhosts(move, 0.45 + cursor, nextKey));
        sounds.add("shuffle");
      } else if (move.type === "skip") {
        stops.push(move.seatId);
        sounds.add("stop");

        if (move.seatId === current.you) {
          toast("You are stopped! Your turn is skipped.", "info");
        }
      } else if (move.type === "check") {
        sounds.add("check");

        if (move.seatId !== current.you) {
          toast(`${nameFor(move.seatId)} says CHECK!`, "check");
        }
      } else if (move.type === "games") {
        sounds.add("games");

        if (move.seatId !== current.you) {
          toast(`${nameFor(move.seatId)} says GAMES! (${ordinal(move.rank)})`, "info");
        }
      } else if (move.type === "tie") {
        toast(
          `Tie! ${move.seatIds.map(nameFor).join(" and ")} take ${move.cards} cards each`,
          "info",
        );
      }
    }

    [...sounds].forEach((name, index) => setTimeout(() => playSfx(name), index * 110));

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

  // The card just played is already on the pile, and gone from the hand.
  const playedCards = pending
    ? pending.cardIds.flatMap((id) => game.hand.filter((card) => card.id === id))
    : [];
  const optimistic =
    pending && playedCards.length > 0 ? { cards: playedCards, placement: pending.placement } : null;
  const stackCards = stack.flatMap((id) => game.hand.filter((card) => card.id === id));
  const liftedIds = new Set([...stack, ...(optimistic?.cards.map((card) => card.id) ?? [])]);
  const handCards: FanCard[] = game.hand.filter((card) => !liftedIds.has(card.id));
  const pileCards = optimistic
    ? optimistic.placement === "under"
      ? [...game.pile.slice(0, -1), ...optimistic.cards, game.pile[game.pile.length - 1]]
      : [...game.pile, ...optimistic.cards]
    : game.pile;
  const stackRank = stackCards[0]?.rank ?? null;

  const isMyTurn = isMyTurnNow && iAmPlaying && !optimistic;
  const hasPlay = game.playableIds.length > 0;
  const currentName =
    view.seats.find((seat) => seat.id === game.currentSeatId)?.name ?? "Someone";
  /** On check: down to their last card (the table announces it by itself). */
  const onCheck = (seat: (typeof view.seats)[number]) =>
    !game.over &&
    seat.inGame &&
    seat.rank === null &&
    !seat.sittingOut &&
    (seat.checked || seat.handCount === 1);
  const hiddenIds = ghosts.flatMap((ghost) => (ghost.revealId ? [ghost.revealId] : []));
  const unplayable =
    stackRank !== null
      ? handCards.filter((card) => card.rank !== stackRank).map((card) => card.id)
      : isMyTurn
        ? game.hand.filter((card) => !game.playableIds.includes(card.id)).map((card) => card.id)
        : [];
  const recent = game.log.slice(-3);
  const { tournament, settings } = view;
  const canTake = game.canDraw && !optimistic && !drawing;

  async function run(action: ClientAction) {
    const error = await onAction(action);

    if (error) {
      setNotice(error);
    }
  }

  async function takeCard() {
    if (!canTake) {
      return;
    }

    setDrawing(true);
    await run({ type: "draw" });
    setDrawing(false);
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
    stackIds?: string[],
  ) {
    const ids = stackIds && stackIds.length > 1 ? stackIds : [cardId];

    for (const id of ids) {
      const origin =
        ids.length === 1 && tapped.current?.cardId === id ? tapped.current.origin : captureOrigin(id);

      if (origin) {
        handOrigins.current.set(id, { at: Date.now(), origin });
      }
    }

    tapped.current = null;

    // Show the card(s) on the pile right now; the server's answer follows.
    const allowed = game?.playableIds.includes(cardId) ?? false;

    if (allowed) {
      setPending({ cardIds: ids, placement: extra.placement ?? "top" });
      setStack([]);
      playSfx("play");
    }

    const error = await onAction({
      cardId,
      type: "play",
      ...(ids.length > 1 ? { cardIds: ids } : {}),
      ...extra,
    });

    if (error) {
      for (const id of ids) {
        handOrigins.current.delete(id);
      }

      setPending(null);
      setNotice(error);

      // The stack comes back, so it can be changed and tried again.
      if (ids.length > 1) {
        setStack(ids);
      }
    }
  }

  function shakeStack(message?: string) {
    setShake((count) => count + 1);
    buzz(40);

    if (message) {
      setNotice(message);
    }
  }

  /** Doubling: a card held down is lifted out of the hand to start (or join) a stack. */
  function holdCard(card: FanCard) {
    if (!view.doubling || !isMyTurn || pending || stack.length > 0) {
      return;
    }

    if (card.rank === "joker") {
      setNotice("Jokers are played alone.");

      return;
    }

    if (!game?.hand.some((other) => other.id !== card.id && other.rank === card.rank)) {
      setNotice("You have no other card with the same number.");
      buzz(40);

      return;
    }

    setStack([card.id]);
    buzz(15);
  }

  /** A tap while a stack is lifted adds a card of the same number, or the stack shakes its head. */
  function addToStack(card: FanCard) {
    if (!stackRank || card.rank !== stackRank || stack.length >= 4) {
      shakeStack();

      return;
    }

    setStack((current) => [...current, card.id]);
  }

  function playStack() {
    if (stackCards.length < 2) {
      setStack([]);

      return;
    }

    const bottom = stackCards[0];

    if (!game?.playableIds.includes(bottom.id)) {
      shakeStack(
        "The bottom card must match the centre card. Tap a card to put it back, then add the cards in another order.",
      );

      return;
    }

    const ids = stackCards.map((card) => card.id);

    if (bottom.rank === "J") {
      setChoice({ cardId: bottom.id, cardIds: ids, kind: "jack" });

      return;
    }

    void sendPlay(bottom.id, {}, ids);
  }

  /** A tap on a card. A 2 or a jack first asks what to do with it. */
  function playFromHand(card: FanCard) {
    if (pending) {
      return;
    }

    if (stack.length > 0) {
      addToStack(card);

      return;
    }

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

  playRef.current = playFromHand;
  holdRef.current = holdCard;

  /** Where a card that just landed on the pile came from, in screen coordinates. */
  function originFor(cardId: string): FlightOrigin | null {
    const move = game?.moves.find(
      (candidate): candidate is Extract<MoveView, { type: "play" }> =>
        candidate.type === "play" && candidate.card.id === cardId,
    );
    // Cards played a moment ago have no move yet: they are still on their way to the server.
    const fromMe = move ? move.seatId === view.you : pending?.cardIds.includes(cardId) === true;

    if (!move && !fromMe) {
      return null;
    }

    if (typeof document === "undefined") {
      return null;
    }

    if (fromMe) {
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

    const seat = queryBox(`[data-seat-card="${move?.seatId}"]`);

    return seat
      ? { rotate: 0, scale: seat.width / PILE_CARD_W, x: seat.x, y: seat.y }
      : null;
  }

  const penaltyForMe = isMyTurn && game.pending > 0;
  const demandColour = game.demand ? (isRedSuit(game.demand) ? "red" : "black") : null;

  let hint = "";

  if (game.over) {
    hint = "";
  } else if (!iAmPlaying) {
    hint = `Watching. ${currentName} is playing…`;
  } else if (iFinished) {
    hint = `You finished ${ordinal(me?.rank ?? 1)}. Watching the others.`;
  } else if (optimistic) {
    hint = "Played!";
  } else if (isMyTurn) {
    if (game.pending > 0) {
      hint = hasPlay
        ? `Answer with a 7 or a joker to pass it on, or take ${game.pending} cards.`
        : `You have no 7 or joker. Take ${game.pending} cards from the bank.`;
    } else if (game.demand) {
      hint = hasPlay
        ? `${game.demand} were asked for. Play one, a 2, a J or the ${demandColour} joker, or take a card.`
        : `No ${game.demand}, 2, J or ${demandColour} joker. Take a card from the bank.`;
    } else {
      hint = hasPlay
        ? view.doubling
          ? "Your turn. Tap a card, or hold one to play several of the same number together."
          : "Your turn. Play a card, or tap the bank to take one instead."
        : "No card matches. Tap the bank to take one.";
    }
  } else {
    hint = `${currentName} is playing…`;
  }

  const myBubble = bubbles[view.you];

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden text-white">
      <style>{BLINK_CSS}</style>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="display rounded-full bg-black/25 px-4 py-1.5 text-sm tracking-widest">
            {view.code}
          </span>
          {settings.elimination ? (
            <span
              className={cn(
                "display rounded-full px-3 py-1.5 text-xs tracking-widest",
                tournament.finalSet ? "bg-amber-300 text-emerald-950" : "bg-black/25",
              )}
              data-set-badge
            >
              {tournament.finalSet ? "FINAL" : `SET ${tournament.set}`}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {connected ? null : (
            <span className="font-bold text-amber-300 text-xs">Reconnecting…</span>
          )}
          <SoundButton />
          <ChatButton onClick={() => setChatOpen(true)} unread={unread} />
          <ReactionTray onSend={(emoji) => void onAction({ emoji, type: "react" })} />
          {view.canLeave ? (
            <button className={quietButton} onClick={onLeave} type="button">
              Leave
            </button>
          ) : null}
        </div>
      </div>

      <TurnClock
        endsInMs={view.turnEndsInMs}
        mine={isMyTurnNow}
        name={currentName}
        resetKey={view.version}
        totalSeconds={view.turnSeconds}
      />

      {me?.away ? (
        <div className="pop mx-4 mt-2 flex items-center justify-between gap-3 rounded-2xl bg-rose-500/80 px-4 py-2" data-away>
          <span className="font-bold text-sm">You are away. The table is playing for you.</span>
          <button className="btn btn-soft" onClick={() => void run({ type: "back" })} type="button">
            I am back
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-center gap-3 px-3 pt-4">
        {others.map((seat, index) => (
          <div
            className={cn(
              "relative flex min-w-[96px] flex-col items-center gap-1.5 rounded-3xl border-2 px-3 pt-3 pb-2.5 transition-colors",
              seat.isCurrent
                ? "border-amber-300 bg-amber-300/20 shadow-[0_4px_0_rgba(184,125,0,0.7)]"
                : "border-white/10 bg-black/20",
              seat.connected ? "" : "opacity-60",
              (!seat.inGame || seat.sittingOut) && "opacity-45",
            )}
            data-checked={onCheck(seat) ? "true" : "false"}
            data-react-anchor={seat.id}
            data-seat={seat.id}
            key={seat.id}
          >
            {onCheck(seat) ? (
              <div
                className="pointer-events-none absolute inset-0 rounded-3xl bg-amber-300/20 ring-4 ring-amber-300"
                data-check-blink
                style={BLINK}
              />
            ) : null}
            {seat.isCurrent && !game.over ? (
              <span
                aria-hidden="true"
                className="-top-3 -translate-x-1/2 absolute left-1/2 text-amber-300 text-sm leading-none"
              >
                ▼
              </span>
            ) : null}
            {isHost && !game.over && !view.matchmade ? (
              confirmKick === seat.id ? (
                <div className="absolute -top-3 -right-2 z-40 flex gap-1">
                  <button
                    className="display rounded-full bg-rose-500 px-2 py-0.5 text-[10px]"
                    data-kick-confirm
                    onClick={() => {
                      setConfirmKick(null);
                      void run({ seatId: seat.id, type: "kickPlayer" });
                    }}
                    type="button"
                  >
                    Remove
                  </button>
                  <button
                    className="display rounded-full bg-black/60 px-2 py-0.5 text-[10px]"
                    onClick={() => setConfirmKick(null)}
                    type="button"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  aria-label={`Remove ${seat.name} from the game`}
                  className="absolute -top-2 -right-2 z-40 grid size-6 place-items-center rounded-full bg-black/60 text-[11px] hover:bg-rose-500"
                  data-kick
                  onClick={() => setConfirmKick(seat.id)}
                  type="button"
                >
                  ✕
                </button>
              )
            ) : null}
            {seat.away ? (
              <span className="display -bottom-2 absolute rounded-full bg-black/60 px-2 py-0.5 text-[10px] tracking-wider">
                AWAY
              </span>
            ) : null}
            {bubbles[seat.id] ? (
              <div
                className="pop -top-9 -translate-x-1/2 absolute left-1/2 z-40 w-max max-w-[170px] rounded-2xl bg-white px-3 py-1 text-center font-bold text-emerald-950 text-xs shadow-[0_3px_0_rgba(0,0,0,0.25)]"
                data-bubble
              >
                <span className="line-clamp-2 break-words">{bubbles[seat.id].text}</span>
              </div>
            ) : null}
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full text-base",
                  seat.kind === "bot"
                    ? "bg-white/25 text-white"
                    : cn(SEAT_COLOURS[index % SEAT_COLOURS.length], "text-emerald-950"),
                )}
              >
                {seat.avatar}
              </span>
              <span className="max-w-[84px] truncate font-bold text-sm">
                {seat.name}
              </span>
            </div>
            <div className="relative" data-seat-card={seat.id}>
              <PlayingCard faceDown rank="A" suit="spades" width={MINI_CARD_W} />
              <span className="display absolute -right-2 -bottom-2 flex size-6 items-center justify-center rounded-full bg-amber-300 text-emerald-950 text-xs tabular-nums shadow-[0_2px_0_rgba(0,0,0,0.3)]">
                {seat.handCount}
              </span>
              {seat.rank !== null ? (
                <span
                  className="display -left-3 -top-3 absolute rounded-full bg-white px-1.5 py-0.5 text-[10px] text-emerald-950"
                  data-rank-badge
                >
                  {ordinal(seat.rank)}
                </span>
              ) : null}
            </div>
            {onCheck(seat) ? (
              <span
                className="display text-amber-300 text-xs tracking-wider"
                data-check-label
                style={BLINK}
              >
                CHECK!
              </span>
            ) : (
              <span className="display invisible text-xs tracking-wider">CHECK!</span>
            )}
            {stopped.includes(seat.id) ? (
              <motion.span
                animate={{ opacity: 1, scale: 1 }}
                className="display -bottom-2 absolute rounded-full bg-rose-500 px-2.5 py-0.5 text-[11px] tracking-wider shadow-[0_2px_0_rgba(0,0,0,0.3)]"
                data-stopped
                initial={{ opacity: 0, scale: 0.6 }}
              >
                STOPPED
              </motion.span>
            ) : null}
            {seat.eliminated ? (
              <span className="display text-[11px] text-rose-200 tracking-wider">
                OUT
              </span>
            ) : seat.sittingOut && !game.over ? (
              <span
                className="display text-[11px] text-white/75 tracking-wider"
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
                    className="rounded-full bg-white/15 px-2.5 py-1 font-semibold text-xs hover:bg-white/25"
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
          className="flex min-h-[2.5rem] flex-col items-center justify-center gap-1"
          data-toasts
        >
          <AnimatePresence>
            {toasts.map((item) => (
              <motion.div
                animate={{ opacity: 1, scale: 1, y: 0 }}
                className={cn(
                  "display rounded-full px-6 py-2 text-lg shadow-[0_4px_0_rgba(0,0,0,0.25)]",
                  item.tone === "check"
                    ? "bg-amber-300 text-emerald-950"
                    : "bg-white text-emerald-950",
                )}
                data-toast={item.tone}
                exit={{ opacity: 0 }}
                initial={{ opacity: 0, scale: 0.85, y: -10 }}
                key={item.id}
              >
                {item.text}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="relative flex items-center gap-6">
          {/* The oval of the table, behind the bank and the pile. */}
          <div
            aria-hidden="true"
            className="-inset-x-3 -inset-y-5 -z-10 absolute rounded-[3rem] border-2 border-white/10 bg-black/15"
          />
          <div className="flex flex-col items-center gap-2">
            <button
              aria-label={
                penaltyForMe
                  ? `Take ${game.pending} cards from the bank`
                  : "Take a card from the bank"
              }
              className={cn(
                "rounded-[10px] transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-95",
                canTake
                  ? hasPlay
                    ? "cursor-pointer ring-2 ring-white/60 hover:-translate-y-1"
                    : "cursor-pointer ring-4 ring-amber-300 hover:-translate-y-1"
                  : "cursor-default opacity-90",
              )}
              data-bank
              disabled={!canTake}
              onClick={() => void takeCard()}
              type="button"
            >
              <PlayingCard faceDown rank="A" suit="spades" width={BANK_CARD_W} />
            </button>
            <span
              className={cn(
                "display rounded-full px-3 py-0.5 text-xs",
                penaltyForMe ? "bg-rose-500 text-white" : "bg-black/25 text-white/80",
              )}
              data-bank-label
            >
              {drawing
                ? "Taking…"
                : penaltyForMe
                  ? `Take ${game.pending}`
                  : `Bank · ${game.bankCount}`}
            </span>
          </div>

          <CentrePile
            cardWidth={PILE_CARD_W}
            cards={pileCards}
            originFor={originFor}
          />
        </div>

        <div className="flex min-h-8 flex-wrap items-center justify-center gap-2">
          {game.pending > 0 ? (
            <span
              className="display pop rounded-full bg-rose-500 px-4 py-1 text-sm shadow-[0_3px_0_rgba(0,0,0,0.25)]"
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
              className="display pop flex items-center gap-1.5 rounded-full bg-white px-4 py-1 text-emerald-950 text-sm shadow-[0_3px_0_rgba(0,0,0,0.25)]"
              data-chip="demand"
            >
              Asked for
              <span
                className={cn(
                  "text-xl leading-none",
                  isRedSuit(game.demand) ? "text-[#d6303a]" : "text-[#23262d]",
                )}
              >
                {SUIT_SYMBOL[game.demand]}
              </span>
              {game.demand}
              <span className="font-sans text-[11px] text-emerald-900/70 normal-case">
                · {demandColour} joker ok
              </span>
            </span>
          ) : null}
        </div>

        <div aria-live="polite" className="min-h-[60px] space-y-0.5 text-center text-sm">
          {notice ? (
            <p className="font-bold text-amber-300">{notice}</p>
          ) : (
            recent.map((line, index) => (
              <p
                className={
                  index === recent.length - 1
                    ? "font-semibold text-white"
                    : "text-white/50"
                }
                key={`${recent.length - index}-${line}`}
              >
                {line}
              </p>
            ))
          )}
        </div>

        <p
          className={cn(
            "min-h-7 rounded-full px-4 py-1 text-center font-semibold text-sm",
            isMyTurn && !game.over
              ? "bg-amber-300 text-emerald-950"
              : "bg-black/20 text-white/70",
          )}
          data-hint
        >
          {hint}
        </p>
      </div>

      <div className="relative z-20 bg-gradient-to-t from-black/35 to-transparent">
        {stackCards.length > 0 ? (
          <StackTray
            cards={stackCards}
            onCancel={() => setStack([])}
            onPlay={playStack}
            onRemove={(id) => setStack((current) => current.filter((other) => other !== id))}
            shakeKey={shake}
          />
        ) : null}
        {myBubble ? (
          <div className="absolute inset-x-0 -top-10 z-[200] flex justify-center">
            <div
              className="pop max-w-[220px] rounded-2xl bg-amber-300 px-3 py-1 text-center font-bold text-emerald-950 text-xs shadow-[0_3px_0_rgba(0,0,0,0.25)]"
              data-my-bubble
            >
              <span className="line-clamp-2 break-words">{myBubble.text}</span>
            </div>
          </div>
        ) : null}
        {me && onCheck(me) ? (
          <div className="absolute inset-x-0 -top-2 z-[200] flex justify-center">
            <span
              className="display rounded-full bg-black/30 px-6 py-2 text-2xl text-amber-300 tracking-wider"
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
          data-react-anchor={view.you}
        >
          {iAmWatching ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center"
              data-watching
            >
              <p className="display text-2xl">
                {iAmSittingOut
                  ? "You are sitting this one out"
                  : iAmPlaying
                    ? `You played your last card (${ordinal(me?.rank ?? 1)})`
                    : me?.eliminated
                    ? "You are eliminated for this set"
                    : "You are watching"}
              </p>
              <p className="font-semibold text-sm text-white/70">
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
              onHold={view.doubling ? onHoldStable : undefined}
              onPlay={onPlayStable}
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
            void sendPlay(choice.cardId, { placement }, choice.cardIds);
          }}
          onSuit={(suit) => {
            setChoice(null);
            void sendPlay(choice.cardId, { suit }, choice.cardIds);
          }}
        />
      ) : null}

      {game.over ? (
        <ResultsOverlay onAction={(action) => void run(action)} onLeave={onLeave} view={view} />
      ) : null}

      <ChatDrawer
        messages={view.chat}
        onClose={() => setChatOpen(false)}
        onSend={sendChat}
        open={chatOpen}
        you={view.you}
      />
      <ReactionLayer nameOf={nameOf} reactions={view.reactions} you={view.you} />
    </div>
  );
}
