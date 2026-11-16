"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/helpers/classname-helper";
import { CHAT_MAX_CHARS, type ChatMessage, QUICK_PHRASES } from "./protocol";

const NAME_COLOURS = [
  "text-amber-300",
  "text-rose-300",
  "text-sky-300",
  "text-lime-300",
  "text-fuchsia-300",
  "text-orange-300",
];

/** The same player always gets the same colour. */
function colourFor(seatId: string) {
  let sum = 0;

  for (let i = 0; i < seatId.length; i++) {
    sum = (sum + seatId.charCodeAt(i) * (i + 1)) % 997;
  }

  return NAME_COLOURS[sum % NAME_COLOURS.length];
}

/** How many lines from other people arrived while the chat was closed. */
export function useUnread(messages: readonly ChatMessage[], open: boolean, you: string) {
  const seen = useRef<number | null>(null);
  const newest = messages.length > 0 ? messages[messages.length - 1].id : 0;

  if (seen.current === null || open) {
    seen.current = newest;
  }

  if (open) {
    return 0;
  }

  const since = seen.current;

  return messages.filter(
    (message) => message.id > since && message.seatId !== null && message.seatId !== you,
  ).length;
}

/** The messages, a box to write in, and one-tap phrases. */
export function ChatBox({
  className,
  messages,
  onSend,
  you,
}: {
  className?: string;
  messages: readonly ChatMessage[];
  onSend: (text: string) => Promise<string | null>;
  you: string;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const count = messages.length;
  const lastId = count > 0 ? messages[count - 1].id : 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a line arrives
  useEffect(() => {
    const element = list.current;

    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lastId]);

  async function send(raw: string) {
    const value = raw.trim();

    if (!value) {
      return;
    }

    setText("");

    const failure = await onSend(value);

    if (failure) {
      setError(failure);
      setTimeout(() => setError(null), 2200);
    }
  }

  return (
    <div className={cn("flex flex-col gap-2", className)} data-chat>
      <div
        aria-live="polite"
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto rounded-2xl bg-black/20 p-3 text-sm"
        ref={list}
      >
        {messages.length === 0 ? (
          <p className="py-6 text-center text-white/50">No messages yet. Say hello!</p>
        ) : null}
        {messages.map((message) =>
          message.seatId === null ? (
            <p className="py-0.5 text-center text-white/50 text-xs" key={message.id}>
              {message.text}
            </p>
          ) : (
            <div
              className={cn("flex flex-col", message.seatId === you ? "items-end" : "items-start")}
              key={message.id}
            >
              <span className={cn("font-bold text-[11px]", colourFor(message.seatId))}>
                {message.seatId === you ? "You" : message.name}
              </span>
              <span
                className={cn(
                  "max-w-[85%] break-words rounded-2xl px-3 py-1.5",
                  message.seatId === you ? "bg-amber-300 text-emerald-950" : "bg-white/15",
                )}
              >
                {message.text}
              </span>
            </div>
          ),
        )}
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {QUICK_PHRASES.map((phrase) => (
          <button
            className="shrink-0 rounded-full bg-white/10 px-3 py-1 font-semibold text-xs hover:bg-white/20 active:scale-95"
            key={phrase}
            onClick={() => void send(phrase)}
            type="button"
          >
            {phrase}
          </button>
        ))}
      </div>

      {error ? <p className="text-center font-semibold text-amber-300 text-xs">{error}</p> : null}

      <div className="flex gap-2">
        <input
          aria-label="Your message"
          autoComplete="off"
          className="input py-2.5 text-sm"
          enterKeyHint="send"
          maxLength={CHAT_MAX_CHARS}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void send(text);
            }
          }}
          placeholder="Write a message…"
          value={text}
        />
        <button className="btn btn-gold px-5 py-2.5 text-base" onClick={() => void send(text)} type="button">
          Send
        </button>
      </div>
    </div>
  );
}

/** The chat as a sheet that slides up over the table. */
export function ChatDrawer({
  onClose,
  open,
  ...box
}: {
  onClose: () => void;
  open: boolean;
  messages: readonly ChatMessage[];
  onSend: (text: string) => Promise<string | null>;
  you: string;
}) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[600] flex items-end justify-center bg-black/40"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-label="Chat"
        aria-modal="true"
        className="pop flex h-[min(70dvh,32rem)] w-full max-w-lg flex-col gap-3 rounded-t-3xl border-2 border-white/20 border-b-0 bg-[#06683c] p-4 shadow-[0_-10px_40px_rgba(0,0,0,0.4)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-center justify-between">
          <h2 className="display text-2xl">Chat</h2>
          <button className="btn btn-soft" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <ChatBox className="min-h-0 flex-1" {...box} />
      </div>
    </div>
  );
}
