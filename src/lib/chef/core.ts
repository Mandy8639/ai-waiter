/**
 * The Chef character's decisions, with no React, network or server code:
 * which pose shows where, when a question is a safety question, and who
 * has the Chef switched on. Unit-tested (tests/unit/chef-core.test.ts).
 *
 * The Chef is presentation only. It never decides or states anything about
 * the menu: replies, prices, allergens and dish cards all come from the AI
 * waiter and the database exactly as before. These rules only choose a
 * face, and the one rule that matters most is that a safety answer never
 * gets a happy one.
 */
import { looksLikeAllergenQuestion } from "@/lib/ai/tools/menu-fact-detection";

export type ChefPose =
  | "hello"
  | "curious"
  | "thinking"
  | "found"
  | "oops"
  /** Calm and attentive: allergen, dietary-law and other safety answers. */
  | "neutral";

export type ChefMotion = "wave" | "think" | "nod";

// Safety -------------------------------------------------------------------------

/**
 * Diet questions — religious, medical or ethical. A wrong or breezy answer
 * here matters as much as an allergen. Vegetarian and vegan included:
 * found live, "Which dishes are vegan?" was answered "none are marked
 * vegan" with four vegetarian dishes underneath, and a delighted Chef over
 * that reads as "these are vegan".
 */
const DIETARY_SAFETY_PATTERNS: RegExp[] = [
  /\b(halal|haram|kosher|jain|coeliac|celiac|intoleran(t|ce)|religio(n|us)|vegan|vegetarian|veggie|non-veg|plant[- ]based)\b/i,
  /हलाल|जैन|शाकाहारी|मांसाहारी|वीगन/u,
  /(?<![\p{L}])(cel[ií]ac[oa]s?|intolerancias?|intolerantes?|religi[oó]n|religios[oa]s?|vegan[oa]s?|vegetarian[oa]s?)(?![\p{L}])/iu,
];

/**
 * Is this diner question one whose answer must get the neutral Chef —
 * allergens, or any diet?
 * Decided on the server from the diner's own words (sendChatMessage), the
 * same way the menu-fact guard decides when allergen data must be looked
 * up — the Chef's face never depends on what the model wrote.
 */
export function isSafetyQuestion(message: string): boolean {
  return (
    looksLikeAllergenQuestion(message) ||
    DIETARY_SAFETY_PATTERNS.some((pattern) => pattern.test(message))
  );
}

// Which chef, where --------------------------------------------------------------

export interface ChefMomentMessage {
  role: "user" | "assistant";
  recommendationCount: number;
  /** One of the waiter's fixed "couldn't answer" replies (isFallbackText). */
  fallback?: boolean;
  /**
   * From the server, for replies sent this visit. Undefined for history
   * loaded from an earlier visit — and unknown is treated as safety.
   */
  safety?: boolean;
}

export type ChefMoment =
  | { placement: "none" }
  | { placement: "welcome"; pose: "hello"; motion: "wave" }
  | { placement: "thinking"; pose: "thinking"; motion: "think" }
  | { placement: "error"; pose: "oops" }
  | {
      /** The newest reply is a fixed "couldn't answer" one. */
      placement: "apology";
      messageIndex: number;
      pose: "oops" | "neutral";
    }
  | {
      placement: "recommendations";
      /** Which message's cards the Chef introduces. */
      messageIndex: number;
      pose: "found" | "neutral";
      /** Whether adding one of these dishes earns a nod. */
      celebrate: boolean;
    };

/**
 * The one Chef moment the conversation shows right now, beside the
 * header's constant calm Chef. One at a time, by priority:
 *
 *   thinking  a reply is on its way
 *   error     the last send failed
 *   welcome   nothing said yet
 *   apology   the newest reply is a fixed "couldn't answer" one
 *   cards     the newest reply that came with dishes
 *
 * Cards get "found", and an apology gets "oops", only when the server said
 * the question was NOT a safety question; anything else — a safety
 * question, or a reply whose flag is unknown — gets the neutral Chef and
 * no celebration. A failed allergen answer is not a moment for a sheepish
 * face either.
 */
export function chefMoment(input: {
  historyLoaded: boolean;
  isPending: boolean;
  hasError: boolean;
  messages: readonly ChefMomentMessage[];
}): ChefMoment {
  if (!input.historyLoaded) return { placement: "none" };
  if (input.isPending) {
    return { placement: "thinking", pose: "thinking", motion: "think" };
  }
  if (input.hasError) return { placement: "error", pose: "oops" };
  if (input.messages.length === 0) {
    return { placement: "welcome", pose: "hello", motion: "wave" };
  }

  const lastIndex = input.messages.length - 1;
  const last = input.messages[lastIndex];
  if (last.role === "assistant" && last.fallback) {
    return {
      placement: "apology",
      messageIndex: lastIndex,
      pose: last.safety === false ? "oops" : "neutral",
    };
  }

  for (let i = lastIndex; i >= 0; i -= 1) {
    const message = input.messages[i];
    if (message.role === "assistant" && message.recommendationCount > 0) {
      const celebrate = message.safety === false;
      return {
        placement: "recommendations",
        messageIndex: i,
        pose: celebrate ? "found" : "neutral",
        celebrate,
      };
    }
  }
  return { placement: "none" };
}

// Rollout ------------------------------------------------------------------------

/**
 * Who has the Chef: CHEF_RESTAURANTS is a comma-separated list of
 * restaurant slugs, or "*" for every restaurant. Unset or empty means
 * nobody — so a deploy without the setting changes nothing for diners.
 */
export function chefEnabledFor(
  setting: string | undefined,
  restaurantSlug: string,
): boolean {
  const entries = (setting ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return (
    entries.includes("*") || entries.includes(restaurantSlug.toLowerCase())
  );
}
