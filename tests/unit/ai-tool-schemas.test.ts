import { describe, expect, it } from "vitest";
import {
  searchMenuSchema,
  getMenuItemSchema,
  getRestaurantInfoSchema,
  getCartSchema,
  addItemToCartSchema,
  updateCartItemSchema,
  removeCartItemSchema,
  clearCartSchema,
  submitOrderSchema,
  getOrderStatusSchema,
  getCustomerOrderHistorySchema,
} from "@/lib/ai/tools/schemas";

describe("AI tool schemas — reject unknown/tenant-scoping fields (spec section 5)", () => {
  it.each([
    ["search_menu", searchMenuSchema, {}],
    ["get_menu_item", getMenuItemSchema, { menuItemId: "abc" }],
    ["get_restaurant_info", getRestaurantInfoSchema, {}],
    ["get_cart", getCartSchema, {}],
    [
      "add_item_to_cart",
      addItemToCartSchema,
      { menuItemId: "abc", quantity: 1, selectedOptionIds: [] },
    ],
    [
      "update_cart_item",
      updateCartItemSchema,
      { cartItemId: "abc", quantity: 1 },
    ],
    ["remove_cart_item", removeCartItemSchema, { cartItemId: "abc" }],
    ["clear_cart", clearCartSchema, {}],
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
    [getMenuItemSchema, { menuItemId: "abc" }],
    [getCartSchema, {}],
    [addItemToCartSchema, { menuItemId: "abc", quantity: 1 }],
    [updateCartItemSchema, { cartItemId: "abc", quantity: 1 }],
    [removeCartItemSchema, { cartItemId: "abc" }],
    [clearCartSchema, {}],
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

describe("addItemToCartSchema", () => {
  it("accepts a valid add", () => {
    expect(
      addItemToCartSchema.safeParse({
        menuItemId: "item-1",
        quantity: 2,
        selectedOptionIds: ["opt-1"],
      }).success,
    ).toBe(true);
  });

  it("defaults selectedOptionIds to an empty array", () => {
    const result = addItemToCartSchema.safeParse({
      menuItemId: "item-1",
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
