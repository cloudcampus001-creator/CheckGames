"use client";

/**
 * The player this device is: the profile (name, face, level, stats) and the
 * look it chose. Kept in the browser so the page shows instantly, and on the
 * server, which is the truth and keeps it between visits and between devices
 * that share nothing but... the device itself.
 */
import { useSyncExternalStore } from "react";
import { loadName, profileRequest, saveName } from "./api";
import { getDevice, makeDevice } from "./device";
import { applyPrefs, cleanPrefs, DEFAULT_PREFS, type Prefs } from "./prefs";
import type { PublicProfile } from "./profile";

const PROFILE_KEY = "cheque-games:profile";
const PREFS_KEY = "cheque-games:prefs";

type Store = { profile: PublicProfile | null; loading: boolean; error: string | null };

let store: Store = { error: null, loading: false, profile: null };
let loadedFromDisk = false;
let prefsMemory: Prefs | null = null;
const listeners = new Set<() => void>();

function emit(next: Partial<Store>) {
  store = { ...store, ...next };

  for (const listener of listeners) {
    listener();
  }
}

function readCached() {
  if (loadedFromDisk || typeof localStorage === "undefined") {
    return;
  }

  loadedFromDisk = true;

  try {
    const raw = localStorage.getItem(PROFILE_KEY);

    if (raw) {
      store = { ...store, profile: JSON.parse(raw) as PublicProfile };
    }
  } catch {
    // an unreadable copy is just ignored
  }
}

export const getProfile = () => {
  readCached();

  return store.profile;
};

function setProfile(profile: PublicProfile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // private mode
  }

  saveName(profile.name);
  emit({ error: null, loading: false, profile });
}

/** Open this device's profile on the server (making it the first time) and bring it up to date. */
export async function refreshProfile(retry = true): Promise<PublicProfile | null> {
  readCached();
  emit({ loading: true });

  const device = getDevice();
  const reply = await profileRequest({
    backup: store.profile,
    name: loadName() || undefined,
    op: "hello",
    profileId: device.id,
    secret: device.secret,
  });

  if (reply.ok === true && reply.profile) {
    const profile = reply.profile as PublicProfile;

    setProfile(profile);

    if (profile.prefs) {
      savePrefsLocal(cleanPrefs(profile.prefs));
    } else if (prefsMemory && JSON.stringify(prefsMemory) !== JSON.stringify(DEFAULT_PREFS)) {
      // The server has no look for this player yet: send the one chosen here.
      void profileRequest({ op: "update", patch: { prefs: prefsMemory } });
    }

    return profile;
  }

  // This device's secret was refused (the profile belongs to another device): start a new identity.
  if (reply.fatal === true && retry) {
    makeDevice();
    store = { ...store, profile: null };

    return refreshProfile(false);
  }

  emit({ error: String(reply.error ?? "Could not open your profile."), loading: false });

  return null;
}

/** Change the name or face. Resolves to an error message, or null. */
export async function saveProfile(patch: { name?: string; avatar?: string }): Promise<string | null> {
  const reply = await profileRequest({ op: "update", patch });

  if (reply.ok === true && reply.profile) {
    setProfile(reply.profile as PublicProfile);

    return null;
  }

  return String(reply.error ?? "Could not save.");
}

/** The profile of this device, kept fresh. */
export function useProfile() {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    () => {
      readCached();

      return store;
    },
    () => store,
  );

  return snapshot;
}

// --- the look ------------------------------------------------------------------------------------------

export function loadPrefs(): Prefs {
  if (prefsMemory) {
    return prefsMemory;
  }

  try {
    const raw = localStorage.getItem(PREFS_KEY);

    prefsMemory = cleanPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    prefsMemory = { ...DEFAULT_PREFS };
  }

  return prefsMemory;
}

function savePrefsLocal(prefs: Prefs) {
  prefsMemory = prefs;

  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // private mode
  }

  applyPrefs(prefs);

  for (const listener of prefListeners) {
    listener();
  }
}

const prefListeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Change the look: shown at once, remembered here, and sent to the profile a moment later. */
export function setPrefs(patch: Partial<Prefs>) {
  const next = cleanPrefs({ ...loadPrefs(), ...patch });

  savePrefsLocal(next);

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    void profileRequest({ op: "update", patch: { prefs: next } });
  }, 800);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (listener) => {
      prefListeners.add(listener);

      return () => {
        prefListeners.delete(listener);
      };
    },
    () => loadPrefs(),
    () => DEFAULT_PREFS,
  );
}
