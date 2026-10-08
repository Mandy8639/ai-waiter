import { describe, expect, it } from "vitest";
import { validateAndPriceSelection } from "@/lib/cart/validate-core";

/**
 * Function-level tests for validateAndPriceSelection — the one place
 * price and availability get decided for both the AI tool
 * (src/lib/ai/tools/cart.ts) and the ordinary customer-facing "Add to
 * cart" form (src/lib/cart/actions.ts), which both call this same
 * function. Existing coverage before this file was either pure Zod-shape
 * checks (tests/unit/*-schema.test.ts) or raw-SQL/RLS constraint tests
 * (tests/integration/db/), neither of which exercised this function's
 * own decision logic (unknown/cross-tenant IDs, availability, dedup,
 * required-group enforcement) at all.
 *
 * A small, purpose-built fake Supabase client — not a general mock
 * library — implementing only the exact chain shape validate.ts uses
 * (.from().select().eq()...eq().maybeSingle() and
 * .from().select().eq()/.in()), backed by plain in-memory table arrays.
 */

interface FakeTables {
  menu_items?: Record<string, unknown>[];
  categories?: Record<string, unknown>[];
  menu_item_modifiers?: Record<string, unknown>[];
  modifier_options?: Record<string, unknown>[];
}

function fakeSupabase(tables: FakeTables, options: { onNow?: boolean } = {}) {
  return {
    // Phase L: category_on_now() — on unless a test says otherwise.
    async rpc(fn: string) {
      if (fn === "category_on_now") {
        return { data: options.onNow ?? true, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
    from(table: keyof FakeTables) {
      let rows = (tables[table] ?? []) as Record<string, unknown>[];
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((r) => r[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          rows = rows.filter((r) => values.includes(r[column]));
          return builder;
        },
        async maybeSingle() {
          return { data: rows[0] ?? null, error: null };
        },
        then(
          onFulfilled: (result: {
            data: Record<string, unknown>[];
            error: null;
          }) => unknown,
        ) {
          return Promise.resolve(onFulfilled({ data: rows, error: null }));
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const RESTAURANT_A = "restaurant-a";
const RESTAURANT_B = "restaurant-b";
const ITEM_ID = "item-1";
const CATEGORY_ID = "cat-1";
const GROUP_ID = "group-1";
const MEDIUM_OPTION = "opt-medium";
const HOT_OPTION = "opt-hot";
const UNAVAILABLE_OPTION = "opt-unavailable";
const OTHER_ITEM_OPTION = "opt-other-item";

function baseTables(overrides: Partial<FakeTables> = {}): FakeTables {
  return {
    menu_items: [
      {
        id: ITEM_ID,
        price: 9.5,
        is_available: true,
        category_id: CATEGORY_ID,
        restaurant_id: RESTAURANT_A,
      },
    ],
    categories: [{ id: CATEGORY_ID, is_active: true }],
    menu_item_modifiers: [
      {
        id: GROUP_ID,
        name: "Spice level",
        is_required: true,
        min_selections: 1,
        max_selections: 1,
        menu_item_id: ITEM_ID,
      },
    ],
    modifier_options: [
      {
        id: MEDIUM_OPTION,
        modifier_id: GROUP_ID,
        name: "Medium",
        price_adjustment: 0,
        is_available: true,
      },
      {
        id: HOT_OPTION,
        modifier_id: GROUP_ID,
        name: "Hot",
        price_adjustment: 1.5,
        is_available: true,
      },
      {
        id: UNAVAILABLE_OPTION,
        modifier_id: GROUP_ID,
        name: "Extra Hot",
        price_adjustment: 2,
        is_available: false,
      },
      // Belongs to a DIFFERENT item's modifier group entirely — proves an
      // option id from elsewhere is rejected, not silently accepted.
      {
        id: OTHER_ITEM_OPTION,
        modifier_id: "group-other-item",
        name: "Large",
        price_adjustment: 3,
        is_available: true,
      },
    ],
    ...overrides,
  };
}

describe("validateAndPriceSelection", () => {
  it("refuses a dish whose menu isn't on right now (phase L)", async () => {
    const supabase = fakeSupabase(baseTables(), { onNow: false });
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      [MEDIUM_OPTION],
    );
    expect(result).toEqual({
      ok: false,
      error: "This dish isn't being served right now.",
    });
  });

  it("succeeds for a valid item and a valid required-modifier selection, pricing from DB values only", async () => {
    const supabase = fakeSupabase(baseTables());
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      [MEDIUM_OPTION],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.priced.unitPrice).toBe(9.5);
      expect(result.priced.modifiersPrice).toBe(0);
      expect(result.priced.selectedOptions).toEqual([
        {
          id: MEDIUM_OPTION,
          modifierId: GROUP_ID,
          name: "Medium",
          priceAdjustment: 0,
        },
      ]);
    }
  });

  it("rejects a nonexistent menuItemId", async () => {
    const supabase = fakeSupabase(baseTables());
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      "does-not-exist",
      [MEDIUM_OPTION],
    );
    expect(result).toEqual({
      ok: false,
      error: "This item is no longer on the menu.",
    });
  });

  it("rejects a menuItemId that belongs to a different restaurant (cross-tenant)", async () => {
    const supabase = fakeSupabase(baseTables());
    // The item genuinely exists — just not for this restaurant. The query
    // filters by id AND restaurant_id together, so this must come back
    // identically to "nonexistent," never leaking that the item exists
    // for someone else.
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_B,
      ITEM_ID,
      [MEDIUM_OPTION],
    );
    expect(result).toEqual({
      ok: false,
      error: "This item is no longer on the menu.",
    });
  });

  it("rejects an unavailable menu item", async () => {
    const supabase = fakeSupabase(
      baseTables({
        menu_items: [
          {
            id: ITEM_ID,
            price: 9.5,
            is_available: false,
            category_id: CATEGORY_ID,
            restaurant_id: RESTAURANT_A,
          },
        ],
      }),
    );
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      [MEDIUM_OPTION],
    );
    expect(result).toEqual({
      ok: false,
      error: "This item is currently unavailable.",
    });
  });

  it("rejects an item whose category is inactive", async () => {
    const supabase = fakeSupabase(
      baseTables({ categories: [{ id: CATEGORY_ID, is_active: false }] }),
    );
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      [MEDIUM_OPTION],
    );
    expect(result).toEqual({
      ok: false,
      error: "This item is currently unavailable.",
    });
  });

  it("rejects an unknown/invalid modifier option id", async () => {
    const supabase = fakeSupabase(baseTables());
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      ["not-a-real-option-id"],
    );
    expect(result).toEqual({
      ok: false,
      error: "One of the selected options isn't valid for this item.",
    });
  });

  it("rejects a modifier option id that belongs to a different item's modifier group", async () => {
    const supabase = fakeSupabase(baseTables());
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      [OTHER_ITEM_OPTION],
    );
    expect(result).toEqual({
      ok: false,
      error: "One of the selected options isn't valid for this item.",
    });
  });

  it("rejects a currently-unavailable modifier option", async () => {
    const supabase = fakeSupabase(baseTables());
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      [UNAVAILABLE_OPTION],
    );
    expect(result).toEqual({
      ok: false,
      error: '"Extra Hot" is no longer available.',
    });
  });

  it("rejects a missing selection for a required modifier group", async () => {
    const supabase = fakeSupabase(baseTables());
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      [],
    );
    expect(result).toEqual({
      ok: false,
      error: 'Please make a selection for "Spice level".',
    });
  });

  it("rejects more selections than the group's max_selections allows", async () => {
    const supabase = fakeSupabase(baseTables());
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      [MEDIUM_OPTION, HOT_OPTION],
    );
    expect(result).toEqual({
      ok: false,
      error: 'Choose at most 1 option(s) for "Spice level".',
    });
  });

  it("dedupes a duplicated option id — the same id sent twice counts once, not as two selections", async () => {
    const supabase = fakeSupabase(baseTables());
    const result = await validateAndPriceSelection(
      supabase,
      RESTAURANT_A,
      ITEM_ID,
      [MEDIUM_OPTION, MEDIUM_OPTION],
    );
    // Deduped to a single selection, satisfying max_selections: 1 — not
    // rejected as "too many," and the price reflects one option, not two.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.priced.selectedOptions).toHaveLength(1);
      expect(result.priced.modifiersPrice).toBe(0);
    }
  });
});
