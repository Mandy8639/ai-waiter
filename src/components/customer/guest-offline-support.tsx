"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { offlineMenuNote } from "@/lib/offline/core";

/**
 * Offline mode, phase 2, on the guest's pages:
 *
 * - Registers the guest menu worker (/r/sw.js, scope /r/), which keeps a
 *   copy of the menu on the phone. Production only: in development a
 *   worker serving saved pages hides every change you make.
 * - Says so when the page is that saved copy ("the menu saved on your
 *   phone at 7:40 PM"), or when the phone is offline, so nobody mistakes
 *   a saved menu for a live one.
 */
export function GuestOfflineSupport() {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Why the worker gave the saved copy: no connection, or too slow.
  const [savedBecause, setSavedBecause] = useState<"offline" | "slow" | null>(
    null,
  );
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV === "production") {
      navigator.serviceWorker
        .register("/r/sw.js", { scope: "/r/" })
        .catch(() => undefined);
    }

    // Ask the worker whether it gave this page from the saved copy.
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        savedAt?: number | null;
        reason?: string | null;
      };
      if (data?.type === "tableside-saved-at" && data.savedAt) {
        setSavedAt(data.savedAt);
        setSavedBecause(data.reason === "slow" ? "slow" : "offline");
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    navigator.serviceWorker.controller?.postMessage({
      type: "tableside-saved-at",
    });
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // The worker knows when the network failed; navigator.onLine often
  // says "online" on a phone with no usable signal.
  const isOffline = offline || savedBecause === "offline";
  const note = offlineMenuNote({ savedAt, offline: isOffline });
  if (!note) return null;

  return (
    <div
      role="status"
      className="bg-muted text-foreground type-body-sm flex items-start gap-2 border-b px-4 py-2.5"
    >
      <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        {note}
        {savedAt && !isOffline && (
          <>
            {" "}
            <button
              type="button"
              className="text-primary font-medium underline underline-offset-4"
              onClick={() => window.location.reload()}
            >
              Refresh
            </button>
          </>
        )}
      </p>
    </div>
  );
}
