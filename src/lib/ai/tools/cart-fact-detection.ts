import type { LoopToolOutcome } from "../loop";
import { fallbackText } from "../fallback-text";

/**
 * The cart-state guard's pure logic — like menu-fact-detection.ts it
 * deliberately has no `server-only` import so it's directly unit-testable.
 *
 * Exists because a live production test showed the model telling a
 * customer "you now have two chicken tikka masala in your order" when the
 * cart actually held one. Nothing was fabricated *that* turn: an earlier
 * turn (on a weaker model) had claimed an add that never happened, and
 * the model then reasoned about the cart from its own conversation
 * history instead of reading the cart back. The system prompt already
 * forbids this for MENU facts; this module extends the same
 * "assertion needs an authoritative source" discipline to CART state.
 *
 * Why this guard is shaped differently from the menu one
 * ----------------------------------------------------
 * menu-fact-detection.ts inspects the CUSTOMER'S message, because a
 * customer asking "how much is the dosa?" reliably signals that the reply
 * will state a menu fact. Cart-state claims don't work that way: the
 * observed failure came from "Please add one more chicken tikka masala" —
 * a mutation request, not a question — and a message-keyword detector
 * would never have fired on it. The unsafe assertion lived in the MODEL'S
 * reply, so that is what this module inspects.
 *
 * Two narrow questions, mirroring menu-fact-detection.ts:
 *   1. looksLikeCartStateClaim — does the model's own reply assert the
 *      aggregate contents or totals of the cart?
 *   2. hasAuthoritativeCartStateSource — did get_cart actually SUCCEED
 *      this turn?
 */

/**
 * Aggregate cart-state assertions only. A successful add_item_to_cart
 * fully justifies "Added one chicken tikka masala" — that's a claim about
 * the action the tool just performed, and it is deliberately NOT matched
 * here. What isn't justified by a mutation alone is a claim about what
 * the cart now HOLDS or what it now COSTS, which is what these patterns
 * target.
 *
 * Detection is sentence-scoped and anchor-gated because a false positive
 * is expensive: it costs a wasted corrective round-trip, and if the model
 * doesn't comply the customer gets the fallback text instead of a perfectly
 * good reply. "Do you have any allergies?" and "Do you have a preference?"
 * are ordinary waiter questions that a bare /you have/ pattern would
 * wrongly flag, so the weak forms below additionally require a cart/order/
 * total anchor in the same sentence.
 */

/** Unambiguous on their own — each already names the cart, the order, or a total. */
const STRONG_CLAIM_PATTERNS: RegExp[] = [
  // "you now have…", "you'll have…", "you will have…"
  /\byou(?:'ll|\s+will|\s+now)\s+have\b/i,
  // "your cart has/contains/includes…", "your order now holds…"
  /\byour\s+(?:cart|order)\b[^.!?]{0,40}\b(?:has|have|contains|includes|holds|is)\b/i,
  // "in your cart", "in your order"
  /\bin\s+your\s+(?:cart|order)\b/i,
  // "your total is…", "the subtotal comes to…"
  /\b(?:your|the)\s+(?:total|subtotal)\b/i,
  // "that brings the total to…", "bringing your total to…"
  /\bbring(?:s|ing)?\s+(?:your|the)\s+total\b/i,
];

/** Only a claim when the same sentence also names the cart, an order, or a total. */
const WEAK_CLAIM_PATTERNS: RegExp[] = [
  // "you have two dosas", "you have 3 items" — but not "do you have any…"
  /\byou\s+have\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  // "that's two items", "that makes three items"
  /\b(?:that(?:'s| is)|that makes)\b[^.!?]{0,20}\bitems?\b/i,
];

const CART_ANCHOR = /\b(?:cart|order|total|subtotal)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?\n])\s+/);
}

/**
 * Deliberately narrow, for the same reason menu-fact-detection.ts is —
 * see the block comment above for why the weak patterns are anchor-gated.
 */
export function looksLikeCartStateClaim(text: string): boolean {
  return sentences(text).some((sentence) => {
    if (STRONG_CLAIM_PATTERNS.some((pattern) => pattern.test(sentence))) {
      return true;
    }
    return (
      WEAK_CLAIM_PATTERNS.some((pattern) => pattern.test(sentence)) &&
      CART_ANCHOR.test(sentence)
    );
  });
}

/**
 * get_cart is the only tool that reads the cart back. Deliberately
 * excludes the mutations (add_item_to_cart, update_cart_item,
 * remove_cart_item, clear_cart): each proves its own effect happened, but
 * none of them returns the resulting cart, so none can substantiate a
 * claim about the cart's total contents or price. This is the exact
 * mirror of menu-fact-detection.ts excluding get_cart from AUTHORITATIVE
 * MENU sources.
 */
export const AUTHORITATIVE_CART_TOOL_NAMES = new Set(["get_cart"]);

/** True only if get_cart SUCCEEDED this turn — a failed call never counts. */
export function hasAuthoritativeCartStateSource(
  toolOutcomes: LoopToolOutcome[],
): boolean {
  return toolOutcomes.some(
    (outcome) =>
      AUTHORITATIVE_CART_TOOL_NAMES.has(outcome.toolName) && outcome.result.ok,
  );
}

/**
 * The guard predicate loop.ts calls: a reply is acceptable unless it makes
 * an aggregate cart-state claim without having read the cart this turn.
 * Replies that make no such claim are always accepted, so this guard can
 * be wired unconditionally — unlike the menu guard, it gates itself on the
 * text rather than on a per-turn flag.
 */
export function acceptsCartStateClaim(
  toolOutcomes: LoopToolOutcome[],
  finalText: string,
): boolean {
  if (!looksLikeCartStateClaim(finalText)) return true;
  return hasAuthoritativeCartStateSource(toolOutcomes);
}

/** See menu-fact-detection.ts — injected transiently, never persisted to ai_conversation_messages. */
export const CART_STATE_CORRECTIVE_INSTRUCTION =
  "[System note: your reply states what the customer's cart contains or what it costs, but you have not read the cart this turn. Call get_cart now and restate it from that result — your own earlier messages in this conversation are not a reliable record of the cart, since an add may have failed or the customer may have changed it another way.]";

/** Customer-facing fallback if the model still won't call get_cart after the one corrective retry — never surfaces the internal instruction text. */
export const CART_STATE_GUARD_FALLBACK_TEXT = fallbackText("cartState", "en");
