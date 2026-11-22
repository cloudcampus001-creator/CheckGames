"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Creds,
  type MatchWants,
  queueJoinRequest,
  queueLeaveRequest,
  queuePollRequest,
  saveCreds,
} from "./api";
import { realtimeEnabled, rtOn } from "./rt";

export type Search =
  | { state: "idle" }
  | { state: "searching"; searching: number; waitedMs: number }
  | { state: "matched"; code: string; creds: Creds }
  | { state: "error"; error: string };

const POLL_MS = 1000;

/**
 * Looking for a game against real people. Starts a search, follows it (pushed
 * by the realtime server, or asked about once a second on plain requests) and
 * says where the table is once it is made. The seat is saved on this device, so
 * the room page opens straight onto it.
 */
export function useMatchmaking() {
  const [search, setSearch] = useState<Search>({ state: "idle" });
  const ticket = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(0);

  const stopTimers = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const matched = useCallback(
    (code: string, seatId: string, token: string) => {
      stopTimers();
      ticket.current = null;
      saveCreds(code, { seatId, token });
      setSearch({ code, creds: { seatId, token }, state: "matched" });
    },
    [stopTimers],
  );

  // The realtime server pushes progress and the match.
  useEffect(() => {
    if (!realtimeEnabled) {
      return;
    }

    const offQueue = rtOn("queue", (data) => {
      if (ticket.current) {
        setSearch({
          searching: Number(data.searching ?? 1),
          state: "searching",
          waitedMs: Number(data.waitedMs ?? 0),
        });
      }
    });
    const offMatch = rtOn("matched", (data) => {
      matched(String(data.code), String(data.seatId), String(data.token));
    });

    return () => {
      offQueue();
      offMatch();
    };
  }, [matched]);

  const poll = useCallback(async () => {
    const id = ticket.current;

    if (!id) {
      return;
    }

    const reply = await queuePollRequest(id);

    if (ticket.current !== id) {
      return;
    }

    if (reply.ok === true && reply.state === "matched") {
      const match = reply.match as { code: string; seatId: string; token: string };

      matched(match.code, match.seatId, match.token);

      return;
    }

    if (reply.ok === true && reply.state === "waiting") {
      setSearch({
        searching: Number(reply.searching ?? 1),
        state: "searching",
        waitedMs: Date.now() - started.current,
      });
    } else if (reply.ok === true && reply.state === "gone") {
      ticket.current = null;
      setSearch({ error: "The search timed out. Try again.", state: "error" });

      return;
    }

    timer.current = setTimeout(() => void poll(), POLL_MS);
  }, [matched]);

  const start = useCallback(
    async (wants: MatchWants) => {
      setSearch({ searching: 1, state: "searching", waitedMs: 0 });
      started.current = Date.now();

      const reply = await queueJoinRequest(wants);

      if (reply.ok !== true) {
        setSearch({ error: String(reply.error ?? "Could not start the search."), state: "error" });

        return;
      }

      ticket.current = String(reply.ticket);

      if (!realtimeEnabled) {
        timer.current = setTimeout(() => void poll(), 400);
      }
    },
    [poll],
  );

  const cancel = useCallback(async () => {
    const id = ticket.current;

    stopTimers();
    ticket.current = null;
    setSearch({ state: "idle" });

    if (id) {
      await queueLeaveRequest(id);
    }
  }, [stopTimers]);

  // Leaving the page gives up the search.
  useEffect(
    () => () => {
      const id = ticket.current;

      stopTimers();

      if (id) {
        void queueLeaveRequest(id);
      }
    },
    [stopTimers],
  );

  return { cancel, search, start };
}
