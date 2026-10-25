/**
 * Square's catalog, turned into the menu shape apply_pos_menu_sync()
 * takes (20261109090000_square_connection.sql). Pure and unit-tested
 * (tests/unit/square-connection.test.ts); api.ts fetches the objects.
 *
 * How Square's model maps onto Tableside's:
 * - CATEGORY → a section. Items without one land in "Other".
 * - ITEM with one variation → one dish, priced from that variation. Its
 *   external_id is the VARIATION id, because that is what a Square order
 *   line points at (catalog_object_id).
 * - ITEM with several variations (Small / Large) → one dish priced at the
 *   cheapest, plus a required "Choose one" group whose options are the
 *   variations, each priced as the difference. The group's external_id is
 *   "var:<item id>" and each option's is the variation id, so an order
 *   line can recover the exact variation chosen.
 * - MODIFIER_LIST → a group on every dish it's attached to. Tableside
 *   groups belong to one dish, so a list shared by five dishes becomes
 *   five groups, external_id "ml:<list id>:<item id>"; each option's
 *   external_id is the Square modifier id.
 *
 * Square amounts are in the smallest currency unit (cents); Tableside
 * stores decimal currency.
 */

interface Money {
  amount?: number | string | null;
  currency?: string;
}

export interface SquareCatalogObject {
  type: string;
  id: string;
  is_deleted?: boolean;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  category_data?: { name?: string };
  item_data?: {
    name?: string;
    description?: string;
    description_plaintext?: string;
    category_id?: string;
    categories?: { id: string; ordinal?: number }[];
    reporting_category?: { id: string };
    is_archived?: boolean;
    variations?: SquareCatalogObject[];
    modifier_list_info?: {
      modifier_list_id: string;
      enabled?: boolean;
      min_selected_modifiers?: number;
      max_selected_modifiers?: number;
    }[];
  };
  item_variation_data?: {
    name?: string;
    ordinal?: number;
    pricing_type?: string;
    price_money?: Money;
    location_overrides?: {
      location_id: string;
      sold_out?: boolean;
      price_money?: Money;
    }[];
  };
  modifier_list_data?: {
    name?: string;
    selection_type?: "SINGLE" | "MULTIPLE";
    ordinal?: number;
    modifiers?: SquareCatalogObject[];
  };
  modifier_data?: {
    name?: string;
    ordinal?: number;
    price_money?: Money;
    location_overrides?: { location_id: string; sold_out?: boolean }[];
  };
}

export interface MenuSyncOption {
  external_id: string;
  name: string;
  price_adjustment: number;
  is_available: boolean;
  display_order: number;
}

export interface MenuSyncGroup {
  external_id: string;
  name: string;
  is_required: boolean;
  min_selections: number;
  max_selections: number;
  display_order: number;
  options: MenuSyncOption[];
}

export interface MenuSyncItem {
  external_id: string;
  category_external_id: string;
  name: string;
  description: string | null;
  price: number;
  is_available: boolean;
  display_order: number;
  groups: MenuSyncGroup[];
}

export interface MenuSyncPayload {
  categories: { external_id: string; name: string; display_order: number }[];
  items: MenuSyncItem[];
}

export interface CatalogMapResult {
  menu: MenuSyncPayload;
  /** Square items that couldn't be imported, with a reason the owner can act on. */
  skipped: { name: string; reason: string }[];
}

export const UNCATEGORIZED_ID = "square:uncategorized";
export const VARIATION_GROUP_PREFIX = "var:";

const toMajor = (money: Money | undefined): number | null => {
  if (!money || money.amount === null || money.amount === undefined)
    return null;
  const cents = Number(money.amount);
  return Number.isFinite(cents) ? Math.round(cents) / 100 : null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Present at the location the restaurant connected? Square's rule. */
export function presentAt(
  object: SquareCatalogObject,
  locationId: string,
): boolean {
  if (object.present_at_all_locations !== false) {
    return !(object.absent_at_location_ids ?? []).includes(locationId);
  }
  return (object.present_at_location_ids ?? []).includes(locationId);
}

function variationPrice(
  variation: SquareCatalogObject,
  locationId: string,
): number | null {
  const data = variation.item_variation_data;
  if (!data) return null;
  const override = data.location_overrides?.find(
    (o) => o.location_id === locationId,
  );
  return toMajor(override?.price_money ?? data.price_money);
}

function variationSoldOut(
  variation: SquareCatalogObject,
  locationId: string,
): boolean {
  return Boolean(
    variation.item_variation_data?.location_overrides?.find(
      (o) => o.location_id === locationId,
    )?.sold_out,
  );
}

export function mapSquareCatalog(
  objects: SquareCatalogObject[],
  locationId: string,
): CatalogMapResult {
  const live = objects.filter((o) => !o.is_deleted);
  const categoryNames = new Map<string, string>();
  const modifierLists = new Map<string, SquareCatalogObject>();
  for (const o of live) {
    if (o.type === "CATEGORY" && o.category_data?.name) {
      categoryNames.set(o.id, o.category_data.name);
    }
    if (o.type === "MODIFIER_LIST") modifierLists.set(o.id, o);
  }

  const skipped: CatalogMapResult["skipped"] = [];
  const usedCategories = new Map<string, number>();
  const items: MenuSyncItem[] = [];

  const itemObjects = live.filter(
    (o) =>
      o.type === "ITEM" &&
      !o.item_data?.is_archived &&
      presentAt(o, locationId),
  );

  itemObjects.forEach((item, itemIndex) => {
    const data = item.item_data ?? {};
    const name = data.name?.trim();
    if (!name) return;

    const variations = (data.variations ?? [])
      .filter((v) => !v.is_deleted && presentAt(v, locationId))
      .sort(
        (a, b) =>
          (a.item_variation_data?.ordinal ?? 0) -
          (b.item_variation_data?.ordinal ?? 0),
      );
    const priced = variations
      .map((v) => ({ v, price: variationPrice(v, locationId) }))
      .filter(
        (p): p is { v: SquareCatalogObject; price: number } =>
          p.price !== null &&
          p.v.item_variation_data?.pricing_type !== "VARIABLE_PRICING",
      );

    if (priced.length === 0) {
      // Variable-priced ("enter amount at the register") items have no
      // price a diner can be shown, and Tableside never guesses one.
      skipped.push({
        name,
        reason: "No fixed price in Square (variable pricing).",
      });
      return;
    }

    const rawCategory =
      data.categories?.[0]?.id ?? data.reporting_category?.id ?? data.category_id;
    const categoryId =
      rawCategory && categoryNames.has(rawCategory)
        ? rawCategory
        : UNCATEGORIZED_ID;
    if (!usedCategories.has(categoryId)) {
      usedCategories.set(categoryId, usedCategories.size);
    }

    const base = Math.min(...priced.map((p) => p.price));
    const groups: MenuSyncGroup[] = [];

    if (priced.length > 1) {
      groups.push({
        external_id: `${VARIATION_GROUP_PREFIX}${item.id}`,
        name: "Choose one",
        is_required: true,
        min_selections: 1,
        max_selections: 1,
        display_order: 0,
        options: priced.map((p, i) => ({
          external_id: p.v.id,
          name: p.v.item_variation_data?.name?.trim() || `Option ${i + 1}`,
          price_adjustment: round2(p.price - base),
          is_available: !variationSoldOut(p.v, locationId),
          display_order: i,
        })),
      });
    }

    (data.modifier_list_info ?? [])
      .filter((info) => info.enabled !== false)
      .forEach((info) => {
        const list = modifierLists.get(info.modifier_list_id);
        const listData = list?.modifier_list_data;
        if (!list || !listData) return;
        const modifiers = (listData.modifiers ?? [])
          .filter((m) => !m.is_deleted && presentAt(m, locationId))
          .sort(
            (a, b) =>
              (a.modifier_data?.ordinal ?? 0) - (b.modifier_data?.ordinal ?? 0),
          );
        if (modifiers.length === 0) return;

        // Square uses -1 for "no limit set". SINGLE lists allow one.
        const single = listData.selection_type === "SINGLE";
        const min = Math.max(info.min_selected_modifiers ?? 0, 0);
        const rawMax = info.max_selected_modifiers ?? -1;
        const max = single
          ? 1
          : rawMax > 0
            ? rawMax
            : modifiers.length;
        groups.push({
          external_id: `ml:${list.id}:${item.id}`,
          name: listData.name?.trim() || "Options",
          is_required: min > 0,
          min_selections: Math.min(min, max),
          max_selections: Math.max(max, Math.min(min, max), 1),
          display_order: groups.length,
          options: modifiers.map((m, i) => ({
            external_id: m.id,
            name: m.modifier_data?.name?.trim() || `Option ${i + 1}`,
            price_adjustment: toMajor(m.modifier_data?.price_money) ?? 0,
            is_available: !m.modifier_data?.location_overrides?.find(
              (o) => o.location_id === locationId,
            )?.sold_out,
            display_order: i,
          })),
        });
      });

    const allSoldOut = priced.every((p) => variationSoldOut(p.v, locationId));
    items.push({
      // One variation: the dish IS that variation. Several: the dish is the
      // item, and the variation comes from the "Choose one" group. (So a
      // dish that gains a second size in Square comes back as a new dish
      // and the old one is hidden: its photos and allergens need re-adding.)
      external_id: priced.length === 1 ? priced[0].v.id : item.id,
      category_external_id: categoryId,
      name: name.slice(0, 200),
      description:
        (data.description_plaintext ?? data.description)?.trim() || null,
      price: round2(base),
      is_available: !allSoldOut,
      display_order: itemIndex,
      groups,
    });
  });

  const categories = [...usedCategories.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id], i) => ({
      external_id: id,
      name: id === UNCATEGORIZED_ID ? "Other" : (categoryNames.get(id) ?? "Other"),
      display_order: i,
    }));

  return { menu: { categories, items }, skipped };
}
