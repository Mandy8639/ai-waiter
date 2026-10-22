import { describe, expect, it } from "vitest";
import {
  addLine,
  buildPosMenu,
  groupProblem,
  makeLine,
  needsChoices,
  searchPosMenu,
  setLineNotes,
  setQuantity,
  ticketTotals,
  toggleOption,
  toOrderLines,
  type PosDish,
  type PosGroup,
} from "@/lib/pos/pos-core";

const size: PosGroup = {
  id: "g-size",
  name: "Size",
  required: true,
  min: 0,
  max: 1,
  options: [
    { id: "o-small", name: "Small", price: 0, available: true },
    { id: "o-large", name: "Large", price: 2.5, available: true },
  ],
};

const extras: PosGroup = {
  id: "g-extras",
  name: "Extras",
  required: false,
  min: 0,
  max: 2,
  options: [
    { id: "o-cheese", name: "Cheese", price: 1, available: true },
    { id: "o-egg", name: "Egg", price: 1.25, available: true },
    { id: "o-bacon", name: "Bacon", price: 2, available: true },
  ],
};

const dosa: PosDish = {
  id: "d-dosa",
  name: "Masala Dosa",
  price: 10,
  available: true,
  groups: [size, extras],
};

const chai: PosDish = {
  id: "d-chai",
  name: "Chai",
  price: 3,
  available: true,
  groups: [],
};

describe("buildPosMenu", () => {
  it("orders categories, dishes, groups and options, and drops empty categories", () => {
    const menu = buildPosMenu({
      categories: [
        { id: "c-drinks", name: "Drinks", display_order: 2, onNow: true },
        { id: "c-mains", name: "Mains", display_order: 1, onNow: false },
        { id: "c-empty", name: "Empty", display_order: 3, onNow: true },
      ],
      dishes: [
        {
          id: "d2",
          name: "Lassi",
          category_id: "c-drinks",
          price: 4,
          is_available: true,
          display_order: 2,
        },
        {
          id: "d1",
          name: "Chai",
          category_id: "c-drinks",
          price: 3,
          is_available: false,
          display_order: 1,
        },
        {
          id: "d3",
          name: "Dosa",
          category_id: "c-mains",
          price: 10,
          is_available: true,
          display_order: 0,
        },
      ],
      groups: [
        {
          id: "g1",
          menu_item_id: "d3",
          name: "Size",
          is_required: true,
          min_selections: 0,
          max_selections: 1,
          display_order: 0,
        },
      ],
      options: [
        {
          id: "o2",
          modifier_id: "g1",
          name: "Large",
          price_adjustment: 2.5,
          is_available: true,
          display_order: 2,
        },
        {
          id: "o1",
          modifier_id: "g1",
          name: "Small",
          price_adjustment: 0,
          is_available: true,
          display_order: 1,
        },
      ],
    });

    expect(menu.map((c) => c.name)).toEqual(["Mains", "Drinks"]);
    expect(menu[0].onNow).toBe(false);
    expect(menu[1].dishes.map((d) => [d.name, d.available])).toEqual([
      ["Chai", false],
      ["Lassi", true],
    ]);
    expect(menu[0].dishes[0].groups[0].options.map((o) => o.name)).toEqual([
      "Small",
      "Large",
    ]);
  });
});

describe("searchPosMenu", () => {
  it("finds dishes by name across categories", () => {
    const menu = [
      { id: "a", name: "A", onNow: true, dishes: [dosa] },
      { id: "b", name: "B", onNow: true, dishes: [chai] },
    ];
    expect(searchPosMenu(menu, "  CHA ").map((d) => d.id)).toEqual(["d-chai"]);
    expect(searchPosMenu(menu, "")).toEqual([]);
  });
});

describe("add-on choices", () => {
  it("needs a choice in a required group", () => {
    expect(groupProblem(size, [])).toBe("Choose a Size");
    expect(groupProblem(size, ["o-large"])).toBeNull();
    expect(groupProblem(extras, [])).toBeNull();
  });

  it("swaps in a pick-one group and caps a pick-several group", () => {
    expect(toggleOption(size, ["o-small"], "o-large")).toEqual(["o-large"]);
    expect(toggleOption(size, ["o-large"], "o-large")).toEqual([]);

    let picked = toggleOption(extras, [], "o-cheese");
    picked = toggleOption(extras, picked, "o-egg");
    expect(toggleOption(extras, picked, "o-bacon")).toEqual([
      "o-cheese",
      "o-egg",
    ]);
  });

  it("keeps other groups' choices when swapping", () => {
    expect(toggleOption(size, ["o-cheese", "o-small"], "o-large")).toEqual([
      "o-cheese",
      "o-large",
    ]);
  });

  it("only asks when a dish has add-ons", () => {
    expect(needsChoices(dosa)).toBe(true);
    expect(needsChoices(chai)).toBe(false);
  });
});

describe("the ticket", () => {
  it("prices a line with its options", () => {
    const line = makeLine(dosa, ["o-large", "o-cheese"], " no onions ");
    expect(line.unitPrice).toBe(13.5);
    expect(line.optionNames).toEqual(["Large", "Cheese"]);
    expect(line.notes).toBe("no onions");
  });

  it("merges identical lines and keeps different ones apart", () => {
    let lines = addLine([], makeLine(chai, []));
    lines = addLine(lines, makeLine(chai, []));
    lines = addLine(lines, makeLine(chai, [], "extra hot"));
    expect(lines.map((l) => [l.notes, l.quantity])).toEqual([
      ["", 2],
      ["extra hot", 1],
    ]);
  });

  it("treats the same options in any order as the same line", () => {
    const a = makeLine(dosa, ["o-large", "o-cheese"]);
    const b = makeLine(dosa, ["o-cheese", "o-large"]);
    expect(a.key).toBe(b.key);
  });

  it("removes a line at zero and caps at 99", () => {
    const lines = addLine([], makeLine(chai, []));
    expect(setQuantity(lines, lines[0].key, 0)).toEqual([]);
    expect(setQuantity(lines, lines[0].key, 150)[0].quantity).toBe(99);
  });

  it("totals like the database: lines to the cent, tax on the subtotal", () => {
    const lines = [
      makeLine(dosa, ["o-large"], "", 3),
      makeLine(chai, [], "", 1),
    ];
    expect(ticketTotals(lines, 0.0875, 0)).toEqual({
      subtotal: 40.5,
      tax: 3.54,
      serviceCharge: 0,
      total: 44.04,
      itemCount: 4,
    });
  });

  it("sends what staff_place_order() reads", () => {
    expect(toOrderLines([makeLine(dosa, ["o-small"], "", 2)])).toEqual([
      {
        menu_item_id: "d-dosa",
        quantity: 2,
        modifier_option_ids: ["o-small"],
        notes: null,
      },
    ]);
  });

  it("edits a line's note in place, merging into a matching line", () => {
    let lines = addLine([], makeLine(chai, []));
    lines = addLine(lines, makeLine(dosa, ["o-small"]));
    const edited = setLineNotes(lines, lines[0].key, " extra hot ");
    expect(edited.map((l) => [l.name, l.notes])).toEqual([
      ["Chai", "extra hot"],
      ["Masala Dosa", ""],
    ]);

    const both = addLine(edited, makeLine(chai, []));
    const merged = setLineNotes(both, both[2].key, "extra hot");
    expect(merged.map((l) => [l.name, l.notes, l.quantity])).toEqual([
      ["Chai", "extra hot", 2],
      ["Masala Dosa", "", 1],
    ]);
  });
});
