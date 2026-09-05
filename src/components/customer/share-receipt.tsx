"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * "Send me this receipt", without collecting anyone's phone number.
 *
 * The receipt already lives at a stable URL, so the phone's own share
 * sheet can put it into WhatsApp, Mail, Messages or the clipboard — which
 * is what a diner actually wants and what they already know how to use.
 * No email provider, no SMS bill, no verified sending domain, and above
 * all no storing a stranger's contact details against an order. The
 * cheapest version of this feature is also the most private one.
 *
 * navigator.share needs a secure context and a user gesture, and is
 * missing on most desktop browsers, so the clipboard is the fallback
 * rather than an afterthought — on a laptop that IS the feature.
 */
export function ShareReceipt({
  restaurantName,
  total,
}: {
  restaurantName: string;
  total: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function share() {
    setFailed(false);
    // Read at click time, not render time: this is a client component and
    // the URL is whatever the diner is actually looking at.
    const url = window.location.href;
    const shareData = {
      title: `Receipt — ${restaurantName}`,
      text: `Receipt from ${restaurantName} — ${total}`,
      url,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (error) {
        // A cancelled share sheet is not a failure — the diner changed
        // their mind, and showing them an error for that would be rude.
        if (error instanceof Error && error.name === "AbortError") return;
        // Anything else falls through to the clipboard.
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 4000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="outline" onClick={share}>
        {copied ? "Link copied" : "Send me this receipt"}
      </Button>
      {/*
        Announced politely rather than as an alert: it is a confirmation,
        not a problem, and a screen reader user should hear it without
        having focus yanked (SC 4.1.3).
      */}
      <p aria-live="polite" className="text-muted-foreground text-xs">
        {failed
          ? "Couldn't copy the link — you can bookmark this page instead."
          : copied
            ? "Receipt link copied. Paste it wherever you like."
            : "Opens your phone's share menu, or copies the link."}
      </p>
    </div>
  );
}
