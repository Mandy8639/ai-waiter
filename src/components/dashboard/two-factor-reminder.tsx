"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldAlert, X } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

const DISMISSED_KEY = "tableside:two-factor-reminder-dismissed";
/** A dismissed reminder comes back after this long. */
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Nudges owners and managers who haven't turned on two-step verification.
 * Optional by decision (2026-10-17), so it can be put off: dismissing hides
 * it on this device for two weeks. Rendered only when it applies (see the
 * dashboard layout); hidden until mounted so a dismissed one never flashes.
 */
export function TwoFactorReminder() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let dismissedAt = 0;
    try {
      dismissedAt = Number(localStorage.getItem(DISMISSED_KEY)) || 0;
    } catch {
      // Storage blocked (private mode): just show it.
    }
    // Reading the browser's storage after mount; there's no value to
    // compute during render on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShow(Date.now() - dismissedAt > SNOOZE_MS);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // Nothing to remember it in; it hides for this visit only.
    }
    setShow(false);
  };

  return (
    <div
      role="note"
      className="bg-muted/60 mb-6 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm"
    >
      <ShieldAlert
        className="text-primary mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>
          <span className="font-medium">Protect your restaurant.</span> Turn on
          two-step verification so a stolen password isn&apos;t enough to sign
          in.
        </p>
        <Link
          href="/account#two-step"
          className={buttonVariants({
            size: "sm",
            className: "w-fit shrink-0",
          })}
        >
          Turn it on
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Remind me later"
        className="text-muted-foreground hover:text-foreground -m-1 rounded-md p-1"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
