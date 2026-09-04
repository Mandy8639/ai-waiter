import { z } from "zod";

/**
 * Turns a vision model's reply into draft menu rows.
 *
 * Deliberately free of `import "server-only"` so it is directly unit
 * testable — the established split in this codebase (see
 * src/lib/payments/stripe-mode.ts, src/lib/ai/tools/cart-fact-detection.ts).
 *
 * The single rule everything here serves: **a price is never invented.**
 * A menu board that gives no price (Nashta's own boards had 14 such items,
 * "ask at counter") must survive extraction as `null` and be resolved by a
 * human. A model that guesses, or a parser that coerces a missing price to
 * 0, produces a restaurant charging the wrong amount — which is the
 * fabricated-cart-write failure again, with money attached.
 */

/** What the model is asked to return. Anything else is a parse failure, not a silent default. */
const extractedItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * `null` is a real, expected answer. `.nullable()` rather than
   * `.optional()` so an omitted price is a schema error the caller can see,
   * not something that quietly becomes undefined.
   */
  price: z.number().nonnegative().max(100000).nullable(),
});

const extractedCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  items: z.array(extractedItemSchema),
});

export const extractionSchema = z.object({
  categories: z.array(extractedCategorySchema),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

export interface DraftItem {
  categoryName: string;
  name: string;
  /** null means the board stated no price — see the module comment. */
  price: number | null;
  displayOrder: number;
}

export interface ParseOutcome {
  ok: boolean;
  drafts: DraftItem[];
  /** Customer-safe reason when ok is false. Never a raw parser message. */
  error?: string;
  /** How many drafts came back with no price. Surfaced so the UI can say so up front. */
  unpricedCount: number;
}

/**
 * Vision models wrap JSON in prose or fences more often than not, so the
 * first balanced object is extracted rather than demanding a clean body.
 * Returns null when there is nothing object-shaped at all.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      // Balanced: this is the end of the first complete object. Braces
      // inside strings can't reach here, so an item literally named
      // "Combo {2 pcs}" doesn't truncate the parse.
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Trailing punctuation and stray whitespace are common in board text
 * ("SOUTH INDIAN  —"), and would otherwise create near-duplicate
 * categories that a reviewer has to merge by hand.
 */
export function normaliseCategoryName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:·|]+|[\s\-–—:·|]+$/g, "")
    .trim();
}

export function parseExtraction(rawText: string): ParseOutcome {
  const json = extractJsonObject(rawText);
  if (!json) {
    return {
      ok: false,
      drafts: [],
      unpricedCount: 0,
      error: "Couldn't read a menu from that response. Please try again.",
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return {
      ok: false,
      drafts: [],
      unpricedCount: 0,
      error:
        "The menu reader returned something unreadable. Please try again, or upload a clearer photo.",
    };
  }

  const result = extractionSchema.safeParse(parsedJson);
  if (!result.success) {
    return {
      ok: false,
      drafts: [],
      unpricedCount: 0,
      error:
        "The menu reader returned an unexpected shape. Please try again, or upload a clearer photo.",
    };
  }

  const drafts: DraftItem[] = [];
  let order = 0;
  const seen = new Set<string>();

  for (const category of result.data.categories) {
    const categoryName = normaliseCategoryName(category.name);
    if (!categoryName) continue;

    for (const item of category.items) {
      const name = item.name.trim();
      if (!name) continue;

      // The same dish read twice off overlapping photos is common when a
      // long board is shot in sections. Dropped here so a reviewer isn't
      // deduplicating by hand — scoped per category, since "Plain Dosa"
      // under two genuinely different headings is not a duplicate.
      const key = `${categoryName.toLowerCase()}::${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      drafts.push({
        categoryName,
        name,
        price: item.price,
        displayOrder: order,
      });
      order += 1;
    }
  }

  if (drafts.length === 0) {
    return {
      ok: false,
      drafts: [],
      unpricedCount: 0,
      error:
        "No menu items were found in that photo. Try a closer or better-lit shot.",
    };
  }

  return {
    ok: true,
    drafts,
    unpricedCount: drafts.filter((d) => d.price === null).length,
  };
}

/** The instruction sent with the images. Exported so a test can assert it still forbids guessing. */
export const EXTRACTION_PROMPT = `Read this restaurant menu and return ONLY JSON, with no prose or explanation:
{"categories":[{"name":"...","items":[{"name":"...","price":number|null}]}]}

Rules:
- "price" must be a NUMBER, or null.
- NEVER invent, estimate, or infer a price. If the menu does not clearly state one — it is unreadable, or says something like "ask at counter", "market price", or "by weight" — use null.
- Copy item names exactly as printed, including things like "(2 pcs)".
- Use the menu's own category headings. If an item has no heading above it, put it in a category called "Uncategorised".
- Include every item you can read. Do not summarise or skip.`;
