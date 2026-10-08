import { describe, expect, it } from "vitest";
import {
  categoriesOnNow,
  hoursLabel,
  menusForCategory,
  onNowFilter,
  rowsFromRules,
  rulesFromHours,
  servedWhen,
  toPublicMenus,
  type PublicMenu,
} from "@/lib/menus/core";

/**
 * Phase L, the parts without a database: which sections are on, hours as
 * words, and turning the owner's schedule into rows. Whether a menu is on
 * is the database's call (tests/integration/db/multiple-menus.test.ts).
 */

const weekdays = [1, 2, 3, 4, 5];

const lunch: PublicMenu = {
  id: "lunch",
  name: "Lunch",
  sort: 1,
  onNow: true,
  hours: weekdays.map((day) => ({ day, opens: "11:00", closes: "15:00" })),
  categoryIds: ["thali", "drinks"],
};
const dinner: PublicMenu = {
  id: "dinner",
  name: "Dinner",
  sort: 2,
  onNow: false,
  hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    opens: "17:00",
    closes: "22:00",
  })),
  categoryIds: ["curries", "drinks"],
};

describe("which sections are on", () => {
  it("is every section on a menu that's on now", () => {
    expect([...categoriesOnNow([lunch, dinner])].sort()).toEqual([
      "drinks",
      "thali",
    ]);
  });

  it("is nothing when no menu is on — the menu says so rather than showing everything", () => {
    const filter = onNowFilter([{ ...lunch, onNow: false }, dinner]);
    expect(filter?.size).toBe(0);
  });

  it("never empties the menu because a lookup failed", () => {
    // getPublicMenus returns null when the lookup itself fails.
    expect(onNowFilter(null)).toBeNull();
  });

  it("treats no menus with sections as nothing on, not as a failure", () => {
    expect(onNowFilter([])?.size).toBe(0);
  });

  it("leaves out menus that hold no sections, so a diner isn't told an empty menu is on", () => {
    expect(
      toPublicMenus([
        {
          public_menu_id: "empty",
          public_menu_name: "Menu",
          public_menu_on_now: true,
          public_menu_hours: [],
          public_menu_category_ids: [],
        },
      ]),
    ).toEqual([]);
  });

  it("finds the menus a section is on, for 'served at Dinner'", () => {
    expect(
      menusForCategory([lunch, dinner], "curries").map((m) => m.id),
    ).toEqual(["dinner"]);
    expect(servedWhen(menusForCategory([lunch, dinner], "curries"))).toBe(
      "Dinner (Daily 17:00–22:00)",
    );
  });

  it("reads get_public_menus rows", () => {
    expect(
      toPublicMenus([
        {
          public_menu_id: "m1",
          public_menu_name: "Menu",
          public_menu_sort: 0,
          public_menu_on_now: true,
          public_menu_hours: [],
          public_menu_category_ids: ["c1"],
        },
      ]),
    ).toEqual([
      {
        id: "m1",
        name: "Menu",
        sort: 0,
        onNow: true,
        hours: [],
        categoryIds: ["c1"],
      },
    ]);
    expect(toPublicMenus(null)).toEqual([]);
  });
});

describe("hours as words", () => {
  it("groups days that share a window", () => {
    expect(hoursLabel(lunch.hours)).toBe("Mon–Fri 11:00–15:00");
    expect(hoursLabel(dinner.hours)).toBe("Daily 17:00–22:00");
  });

  it("lists separate windows, and short runs of days by name", () => {
    expect(
      hoursLabel([
        ...weekdays.map((day) => ({ day, opens: "11:00", closes: "15:00" })),
        { day: 6, opens: "12:00", closes: "16:00" },
        { day: 0, opens: "12:00", closes: "16:00" },
      ]),
    ).toBe("Mon–Fri 11:00–15:00 · Sat, Sun 12:00–16:00");
  });

  it("says Always for a menu with no hours", () => {
    expect(hoursLabel([])).toBe("Always");
  });
});

describe("editing hours", () => {
  it("turns one rule into a row per day, and back", () => {
    const rules = [{ days: weekdays, opens: "11:00", closes: "15:00" }];
    const checked = rowsFromRules(rules);
    expect(checked.ok && checked.rows).toHaveLength(5);
    expect(rulesFromHours(lunch.hours)).toEqual(rules);
  });

  it("allows a window that runs to the end of the day", () => {
    expect(
      rowsFromRules([{ days: [5], opens: "22:00", closes: "24:00" }]).ok,
    ).toBe(true);
  });

  it("refuses overnight hours in one window, and says how to do them", () => {
    const checked = rowsFromRules([
      { days: [5], opens: "22:00", closes: "02:00" },
    ]);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error).toMatch(
      /second set starting at 00:00/,
    );
  });

  it("refuses a rule with no days, or a badly formed time", () => {
    expect(
      rowsFromRules([{ days: [], opens: "11:00", closes: "15:00" }]).ok,
    ).toBe(false);
    expect(
      rowsFromRules([{ days: [1], opens: "11", closes: "15:00" }]).ok,
    ).toBe(false);
  });

  it("accepts no rules at all, meaning always on", () => {
    expect(rowsFromRules([])).toEqual({ ok: true, rows: [] });
  });
});
