/**
 * The same dish listed twice in one section at two different prices.
 *
 * Found on a real 249-dish import (2026-10-18): Chicken Tikka Masala came
 * back at $18 and $19 in the same section. Until then the reader quietly
 * kept the first and dropped the second, so the restaurant never saw that
 * the board disagreed with itself. Now both rows reach the review screen,
 * and neither can be added until a person decides which price is right
 * (untick one, fix a price, or rename one if they really are two dishes).
 *
 * Scoped to one section on purpose: "Chilli Paneer" as a $7 appetizer and
 * a $17 entree is two things the restaurant sells, not a conflict.
 *
 * commit_menu_import() applies the same rule, so this is the early
 * warning, not the safety property. The two must normalise names the same
 * way: trimmed, whitespace collapsed, lower-cased.
 */

export interface PriceConflictRow {
  id: string;
  categoryName: string;
  name: string;
  price: number | null;
  include: boolean;
}

function key(row: PriceConflictRow): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return `${norm(row.categoryName)}::${norm(row.name)}`;
}

/**
 * Row id → the other prices the same dish is listed at in its section.
 * Only included, priced rows count: an unticked row has been dealt with,
 * and an unpriced one is already blocked for its own reason.
 */
export function findPriceConflicts(
  rows: PriceConflictRow[],
): Map<string, number[]> {
  const groups = new Map<string, PriceConflictRow[]>();
  for (const row of rows) {
    if (!row.include || row.price === null) continue;
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }

  const conflicts = new Map<string, number[]>();
  for (const group of groups.values()) {
    const prices = new Set(group.map((r) => r.price as number));
    if (prices.size < 2) continue;
    for (const row of group) {
      conflicts.set(
        row.id,
        [...prices].filter((p) => p !== row.price).sort((a, b) => a - b),
      );
    }
  }
  return conflicts;
}
