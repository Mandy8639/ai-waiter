import { describe, expect, it } from "vitest";
import {
  OTHER_CATEGORY_ID,
  buildSoldOutMenu,
  filterSoldOutMenu,
  soldOutNow,
  type SoldOutRows,
} from "@/lib/menu/sold-out-core";
import {
  offersUndo,
  undoMessage,
  UNDO_WINDOW_MS,
} from "@/components/kitchen/undo-core";

const rows: SoldOutRows = {
  categories: [
    { id: "mains", name: "Mains", display_order: 2 },
    { id: "breads", name: "Breads", display_order: 1 },
  ],
  dishes: [
    {
      id: "curry",
      name: "Butter chicken",
      category_id: "mains",
      is_available: true,
      display_order: 1,
    },
    {
      id: "naan",
      name: "Garlic naan",
      category_id: "breads",
      is_available: false,
      display_order: 1,
    },
    {
      id: "special",
      name: "Chef's special",
      category_id: "hidden",
      is_available: true,
      display_order: 1,
    },
  ],
  groups: [
    { id: "extras", menu_item_id: "curry", name: "Extras", display_order: 1 },
  ],
  options: [
    {
      id: "rice",
      modifier_id: "extras",
      name: "Extra rice",
      is_available: true,
      display_order: 2,
    },
    {
      id: "xnaan",
      modifier_id: "extras",
      name: "Extra naan",
      is_available: false,
      display_order: 1,
    },
  ],
};

describe("buildSoldOutMenu", () => {
  it("orders categories, dishes and add-ons as the menu does", () => {
    const menu = buildSoldOutMenu(rows);
    expect(menu.map((c) => c.id)).toEqual([
      "breads",
      "mains",
      OTHER_CATEGORY_ID,
    ]);
    const curry = menu[1].dishes[0];
    expect(curry.options.map((o) => o.name)).toEqual([
      "Extra naan",
      "Extra rice",
    ]);
    expect(curry.options[0].groupName).toBe("Extras");
  });

  it("keeps a dish whose category isn't listed, under Other", () => {
    const other = buildSoldOutMenu(rows).at(-1)!;
    expect(other.name).toBe("Other");
    expect(other.dishes.map((d) => d.id)).toEqual(["special"]);
  });

  it("drops empty categories", () => {
    const menu = buildSoldOutMenu({
      ...rows,
      categories: [
        ...rows.categories,
        { id: "empty", name: "Desserts", display_order: 3 },
      ],
    });
    expect(menu.some((c) => c.id === "empty")).toBe(false);
  });
});

describe("filterSoldOutMenu", () => {
  const menu = buildSoldOutMenu(rows);

  it("finds a dish by name, and add-ons by theirs", () => {
    const found = filterSoldOutMenu(menu, "NAAN");
    const ids = found.flatMap((c) => c.dishes.map((d) => d.id));
    expect(ids).toEqual(["naan", "curry"]);
    // The curry is there only for its matching add-on.
    expect(found[1].dishes[0].options.map((o) => o.id)).toEqual(["xnaan"]);
  });

  it("keeps all of a matching dish's add-ons", () => {
    const found = filterSoldOutMenu(menu, "butter");
    expect(found[0].dishes[0].options).toHaveLength(2);
  });

  it("returns everything for a blank search", () => {
    expect(filterSoldOutMenu(menu, "  ")).toBe(menu);
  });
});

describe("soldOutNow", () => {
  it("lists what's off, naming the dish an add-on belongs to", () => {
    expect(soldOutNow(buildSoldOutMenu(rows))).toEqual([
      { kind: "dish", id: "naan", label: "Garlic naan" },
      { kind: "option", id: "xnaan", label: "Extra naan (Butter chicken)" },
    ]);
  });
});

describe("kitchen undo", () => {
  it("holds forward moves, not a cancel (which has its own confirmation)", () => {
    expect(offersUndo("confirmed")).toBe(true);
    expect(offersUndo("ready")).toBe(true);
    expect(offersUndo("cancelled")).toBe(false);
  });

  it("says which order moved where", () => {
    expect(undoMessage(12, "ready")).toBe("Order #12 → Ready");
    expect(undoMessage(undefined, "preparing")).toBe("Order → Preparing");
  });

  it("waits a few seconds, not long enough to hold up the floor", () => {
    expect(UNDO_WINDOW_MS).toBeGreaterThanOrEqual(3_000);
    expect(UNDO_WINDOW_MS).toBeLessThanOrEqual(10_000);
  });
});
