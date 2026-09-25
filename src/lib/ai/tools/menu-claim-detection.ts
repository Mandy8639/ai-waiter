import type { LoopToolOutcome } from "../loop";
import { AUTHORITATIVE_MENU_TOOL_NAMES } from "./menu-fact-detection";

/**
 * The menu-claim guard's pure logic: checks the MODEL'S reply for a price
 * or a halal/kosher claim that nothing this turn backs up. No
 * `server-only` import, like its two siblings, so it is unit-testable.
 *
 * WHY A THIRD GUARD. menu-fact-detection.ts fires when the CUSTOMER asks a
 * menu question. That leaves a hole it was never meant to cover: a menu
 * fact the model volunteers unprompted. The customer says "hi", the model
 * says "welcome — the thali is only $12 today!", and nothing checks it,
 * because "hi" is not a menu question.
 *
 * Phase D made that hole matter. An owner's persona note is text in the
 * prompt, and owners write facts into notes: "our thali is only $12!",
 * "everything here is halal". The price then changes on the menu and the
 * note does not; or the halal claim was never true of every dish. Found by
 * tests/unit/ai-persona-guard.test.ts, which showed a note-induced "$1" in
 * reply to "Hi there!" sailing straight through.
 *
 * Like cart-fact-detection.ts, this inspects the reply rather than the
 * question, and so gates itself: a reply with no price and no claim word
 * is always accepted. It never reads the system prompt or the note, which
 * is the whole point — a note cannot switch it off.
 *
 * TWO CHECKS, DELIBERATELY DIFFERENT IN SHAPE.
 *
 *   Prices are checked by VALUE. Every amount the reply states must equal
 *   a number some tool actually returned this turn. That catches "$1" even
 *   when a real search did run and said 12.99 — a stale note beside a live
 *   menu is exactly the failure this exists for.
 *
 *   Halal and kosher are checked by SOURCE, not by wording. The reply
 *   needs an authoritative menu tool call this turn, and that is all. A
 *   word-level check is impossible here: "the menu doesn't say whether it's
 *   halal" is the CORRECT phase B answer and contains the word, and no
 *   regex tells an assertion from a denial. What separates the correct
 *   answer from the dangerous one is not its wording but whether the model
 *   looked — the correct answer always follows a get_menu_item, and a
 *   note-induced "everything here is halal!" follows nothing.
 *
 * NOT CHECKED, ON PURPOSE: "nut-free", "gluten-free" and the like. Same
 * assertion-versus-denial problem as halal, and unlike halal there is no
 * claim in the data that could ever back one — so a source check would
 * pass the wrong answer and a word check would fail the right one. The
 * system prompt and phase B's never-report-a-negative design carry those.
 */

/**
 * Currency-marked amounts only. A bare number is a quantity, a time or a
 * table ("two dosas", "about fifteen minutes", "table 4") and is none of
 * this guard's business; a false positive here costs a customer a good
 * reply, so the patterns insist on a currency mark.
 */
const CURRENCY_BEFORE =
  /(?:[$€£₹¥]|\b(?:USD|EUR|GBP|INR|CAD|AUD|JPY|NZD|SGD|AED)\s?)\s?(\d{1,7}(?:[.,]\d{1,2})?)/gi;
const CURRENCY_AFTER =
  /(\d{1,7}(?:[.,]\d{1,2})?)\s?(?:USD|EUR|GBP|INR|CAD|AUD|JPY|NZD|SGD|AED|dollars?|euros?|pounds?|rupees?)\b/gi;

function toAmount(raw: string): number {
  // "7,50" is a decimal comma; "1,250" is not a price format we emit, and
  // treating it as 1.25 would only ever make the check stricter.
  return Number(raw.replace(",", "."));
}

/** Every currency-marked amount in `text`, in major units. */
export function extractPriceAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const pattern of [CURRENCY_BEFORE, CURRENCY_AFTER]) {
    for (const match of text.matchAll(pattern)) {
      const value = toAmount(match[1]);
      if (Number.isFinite(value)) amounts.push(value);
    }
  }
  return amounts;
}

// Latin script covers English and Spanish; Devanagari covers a Hindi reply
// (phase E). Devanagari is a substring match — `\b` does not work there.
const RELIGIOUS_CLAIM = /\b(?:halal|kosher)\b|हलाल|कोशर/iu;

/** Does the reply mention halal or kosher at all? See the header for why wording can't matter. */
export function mentionsReligiousClaim(text: string): boolean {
  return RELIGIOUS_CLAIM.test(text);
}

/** Every number anywhere in a tool result, however deeply nested. */
function collectNumbers(value: unknown, into: Set<number>): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    into.add(Math.round(value * 100));
    return;
  }
  if (typeof value === "string") {
    // Prices sometimes arrive as numeric strings ("12.99").
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n))
      into.add(Math.round(n * 100));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, into);
  }
}

/**
 * The guard predicate: accept unless the reply states a price no tool
 * returned this turn, or mentions halal/kosher without a menu tool having
 * run this turn. Failed tool calls never count as backing.
 */
export function acceptsMenuClaims(
  toolOutcomes: LoopToolOutcome[],
  finalText: string,
): boolean {
  const succeeded = toolOutcomes.filter((outcome) => outcome.result.ok);

  const amounts = extractPriceAmounts(finalText);
  if (amounts.length > 0) {
    const grounded = new Set<number>();
    for (const outcome of succeeded) {
      if (outcome.result.ok) collectNumbers(outcome.result.data, grounded);
    }
    const unbacked = amounts.some(
      (amount) => !grounded.has(Math.round(amount * 100)),
    );
    if (unbacked) return false;
  }

  if (mentionsReligiousClaim(finalText)) {
    const looked = succeeded.some((outcome) =>
      AUTHORITATIVE_MENU_TOOL_NAMES.has(outcome.toolName),
    );
    if (!looked) return false;
  }

  return true;
}

export const MENU_CLAIM_CORRECTIVE_INSTRUCTION =
  "[System note: your reply states a price, or says something about halal or kosher, that no tool returned this turn. Prices and dietary claims must come from search_menu, get_menu_item or get_cart called now — not from memory, earlier messages, or the restaurant's style notes. Call the right tool and answer from its result, or leave the price or claim out.]";
