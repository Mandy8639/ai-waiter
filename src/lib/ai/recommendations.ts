import type { LoopToolOutcome } from "./loop";

/**
 * Which real menu items a waiter reply talks about, so the chat can show
 * them as dish cards instead of leaving the diner to hunt for them.
 *
 * The contract, and why it is shaped this way
 * -------------------------------------------
 * The candidates come ONLY from structured tool results of this same turn:
 * a successful `search_menu` (its `items`) or `get_menu_item` (the item
 * itself). Those are rows the database just returned through the diner's
 * own RLS-scoped client, available and priced by the server. Nothing here
 * ever reads an id, a price or a name out of the model's prose.
 *
 * The reply text is used for one thing: choosing WHICH of those real rows
 * the waiter actually mentioned, and in what order. A search for "dosa"
 * returns up to 25 rows; showing all 25 as cards under a reply that names
 * two would bury the answer. Matching a name the database supplied against
 * the reply is a membership test on known strings, not free-form parsing,
 * so the failure mode is benign: a dish the model renamed ("the dosa")
 * simply gets no card, and the reply still reads correctly — except in the
 * one case covered by singleDishInPlay() below.
 *
 * Why not a dedicated "show these dishes" tool the model calls with ids?
 * It was considered. Every tool call is another model round trip (2–10 s
 * on the current models) and spends the per-turn tool budget that a real
 * compound question already exhausted once in live testing. Deriving the
 * cards from calls the model already made costs nothing extra.
 *
 * The UI labels these "On the menu", not "Recommended": a reply can name a
 * dish in order to warn a diner off it ("the jalebi lists ghee"), and a
 * card must not imply an endorsement the text did not make.
 *
 * Pure and free of `server-only`, per the extract-the-core convention.
 */

export const MAX_RECOMMENDED_ITEMS = 4;

export interface MentionedMenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  isVegetarian: boolean;
  isVegan: boolean;
  isSpicy: boolean;
}

interface ToolMenuItem {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  price?: unknown;
  isVegetarian?: unknown;
  isVegan?: unknown;
  isSpicy?: unknown;
}

function toItem(raw: ToolMenuItem, currency: string): MentionedMenuItem | null {
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  if (typeof raw.price !== "number" || !Number.isFinite(raw.price)) return null;
  return {
    id: raw.id,
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : null,
    price: raw.price,
    currency,
    isVegetarian: raw.isVegetarian === true,
    isVegan: raw.isVegan === true,
    isSpicy: raw.isSpicy === true,
  };
}

/** Every item an authoritative menu tool returned this turn, first sighting wins. */
export function collectToolMenuItems(
  toolOutcomes: LoopToolOutcome[],
): MentionedMenuItem[] {
  const byId = new Map<string, MentionedMenuItem>();

  for (const outcome of toolOutcomes) {
    if (!outcome.result.ok) continue;
    const data = outcome.result.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") continue;
    const currency = typeof data.currency === "string" ? data.currency : "USD";

    const raws: ToolMenuItem[] =
      outcome.toolName === "search_menu" && Array.isArray(data.items)
        ? (data.items as ToolMenuItem[])
        : outcome.toolName === "get_menu_item"
          ? [data as ToolMenuItem]
          : // The menu knowledge graph: what guests pair a dish with, and,
            // from an allergy check, only the dishes NOT marked as
            // containing the allergen — never a card for one to avoid.
            outcome.toolName === "get_pairings" && Array.isArray(data.pairings)
            ? (data.pairings as ToolMenuItem[])
            : outcome.toolName === "check_menu_allergens" &&
                Array.isArray(data.notMarkedAsContaining)
              ? (data.notMarkedAsContaining as ToolMenuItem[])
              : [];

    for (const raw of raws) {
      const item = toItem(raw, currency);
      if (item && !byId.has(item.id)) byId.set(item.id, item);
    }
  }

  return [...byId.values()];
}

/** Lower-cased, markdown emphasis removed, whitespace collapsed. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Any letter outside the Latin script — Devanagari, Arabic, CJK, and so on. */
const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u;

function occurrences(
  haystack: string,
  needle: string,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!needle) return ranges;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    const before = at > 0 ? haystack[at - 1] : "";
    const after = haystack[at + needle.length] ?? "";
    // Whole-phrase only: "Tea" must not match inside "Teacake", nor
    // "Dosa" inside "Dosai".
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) {
      ranges.push([at, at + needle.length]);
    }
    from = at + 1;
  }
  return ranges;
}

/**
 * The menu items a reply names, in the order it names them, capped at
 * MAX_RECOMMENDED_ITEMS. A name that only ever appears inside a longer
 * matched name ("Masala Dosa" inside "Mysore Masala Dosa") does not count
 * as a separate mention.
 */
export function selectMentionedItems(
  reply: string,
  toolOutcomes: LoopToolOutcome[],
  limit = MAX_RECOMMENDED_ITEMS,
): MentionedMenuItem[] {
  const text = normalize(reply);
  if (!text) return [];

  const matches = collectToolMenuItems(toolOutcomes)
    .map((item) => ({
      item,
      ranges: occurrences(text, normalize(item.name)),
    }))
    .filter((m) => m.ranges.length > 0);

  const standalone = matches
    .map((m) => ({
      item: m.item,
      ranges: m.ranges.filter(
        ([start, end]) =>
          !matches.some(
            (other) =>
              other !== m &&
              normalize(other.item.name).length >
                normalize(m.item.name).length &&
              other.ranges.some(([s, e]) => s <= start && end <= e),
          ),
      ),
    }))
    .filter((m) => m.ranges.length > 0);

  if (standalone.length > 0) {
    return standalone
      .sort((a, b) => a.ranges[0][0] - b.ranges[0][0])
      .slice(0, limit)
      .map((m) => m.item);
  }

  // Only for replies in another script. A Latin-script reply that names a
  // dish already matched above; one that names none is genuinely about
  // something else, and a card there would be a guess ("a teacake would be
  // nice" is not about the Tea a search happened to return).
  return NON_LATIN_LETTER.test(reply) ? singleDishInPlay(toolOutcomes) : [];
}

/**
 * The fallback when the reply names no dish the matcher can find: if
 * exactly ONE dish is in play this turn, the reply is about that dish, so
 * it gets its card.
 *
 * Why it exists (phase E): replies in Hindi write "Chicken Biryani" as
 * "चिकन बिरयानी", and live testing showed the free models do this even when
 * the system prompt tells them not to. The name match above then finds
 * nothing, so no card appears — and the card is the one place the diner
 * sees the restaurant's own allergen text ("Contains Peanuts, Milk")
 * exactly as the restaurant wrote it, rather than as the model translated
 * it. Losing it in exactly the replies that are already machine-translated
 * is the wrong way round, so this does not rely on the model obeying.
 *
 * "Exactly one dish in play", in order of preference:
 *   1. one dish looked up in detail with get_menu_item (however many
 *      search results came back alongside it), else
 *   2. one dish across everything the tools returned — typically a search
 *      for a named dish that matched only that dish.
 * Two or more, and there is no telling which dish the reply is about, so
 * no card is safer than a wrong one.
 */
function singleDishInPlay(
  toolOutcomes: LoopToolOutcome[],
): MentionedMenuItem[] {
  const detailed = collectToolMenuItems(
    toolOutcomes.filter((outcome) => outcome.toolName === "get_menu_item"),
  );
  if (detailed.length === 1) return detailed;
  if (detailed.length > 1) return [];

  const all = collectToolMenuItems(toolOutcomes);
  return all.length === 1 ? all : [];
}
