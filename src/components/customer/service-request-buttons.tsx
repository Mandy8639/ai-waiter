"use client";

import { useState } from "react";
import { Hand, ReceiptText } from "lucide-react";
import {
  DINER_CONFIRMATIONS,
  DINER_LABELS,
  type RequestKind,
} from "@/lib/table-requests/core";
import { requestService } from "@/lib/table-requests/actions";

/**
 * "Call a waiter" and "Ask for the bill", above the chat composer.
 *
 * Two buttons rather than a menu, and in the waiter panel rather than
 * somewhere in the page furniture, because this is where a diner already
 * goes when they want something they cannot get themselves. The AI can
 * raise the same requests from a sentence (see
 * src/lib/ai/tools/service.ts) — these exist for the much larger number of
 * people who will never type at all.
 *
 * ONCE ASKED, IT STAYS ASKED. After a successful tap the button becomes
 * its own confirmation and stops being pressable. The database already
 * collapses repeat taps into one request, so nothing breaks if someone
 * hammers it — but a button that keeps looking pressable after it worked
 * invites exactly that, and then the diner cannot tell whether anything
 * happened at all.
 *
 * The state is deliberately local and forgotten on reload. The
 * authoritative answer lives in the database and is visible to staff; a
 * diner who reloads and asks again gets the same request back, not a
 * second one.
 */
const ICONS: Record<RequestKind, typeof Hand> = {
  waiter: Hand,
  bill: ReceiptText,
};

export function ServiceRequestButtons() {
  const [asked, setAsked] = useState<Partial<Record<RequestKind, boolean>>>({});
  const [busy, setBusy] = useState<RequestKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(kind: RequestKind) {
    if (busy || asked[kind]) return;
    setError(null);
    setBusy(kind);
    const result = await requestService(kind);
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? "That didn't go through. Please try again.");
      return;
    }
    setAsked((current) => ({ ...current, [kind]: true }));
  }

  return (
    <div className="px-1 pb-2">
      {/* Announced once, so a screen reader hears the outcome rather than
          only seeing a changed label. */}
      <p aria-live="polite" className="sr-only">
        {error ?? ""}
      </p>

      <div className="flex flex-wrap gap-2">
        {(["waiter", "bill"] as const).map((kind) => {
          const Icon = ICONS[kind];
          const done = Boolean(asked[kind]);
          return (
            <button
              key={kind}
              type="button"
              disabled={done || busy !== null}
              onClick={() => void ask(kind)}
              className="type-caption border-border text-foreground hover:bg-muted disabled:text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 transition-colors disabled:cursor-default disabled:hover:bg-transparent"
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {done
                ? DINER_CONFIRMATIONS[kind]
                : busy === kind
                  ? "Asking…"
                  : DINER_LABELS[kind]}
            </button>
          );
        })}
      </div>

      {error && (
        <p className="type-caption text-destructive mt-1.5" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
