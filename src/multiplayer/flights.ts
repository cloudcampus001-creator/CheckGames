/**
 * Helpers for the card animations: where a card lands on the pile, and where
 * on the screen a flying card starts and ends. All screen positions are
 * viewport coordinates (what getBoundingClientRect gives).
 */

export type Point = { x: number; y: number };

/** Where a flying card starts: its centre, tilt and size relative to a full card. */
export type FlightOrigin = Point & { rotate: number; scale: number };

export type Box = Point & { height: number; width: number };

function hash(text: string) {
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

/** A repeatable number between 0 and 1 for a seed and a salt. */
function unit(seed: number, salt: number) {
  let t = (seed + Math.imul(salt, 0x9e3779b9)) >>> 0;

  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export type PileTilt = { rotate: number; x: number; y: number };

/**
 * How a card sits on the pile. It looks random, but it is the same for the
 * same card on every screen. A card is never straight and dead centre, so the
 * cards underneath always peek out, like a real pile.
 */
export function pileTilt(cardId: string): PileTilt {
  const seed = hash(cardId);
  const side = unit(seed, 1) < 0.5 ? -1 : 1;
  const angle = unit(seed, 3) * Math.PI * 2;
  const distance = 12 + unit(seed, 4) * 16;

  return {
    // 5 to 22 degrees, either way
    rotate: side * (5 + unit(seed, 2) * 17),
    x: Math.cos(angle) * distance * 1.1,
    y: Math.sin(angle) * distance * 0.8,
  };
}

/** Centre and size of an element on screen, or null if it is not there. */
export function boxOf(element: Element | null): Box | null {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();

  if (rect.width === 0 && rect.height === 0) {
    return null;
  }

  return {
    height: rect.height,
    width: rect.width,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

/** How far an element is turned, in degrees, read from its computed transform. */
export function rotationOf(element: Element | null) {
  if (!element || typeof getComputedStyle === "undefined") {
    return 0;
  }

  const transform = getComputedStyle(element).transform;
  const match = /^matrix(?:3d)?\(([^)]+)\)$/.exec(transform);

  if (!match) {
    return 0;
  }

  const [a, b] = match[1].split(",").map(Number);

  return (Math.atan2(b, a) * 180) / Math.PI;
}

export function queryBox(selector: string) {
  return typeof document === "undefined"
    ? null
    : boxOf(document.querySelector(selector));
}
