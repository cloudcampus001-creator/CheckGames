"use client";

/**
 * Sound effects made on the spot with the browser's audio (no files to
 * download, nothing to load). Small beeps and blips for the moments of the
 * game. The mute choice is remembered on this device.
 */
import { useSyncExternalStore } from "react";

const KEY = "cheque-games:muted";

let context: AudioContext | null = null;
let muted: boolean | null = null;
const listeners = new Set<() => void>();

export function isMuted() {
  if (muted === null) {
    try {
      muted = localStorage.getItem(KEY) === "1";
    } catch {
      muted = false;
    }
  }

  return muted;
}

export function setMuted(value: boolean) {
  muted = value;

  try {
    localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    // not important
  }

  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** [muted, toggle] for a button. */
export function useMuted(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, isMuted, () => false);

  return [value, () => setMuted(!isMuted())];
}

function audio() {
  if (typeof window === "undefined") {
    return null;
  }

  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!Ctor) {
      return null;
    }

    try {
      context = new Ctor();
    } catch {
      return null;
    }
  }

  // Browsers keep audio asleep until the first tap.
  if (context.state === "suspended") {
    void context.resume().catch(() => {});
  }

  return context;
}

function tone(
  c: AudioContext,
  frequency: number,
  start: number,
  duration: number,
  type: OscillatorType,
  volume: number,
  slideTo?: number,
) {
  const at = c.currentTime + start;
  const oscillator = c.createOscillator();
  const gain = c.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, at);

  if (slideTo) {
    oscillator.frequency.exponentialRampToValueAtTime(slideTo, at + duration);
  }

  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain);
  gain.connect(c.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.03);
}

export type Sfx =
  | "play"
  | "draw"
  | "turn"
  | "check"
  | "games"
  | "stop"
  | "chat"
  | "pop"
  | "shuffle"
  | "win";

const recipes: Record<Sfx, (c: AudioContext) => void> = {
  chat: (c) => tone(c, 1040, 0, 0.07, "sine", 0.07),
  check: (c) => {
    tone(c, 880, 0, 0.09, "square", 0.06);
    tone(c, 660, 0.1, 0.09, "square", 0.06);
    tone(c, 880, 0.2, 0.14, "square", 0.06);
  },
  draw: (c) => {
    tone(c, 300, 0, 0.07, "sine", 0.12, 420);
    tone(c, 380, 0.07, 0.07, "sine", 0.1, 520);
  },
  games: (c) => {
    [523, 659, 784, 1047].forEach((f, i) => tone(c, f, i * 0.09, 0.2, "triangle", 0.12));
  },
  play: (c) => {
    tone(c, 520, 0, 0.05, "triangle", 0.14, 300);
    tone(c, 260, 0.03, 0.08, "sine", 0.1);
  },
  pop: (c) => tone(c, 520, 0, 0.12, "sine", 0.12, 980),
  shuffle: (c) => {
    for (let i = 0; i < 6; i++) {
      tone(c, 200 + ((i * 53) % 90), i * 0.045, 0.05, "sawtooth", 0.04);
    }
  },
  stop: (c) => {
    tone(c, 220, 0, 0.18, "sawtooth", 0.08, 110);
  },
  turn: (c) => {
    tone(c, 660, 0, 0.1, "sine", 0.12);
    tone(c, 880, 0.1, 0.16, "sine", 0.12);
  },
  win: (c) => {
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) =>
      tone(c, f, i * 0.11, 0.22, "triangle", 0.12),
    );
  },
};

export function playSfx(name: Sfx) {
  if (isMuted()) {
    return;
  }

  const c = audio();

  if (!c) {
    return;
  }

  try {
    recipes[name](c);
  } catch {
    // a sound that fails is not worth a crash
  }
}

/** A short buzz on phones that can do it (your turn). */
export function buzz(ms: number) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // not supported
  }
}
