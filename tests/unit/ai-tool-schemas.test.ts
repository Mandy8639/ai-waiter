import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  searchMenuSchema,
  getMenuItemSchema,
  getRestaurantInfoSchema,
  getCartSchema,
  addItemToCartSchema,
  updateCartItemSchema,
  removeCartItemSchema,
  clearCartSchema,
  requestOrderConfirmationSchema,
  submitOrderSchema,
  getOrderStatusSchema,
  getCustomerOrderHistorySchema,
} from "@/lib/ai/tools/schemas";

describe("AI tool schemas — reject unknown/tenant-scoping fields (spec section 5)", () => {
  it.each([
    ["search_menu", searchMenuSchema, {}],
    [
      "get_menu_item",
      getMenuItemSchema,
      { menuItemId: "11111111-1111-4111-8111-111111111111" },
    ],
    ["get_restaurant_info", getRestaurantInfoSchema, {}],
    ["get_cart", getCartSchema, {}],
    [
      "add_item_to_cart",
      addItemToCartSchema,
      {
        menuItemId: "11111111-1111-4111-8111-111111111111",
        quantity: 1,
        selectedOptionIds: [],
      },
    ],
    [
      "update_cart_item",
      updateCartItemSchema,
      { cartItemId: "abc", quantity: 1 },
    ],
    ["remove_cart_item", removeCartItemSchema, { cartItemId: "abc" }],
    ["clear_cart", clearCartSchema, {}],
    ["request_order_confirmation", requestOrderConfirmationSchema, {}],
    ["submit_order", submitOrderSchema, {}],
    ["get_order_status", getOrderStatusSchema, {}],
    ["get_customer_order_history", getCustomerOrderHistorySchema, {}],
  ])(
    "%s: no tool schema accepts restaurant_id/table_id/customer_session_id from the model",
    (_name, schema, validBase) => {
      for (const smuggledField of [
        "restaurant_id",
        "restaurantId",
        "table_id",
        "customer_session_id",
        "customerSessionId",
      ]) {
        const result = schema.safeParse({
          ...validBase,
          [smuggledField]: "00000000-0000-0000-0000-000000000000",
        });
        expect(result.success, `${smuggledField} should be rejected`).toBe(
          false,
        );
      }
    },
  );

  it.each([
    [searchMenuSchema, {}],
    [getMenuItemSchema, { menuItemId: "11111111-1111-4111-8111-111111111111" }],
    [getCartSchema, {}],
    [
      addItemToCartSchema,
      { menuItemId: "11111111-1111-4111-8111-111111111111", quantity: 1 },
    ],
    [updateCartItemSchema, { cartItemId: "abc", quantity: 1 }],
    [removeCartItemSchema, { cartItemId: "abc" }],
    [clearCartSchema, {}],
    [requestOrderConfirmationSchema, {}],
    [submitOrderSchema, {}],
  ])("rejects a smuggled price/total field", (schema, validBase) => {
    for (const priceField of [
      "price",
      "unitPrice",
      "unit_price",
      "total",
      "subtotal",
    ]) {
      const result = schema.safeParse({ ...validBase, [priceField]: 0.01 });
      expect(result.success, `${priceField} should be rejected`).toBe(false);
    }
  });
});

describe("getMenuItemSchema — menuItemId must be a real UUID (Phase 2A identifier-contract hardening)", () => {
  it("accepts a valid UUID", () => {
    expect(
      getMenuItemSchema.safeParse({
        menuItemId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["the item's name instead of its id", "Paneer Dosa"],
    ["a non-UUID slug", "paneer-dosa"],
    ["an empty string", ""],
    ["a truncated/malformed id", "11111111-1111-1111-1111"],
  ])("rejects %s", (_label, menuItemId) => {
    expect(getMenuItemSchema.safeParse({ menuItemId }).success).toBe(false);
  });
});

describe("addItemToCartSchema", () => {
  it("accepts a valid UUID menuItemId", () => {
    expect(
      addItemToCartSchema.safeParse({
        menuItemId: "11111111-1111-4111-8111-111111111111",
        quantity: 1,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["the item's name instead of its id", "Paneer Dosa"],
    ["a non-UUID slug", "paneer-dosa"],
    ["an empty string", ""],
  ])("rejects %s as menuItemId", (_label, menuItemId) => {
    expect(
      addItemToCartSchema.safeParse({ menuItemId, quantity: 1 }).success,
    ).toBe(false);
  });

  it("accepts a valid add", () => {
    expect(
      addItemToCartSchema.safeParse({
        menuItemId: "11111111-1111-4111-8111-111111111111",
        quantity: 2,
        selectedOptionIds: ["opt-1"],
      }).success,
    ).toBe(true);
  });

  it("defaults selectedOptionIds to an empty array", () => {
    const result = addItemToCartSchema.safeParse({
      menuItemId: "11111111-1111-4111-8111-111111111111",
      quantity: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.selectedOptionIds).toEqual([]);
  });

  it("rejects a negative quantity", () => {
    expect(
      addItemToCartSchema.safeParse({ menuItemId: "item-1", quantity: -1 })
        .success,
    ).toBe(false);
  });

  it("rejects a zero quantity", () => {
    expect(
      addItemToCartSchema.safeParse({ menuItemId: "item-1", quantity: 0 })
        .success,
    ).toBe(false);
  });

  it("rejects a non-integer quantity", () => {
    expect(
      addItemToCartSchema.safeParse({ menuItemId: "item-1", quantity: 1.5 })
        .success,
    ).toBe(false);
  });

  it("rejects a quantity above 99", () => {
    expect(
      addItemToCartSchema.safeParse({ menuItemId: "item-1", quantity: 100 })
        .success,
    ).toBe(false);
  });

  it("rejects a missing menuItemId", () => {
    expect(addItemToCartSchema.safeParse({ quantity: 1 }).success).toBe(false);
  });

  it("rejects an oversized menuItemId (malformed/attack-sized input)", () => {
    expect(
      addItemToCartSchema.safeParse({
        menuItemId: "x".repeat(500),
        quantity: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects too many selected options (oversized array)", () => {
    expect(
      addItemToCartSchema.safeParse({
        menuItemId: "item-1",
        quantity: 1,
        selectedOptionIds: Array.from({ length: 50 }, (_, i) => `opt-${i}`),
      }).success,
    ).toBe(false);
  });

  it("rejects a non-array selectedOptionIds (malformed model output)", () => {
    expect(
      addItemToCartSchema.safeParse({
        menuItemId: "item-1",
        quantity: 1,
        selectedOptionIds: "opt-1",
      }).success,
    ).toBe(false);
  });
});

describe("updateCartItemSchema / removeCartItemSchema", () => {
  it("rejects a negative quantity", () => {
    expect(
      updateCartItemSchema.safeParse({ cartItemId: "c-1", quantity: -5 })
        .success,
    ).toBe(false);
  });

  it("rejects a missing cartItemId", () => {
    expect(removeCartItemSchema.safeParse({}).success).toBe(false);
  });
});

describe("searchMenuSchema", () => {
  it("accepts an empty search (browse-all)", () => {
    expect(searchMenuSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an invalid dietary enum value (malformed model output)", () => {
    expect(searchMenuSchema.safeParse({ dietary: "keto" }).success).toBe(false);
  });

  it("rejects an oversized query string", () => {
    expect(
      searchMenuSchema.safeParse({ query: "x".repeat(1000) }).success,
    ).toBe(false);
  });
});

describe("submitOrderSchema", () => {
  it("accepts no note", () => {
    expect(submitOrderSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an oversized note", () => {
    expect(
      submitOrderSchema.safeParse({ customerNote: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("never accepts an idempotencyKey field from the model (spec section 14)", () => {
    expect(
      submitOrderSchema.safeParse({ idempotencyKey: "attacker-chosen-key" })
        .success,
    ).toBe(false);
  });

  it("never accepts an orderId field (submit_order creates, it does not target an existing order)", () => {
    expect(submitOrderSchema.safeParse({ orderId: "some-id" }).success).toBe(
      false,
    );
  });

  it("never accepts a confirmation id/token/hash/flag from the model — the confirmation gate is server-derived, never a tool argument (see order-confirmation.ts)", () => {
    for (const smuggledField of [
      "confirmed",
      "confirmationId",
      "confirmationToken",
      "cartFingerprint",
      "isConfirmed",
    ]) {
      const result = submitOrderSchema.safeParse({
        [smuggledField]:
          smuggledField === "confirmed" ? true : "attacker-value",
      });
      expect(result.success, `${smuggledField} should be rejected`).toBe(false);
    }
  });
});

describe("get_order_status / get_customer_order_history never accept an order id (spec section 15)", () => {
  it("rejects an orderId argument", () => {
    expect(getOrderStatusSchema.safeParse({ orderId: "some-id" }).success).toBe(
      false,
    );
    expect(
      getCustomerOrderHistorySchema.safeParse({ orderId: "some-id" }).success,
    ).toBe(false);
  });
});

describe("model-facing JSON schema carries the menuItemId identifier-provenance guidance (Phase 2A)", () => {
  // Mirrors exactly how src/lib/ai/tools/index.ts#getToolDefinitions()
  // exposes each tool's schema to the model — z.toJSONSchema(schema,
  // { target: "draft-7" }) — so this confirms the description the model
  // actually sees, not just that .describe() was called somewhere.
  it("get_menu_item's generated schema describes menuItemId's provenance", () => {
    const jsonSchema = z.toJSONSchema(getMenuItemSchema, {
      target: "draft-7",
    }) as { properties?: { menuItemId?: { description?: string } } };
    const description = jsonSchema.properties?.menuItemId?.description ?? "";
    expect(description).toContain("search_menu");
    expect(description).toContain("guessed");
  });

  it("add_item_to_cart's generated schema describes menuItemId's provenance", () => {
    const jsonSchema = z.toJSONSchema(addItemToCartSchema, {
      target: "draft-7",
    }) as { properties?: { menuItemId?: { description?: string } } };
    const description = jsonSchema.properties?.menuItemId?.description ?? "";
    expect(description).toContain("search_menu");
    expect(description).toContain("guessed");
  });
});
