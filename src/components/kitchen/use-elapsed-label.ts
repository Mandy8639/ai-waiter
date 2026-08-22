"use client";

import { useEffect, useState } from "react";

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return `${hours}h ${remaining}m`;
}

/** Live-updating "12 min" style label — ticks every 15s, plenty for a kitchen display (no need for second-level precision). */
export function useElapsedLabel(since: string): string {
  const [label, setLabel] = useState(() =>
    formatElapsed(Date.now() - new Date(since).getTime()),
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setLabel(formatElapsed(Date.now() - new Date(since).getTime()));
    }, 15_000);
    return () => clearInterval(interval);
  }, [since]);

  return label;
}
