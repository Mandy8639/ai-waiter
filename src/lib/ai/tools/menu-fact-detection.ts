import type { LoopToolOutcome } from "../loop";
import { fallbackText } from "../fallback-text";

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
 * The same questions in the languages diners actually use here (phase E):
 * Hindi in Devanagari, Hindi typed in English letters ("Hinglish"), and
 * Spanish.
 *
 * Why this exists: the waiter has always answered in whatever language it
 * was spoken to, but every guard above keyed on English words. A diner who
 * asked "चिकन बिरयानी कितने की है?" was never required to get a grounded
 * answer — in the phase E baseline the model happened to look the dish up,
 * but nothing made it.
 *
 * Devanagari is matched as a plain substring. JavaScript's `\b` does not
 * understand it, and Hindi vowel signs are combining marks, so a
 * letter-boundary check would split words in the wrong places. A stray
 * substring match costs one unnecessary menu lookup; a missed question
 * costs an ungrounded answer. Latin-script words use letter lookarounds
 * (with the `u` flag) so accented Spanish ("alérgenos") is bounded properly.
 *
 * Deliberately NOT here: greetings ("नमस्ते", "namaste", "hola"). They ask
 * for nothing, and forcing a menu lookup on a hello is how a guard gets
 * turned off by whoever is annoyed by it.
 *
 * Other languages still get the reply-side guards (menu-claim-detection.ts
 * checks prices by value in any language), but not this one. Adding a
 * language means adding its words here, with tests.
 */
const MULTILINGUAL_MENU_FACT_PATTERNS: RegExp[] = [
  // Hindi (Devanagari): price, allergen/diet, ingredients, menu,
  // availability, suggestion, time, portion.
  /कितने|कितना|कितनी|कीमत|दाम|रेट|एलर्जी|शाकाहारी|मांसाहारी|वीगन|हलाल|कोशर|मसालेदार|तीखा|ग्लूटेन|मूंगफली|सामग्री|क्या क्या|मेनू|मेन्यू|उपलब्ध|मिलेगा|मिलता|सुझाव|सलाह|बनता|बनाते|बनाया|देर लगेगी|समय लगेगा/u,
  // Hinglish: the same questions typed in English letters.
  /(?<![\p{L}])(kitne|kitna|kitni|keemat|kimat|daam|shakahari|masaledar|teekha|tikha|mungfali|milega|milta|banta|banate|kya kya|isme kya|ismein kya|kitni der|kitne log|kitne logon)(?![\p{L}])/iu,
  // Spanish.
  /(?<![\p{L}])(cu[aá]nto|cu[aá]nta|precio|precios|cuesta|cuestan|al[eé]rgenos?|alergias?|al[eé]rgic[oa]s?|vegetarian[oa]s?|vegan[oa]s?|picantes?|gluten|l[aá]cteos?|nuez|nueces|cacahuetes?|man[ií]|ingredientes?|contiene|contienen|lleva|llevan|hech[oa] con|men[uú]|disponibles?|recomienda|recomiendas|recomendaci[oó]n|recomendar|sugerencias?|tarda|tardan|cu[aá]ntas personas|porci[oó]n|raci[oó]n)(?![\p{L}])/iu,
];

/**
 * Deliberately narrow (see the header comment) — generic words like
 * "dish", "food", "item", "good", "order", "want" are excluded on
 * purpose, since matching them created excessive false positives against
 * ordinary ordering/confirmation chat ("Place the order", "Sounds good").
 */
export function looksLikeMenuFactQuestion(message: string): boolean {
  return (
    MENU_FACT_KEYWORD_GROUPS.some((pattern) => pattern.test(message)) ||
    MULTILINGUAL_MENU_FACT_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/**
 * Allergen and ingredient questions, in every language the menu guard
 * knows. A strict subset of looksLikeMenuFactQuestion, with a stricter
 * requirement (see hasAllergenSource).
 *
 * Found in the phase E baseline: asked in Hindi what allergens the Peanut
 * Chikki Shake had, the model ran search_menu, saw no allergen field —
 * search_menu has none — and told the diner the menu had no allergen
 * information. The dish had two confirmed allergens, Peanuts and Milk. The
 * menu guard was satisfied, because search_menu is an authoritative menu
 * source; it just isn't a source for THIS.
 */
const ALLERGEN_QUESTION_PATTERNS: RegExp[] = [
  /\b(allergens?|allerg(y|ies|ic)|ingredients?|contains?|gluten|dairy|lactose|nuts?|peanuts?|tree nuts?|sesame|soy|shellfish|egg|eggs)\b/i,
  /एलर्जी|सामग्री|मूंगफली|ग्लूटेन|क्या डाला|इसमें क्या/u,
  /(?<![\p{L}])(mungfali|isme kya|ismein kya|kya daala|kya dala)(?![\p{L}])/iu,
  /(?<![\p{L}])(al[eé]rgenos?|alergias?|al[eé]rgic[oa]s?|ingredientes?|contiene|contienen|lleva|llevan|gluten|l[aá]cteos?|lactosa|nuez|nueces|cacahuetes?|man[ií]|s[eé]samo|soja|mariscos?|huevos?)(?![\p{L}])/iu,
];

export function looksLikeAllergenQuestion(message: string): boolean {
  return ALLERGEN_QUESTION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * True only if get_menu_item SUCCEEDED this turn. It is the one tool that
 * returns a dish's confirmed allergens and its ingredients; search_menu and
 * get_restaurant_info return neither, so neither can support an answer
 * about them — including "the menu doesn't list any".
 */
export function hasAllergenSource(toolOutcomes: LoopToolOutcome[]): boolean {
  return toolOutcomes.some(
    (outcome) =>
      // check_menu_allergens reads the same confirmed allergens across the
      // whole menu (the menu knowledge graph, src/lib/menu-graph).
      (outcome.toolName === "get_menu_item" ||
        outcome.toolName === "check_menu_allergens") &&
      outcome.result.ok,
  );
}

export const ALLERGEN_SOURCE_CORRECTIVE_INSTRUCTION =
  "[System note: the customer asked about allergens or ingredients. Only get_menu_item (one dish) and check_menu_allergens (the whole menu) return declared allergens — search_menu does not, so a search result showing no allergens tells you nothing. Call the right one and answer from what it returns. If it lists none, say the menu doesn't specify and suggest checking with staff.]";

export const AUTHORITATIVE_MENU_TOOL_NAMES = new Set([
  "search_menu",
  "get_menu_item",
  "get_restaurant_info",
  // The menu knowledge graph's tools return menu rows too, prices included.
  "check_menu_allergens",
  "get_pairings",
]);

/**
 * True only if an authoritative tool call SUCCEEDED this turn — a failed
 * call or a call to any other tool (get_cart included) never counts.
 *
 * get_order_status counts too, for this guard only: "how long until my
 * food is ready?" matches the "how long until" pattern, and the order's
 * own estimate is the right source for it, not the menu. Without it the
 * guard rejected a correct answer built from get_order_status twice and
 * the diner got "I wasn't able to pull that up from the menu" (found by
 * the waiter evaluation, evals/). Not added to AUTHORITATIVE_MENU_TOOL_NAMES,
 * which also decides what can back a menu claim (menu-claim-detection.ts).
 */
export function hasAuthoritativeMenuFactSource(
  toolOutcomes: LoopToolOutcome[],
): boolean {
  return toolOutcomes.some(
    (outcome) =>
      (AUTHORITATIVE_MENU_TOOL_NAMES.has(outcome.toolName) ||
        outcome.toolName === "get_order_status") &&
      outcome.result.ok,
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
  "[System note: the customer's last message asks about menu items, prices, dietary information, ingredients, how a dish is made, how long it takes, how many people it feeds, availability, or restaurant details. Call search_menu, get_menu_item, or get_restaurant_info now (or get_order_status, if they're asking when an order they've already placed will be ready) and answer from its result — do not answer from memory or general knowledge about this kind of food, even if this was discussed earlier in this conversation.]";

/** Customer-facing fallback if the model still won't call a menu tool after the one corrective retry — never surfaces the internal instruction text. */
export const MENU_FACT_GUARD_FALLBACK_TEXT = fallbackText("menuFact", "en");
