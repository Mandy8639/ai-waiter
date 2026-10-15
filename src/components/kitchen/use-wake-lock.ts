"use client";

import { useEffect } from "react";

/**
 * Keeps the screen on while the kitchen board is open: a tablet on the
 * pass that dims and locks mid-service shows nothing and plays nothing.
 *
 * Uses the Screen Wake Lock API. The browser drops the lock whenever the
 * page is hidden (another app, the screen switched off by hand), so it is
 * asked for again each time the page becomes visible. Where the API is
 * missing or refused (low battery, an old browser) the board simply works
 * as before; the device's own sleep setting is then the fallback.
 */
export function useWakeLock() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      return;
    }
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    async function acquire() {
      if (document.visibilityState !== "visible" || lock) return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void next.release();
          return;
        }
        lock = next;
        next.addEventListener("release", () => {
          if (lock === next) lock = null;
        });
      } catch {
        // Refused (battery saver, permissions policy): nothing to do.
      }
    }

    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
      lock = null;
    };
  }, []);
}
