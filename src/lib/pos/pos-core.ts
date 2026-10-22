/**
 * The POS screen (/dashboard/pos), the part with no database in it: the
 * menu arranged for ringing up, the ticket being built, and its estimate.
 * The real prices, add-on rules and totals are staff_place_order()'s
 * (20261107090000); this only has to agree with it closely enough that
 * nothing surprises the person at the till.
 *
 * No `server-only`, per the extract-the-core convention.
 */

export interface PosOption {
  id: string;
  name: string;
  price: number;
  available: boolean;
}

export interface PosGroup {
  id: string;
  name: string;
  required: boolean;
  min: number;
  max: number;
  options: PosOption[];
}

export interface PosDish {
  id: string;
  name: string;
  price: number;
  available: boolean;
  groups: PosGroup[];
}

export interface PosCategory {
  id: string;
  name: string;
  /** False outside its menu's hours: the database refuses its dishes then. */
  onNow: boolean;
  dishes: PosDish[];
}

export interface PosTable {
  id: string;
  label: string;
  /** A pickup counter takes takeout and phone orders, under a name. */
  kind: "table" | "counter";
}

export interface PosMenuRows {
  categories: {
    id: string;
    name: string;
    display_order: number;
    onNow: boolean;
  }[];
  dishes: {
    id: string;
    name: string;
    category_id: string;
    price: number;
    is_available: boolean;
    display_order: number;
  }[];
  groups: {
    id: string;
    menu_item_id: string;
    name: string;
    is_required: boolean;
    min_selections: number;
    max_selections: number;
    display_order: number;
  }[];
  options: {
    id: string;
    modifier_id: string;
    name: string;
    price_adjustment: number;
    is_available: boolean;
    display_order: number;
  }[];
}

const byOrder = <T extends { display_order: number; name: string }>(
  a: T,
  b: T,
) => a.display_order - b.display_order || a.name.localeCompare(b.name);

/** Categories in menu order, each with its dishes; empty categories left out. */
export function buildPosMenu(rows: PosMenuRows): PosCategory[] {
  const optionsByGroup = new Map<string, PosOption[]>();
  for (const o of [...rows.options].sort(byOrder)) {
    const list = optionsByGroup.get(o.modifier_id) ?? [];
    list.push({
      id: o.id,
      name: o.name,
      price: Number(o.price_adjustment),
      available: o.is_available,
    });
    optionsByGroup.set(o.modifier_id, list);
  }

  const groupsByDish = new Map<string, PosGroup[]>();
  for (const g of [...rows.groups].sort(byOrder)) {
    const list = groupsByDish.get(g.menu_item_id) ?? [];
    list.push({
      id: g.id,
      name: g.name,
      required: g.is_required,
      min: g.min_selections,
      max: g.max_selections,
      options: optionsByGroup.get(g.id) ?? [],
    });
    groupsByDish.set(g.menu_item_id, list);
  }

  const dishesByCategory = new Map<string, PosDish[]>();
  for (const d of [...rows.dishes].sort(byOrder)) {
    const list = dishesByCategory.get(d.category_id) ?? [];
    list.push({
      id: d.id,
      name: d.name,
      price: Number(d.price),
      available: d.is_available,
      groups: groupsByDish.get(d.id) ?? [],
    });
    dishesByCategory.set(d.category_id, list);
  }

  return [...rows.categories]
    .sort(byOrder)
    .map((c) => ({
      id: c.id,
      name: c.name,
      onNow: c.onNow,
      dishes: dishesByCategory.get(c.id) ?? [],
    }))
    .filter((c) => c.dishes.length > 0);
}

/** Dishes whose name matches, across every category, in menu order. */
export function searchPosMenu(menu: PosCategory[], query: string): PosDish[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return menu.flatMap((c) =>
    c.dishes.filter((d) => d.name.toLowerCase().includes(q)),
  );
}

/** The fewest options a group needs, as the database counts it. */
export function effectiveMin(group: PosGroup): number {
  return group.required ? Math.max(1, group.min) : group.min;
}

/** What's wrong with a group's choices, in words for the till; null if fine. */
export function groupProblem(
  group: PosGroup,
  selected: readonly string[],
): string | null {
  const count = group.options.filter((o) => selected.includes(o.id)).length;
  const min = effectiveMin(group);
  if (count < min) {
    return min === 1
      ? `Choose a ${group.name}`
      : `Choose ${min} for ${group.name}`;
  }
  if (count > group.max) {
    return `Only ${group.max} for ${group.name}`;
  }
  return null;
}

/**
 * Tapping an option: a pick-one group swaps its choice, a pick-several
 * group toggles, never past its maximum.
 */
export function toggleOption(
  group: PosGroup,
  selected: readonly string[],
  optionId: string,
): string[] {
  const inGroup = new Set(group.options.map((o) => o.id));
  if (selected.includes(optionId)) {
    return selected.filter((id) => id !== optionId);
  }
  if (group.max === 1) {
    return [...selected.filter((id) => !inGroup.has(id)), optionId];
  }
  const count = selected.filter((id) => inGroup.has(id)).length;
  if (count >= group.max) return [...selected];
  return [...selected, optionId];
}

/** Whether a dish can go straight onto the ticket with one tap. */
export function needsChoices(dish: PosDish): boolean {
  return dish.groups.length > 0;
}

export interface TicketLine {
  /** Identical dish + options + note share a line; quantity counts them. */
  key: string;
  dishId: string;
  name: string;
  /** Dish price plus its options, for one. */
  unitPrice: number;
  quantity: number;
  optionIds: string[];
  optionNames: string[];
  notes: string;
}

export function makeLine(
  dish: PosDish,
  optionIds: readonly string[],
  notes = "",
  quantity = 1,
): TicketLine {
  const chosen = dish.groups
    .flatMap((g) => g.options)
    .filter((o) => optionIds.includes(o.id));
  const sortedIds = chosen.map((o) => o.id).sort();
  const trimmed = notes.trim();
  return {
    key: [dish.id, sortedIds.join(","), trimmed].join("|"),
    dishId: dish.id,
    name: dish.name,
    unitPrice: dish.price + chosen.reduce((sum, o) => sum + o.price, 0),
    quantity,
    optionIds: sortedIds,
    optionNames: chosen.map((o) => o.name),
    notes: trimmed,
  };
}

/** Adds a line, or more of an identical one already on the ticket. */
export function addLine(
  lines: readonly TicketLine[],
  line: TicketLine,
): TicketLine[] {
  const existing = lines.find((l) => l.key === line.key);
  if (!existing) return [...lines, line];
  return lines.map((l) =>
    l.key === line.key
      ? { ...l, quantity: Math.min(99, l.quantity + line.quantity) }
      : l,
  );
}

/** Sets a line's quantity; zero or less takes it off the ticket. */
export function setQuantity(
  lines: readonly TicketLine[],
  key: string,
  quantity: number,
): TicketLine[] {
  if (quantity <= 0) return lines.filter((l) => l.key !== key);
  return lines.map((l) =>
    l.key === key ? { ...l, quantity: Math.min(99, quantity) } : l,
  );
}

/**
 * Changes a line's note. The note is part of what makes a line distinct,
 * so the line may now match another one, and they merge.
 */
export function setLineNotes(
  lines: readonly TicketLine[],
  key: string,
  notes: string,
): TicketLine[] {
  const line = lines.find((l) => l.key === key);
  if (!line) return [...lines];
  const trimmed = notes.trim().slice(0, 200);
  const updated: TicketLine = {
    ...line,
    notes: trimmed,
    key: [line.dishId, line.optionIds.join(","), trimmed].join("|"),
  };
  if (updated.key === key)
    return lines.map((l) => (l.key === key ? updated : l));
  const others = lines.filter((l) => l.key !== key);
  const index = lines.findIndex((l) => l.key === key);
  if (others.some((l) => l.key === updated.key)) {
    return addLine(others, updated);
  }
  return [...others.slice(0, index), updated, ...others.slice(index)];
}

const roundMoney = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface TicketTotals {
  subtotal: number;
  tax: number;
  serviceCharge: number;
  total: number;
  itemCount: number;
}

/**
 * The same arithmetic as staff_place_order(): each line rounded to the
 * cent, tax and service charge on the subtotal. An estimate only; the
 * order the database returns is the truth.
 */
export function ticketTotals(
  lines: readonly TicketLine[],
  taxRate: number,
  serviceChargeRate: number,
): TicketTotals {
  const subtotal = roundMoney(
    lines.reduce((sum, l) => sum + roundMoney(l.unitPrice * l.quantity), 0),
  );
  const tax = roundMoney(subtotal * taxRate);
  const serviceCharge = roundMoney(subtotal * serviceChargeRate);
  return {
    subtotal,
    tax,
    serviceCharge,
    total: roundMoney(subtotal + tax + serviceCharge),
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}

/** The shape staff_place_order() reads from p_lines. */
export function toOrderLines(lines: readonly TicketLine[]) {
  return lines.map((l) => ({
    menu_item_id: l.dishId,
    quantity: l.quantity,
    modifier_option_ids: l.optionIds,
    notes: l.notes || null,
  }));
}
