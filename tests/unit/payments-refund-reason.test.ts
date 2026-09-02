import { describe, expect, it } from "vitest";
import {
  parseRefundReason,
  parseRefundAmount,
  isRefundCategory,
  REFUND_CATEGORIES,
} from "@/lib/payments/refund-reason";

// Two different "reasons" meet here: Stripe's fixed enum, which it rejects
// anything outside of, and our free-text audit trail. These tests are about
// keeping them straight.
describe("parseRefundReason", () => {
  it("accepts every category Stripe allows", () => {
    for (const category of REFUND_CATEGORIES) {
      const r = parseRefundReason(category, "a note");
      expect(r.ok).toBe(true);
    }
  });

  it("rejects a category Stripe would refuse", () => {
    // Sending an arbitrary string here fails at the API, after the pending
    // row already exists — better to stop it in the form.
    for (const bad of ["other", "mistake", "", null, undefined, 42]) {
      expect(parseRefundReason(bad, "a note")).toMatchObject({ ok: false });
    }
  });

  it("requires a note, since a refund nobody explained is the one you cannot account for", () => {
    expect(parseRefundReason("duplicate", "")).toMatchObject({ ok: false });
    expect(parseRefundReason("duplicate", "   ")).toMatchObject({ ok: false });
    expect(parseRefundReason("duplicate", null)).toMatchObject({ ok: false });
  });

  it("builds an audit line that reads as a sentence", () => {
    const r = parseRefundReason("duplicate", "charged twice for order #12");
    expect(r).toMatchObject({
      ok: true,
      category: "duplicate",
      storedReason: "Charged twice — charged twice for order #12",
    });
  });

  it("trims the note rather than storing the whitespace", () => {
    const r = parseRefundReason("fraudulent", "  stolen card  ");
    expect(r).toMatchObject({ ok: true, note: "stolen card" });
  });

  it("keeps the stored reason inside what the column accepts", () => {
    // payment_refunds_reason_length caps at 500; exceeding it would fail
    // as a database error after the form looked fine.
    const r = parseRefundReason("duplicate", "x".repeat(600));
    expect(r).toMatchObject({ ok: false });
  });

  it("recognises categories without pretending unknown ones are valid", () => {
    expect(isRefundCategory("duplicate")).toBe(true);
    expect(isRefundCategory("nonsense")).toBe(false);
    expect(isRefundCategory(null)).toBe(false);
  });
});

describe("parseRefundAmount", () => {
  it("treats empty as 'refund whatever is left'", () => {
    // Which is what a full refund means once partial ones exist.
    for (const input of [undefined, null, "", "   "]) {
      expect(parseRefundAmount(input)).toEqual({ ok: true, value: null });
    }
  });

  it("accepts money-shaped amounts", () => {
    expect(parseRefundAmount("5")).toEqual({ ok: true, value: 5 });
    expect(parseRefundAmount("5.5")).toEqual({ ok: true, value: 5.5 });
    expect(parseRefundAmount("12.75")).toEqual({ ok: true, value: 12.75 });
  });

  it("rejects more precision than money has, rather than rounding", () => {
    expect(parseRefundAmount("5.567")).toMatchObject({ ok: false });
  });

  it("rejects zero and negatives", () => {
    // A zero refund is a no-op that would still consume a Stripe call and
    // a row; a negative one is a charge wearing a refund's clothes.
    expect(parseRefundAmount("0")).toMatchObject({ ok: false });
    expect(parseRefundAmount("-5")).toMatchObject({ ok: false });
  });

  it("rejects text and formatted currency", () => {
    for (const bad of ["abc", "£5", "5,50", "1e3", "Infinity", "NaN"]) {
      expect(parseRefundAmount(bad)).toMatchObject({ ok: false });
    }
  });
});
