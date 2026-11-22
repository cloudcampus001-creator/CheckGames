"use client";

import { useEffect } from "react";
import { applyPrefs } from "./prefs";
import { loadPrefs } from "./identity";

/** Puts the look this player chose on the page as soon as it opens. Draws nothing. */
export function PrefsApplier() {
  useEffect(() => {
    applyPrefs(loadPrefs());
  }, []);

  return null;
}
