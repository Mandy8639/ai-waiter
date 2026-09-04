"use client";

import { useState } from "react";
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

  // The floating button lives INSIDE the panel's Dialog root, as a real
  // Dialog.Trigger. It used to be a plain <button> calling setOpen(true)
  // from out here, which meant Base UI never knew a trigger existed — so
  // none of its focus lifecycle ran: focus never entered the dialog on
  // open and never returned to the button on close. See
  // docs/accessibility.md.
  return (
    <AiWaiterPanel
      restaurantSlug={restaurantSlug}
      open={open}
      onOpenChange={setOpen}
    />
  );
}
