/**
 * The kitchen's sold-out screen, the part with no database in it: the
 * menu arranged the way a cook scans it (category, dish, then the dish's
 * add-ons), a search over all of it, and the list of what's off right
 * now. No `server-only`, per the extract-the-core convention.
 */

export interface SoldOutOption {
  id: string;
  name: string;
  /** The add-on group it belongs to, e.g. "Extras" — two dishes can both have a "Cheese". */
  groupName: string;
  available: boolean;
}

export interface SoldOutDish {
  id: string;
  name: string;
  available: boolean;
  /** When a dish sold out "until tomorrow" comes back by itself (ISO); null otherwise. */
  backAt: string | null;
  options: SoldOutOption[];
}

export interface SoldOutCategory {
  id: string;
  name: string;
  dishes: SoldOutDish[];
}

export interface SoldOutRows {
  categories: { id: string; name: string; display_order: number }[];
  dishes: {
    id: string;
    name: string;
    category_id: string;
    is_available: boolean;
    available_again_at?: string | null;
    display_order: number;
  }[];
  groups: {
    id: string;
    menu_item_id: string;
    name: string;
    display_order: number;
  }[];
  options: {
    id: string;
    modifier_id: string;
    name: string;
    is_available: boolean;
    display_order: number;
  }[];
}

const byOrder = <T extends { display_order: number; name: string }>(
  a: T,
  b: T,
) => a.display_order - b.display_order || a.name.localeCompare(b.name);

/** A dish whose category isn't listed (hidden, say) still has a switch. */
export const OTHER_CATEGORY_ID = "other";

export function buildSoldOutMenu(rows: SoldOutRows): SoldOutCategory[] {
  const groupsByDish = new Map<string, SoldOutRows["groups"]>();
  for (const group of [...rows.groups].sort(byOrder)) {
    const list = groupsByDish.get(group.menu_item_id) ?? [];
    list.push(group);
    groupsByDish.set(group.menu_item_id, list);
  }
  const optionsByGroup = new Map<string, SoldOutRows["options"]>();
  for (const option of [...rows.options].sort(byOrder)) {
    const list = optionsByGroup.get(option.modifier_id) ?? [];
    list.push(option);
    optionsByGroup.set(option.modifier_id, list);
  }

  const toDish = (dish: SoldOutRows["dishes"][number]): SoldOutDish => ({
    id: dish.id,
    name: dish.name,
    available: dish.is_available,
    backAt: dish.is_available ? null : (dish.available_again_at ?? null),
    options: (groupsByDish.get(dish.id) ?? []).flatMap((group) =>
      (optionsByGroup.get(group.id) ?? []).map((option) => ({
        id: option.id,
        name: option.name,
        groupName: group.name,
        available: option.is_available,
      })),
    ),
  });

  const known = new Set(rows.categories.map((c) => c.id));
  const dishes = [...rows.dishes].sort(byOrder);
  const menu: SoldOutCategory[] = [...rows.categories]
    .sort(byOrder)
    .map((category) => ({
      id: category.id,
      name: category.name,
      dishes: dishes
        .filter((dish) => dish.category_id === category.id)
        .map(toDish),
    }));
  const orphans = dishes.filter((dish) => !known.has(dish.category_id));
  if (orphans.length > 0) {
    menu.push({
      id: OTHER_CATEGORY_ID,
      name: "Other",
      dishes: orphans.map(toDish),
    });
  }
  return menu.filter((category) => category.dishes.length > 0);
}

/**
 * Narrows the menu to what matches `query` (case-insensitive, anywhere in
 * the name). A dish that matches keeps all its add-ons; a dish that only
 * matches through an add-on keeps just the matching ones, so typing
 * "naan" finds both the Naan dish and every curry's "Extra naan".
 */
export function filterSoldOutMenu(
  menu: SoldOutCategory[],
  query: string,
): SoldOutCategory[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return menu;
  const hit = (name: string) => name.toLowerCase().includes(needle);

  return menu
    .map((category) => ({
      ...category,
      dishes: category.dishes.flatMap((dish) => {
        if (hit(dish.name)) return [dish];
        const options = dish.options.filter(
          (option) => hit(option.name) || hit(option.groupName),
        );
        return options.length > 0 ? [{ ...dish, options }] : [];
      }),
    }))
    .filter((category) => category.dishes.length > 0);
}

export type SoldOutEntry =
  | { kind: "dish"; id: string; label: string; backAt: string | null }
  | { kind: "option"; id: string; label: string };

/** Everything off the menu right now, for the list at the top of the screen. */
export function soldOutNow(menu: SoldOutCategory[]): SoldOutEntry[] {
  const entries: SoldOutEntry[] = [];
  for (const category of menu) {
    for (const dish of category.dishes) {
      if (!dish.available) {
        entries.push({
          kind: "dish",
          id: dish.id,
          label: dish.name,
          backAt: dish.backAt,
        });
      }
      for (const option of dish.options) {
        if (!option.available) {
          entries.push({
            kind: "option",
            id: option.id,
            label: `${option.name} (${dish.name})`,
          });
        }
      }
    }
  }
  return entries;
}

/** A calendar date, YYYY-MM-DD, in the given timezone. */
function localDate(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-CA", { timeZone });
}

/**
 * When a dish sold out "until tomorrow" comes back, the way a cook says it:
 * "Back tomorrow 11:00 AM", "Back today 5:00 PM", or "Back Thu 11:00 AM"
 * after a closed day. In the restaurant's timezone, not the tablet's.
 */
export function formatBackAt(
  backAt: string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const at = new Date(backAt);
  const time = at.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const day = localDate(at, timeZone);
  const tomorrow = localDate(new Date(now.getTime() + 86_400_000), timeZone);
  if (day === localDate(now, timeZone)) return `Back today ${time}`;
  if (day === tomorrow) return `Back tomorrow ${time}`;
  const weekday = at.toLocaleDateString("en-US", {
    weekday: "short",
    timeZone,
  });
  return `Back ${weekday} ${time}`;
}
