import type {
  CatalogMapResult,
  MenuSyncGroup,
  MenuSyncItem,
} from "../square/catalog-core";

/**
 * Clover's inventory, turned into the menu shape apply_pos_menu_sync()
 * takes (the same one Square's import builds). Pure and unit-tested
 * (tests/unit/clover-connection.test.ts); api.ts fetches the objects.
 *
 * How Clover's model maps onto Tableside's:
 * - Category → a section, by Clover's sortOrder. Items in none land in
 *   "Other"; an item in several takes its first.
 * - Item → one dish. external_id is the Clover item id, which is what an
 *   order line points at (lineItems[].item.id).
 * - Modifier group → a group on every dish it's attached to. Tableside
 *   groups belong to one dish, so a group shared by five dishes becomes
 *   five, external_id "mg:<group id>:<item id>"; each option's external_id
 *   is the Clover modifier id. minRequired/maxAllowed carry over; a
 *   missing or zero maxAllowed means "any number".
 * - Hidden or unavailable items come in unavailable rather than missing,
 *   so a dish 86'd on the register is 86'd in Tableside.
 * - Variable and per-unit priced items are skipped and named: Tableside
 *   can't guess a price.
 *
 * Clover amounts are cents; Tableside stores decimal currency.
 */

export interface CloverCategory {
  id: string;
  name?: string;
  sortOrder?: number;
  deleted?: boolean;
}

export interface CloverModifier {
  id: string;
  name?: string;
  price?: number;
  available?: boolean;
}

export interface CloverModifierGroup {
  id: string;
  name?: string;
  minRequired?: number | null;
  maxAllowed?: number | null;
  sortOrder?: number;
  deleted?: boolean;
  modifiers?: { elements?: CloverModifier[] };
}

export interface CloverItem {
  id: string;
  name?: string;
  price?: number;
  priceType?: "FIXED" | "VARIABLE" | "PER_UNIT" | string;
  hidden?: boolean;
  available?: boolean;
  deleted?: boolean;
  categories?: { elements?: { id: string }[] };
  modifierGroups?: { elements?: { id: string }[] };
}

export const CLOVER_UNCATEGORIZED_ID = "clover:uncategorized";
export const CLOVER_GROUP_PREFIX = "mg:";

const toMajor = (cents: number | undefined): number =>
  Math.round(Number(cents ?? 0)) / 100;

export function mapCloverInventory(input: {
  items: CloverItem[];
  categories: CloverCategory[];
  modifierGroups: CloverModifierGroup[];
}): CatalogMapResult {
  const categories = input.categories
    .filter((c) => !c.deleted && c.name?.trim())
    .sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
        (a.name ?? "").localeCompare(b.name ?? ""),
    );
  const categoryOrder = new Map(categories.map((c, i) => [c.id, i]));
  const groupsById = new Map(
    input.modifierGroups.filter((g) => !g.deleted).map((g) => [g.id, g]),
  );

  const skipped: CatalogMapResult["skipped"] = [];
  const items: MenuSyncItem[] = [];
  let uncategorized = false;

  const live = input.items
    .filter((item) => !item.deleted && item.name?.trim())
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  live.forEach((item, index) => {
    const name = item.name!.trim();
    if (item.priceType && item.priceType !== "FIXED") {
      skipped.push({
        name,
        reason:
          item.priceType === "PER_UNIT"
            ? "priced by weight or unit"
            : "priced at the register",
      });
      return;
    }

    const categoryId =
      (item.categories?.elements ?? [])
        .map((c) => c.id)
        .find((id) => categoryOrder.has(id)) ?? null;
    if (!categoryId) uncategorized = true;

    const groups: MenuSyncGroup[] = [];
    for (const ref of item.modifierGroups?.elements ?? []) {
      const group = groupsById.get(ref.id);
      if (!group) continue;
      const options = (group.modifiers?.elements ?? [])
        .filter((m) => m.name?.trim())
        .map((m, i) => ({
          external_id: m.id,
          name: m.name!.trim(),
          price_adjustment: toMajor(m.price),
          is_available: m.available !== false,
          display_order: i,
        }));
      if (options.length === 0) continue;
      const min = Math.max(0, Math.min(group.minRequired ?? 0, options.length));
      const max =
        group.maxAllowed && group.maxAllowed > 0
          ? Math.max(min, Math.min(group.maxAllowed, options.length))
          : options.length;
      groups.push({
        external_id: `${CLOVER_GROUP_PREFIX}${group.id}:${item.id}`,
        name: group.name?.trim() || "Options",
        is_required: min > 0,
        min_selections: min,
        max_selections: max,
        display_order: groups.length,
        options,
      });
    }

    items.push({
      external_id: item.id,
      category_external_id: categoryId ?? CLOVER_UNCATEGORIZED_ID,
      name,
      description: null,
      price: toMajor(item.price),
      is_available: item.available !== false && !item.hidden,
      display_order: index,
      groups,
    });
  });

  const usedCategories = new Set(items.map((i) => i.category_external_id));
  return {
    menu: {
      categories: [
        ...categories
          .filter((c) => usedCategories.has(c.id))
          .map((c, i) => ({
            external_id: c.id,
            name: c.name!.trim(),
            display_order: i,
          })),
        ...(uncategorized
          ? [
              {
                external_id: CLOVER_UNCATEGORIZED_ID,
                name: "Other",
                display_order: categories.length,
              },
            ]
          : []),
      ],
      items,
    },
    skipped,
  };
}
