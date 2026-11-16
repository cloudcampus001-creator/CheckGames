"use client";

import { useEffect, useState } from "react";

/**
 * Milliseconds left, counting down on this device. `ms` is what the server
 * said when it made the view; a fresh view starts the count again from the
 * server's number, so clocks that disagree never matter. Null in, null out.
 */
export function useCountdown(ms: number | null, key?: unknown): number | null {
  const [left, setLeft] = useState<number | null>(ms);

  useEffect(() => {
    if (ms === null) {
      setLeft(null);

      return;
    }

    const end = Date.now() + ms;

    setLeft(ms);

    const timer = setInterval(() => setLeft(Math.max(0, end - Date.now())), 250);

    return () => clearInterval(timer);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `key` restarts the count on purpose
  }, [ms, key]);

  return left;
}
