"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MUTE_STORAGE_KEY = "kds-notifications-muted";

/**
 * A short, synthesized two-tone chime (Web Audio API — no bundled audio
 * asset, no third-party service) for new orders arriving on the kitchen
 * board. Browsers block audio until a user gesture occurs on the page
 * (autoplay restrictions); `unlock()` — called from the board's first
 * click/tap anywhere, and from the mute toggle itself — creates/resumes
 * the AudioContext at that point. Before any gesture, `play()` is a safe
 * no-op rather than a thrown/rejected promise. The mute preference persists
 * to localStorage so it survives a reload.
 */
export function useNotificationSound() {
  const [muted, setMuted] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const unlockedRef = useRef(false);

  useEffect(() => {
    // localStorage doesn't exist during SSR, so the mute preference can
    // only be read after mount — reading it in the useState initializer
    // instead would desync the server-rendered and first-client-render
    // output and trigger a hydration mismatch.
    const stored = window.localStorage.getItem(MUTE_STORAGE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored !== null) setMuted(stored === "true");
  }, []);

  const unlock = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      audioCtxRef.current = new Ctor();
    }
    if (audioCtxRef.current.state === "suspended") {
      void audioCtxRef.current.resume();
    }
    unlockedRef.current = true;
  }, []);

  const toggleMuted = useCallback(() => {
    unlock();
    setMuted((prev) => {
      const next = !prev;
      window.localStorage.setItem(MUTE_STORAGE_KEY, String(next));
      return next;
    });
  }, [unlock]);

  const play = useCallback(() => {
    if (muted || !unlockedRef.current || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const now = ctx.currentTime;

    for (const [start, freq] of [
      [0, 880],
      [0.14, 1108],
    ] as const) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.12, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.22);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(now + start);
      oscillator.stop(now + start + 0.25);
    }
  }, [muted]);

  return { muted, toggleMuted, unlock, play };
}
