import {
  ALLERGEN_LABELS,
  allergenGroupsIn,
  type AllergenGroup,
} from "@/lib/menu-graph/allergen-lexicon";
import { allergenReport, type MenuGraph } from "@/lib/menu-graph/core";

/**
 * The allergy hold on add_item_to_cart. A guest who said they have an
 * allergy doesn't get a dish flagged for it added to their cart until
 * they've been told and said yes in a later message.
 *
 * Why it's code: asking the model wasn't enough. On 2026-10-30 one free
 * model warned and added it anyway, and another added Butter Chicken for a
 * guest who had just said they were allergic to dairy, with no warning at
 * all. So the tool itself refuses, and a guard (acceptsAllergyHold) makes
 * sure the guest is told. Same shape as the order confirmation gate
 * (order-confirmation.ts): asked in one turn, answered in a later one.
 *
 * A guest counts as told if this tool held the dish, or if the waiter's last
 * reply said so itself. Models usually warn before ever trying to add it,
 * and a guest who has already said "yes, I know" shouldn't be asked again.
 *
 * Deliberately one-sided, like the menu graph's one-way rule. A false hold
 * costs a guest one extra "are you sure?"; a missed one can put them in
 * hospital. A dish with nothing flagged is NOT "safe": this check says
 * nothing about it, and the waiter still tells them to confirm with staff.
 *
 * Only the AI's tool is held. A guest pressing Add themselves is choosing a
 * dish they can see; the menu shows them its allergens.
 *
 * No `server-only`, so the evaluation's simulated restaurant runs this
 * exact rule (evals/waiter/world.ts).
 */

/** Words that say this person, or someone they're ordering for, must avoid something. */
const STATES_AVOIDING =
  /\b(?:allerg\w*|intoleran\w*|anaphyla\w*|celiac|coeliac|epi-?pen|avoid(?:ing)?|can'?t\s+(?:have|eat)|can\s*not\s+(?:have|eat)|no|without|free|nahi|nahin)\b|एलर्जी|नहीं/iu;

/**
 * "I'm not allergic", "no allergies", "I don't have any allergies". Only
 * the plain forms: anything subtler stays stated, because a wrong retraction
 * is the mistake that hurts someone. "No, I'm allergic to nuts" isn't one.
 */
const DENIES =
  /\bnot\s+(?:[a-z]+\s+)?allerg|\b(?:is|are|am)n'?t\s+(?:[a-z]+\s+)?allerg|\bno\s+(?!(?:i|i'?m|my|but)\b)(?:[a-z]+\s+){0,2}allerg(?:y|ies)\b|\b(?:do|does)(?:n'?t|\s+not)\s+have\s+(?:[a-z]+\s+){0,3}allerg/i;

/**
 * Hindi and Hinglish names, since this is who the product serves. The
 * shared lexicon is English: it also has to match restaurants' allergen
 * lists.
 */
const LOCAL_NAMES: Array<[RegExp, AllergenGroup]> = [
  [/\b(?:doodh|dudh)\b|दूध|डेयरी/iu, "dairy"],
  [/\b(?:anda|ande|andey)\b|अंडा|अंडे/iu, "egg"],
  [/\b(?:moongfali|mungfali)\b|मूंगफली/iu, "peanuts"],
  [/\b(?:kaju|badam)\b|काजू|बादाम|मेवे?/iu, "nuts"],
  [/\b(?:gehun|gehu)\b|ग्लूटेन|गेहूं/iu, "gluten"],
  [/\b(?:machli|machhli)\b|मछली/iu, "fish"],
];

function groupsNamedIn(sentence: string): AllergenGroup[] {
  const groups = new Set(allergenGroupsIn(sentence));
  for (const [name, group] of LOCAL_NAMES) {
    if (name.test(sentence)) groups.add(group);
  }
  return [...groups];
}

/**
 * The allergens a guest has said they must avoid, reading their messages in
 * order so a later "actually I'm not allergic to nuts" takes one back.
 * "Does this have nuts?" is a question, not a statement, and doesn't count.
 */
export function statedAllergies(userMessages: string[]): AllergenGroup[] {
  const stated = new Set<AllergenGroup>();
  for (const message of userMessages) {
    // "but" too: "not allergic to dairy but allergic to nuts" says both.
    for (const clause of message.split(/[.!?;\n।]+|\bbut\b/i)) {
      const groups = groupsNamedIn(clause);
      if (groups.length === 0) continue;
      if (DENIES.test(clause)) {
        for (const g of groups) stated.delete(g);
      } else if (STATES_AVOIDING.test(clause)) {
        for (const g of groups) stated.add(g);
      }
    }
  }
  return [...stated];
}

export interface AllergyHold {
  menuItemId: string;
  dish: string;
  groups: AllergenGroup[];
  /** As the guest would read them: "Dairy", "Tree nuts". */
  allergens: string[];
  /** Why: "Dairy: made with paneer". Strongest first. */
  reasons: string[];
}

/** What the tool log needs to show for a hold, read by a later turn. */
export interface LoggedToolCall {
  content: string;
  createdAt: string;
}

function isHoldFor(call: LoggedToolCall, menuItemId: string): boolean {
  try {
    const data = (JSON.parse(call.content) as { data?: AllergyHoldResult })
      .data;
    return data?.heldForAllergy === true && data.menuItemId === menuItemId;
  } catch {
    return false;
  }
}

const SAYS_YES =
  /\b(?:yes|yeah|yep|yup|sure|ok(?:ay)?|anyway|anyways|go ahead|still (?:want|like|have)|add it|i understand|i know|fine|haan?|theek|thik)\b|हाँ|हां|ठीक/iu;
const SAYS_NO =
  /^\s*(?:no|nope|nah|nahi)\b|\b(?:no thanks|never ?mind|cancel|don'?t add|something else)\b|(?:^|\s)मत(?:\s|$)|नहीं/iu;

/**
 * The guest's own words decide, not only the model's flag: a model that
 * warned and then called the tool without it kept a guest who'd said "add it
 * anyway" going round the same question (2026-10-30). The flag still counts
 * for a yes in words this can't read, but never over a plain no.
 */
function guestSaidYes(input: {
  guestAccepted: boolean;
  userMessages: string[];
}): boolean {
  const latest = input.userMessages.at(-1) ?? "";
  return (
    (input.guestAccepted || SAYS_YES.test(latest)) && !SAYS_NO.test(latest)
  );
}

/**
 * Did this reply warn about this dish? One sentence has to name both, so a
 * "dishes to avoid" list under a heading about dairy doesn't count: being
 * listed isn't the same as being told and asked.
 */
function warnedAbout(
  reply: string,
  dish: string,
  groups: AllergenGroup[],
): boolean {
  const name = dish.toLowerCase();
  return reply
    .split(/[.!?\n।]+/)
    .some(
      (sentence) =>
        sentence.toLowerCase().includes(name) &&
        groupsNamedIn(sentence).some((g) => groups.includes(g)),
    );
}

/**
 * Whether adding this dish must wait. The guest's acceptance counts only if
 * they were told about this same dish in an EARLIER turn, so a model can't
 * set the flag itself on the first try, and telling them was a real step.
 */
export function decideAllergyHold(input: {
  graph: MenuGraph;
  userMessages: string[];
  menuItemId: string;
  guestAccepted: boolean;
  /** add_item_to_cart's successful calls from before this turn. */
  earlierCalls: LoggedToolCall[];
  /** The waiter's reply just before the guest's latest message. */
  lastWaiterReply: string | null;
}): AllergyHold | null {
  const stated = statedAllergies(input.userMessages);
  if (stated.length === 0) return null;
  const report = allergenReport(input.graph, stated, {
    dishIds: new Set([input.menuItemId]),
  });
  const flagged = report.contains[0] ?? report.likely[0];
  if (!flagged) return null;
  // Only the allergens this dish is flagged for, not everything they said.
  const flaggedGroups = stated.filter((g) =>
    flagged.reasons.some((r) => r.startsWith(`${ALLERGEN_LABELS[g]}:`)),
  );
  const groups = flaggedGroups.length > 0 ? flaggedGroups : stated;
  const told =
    input.earlierCalls.some((c) => isHoldFor(c, input.menuItemId)) ||
    warnedAbout(input.lastWaiterReply ?? "", flagged.name, groups);
  if (told && guestSaidYes(input)) return null;
  return {
    menuItemId: input.menuItemId,
    dish: flagged.name,
    groups,
    allergens: groups.map((g) => ALLERGEN_LABELS[g]),
    reasons: flagged.reasons.slice(0, 4),
  };
}

export interface AllergyHoldResult extends AllergyHold {
  added: false;
  heldForAllergy: true;
  instruction: string;
}

/** The tool's answer. A success, so the hold is logged for the later turn. */
export function allergyHoldResult(hold: AllergyHold): AllergyHoldResult {
  return {
    ...hold,
    added: false,
    heldForAllergy: true,
    instruction: `NOT added to the cart. The customer said they must avoid this, and ${hold.dish} is flagged for it. Tell them that plainly, with the reason, and ask whether they still want it or would like something else. Do not say it was added. Only if they then say they still want it, call add_item_to_cart again with guestAcceptedAllergyRisk: true.`,
  };
}

type Outcomes = ReadonlyArray<{
  toolName: string;
  result: { ok: boolean; data?: unknown };
}>;

/** The dishes held this turn. */
export function holdsIn(toolOutcomes: Outcomes): AllergyHoldResult[] {
  const byDish = new Map<string, AllergyHoldResult>();
  for (const o of toolOutcomes) {
    const data = o.result.data as AllergyHoldResult | undefined;
    if (
      o.toolName === "add_item_to_cart" &&
      o.result.ok &&
      data?.heldForAllergy
    ) {
      byDish.set(data.menuItemId, data);
    }
  }
  return [...byDish.values()];
}

/** A dish really went in this turn. A held one came back ok too. */
export function addedToCart(toolOutcomes: Outcomes): boolean {
  return toolOutcomes.some(
    (o) =>
      o.toolName === "add_item_to_cart" &&
      o.result.ok &&
      (o.result.data as { added?: boolean } | undefined)?.added === true,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "I added the Naan, but the Butter Chicken has dairy" claims only the naan. */
const SAME_CLAIM = String.raw`(?:(?!\bbut\b)[^.!?\n,;])*`;

function claimsAdded(dish: string, text: string): boolean {
  const name = escapeRegExp(dish);
  return new RegExp(
    String.raw`\b(?:i'?ve|i have|i)\s+(?:gone ahead and\s+)?(?:just\s+)?added\b${SAME_CLAIM}${name}|${name}${SAME_CLAIM}(?:\b(?:is|was|has been)\s+(?:now\s+)?(?:added|in your cart)\b|\badd\s+kar\s+di|जोड़\s*(?:दिया|दी|दिए))`,
    "i",
  ).test(text);
}

/**
 * The guard: on a turn where a dish was held, the reply must tell the guest
 * about the allergen and must not claim the dish was added.
 */
export function acceptsAllergyHold(
  toolOutcomes: Outcomes,
  finalText: string,
): boolean {
  const named = groupsNamedIn(finalText);
  const saysAllergy = /allerg|एलर्जी/i.test(finalText);
  return holdsIn(toolOutcomes).every(
    (hold) =>
      (saysAllergy || hold.groups.some((g) => named.includes(g))) &&
      !claimsAdded(hold.dish, finalText),
  );
}

export const ALLERGY_HOLD_CORRECTIVE_INSTRUCTION =
  "[System note: add_item_to_cart did NOT add that dish, because the customer said they must avoid an allergen it's flagged for. Tell them this plainly, name the allergen and the reason from the tool result, and ask whether they still want it or would like something else. Do not say it was added.]";

/**
 * What the guest reads whenever the model's reply didn't tell them, whatever
 * went wrong: a rejected reply, an empty one, too many tool calls.
 * Hand-written, like fallback-text.ts.
 */
export function allergyHoldText(
  holds: Pick<AllergyHold, "dish" | "allergens">[],
  language: "en" | "hi" | "es",
): string {
  const dishes = holds.map((h) => h.dish).join(", ");
  const allergens = [...new Set(holds.flatMap((h) => h.allergens))].join(", ");
  if (language === "hi") {
    return `${dishes} कार्ट में नहीं जोड़ा गया: इसमें ${allergens} होने की जानकारी है, और आपने इससे बचने को कहा था। क्या आप फिर भी लेना चाहेंगे, या कुछ और देखें?`;
  }
  if (language === "es") {
    return `No he añadido ${dishes}: indica ${allergens}, y dijiste que debes evitarlo. ¿Lo quieres de todos modos o prefieres otra cosa?`;
  }
  return `I haven't added ${dishes}: it's flagged for ${allergens}, and you said you need to avoid that. Do you still want it, or would you like something else?`;
}
