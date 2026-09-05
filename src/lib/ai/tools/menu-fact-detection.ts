import type { LoopToolOutcome } from "../loop";

/**
 * The menu-factuality guard's pure logic — deliberately has no
 * `server-only` import, mirroring order-confirmation.ts's split, so it's
 * directly unit-testable. Exists because a live test showed the model
 * fabricating a menu price (stated $5.99 for an item that's really $7.99)
 * when it answered a recommendation question from memory/general
 * knowledge instead of calling a menu tool — the system prompt already
 * says not to do this, but as with the submit_order confirmation gate,
 * a prompt instruction alone isn't a reliable control.
 *
 * Extended once since: the guard's keyword list predates the waiter being
 * able to discuss preparation, timing and portions at all, so exactly the
 * questions those capabilities invited — "how is it made", "how long does
 * it take", "is it enough for two?" — matched nothing and went unguarded.
 * Two live turns answered them with zero tool calls. A capability and its
 * factuality guard have to ship together; adding the first without the
 * second is how a grounded feature becomes an ungrounded one.
 *
 * This module answers two separate, narrow questions:
 *   1. looksLikeMenuFactQuestion — does the CUSTOMER'S message plausibly
 *      ask for restaurant-specific facts (menu/price/dietary/ingredients/
 *      availability/recommendation)? Deliberately keyword-based and
 *      narrow — no attempt to understand full intent, and no attempt to
 *      verify the MODEL'S answer is correct (that would need another LLM
 *      call, which we're explicitly not doing).
 *   2. hasAuthoritativeMenuFactSource — did an authoritative tool
 *      (search_menu / get_menu_item / get_restaurant_info) actually
 *      SUCCEED this turn? A failed call or an unrelated tool (get_cart,
 *      add_item_to_cart, etc.) never counts.
 *
 * The orchestrator/providers wire these into loop.ts's optional
 * textAcceptanceGuard — see loop.ts for the bounded-one-retry mechanism
 * that actually enforces this.
 */

const MENU_FACT_KEYWORD_GROUPS: RegExp[] = [
  // price / cost
  /\b(how much|price|prices|cost|costs|expensive|cheap)\b/i,
  // dietary / allergen / spice characteristics
  /\b(vegetarian|vegan|dietary|allergen|allergens|gluten|dairy|nuts?|halal|kosher|spicy|spice)\b/i,
  // ingredients / composition
  /\b(ingredient|ingredients|contains?|made with|made of)\b/i,
  // availability / the menu itself
  /\b(available|availability|menu|options?)\b/i,
  // recommendation / suggestion
  /\b(recommend|recommendation|suggest|suggestion)\b/i,
  // How the dish is made. "made with"/"made of" above catch composition;
  // these catch method, which is a separate question a diner actually
  // asks ("how is the biryani cooked?") and which the model will happily
  // answer from general knowledge about the cuisine if nothing stops it.
  /\b(how (is|are|do|does) .{0,40}\b(made|cooked|prepared|prepare)\b)/i,
  /\b(cooking process|preparation|recipe|deep[- ]?fried|how it's made)\b/i,
  // How long it takes. A kitchen's timing is a fact about that kitchen.
  // "how long" is anchored to a following verb: "how long does it take"
  // is about the food, "how long have you been open?" is not.
  /\bhow long (does|do|will|until|before|to)\b/i,
  /\b(how many minutes|prep time|preparation time|takes? to (make|cook|prepare))\b/i,
  // How much food it is. "enough for" and "how many people" are the two
  // phrasings that actually show up; "serves"/"portion" cover the rest.
  /\b(how many people|enough for (one|two|three|a |us|me)|serves?|portion|portions|feed (one|two|us|me))\b/i,
];

/**
 * Deliberately narrow (see the header comment) — generic words like
 * "dish", "food", "item", "good", "order", "want" are excluded on
 * purpose, since matching them created excessive false positives against
 * ordinary ordering/confirmation chat ("Place the order", "Sounds good").
 */
export function looksLikeMenuFactQuestion(message: string): boolean {
  return MENU_FACT_KEYWORD_GROUPS.some((pattern) => pattern.test(message));
}

export const AUTHORITATIVE_MENU_TOOL_NAMES = new Set([
  "search_menu",
  "get_menu_item",
  "get_restaurant_info",
]);

/** True only if an authoritative tool call SUCCEEDED this turn — a failed call or a call to any other tool (get_cart included) never counts. */
export function hasAuthoritativeMenuFactSource(
  toolOutcomes: LoopToolOutcome[],
): boolean {
  return toolOutcomes.some(
    (outcome) =>
      AUTHORITATIVE_MENU_TOOL_NAMES.has(outcome.toolName) && outcome.result.ok,
  );
}

/**
 * Injected as a plain user-shaped message (loop.ts has no "system aside"
 * message type available mid-turn) — bracketed and explicit so the model
 * reads it as an instruction, not customer speech. Never persisted to
 * ai_conversation_messages; it only exists transiently within this turn's
 * in-flight message list.
 */
export const MENU_FACT_CORRECTIVE_INSTRUCTION =
  "[System note: the customer's last message asks about menu items, prices, dietary information, ingredients, how a dish is made, how long it takes, how many people it feeds, availability, or restaurant details. Call search_menu, get_menu_item, or get_restaurant_info now and answer from its result — do not answer from memory or general knowledge about this kind of food, even if this was discussed earlier in this conversation.]";

/** Customer-facing fallback if the model still won't call a menu tool after the one corrective retry — never surfaces the internal instruction text. */
export const MENU_FACT_GUARD_FALLBACK_TEXT =
  "I wasn't able to pull that up from the menu just now — could you try asking again, or check with the staff?";
