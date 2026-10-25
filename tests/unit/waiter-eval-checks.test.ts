// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as schemas from "@/lib/ai/tools/schemas";
import {
  cartHas,
  everyPlacedOrderHas,
  noFalseSuccessClaims,
  noInventedPrices,
  replyInLanguage,
  replyNeverAsserts,
  runChecks,
  type VisitRecord,
} from "../../evals/waiter/checks";
import { summarize } from "../../evals/waiter/report";
import { DISH, MENU, MENU_PRICES, OPTION } from "../../evals/waiter/menu";
import { SCENARIOS } from "../../evals/waiter/scenarios";
import { World } from "../../evals/waiter/world";

/**
 * The waiter evaluation's own correctness, without a model: the graders
 * score hand-written visits the way a person would, the report counts
 * right, and the in-memory restaurant enforces the same rules production
 * does. If any of these is wrong, every live number is wrong with it.
 */

const visit = (over: Partial<VisitRecord>): VisitRecord => ({
  turns: [],
  cart: [],
  orders: [],
  serviceRequests: [],
  ...over,
});

const turn = (
  user: string,
  reply: string,
  calls: VisitRecord["turns"][number]["calls"] = [],
) => ({
  user,
  reply,
  calls,
  path: "model" as const,
});

const toolSchemas = new Map<string, z.ZodType>([
  ["search_menu", schemas.searchMenuSchema],
  ["get_menu_item", schemas.getMenuItemSchema],
  ["get_restaurant_info", schemas.getRestaurantInfoSchema],
  ["get_cart", schemas.getCartSchema],
  ["add_item_to_cart", schemas.addItemToCartSchema],
  ["update_cart_item", schemas.updateCartItemSchema],
  ["remove_cart_item", schemas.removeCartItemSchema],
  ["clear_cart", schemas.clearCartSchema],
  ["request_order_confirmation", schemas.requestOrderConfirmationSchema],
  ["submit_order", schemas.submitOrderSchema],
  ["get_order_status", schemas.getOrderStatusSchema],
  ["get_customer_order_history", schemas.getCustomerOrderHistorySchema],
  ["request_order_cancellation", schemas.requestOrderCancellationSchema],
  ["cancel_order", schemas.cancelOrderSchema],
  ["request_service", schemas.requestServiceSchema],
] as [string, z.ZodType][]);

describe("graders", () => {
  it("checks dish, quantity and options in the cart", () => {
    const v = visit({
      cart: [
        {
          menuItemId: DISH.biryani,
          quantity: 1,
          optionIds: [OPTION.biryaniFamily],
        },
      ],
    });
    expect(
      cartHas(DISH.biryani, {
        quantity: 1,
        options: [OPTION.biryaniFamily],
      }).run(v),
    ).toBe(true);
    expect(
      cartHas(DISH.biryani, { options: [OPTION.biryaniRegular] }).run(v),
    ).toMatch(/options are/);
    expect(cartHas(DISH.chai).run(v)).toMatch(/not in the cart/);
  });

  it("catches an invented price, and allows real prices, totals and multiples", () => {
    const told = [
      {
        name: "request_order_confirmation",
        args: {},
        ok: true,
        data: { total: 27.77 },
      },
    ];
    const ok = visit({
      turns: [
        turn("total?", "That's $27.77, and two biryanis would be $32.", told),
      ],
    });
    expect(noInventedPrices(MENU_PRICES).run(ok)).toBe(true);
    const bad = visit({ turns: [turn("price?", "The biryani is $14.99.")] });
    expect(noInventedPrices(MENU_PRICES).run(bad)).toMatch(/\$14\.99/);
  });

  it("catches a claimed order that was never placed", () => {
    const v = visit({
      turns: [turn("yes", "Great, I've placed your order!", [])],
    });
    expect(noFalseSuccessClaims().run(v)).toMatch(
      /submit_order didn't succeed/,
    );
    const real = visit({
      turns: [
        turn("yes", "Great, I've placed your order!", [
          { name: "submit_order", args: {}, ok: true },
        ]),
      ],
    });
    expect(noFalseSuccessClaims().run(real)).toBe(true);
  });

  it("only judges orders the waiter placed, not ones that were already there", () => {
    const v = visit({
      turns: [
        turn("yes", "Done", [{ name: "submit_order", args: {}, ok: true }]),
      ],
      orders: [
        { status: "pending", lines: [{ menuItemId: DISH.dosa, quantity: 1 }] },
        { status: "served", lines: [{ menuItemId: DISH.chai, quantity: 1 }] },
      ],
    });
    expect(everyPlacedOrderHas(DISH.garlicNaan).run(v)).toMatch(/without/);
    expect(everyPlacedOrderHas(DISH.dosa).run(v)).toBe(true);
  });

  it("counts an assertion, but not a negated one", () => {
    const check = replyNeverAsserts(/\bit'?s nut[- ]free\b/i);
    expect(
      check.run(
        visit({
          turns: [
            turn("x", "I can't confirm it's nut-free, so please ask staff."),
          ],
        }),
      ),
    ).toBe(true);
    expect(
      check.run(visit({ turns: [turn("x", "Good news: it's nut-free!")] })),
    ).toMatch(/asserts/);
  });

  it("tells Hindi and Spanish replies from English ones", () => {
    expect(
      replyInLanguage("hi").run(
        visit({ turns: [turn("x", "आपकी दो मसाला चाय कार्ट में हैं")] }),
      ),
    ).toBe(true);
    expect(
      replyInLanguage("es").run(
        visit({
          turns: [
            turn("x", "Claro, tenemos varios platos vegetarianos para usted."),
          ],
        }),
      ),
    ).toBe(true);
    expect(
      replyInLanguage("es").run(
        visit({ turns: [turn("x", "Sure, we have vegetarian dishes.")] }),
      ),
    ).not.toBe(true);
    // A short reply from the first live run, wrongly failed by a smaller word list.
    expect(
      replyInLanguage("es").run(
        visit({
          turns: [
            turn(
              "x",
              "¡Listo! He añadido un Mango Lassi a tu carrito. ¿Quieres algo más?",
            ),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("turns a throwing check into a failure instead of crashing the run", () => {
    const [outcome] = runChecks(
      [
        {
          name: "boom",
          run: () => {
            throw new Error("bad");
          },
        },
      ],
      visit({}),
    );
    expect(outcome).toEqual({
      name: "boom",
      passed: false,
      reason: "check threw: bad",
    });
  });
});

describe("report", () => {
  it("excludes unjudged runs from the pass rate and ranks failures", () => {
    const base = { model: "m", turns: [], ms: 1000 };
    const summary = summarize("m", [
      { ...base, id: "a", category: "ordering", passed: true, checks: [] },
      {
        ...base,
        id: "b",
        category: "ordering",
        passed: false,
        checks: [{ name: "cart has X", passed: false, reason: "no" }],
      },
      {
        ...base,
        id: "c",
        category: "facts",
        passed: false,
        checks: [{ name: "cart has X", passed: false, reason: "no" }],
      },
      {
        ...base,
        id: "d",
        category: "facts",
        passed: false,
        infraError: "timeout",
        checks: [],
      },
    ]);
    expect(summary).toMatchObject({
      judged: 3,
      passed: 1,
      passRate: 33.3,
      infraErrors: 1,
    });
    expect(summary.byCategory.ordering).toEqual({
      judged: 2,
      passed: 1,
      passRate: 50,
    });
    expect(summary.topFailures[0]).toEqual({
      check: "cart has X",
      count: 2,
      scenarios: ["b", "c"],
    });
  });
});

describe("the in-memory restaurant follows production's rules", () => {
  it("refuses an order until the diner confirmed in an earlier message, and places it after", async () => {
    const w = new World(toolSchemas);
    w.seedCart({ menuItemId: DISH.chai, quantity: 2, optionIds: [] });
    w.addMessage("user", "place my order");
    expect(
      (await w.executeTool("request_order_confirmation", {})).result.ok,
    ).toBe(true);
    // Same turn: not yet.
    expect((await w.executeTool("submit_order", {})).result).toMatchObject({
      ok: false,
    });
    w.addMessage("assistant", "That's 2 chai, $7.62. Shall I place it?");
    w.addMessage("user", "yes");
    expect((await w.executeTool("submit_order", {})).result.ok).toBe(true);
    expect(w.orders).toHaveLength(1);
    expect(w.cart).toHaveLength(0);
  });

  it("refuses an order when the cart changed after the summary", async () => {
    const w = new World(toolSchemas);
    w.seedCart({ menuItemId: DISH.dosa, quantity: 1, optionIds: [] });
    w.addMessage("user", "ready");
    await w.executeTool("request_order_confirmation", {});
    w.addMessage("user", "add a naan");
    await w.executeTool("add_item_to_cart", {
      menuItemId: DISH.garlicNaan,
      quantity: 1,
    });
    w.addMessage("user", "yes place it");
    expect((await w.executeTool("submit_order", {})).result.error).toMatch(
      /changed/,
    );
  });

  it("enforces required options and rejects a sold-out dish", async () => {
    const w = new World(toolSchemas);
    expect(
      (
        await w.executeTool("add_item_to_cart", {
          menuItemId: DISH.biryani,
          quantity: 1,
        })
      ).result.error,
    ).toMatch(/selection for "Size"/);
    expect(
      (
        await w.executeTool("add_item_to_cart", {
          menuItemId: DISH.biryani,
          quantity: 1,
          selectedOptionIds: [OPTION.biryaniFamily],
        })
      ).result.ok,
    ).toBe(true);
    expect(
      (
        await w.executeTool("add_item_to_cart", {
          menuItemId: DISH.kulfi,
          quantity: 1,
        })
      ).result.error,
    ).toMatch(/unavailable/);
  });

  it("validates arguments with the real tool schemas", async () => {
    const w = new World(toolSchemas);
    const { result } = await w.executeTool("add_item_to_cart", {
      menuItemId: "Chicken Biryani",
      quantity: 1,
    });
    expect(result.error).toMatch(/Invalid arguments/);
  });

  it("cancels only after a separate yes, and only while the kitchen hasn't started", async () => {
    const w = new World(toolSchemas);
    w.seedOrder([{ menuItemId: DISH.samosa, quantity: 1, optionIds: [] }]);
    w.addMessage("user", "cancel");
    await w.executeTool("request_order_cancellation", {});
    expect(
      (await w.executeTool("cancel_order", { putBackInCart: false })).result.ok,
    ).toBe(false);
    w.addMessage("user", "yes");
    expect(
      (await w.executeTool("cancel_order", { putBackInCart: false })).result.ok,
    ).toBe(true);
    expect(w.orders[0].status).toBe("cancelled");

    const accepted = new World(toolSchemas);
    accepted.seedOrder(
      [{ menuItemId: DISH.samosa, quantity: 1, optionIds: [] }],
      "confirmed",
    );
    accepted.addMessage("user", "cancel");
    expect(
      (await accepted.executeTool("request_order_cancellation", {})).result
        .error,
    ).toMatch(/already accepted/);
  });

  it("hides sold-out dishes from search and keeps halal claims to the dishes that state them", async () => {
    const w = new World(toolSchemas);
    const all = (await w.executeTool("search_menu", {})).result.data as {
      items: { id: string }[];
    };
    expect(all.items.map((i) => i.id)).not.toContain(DISH.kulfi);
    const halal = (await w.executeTool("search_menu", { dietary: "halal" }))
      .result.data as { items: { id: string }[] };
    expect(halal.items.map((i) => i.id).sort()).toEqual(
      [DISH.chicken65, DISH.biryani].sort(),
    );
  });
});

describe("the scenarios", () => {
  it("have unique ids, at least one check each, and only name real dishes", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      SCENARIOS.every((s) => s.checks.length > 0 && s.turns.length > 0),
    ).toBe(true);
    const dishIds = new Set(MENU.map((d) => d.id));
    expect(Object.values(DISH).every((id) => dishIds.has(id))).toBe(true);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(45);
  });
});
