"use client";

import { ConciergeBell } from "lucide-react";
import { useAiWaiter } from "./ai-waiter";
import { ChefArt } from "./chef-art";

// Each of these maps to one or two tool calls the waiter already makes
// well (asking the diner's mood; a category search; a spicy-only search).
// "What's quick to make?" was considered and dropped: prep time lives on
// get_menu_item, so answering it means one call per dish and runs into the
// per-turn tool budget.
const PROMPTS = [
  "What do you recommend?",
  "Something light",
  "Something spicy",
];

/**
 * The menu's introduction to the waiter — placed above the dishes, because
 * that is where a diner decides how to choose. Each prompt opens the waiter
 * and asks it straight away. Renders nothing when the restaurant hasn't
 * enabled the waiter.
 */
export function AskWaiterCard() {
  const { available, chef, openWaiter } = useAiWaiter();
  if (!available) return null;

  return (
    <section
      aria-labelledby="ask-waiter-heading"
      className="bg-ai-soft border-ai/25 flex flex-col gap-3.5 rounded-2xl border p-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        {chef ? (
          <ChefArt pose="curious" size={56} className="-my-1" />
        ) : (
          <span
            aria-hidden="true"
            className="bg-card text-ai shadow-card flex size-10 shrink-0 items-center justify-center rounded-full"
          >
            <ConciergeBell className="size-5" />
          </span>
        )}
        <div className="flex flex-col gap-0.5">
          <h2 id="ask-waiter-heading" className="type-dish">
            Not sure what to order?
          </h2>
          <p className="type-body-sm text-muted-foreground">
            {chef
              ? "Ask the Chef, an AI guide to this menu. It knows the ingredients, spice, allergens and prep times, and can add dishes to your order."
              : "Ask the waiter. It knows this menu — ingredients, spice, allergens and prep times — and can add dishes to your order."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={(event) => openWaiter(prompt, event.currentTarget)}
            className="type-label bg-card hover:bg-background focus-visible:ring-ring/50 h-9 rounded-full border px-3.5 transition-colors focus-visible:ring-3 focus-visible:outline-none"
          >
            {prompt}
          </button>
        ))}
        <button
          type="button"
          onClick={(event) => openWaiter(undefined, event.currentTarget)}
          className="type-label bg-foreground text-background hover:bg-foreground/90 focus-visible:ring-ring/50 h-9 rounded-full px-4 transition-colors focus-visible:ring-3 focus-visible:outline-none"
        >
          {chef ? "Ask the Chef" : "Ask something else"}
        </button>
      </div>
    </section>
  );
}

/**
 * A single "ask the waiter" button, for empty states and dish pages. Where
 * the waiter appears as the Chef, it carries the Chef's face and
 * `chefLabel` instead of the bell and `children`.
 */
export function AskWaiterButton({
  prompt,
  children,
  chefLabel,
  className,
}: {
  prompt?: string;
  children: React.ReactNode;
  /** The label where the Chef is on, e.g. "Ask the Chef about this dish". */
  chefLabel?: React.ReactNode;
  className?: string;
}) {
  const { available, chef, openWaiter } = useAiWaiter();
  if (!available) return null;
  return (
    <button
      type="button"
      onClick={(event) => openWaiter(prompt, event.currentTarget)}
      className={
        className ??
        "type-label bg-ai-soft text-foreground hover:bg-ai-soft/70 border-ai/25 focus-visible:ring-ring/50 inline-flex h-10 items-center gap-2 rounded-full border px-4 transition-colors focus-visible:ring-3 focus-visible:outline-none"
      }
    >
      {chef ? (
        <span className="bg-card -ml-1.5 flex size-7 items-center justify-center overflow-hidden rounded-full">
          <ChefArt pose="neutral" size={28} />
        </span>
      ) : (
        <ConciergeBell className="text-ai size-4" aria-hidden="true" />
      )}
      {chef && chefLabel ? chefLabel : children}
    </button>
  );
}
