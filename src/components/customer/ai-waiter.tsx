"use client";

import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { AiWaiterPanel } from "./ai-waiter-panel";

/**
 * The floating entry point into the AI waiter — a fixed corner button that
 * opens the chat panel as a dialog on top of (never replacing) the normal
 * menu/cart/order pages, so closing it always returns the customer to
 * exactly where they were (spec section 33: "do not make AI chat obscure
 * the normal menu"). Only rendered when the server has already confirmed
 * (`isAiWaiterAvailable()`) both that a provider key is configured and
 * this restaurant opted in — see src/app/r/[restaurantSlug]/layout.tsx.
 */
export function AiWaiter({ restaurantSlug }: { restaurantSlug: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open AI waiter chat"
        className="bg-primary text-primary-foreground fixed right-4 bottom-4 z-20 flex size-14 items-center justify-center rounded-full shadow-lg motion-safe:transition-transform motion-safe:hover:scale-105"
      >
        <MessageCircle className="size-6" aria-hidden="true" />
      </button>
      <AiWaiterPanel
        restaurantSlug={restaurantSlug}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
