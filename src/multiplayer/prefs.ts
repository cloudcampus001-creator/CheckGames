/**
 * How a player wants the game to look: the board, the cards and the fonts.
 * Everything is a set of CSS variables on the page, so changing a choice is
 * instant and costs nothing while playing. Plain data, shared by the server
 * (which keeps it in the profile) and the browser (which applies it).
 */

export type Prefs = {
  /** A board colour id, or "custom" (then `boardHue` is used). */
  board: string;
  boardHue: number;
  pattern: string;
  font: string;
  bodyFont: string;
  face: string;
  deck: "classic" | "four";
  back: string;
  /** Fewer effects, for slow phones. */
  lite: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  back: "classic",
  board: "emerald",
  boardHue: 150,
  bodyFont: "nunito",
  deck: "classic",
  face: "classic",
  font: "lilita",
  lite: false,
  pattern: "weave",
};

export const BOARDS = [
  { hi: "#25c775", id: "emerald", lo: "#045a31", mid: "#0d9a58", name: "Emerald" },
  { hi: "#3aa6ff", id: "ocean", lo: "#0a3a7a", mid: "#1769d1", name: "Ocean" },
  { hi: "#ff6b6b", id: "ruby", lo: "#6b0f1a", mid: "#d62839", name: "Ruby" },
  { hi: "#7c74ff", id: "midnight", lo: "#14123d", mid: "#352f8f", name: "Midnight" },
  { hi: "#ffb347", id: "sunset", lo: "#8a2f0a", mid: "#f2711c", name: "Sunset" },
  { hi: "#2ee6c8", id: "lagoon", lo: "#04574c", mid: "#0aa58f", name: "Lagoon" },
  { hi: "#d65bff", id: "grape", lo: "#3d0f63", mid: "#8b2fc9", name: "Grape" },
  { hi: "#8aa0b5", id: "slate", lo: "#1f2a36", mid: "#4a5d70", name: "Slate" },
  { hi: "#c58b4e", id: "wood", lo: "#4a2c12", mid: "#8b5a2b", name: "Wood" },
] as const;

export const PATTERNS = [
  {
    css: "repeating-linear-gradient(45deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 28px), repeating-linear-gradient(-45deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 28px)",
    id: "weave",
    name: "Weave",
    size: "auto, auto",
  },
  {
    css: "radial-gradient(rgba(255,255,255,0.08) 2px, transparent 2.6px)",
    id: "dots",
    name: "Dots",
    size: "26px 26px",
  },
  {
    css: "linear-gradient(135deg, rgba(255,255,255,0.06) 25%, transparent 25%), linear-gradient(225deg, rgba(255,255,255,0.06) 25%, transparent 25%)",
    id: "diamonds",
    name: "Diamonds",
    size: "44px 44px, 44px 44px",
  },
  {
    css: "repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 22px, transparent 22px 44px)",
    id: "stripes",
    name: "Stripes",
    size: "auto",
  },
  { css: "none", id: "plain", name: "Plain", size: "auto" },
] as const;

export const FONTS = [
  { id: "lilita", name: "Lilita" },
  { id: "bungee", name: "Bungee" },
  { id: "fredoka", name: "Fredoka" },
  { id: "baloo", name: "Baloo" },
  { id: "righteous", name: "Righteous" },
  { id: "pacifico", name: "Pacifico" },
] as const;

export const BODY_FONTS = [
  { id: "nunito", name: "Nunito" },
  { id: "poppins", name: "Poppins" },
  { id: "quicksand", name: "Quicksand" },
] as const;

export const FACES = [
  { bg: "#ffffff", border: "rgba(0,0,0,0.1)", clubs: "#23262d", dark: false, diamonds: "#c22f2f", hearts: "#c22f2f", id: "classic", name: "Classic", spades: "#23262d" },
  { bg: "#fff4d9", border: "rgba(90,60,10,0.25)", clubs: "#2b2118", dark: false, diamonds: "#b8322a", hearts: "#b8322a", id: "cream", name: "Cream", spades: "#2b2118" },
  { bg: "#1d2230", border: "rgba(255,255,255,0.18)", clubs: "#e8ecf4", dark: true, diamonds: "#ff6b6b", hearts: "#ff6b6b", id: "night", name: "Night", spades: "#e8ecf4" },
  { bg: "#0f1224", border: "rgba(94,224,255,0.45)", clubs: "#39ff88", dark: true, diamonds: "#ffd23f", hearts: "#ff4d8d", id: "neon", name: "Neon", spades: "#5ee0ff" },
  { bg: "#fffafc", border: "rgba(255,111,145,0.35)", clubs: "#5b5b7a", dark: false, diamonds: "#ff6f91", hearts: "#ff6f91", id: "pastel", name: "Pastel", spades: "#5b5b7a" },
  { bg: "#fffdf5", border: "rgba(201,138,0,0.6)", clubs: "#3b2a14", dark: false, diamonds: "#a3171f", hearts: "#a3171f", id: "royal", name: "Royal", spades: "#3b2a14" },
] as const;

const hatch = (line: string) =>
  `repeating-linear-gradient(45deg, ${line} 0, ${line} 1.5px, transparent 1.5px, transparent 7px), repeating-linear-gradient(-45deg, ${line} 0, ${line} 1.5px, transparent 1.5px, transparent 7px)`;
const dots = (line: string) => `radial-gradient(${line} 2px, transparent 2.6px)`;
const stripes = (line: string) =>
  `repeating-linear-gradient(90deg, ${line} 0 3px, transparent 3px 9px)`;
const WHITE = "rgba(255,255,255,0.16)";
const GOLD = "rgba(255,210,63,0.55)";

export const BACKS = [
  {
    color: "#9d2c35",
    id: "classic",
    image: `url('/experiments/card-back.png'), ${hatch(WHITE)}`,
    name: "Classic",
    size: "cover, auto, auto",
  },
  { color: "#1e50c8", id: "blue", image: hatch(WHITE), name: "Blue", size: "auto, auto" },
  { color: "#15803d", id: "green", image: dots(WHITE), name: "Green", size: "14px 14px" },
  { color: "#7e22ce", id: "purple", image: stripes(WHITE), name: "Purple", size: "auto" },
  { color: "#14141c", id: "black", image: stripes(GOLD), name: "Black", size: "auto" },
  { color: "#c98a00", id: "gold", image: dots("rgba(255,255,255,0.5)"), name: "Gold", size: "14px 14px" },
  { color: "#0f9488", id: "teal", image: hatch(WHITE), name: "Teal", size: "auto, auto" },
  { color: "#db2777", id: "pink", image: dots(WHITE), name: "Pink", size: "14px 14px" },
] as const;

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);
const pick = (value: unknown, list: readonly { id: string }[], fallback: string) =>
  typeof value === "string" && ids(list).includes(value) ? value : fallback;

/** Whatever a device sends: only known choices get through. */
export function cleanPrefs(raw: unknown): Prefs {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const hue = typeof value.boardHue === "number" && Number.isFinite(value.boardHue)
    ? Math.min(360, Math.max(0, Math.round(value.boardHue)))
    : DEFAULT_PREFS.boardHue;

  return {
    back: pick(value.back, BACKS, DEFAULT_PREFS.back),
    board: value.board === "custom" ? "custom" : pick(value.board, BOARDS, DEFAULT_PREFS.board),
    boardHue: hue,
    bodyFont: pick(value.bodyFont, BODY_FONTS, DEFAULT_PREFS.bodyFont),
    deck: value.deck === "four" ? "four" : "classic",
    face: pick(value.face, FACES, DEFAULT_PREFS.face),
    font: pick(value.font, FONTS, DEFAULT_PREFS.font),
    lite: value.lite === true,
    pattern: pick(value.pattern, PATTERNS, DEFAULT_PREFS.pattern),
  };
}

export function boardColours(prefs: Prefs) {
  if (prefs.board === "custom") {
    const h = prefs.boardHue;

    return { hi: `hsl(${h} 70% 50%)`, lo: `hsl(${h} 85% 17%)`, mid: `hsl(${h} 80% 34%)` };
  }

  const found = BOARDS.find((board) => board.id === prefs.board) ?? BOARDS[0];

  return { hi: found.hi, lo: found.lo, mid: found.mid };
}

/** The four suit colours a card face uses, with the four-colour deck applied. */
export function suitColours(prefs: Prefs) {
  const face = FACES.find((candidate) => candidate.id === prefs.face) ?? FACES[0];

  if (prefs.deck === "four") {
    return {
      clubs: face.dark ? "#4ade80" : "#1f8f4e",
      diamonds: face.dark ? "#60a5fa" : "#2563eb",
      hearts: face.hearts,
      spades: face.spades,
    };
  }

  return { clubs: face.clubs, diamonds: face.diamonds, hearts: face.hearts, spades: face.spades };
}

/** Put the choices on the page. Safe to call any time; does nothing on the server. */
export function applyPrefs(raw: Prefs | null | undefined) {
  if (typeof document === "undefined") {
    return;
  }

  const prefs = cleanPrefs(raw);
  const root = document.documentElement;
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  const board = boardColours(prefs);
  const pattern = PATTERNS.find((item) => item.id === prefs.pattern) ?? PATTERNS[0];
  const face = FACES.find((item) => item.id === prefs.face) ?? FACES[0];
  const back = BACKS.find((item) => item.id === prefs.back) ?? BACKS[0];
  const suits = suitColours(prefs);

  set("--felt-hi", board.hi);
  set("--felt", board.mid);
  set("--felt-lo", board.lo);
  set("--pattern", pattern.css);
  set("--pattern-size", pattern.size);
  set("--f-display", `var(--f-${prefs.font})`);
  set("--f-body", `var(--f-${prefs.bodyFont})`);
  set("--card-bg", face.bg);
  set("--card-border", face.border);
  set("--suit-clubs", suits.clubs);
  set("--suit-diamonds", suits.diamonds);
  set("--suit-hearts", suits.hearts);
  set("--suit-spades", suits.spades);
  set("--back-color", back.color);
  set("--back-image", back.image);
  set("--back-size", back.size);
  root.dataset.lite = prefs.lite ? "true" : "false";
}
