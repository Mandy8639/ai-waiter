import { describe, expect, it } from "vitest";
import { parseOrderIds, parseReversalReason } from "@/lib/payments/cash";

/**
 * The form-facing half of cash recording. The database half is covered by
 * tests/integration/db/payments-cash.test.ts — these are the checks that
 * run before anything reaches it.
 */

describe("parseOrderIds", () => {
  it("accepts the ticked boxes", () => {
    const result = parseOrderIds(["a", "b"]);
    expect(result).toEqual({ ok: true, value: ["a", "b"] });
  });

  it("refuses an empty selection rather than sending nothing", () => {
    // record_cash_payment() raises PAYMENT_NO_ORDERS for this; failing
    // here gives the reader a sentence instead of a round trip.
    const result = parseOrderIds([]);
    expect(result.ok).toBe(false);
  });

  it("treats blank and whitespace-only entries as no selection", () => {
    expect(parseOrderIds(["", "   "]).ok).toBe(false);
  });

  it("collapses duplicates instead of settling an order twice", () => {
    const result = parseOrderIds(["a", "a", "b"]);
    expect(result).toEqual({ ok: true, value: ["a", "b"] });
  });

  it("ignores non-string entries a hand-built request might carry", () => {
    const result = parseOrderIds([{ id: "a" }, 7, null, "b"]);
    expect(result).toEqual({ ok: true, value: ["b"] });
  });

  it("trims, so a padded id still matches the order it names", () => {
    expect(parseOrderIds([" a "])).toEqual({ ok: true, value: ["a"] });
  });
});

describe("parseReversalReason", () => {
  it("accepts a written reason, trimmed", () => {
    expect(parseReversalReason("  rang it up twice  ")).toEqual({
      ok: true,
      value: "rang it up twice",
    });
  });

  it("requires one — an unexplained reversal is the one you cannot account for", () => {
    expect(parseReversalReason("").ok).toBe(false);
    expect(parseReversalReason("   ").ok).toBe(false);
    expect(parseReversalReason(null).ok).toBe(false);
    expect(parseReversalReason(undefined).ok).toBe(false);
  });

  it("holds to the 500 characters the column allows", () => {
    // Matches order_payments_reversal_reason_length, so the message comes
    // from here rather than as a constraint violation.
    expect(parseReversalReason("x".repeat(500)).ok).toBe(true);
    expect(parseReversalReason("x".repeat(501)).ok).toBe(false);
  });

  it("measures the trimmed length, not the padding", () => {
    expect(parseReversalReason(` ${"x".repeat(500)} `).ok).toBe(true);
  });
});
