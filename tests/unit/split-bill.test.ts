import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  chosenAmount,
  progressLabel,
  remainingAmount,
  toSplitView,
  type SplitView,
} from "@/lib/payments/split";
import { minorUnitDigits } from "@/lib/payments/money";
import { parsePaymentError } from "@/lib/payments/errors";

/**
 * Phase J, the browser's side of a split bill: what a payer is shown. What
 * they are charged is the database's own sum
 * (tests/integration/db/split-bill.test.ts).
 */

const raw = {
  split_id: "s1",
  status: "open",
  mode: "equal",
  currency: "USD",
  total: "100.00",
  paid_total: "33.34",
  restaurant_name: "Nashta",
  restaurant_slug: "nashta",
  tipping_enabled: true,
  is_owner: false,
  order_numbers: [12, 14],
  units: [
    {
      id: "a",
      position: 1,
      kind: "share",
      label: "Share 1 of 3",
      amount: 33.34,
      status: "paid",
    },
    {
      id: "b",
      position: 2,
      kind: "share",
      label: "Share 2 of 3",
      amount: 33.33,
      status: "pending",
    },
    {
      id: "c",
      position: 3,
      kind: "share",
      label: "Share 3 of 3",
      amount: 33.33,
      status: "open",
    },
  ],
};

describe("reading a split", () => {
  it("types get_tab_split's JSON, keeping money as strings", () => {
    const v = toSplitView(raw)!;
    expect(v.parts.map((p) => p.amount)).toEqual(["33.34", "33.33", "33.33"]);
    expect(v.orderNumbers).toEqual([12, 14]);
    expect(v.tippingEnabled).toBe(true);
    expect(v.isOwner).toBe(false);
  });

  it("is null for an unknown link", () => {
    expect(toSplitView(null)).toBeNull();
  });
});

describe("what a payer is shown", () => {
  const v = toSplitView(raw) as SplitView;

  it("adds up the chosen free parts in cents, not floats", () => {
    const parts = v.parts.map((p) => ({ ...p, status: "open" as const }));
    // 0.1 + 0.2 style drift would show up here as 99.99999999.
    expect(chosenAmount(parts, new Set(["a", "b", "c"]), "USD")).toBe("100.00");
  });

  it("ignores a part someone else has since claimed or paid", () => {
    expect(chosenAmount(v.parts, new Set(["a", "b", "c"]), "USD")).toBe(
      "33.33",
    );
  });

  it("counts what's left, including parts that are only being paid", () => {
    expect(remainingAmount(v)).toBe("66.66");
    expect(progressLabel(v)).toBe("1 of 3 shares paid");
  });

  it("speaks in dishes for a by-dish split", () => {
    expect(progressLabel({ ...v, mode: "by_dish" })).toBe("1 of 3 dishes paid");
  });
});

describe("the database and the app agree on which currencies have no cents", () => {
  it("has the same list in money.ts and the split migration", () => {
    const sql = readFileSync(
      path.resolve("supabase/migrations/20261002090000_split_bill.sql"),
      "utf8",
    );
    const block = sql.slice(
      sql.indexOf("create function public.currency_minor_digits"),
      sql.indexOf("create function public.to_minor_units"),
    );
    const zeroDecimal = [...block.matchAll(/'([A-Z]{3})'/g)].map((m) => m[1]);
    expect(zeroDecimal.length).toBeGreaterThan(10);
    for (const code of zeroDecimal) expect(minorUnitDigits(code)).toBe(0);
    for (const code of ["USD", "EUR", "GBP", "INR", "AUD"]) {
      expect(minorUnitDigits(code)).toBe(2);
      expect(zeroDecimal).not.toContain(code);
    }
  });
});

describe("messages", () => {
  it("tells a diner, in plain words, why a split payment was refused", () => {
    expect(
      parsePaymentError(
        "SPLIT_PART_TAKEN: someone is already paying for one of those",
      ),
    ).toMatch(/Someone is already paying/);
    expect(
      parsePaymentError(
        "PAYMENT_ORDER_IN_SPLIT: this order is part of a bill being split",
      ),
    ).toMatch(/Pay your part from the split page/);
  });
});
