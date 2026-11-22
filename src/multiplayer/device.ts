/**
 * This device's identity: a random id and a secret, made once and kept in the
 * browser. The server knows the device by them (that is what makes it "a
 * player" with a name, scores and wins), and only the secret can change it.
 */

const KEY = "cheque-games:device";

export type Device = { id: string; secret: string };

/** A random id. Older phones have no crypto.randomUUID, so there are fallbacks. */
export function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const bytes = new Uint8Array(16);

      crypto.getRandomValues(bytes);

      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // fall through
  }

  let text = "";

  for (let i = 0; i < 32; i++) {
    text += Math.floor(Math.random() * 16).toString(16);
  }

  return text;
}

let memory: Device | null = null;

export function getDevice(): Device {
  if (memory) {
    return memory;
  }

  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Device>) : null;

    if (parsed && typeof parsed.id === "string" && typeof parsed.secret === "string") {
      memory = { id: parsed.id, secret: parsed.secret };

      return memory;
    }
  } catch {
    // no storage: the identity lasts until the page is closed
  }

  return makeDevice();
}

/** A brand new identity (the first visit, or after the old one was refused). */
export function makeDevice(): Device {
  memory = { id: uuid(), secret: uuid() };

  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // private mode
  }

  return memory;
}
