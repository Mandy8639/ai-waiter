"use client";

import { useEffect, useState } from "react";
import { Smartphone, X } from "lucide-react";
import { StoreLinks } from "@/components/marketing/store-links";
import { STAFF_APP_SNOOZE_MS } from "@/lib/staff-app/core";

const DISMISSED_KEY = "tableside:staff-app-nudge-dismissed";

/**
 * "Get the app", for someone using the dashboard on the web who hasn't set
 * the staff app up on a phone (the dashboard layout decides that, with
 * shouldOfferStaffApp). "Not now" hides it on this device for 30 days; the
 * Settings page keeps a permanent copy. Hidden until mounted, like the
 * two-step reminder, so a dismissed one never flashes.
 *
 * On a computer it shows a QR code to scan with the phone; on a phone,
 * the store badges.
 */
export function StaffAppNudge({
  title,
  body,
  qrDataUrl,
}: {
  title: string;
  body: string;
  qrDataUrl: string;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let dismissedAt = 0;
    try {
      dismissedAt = Number(localStorage.getItem(DISMISSED_KEY)) || 0;
    } catch {
      // Storage blocked: show it.
    }
    // Reading the browser's storage after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShow(Date.now() - dismissedAt > STAFF_APP_SNOOZE_MS);
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
      className="bg-muted/60 mb-6 flex items-start gap-4 rounded-xl border px-4 py-3 text-sm"
    >
      <Smartphone
        className="text-primary mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl">
          <span className="font-medium">{title}</span> {body}
        </p>
        {/* A phone gets the badges; a computer gets a code to scan. */}
        <StoreLinks className="sm:hidden" />
        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL */}
          <img
            src={qrDataUrl}
            alt="QR code for tableside.menu/get-app"
            width={72}
            height={72}
            className="rounded-md border bg-white p-1"
          />
          <p className="text-muted-foreground w-28 text-xs">
            Scan with your phone&apos;s camera to get the app.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="text-muted-foreground hover:text-foreground -mt-0.5 -mr-1 rounded-md p-1"
        aria-label="Not now"
        title="Not now"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
