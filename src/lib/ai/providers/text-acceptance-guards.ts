import type { TextAcceptanceGuard } from "../loop";
import {
  hasAuthoritativeMenuFactSource,
  MENU_FACT_CORRECTIVE_INSTRUCTION,
} from "../tools/menu-fact-detection";
import {
  acceptsCartStateClaim,
  CART_STATE_CORRECTIVE_INSTRUCTION,
} from "../tools/cart-fact-detection";
import {
  acceptsMenuClaims,
  MENU_CLAIM_CORRECTIVE_INSTRUCTION,
} from "../tools/menu-claim-detection";

/**
 * Guard ids, shared between the providers that build the guards and the
 * orchestrator that maps an exhausted guard to its customer-facing
 * fallback and log outcome. Kept here rather than in either detection
 * module so neither has to know the other exists.
 */
export const MENU_FACT_GUARD_ID = "menu_fact";
export const CART_STATE_GUARD_ID = "cart_state";
export const MENU_CLAIM_GUARD_ID = "menu_claim";

/**
 * Builds the turn's text-acceptance guards. Both providers call this with
 * their own `appendUserMessage` (the one genuinely provider-specific
 * piece — Anthropic's message shape and OpenAI-compatible message shape
 * differ), so the guard *policy* lives in exactly one place and can never
 * drift between providers. See loop.ts#TextAcceptanceGuard.
 */
export function buildTextAcceptanceGuards<TMessages>(params: {
  /** From the turn — the menu guard only applies when the customer's message asked for restaurant facts (see tools/menu-fact-detection.ts). */
  requiresAuthoritativeMenuSource?: boolean;
  appendUserMessage: (messages: TMessages, text: string) => TMessages;
}): Array<TextAcceptanceGuard<TMessages>> {
  const { requiresAuthoritativeMenuSource, appendUserMessage } = params;
  const guards: Array<TextAcceptanceGuard<TMessages>> = [];

  if (requiresAuthoritativeMenuSource) {
    guards.push({
      id: MENU_FACT_GUARD_ID,
      shouldAccept: hasAuthoritativeMenuFactSource,
      correctiveInstruction: MENU_FACT_CORRECTIVE_INSTRUCTION,
      appendUserMessage,
    });
  }

  // Unconditional, unlike the menu guard: this one inspects the model's
  // own reply and accepts anything that makes no aggregate cart-state
  // claim, so it needs no per-turn flag to gate it. See
  // tools/cart-fact-detection.ts for why it can't key off the customer's
  // message the way the menu guard does.
  guards.push({
    id: CART_STATE_GUARD_ID,
    shouldAccept: acceptsCartStateClaim,
    correctiveInstruction: CART_STATE_CORRECTIVE_INSTRUCTION,
    appendUserMessage,
  });

  // Unconditional too, and after the cart guard: "your total is $17.98"
  // trips both, and the cart guard's instruction (read the cart) is the
  // more specific correction. This one catches a price or a halal/kosher
  // claim the model volunteers when the customer asked no menu question —
  // the hole the menu guard above cannot see, and the one an owner's
  // persona note (phase D) is most likely to open. See
  // tools/menu-claim-detection.ts.
  guards.push({
    id: MENU_CLAIM_GUARD_ID,
    shouldAccept: acceptsMenuClaims,
    correctiveInstruction: MENU_CLAIM_CORRECTIVE_INSTRUCTION,
    appendUserMessage,
  });

  return guards;
}
