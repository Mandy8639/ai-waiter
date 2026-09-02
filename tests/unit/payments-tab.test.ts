import { describe, expect, it } from "vitest";
import {
  deriveTab,
  type TabCoverageInput,
  type TabOrderInput,
} from "@/lib/payments/tab";

/**
 * These mirror tests/integration/db/payments-tab.test.ts case for case,
 * on purpose. deriveTab() restates start_tab_payment()'s rule for what a
 * tab covers, and the only defence against the two drifting apart is
 * asserting the same things about both.
 */

const order = (
  id: string,
  overrides: Partial<TabOrderInput> = {},
): TabOrderInput => ({
  id,
  orderNumber: Number(id.replace(/\D/g, "")) || 1,
  status: "served",
  total: 10,
  currency: "USD",
  ...overrides,
});

const covers = (
  orderId: string,
  status: string,
  tipAmount = 0,
): TabCoverageInput => ({ orderId, status, tipAmount });

describe("deriveTab", () => {
  it("owes every order when nothing has been paid", () => {
    const tab = deriveTab([order("1"), order("2")], []);
    expect(tab.unpaidCount).toBe(2);
    expect(tab.unpaidTotal).toBe(20);
  });

  it("excludes cancelled orders from the tab entirely", () => {
    // Not merely "unpaid": listing them would inflate the total the diner
    // is asked to approve.
    const tab = deriveTab(
      [order("1"), order("2", { status: "cancelled" })],
      [],
    );
    expect(tab.unpaidCount).toBe(1);
    expect(tab.unpaidTotal).toBe(10);
    expect(tab.orders).toHaveLength(1);
  });

  it("excludes orders already paid for individually", () => {
    const tab = deriveTab([order("1"), order("2")], [covers("1", "succeeded")]);
    expect(tab.unpaidCount).toBe(1);
    expect(tab.unpaidTotal).toBe(10);
    expect(tab.orders.find((o) => o.id === "1")?.paid).toBe(true);
  });

  it("owes nothing once every order is settled", () => {
    const tab = deriveTab(
      [order("1"), order("2")],
      [covers("1", "succeeded"), covers("2", "succeeded")],
    );
    expect(tab.unpaidCount).toBe(0);
    expect(tab.unpaidTotal).toBe(0);
  });

  it("still owes for an abandoned checkout", () => {
    // A pending payment is a Checkout nobody completed. Treating it as
    // paid would let a table leave without ever being charged.
    const tab = deriveTab([order("1")], [covers("1", "pending", 3)]);
    expect(tab.unpaidCount).toBe(1);
    expect(tab.orders[0].paid).toBe(false);
  });

  it("still owes after a failed or cancelled attempt", () => {
    const tab = deriveTab(
      [order("1"), order("2")],
      [covers("1", "failed"), covers("2", "cancelled")],
    );
    expect(tab.unpaidCount).toBe(2);
  });

  it("surfaces the in-flight tip so a reused payment is not refused", () => {
    // start_tab_payment() reuses an open payment only when the tip
    // matches, so the panel needs to know what it was.
    const tab = deriveTab([order("1")], [covers("1", "pending", 4.5)]);
    expect(tab.pendingTip).toBe(4.5);
  });

  it("reports no in-flight tip when nothing is open", () => {
    expect(deriveTab([order("1")], []).pendingTip).toBeNull();
    expect(
      deriveTab([order("1")], [covers("1", "succeeded", 2)]).pendingTip,
    ).toBeNull();
  });

  it("flags a tab that mixes currencies", () => {
    const tab = deriveTab([order("1"), order("2", { currency: "EUR" })], []);
    expect(tab.mixedCurrency).toBe(true);
  });

  it("does not flag a mix that is already paid off", () => {
    // Only what is still owed has to go through one charge.
    const tab = deriveTab(
      [order("1"), order("2", { currency: "EUR" })],
      [covers("2", "succeeded")],
    );
    expect(tab.mixedCurrency).toBe(false);
    expect(tab.currency).toBe("USD");
  });

  it("ignores coverage naming an order outside this session", () => {
    // The rows come from a query scoped to this session's orders, but a
    // stray id must not mark anything paid or count toward the total.
    const tab = deriveTab([order("1")], [covers("999", "succeeded")]);
    expect(tab.unpaidCount).toBe(1);
    expect(tab.orders[0].paid).toBe(false);
  });

  it("returns an empty tab when every order was cancelled", () => {
    const tab = deriveTab([order("1", { status: "cancelled" })], []);
    expect(tab.unpaidCount).toBe(0);
    expect(tab.orders).toHaveLength(0);
    expect(tab.mixedCurrency).toBe(false);
  });

  it("sums money without drifting on the usual awkward figures", () => {
    const tab = deriveTab(
      [order("1", { total: 19.99 }), order("2", { total: 0.1 })],
      [],
    );
    expect(tab.unpaidTotal).toBeCloseTo(20.09, 2);
  });
});
