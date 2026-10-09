"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { AiWaiterPanel, type PromptRequest } from "./ai-waiter-panel";

interface AiWaiterContextValue {
  /** False when the restaurant hasn't enabled the waiter, or no model is configured. */
  available: boolean;
  /** Whether the waiter appears as the Chef character here (CHEF_RESTAURANTS). */
  chef: boolean;
  /**
   * Opens the waiter; with a prompt, asks it straight away. Pass the
   * element that was pressed as `opener` so focus returns to it on close.
   */
  openWaiter: (prompt?: string, opener?: HTMLElement | null) => void;
}

const AiWaiterContext = createContext<AiWaiterContextValue>({
  available: false,
  chef: false,
  openWaiter: () => {},
});

export function useAiWaiter(): AiWaiterContextValue {
  return useContext(AiWaiterContext);
}

/**
 * Owns the waiter sheet for every diner page, so any button — the dock,
 * the menu's "Ask the waiter" card, a dish page — can open it (and ask a
 * question) without each mounting its own copy of the conversation.
 *
 * Focus: the sheet is no longer opened by a single Dialog.Trigger, so the
 * element that opened it is remembered and handed to Base UI as
 * `finalFocus`. Closing the sheet returns focus to whichever button the
 * diner used, which is what a Trigger would have done (docs/accessibility.md).
 *
 * `available` is decided on the server (isAiWaiterAvailable() in the
 * layout) — this component never decides it, and sendChatMessage re-checks
 * independently regardless.
 */
export function AiWaiterProvider({
  available,
  chef,
  restaurantSlug,
  restaurantName,
  children,
}: {
  available: boolean;
  chef: boolean;
  restaurantSlug: string;
  restaurantName: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(
    null,
  );
  const openerRef = useRef<HTMLElement | null>(null);
  const requestCounter = useRef(0);

  const openWaiter = useCallback(
    (prompt?: string, opener?: HTMLElement | null) => {
      if (!available) return;
      // Passed explicitly rather than read from document.activeElement:
      // Safari does not focus a button on click, so "whatever has focus"
      // is often <body> and focus would land somewhere arbitrary on close.
      openerRef.current =
        opener ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      if (prompt) {
        requestCounter.current += 1;
        setPromptRequest({ id: requestCounter.current, text: prompt });
      }
      setOpen(true);
    },
    [available],
  );

  return (
    <AiWaiterContext.Provider value={{ available, chef, openWaiter }}>
      {children}
      {available && (
        <AiWaiterPanel
          chef={chef}
          restaurantSlug={restaurantSlug}
          restaurantName={restaurantName}
          open={open}
          onOpenChange={setOpen}
          promptRequest={promptRequest}
          onPromptHandled={() => setPromptRequest(null)}
          finalFocus={openerRef}
        />
      )}
    </AiWaiterContext.Provider>
  );
}
