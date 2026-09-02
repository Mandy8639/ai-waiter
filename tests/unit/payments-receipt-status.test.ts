import { describe, expect, it } from "vitest";
import {
  isReceiptable,
  netPaid,
  receiptState,
} from "@/lib/payments/receipt-status";

/**
 * A receipt is a claim about money, handed to the person whose money it
 * was. The failure that matters is not a crash but a confident wrong
 * number, so these tests are mostly about what the document is allowed to
 * say.
 */

describe("receiptState", () => {
  it("calls a settled payment with nothing returned paid", () => {
    expect(receiptState({ status: "succeeded", total: 20, refunded: 0 })).toBe(
      "paid",
    );
  });

  it("distinguishes a partial refund from a full one", () => {
    expect(receiptState({ status: "succeeded", total: 20, refunded: 5 })).toBe(
      "partly_refunded",
    );
    expect(receiptState({ status: "succeeded", total: 20, refunded: 20 })).toBe(
      "fully_refunded",
    );
  });

  it("treats a refund a hair under the total as full", () => {
    // numeric(10,2) arriving as a JS number can land just short. Calling
    // this "partly refunded" would send a reader hunting for a penny that
    // does not exist.
    expect(
      receiptState({ status: "succeeded", total: 19.99, refunded: 19.989 }),
    ).toBe("fully_refunded");
  });

  it("reports a reversal as reversed, never as refunded", () => {
    // Checked before refunds on purpose: reversed cash means the money was
    // never taken, so a refund figure would describe returning money that
    // never moved.
    expect(receiptState({ status: "reversed", total: 20, refunded: 0 })).toBe(
      "reversed",
    );
    expect(receiptState({ status: "reversed", total: 20, refunded: 20 })).toBe(
      "reversed",
    );
  });

  it("refuses to call an incomplete attempt a receipt", () => {
    for (const status of ["pending", "failed", "cancelled"]) {
      expect(receiptState({ status, total: 20, refunded: 0 })).toBe("unpaid");
      expect(
        isReceiptable(receiptState({ status, total: 20, refunded: 0 })),
      ).toBe(false);
    }
  });

  it("treats every settled state as receiptable", () => {
    expect(isReceiptable("paid")).toBe(true);
    expect(isReceiptable("partly_refunded")).toBe(true);
    expect(isReceiptable("fully_refunded")).toBe(true);
    expect(isReceiptable("reversed")).toBe(true);
  });
});

describe("netPaid", () => {
  it("is the charge when nothing was returned", () => {
    expect(netPaid({ status: "succeeded", total: 24.99, refunded: 0 })).toBe(
      24.99,
    );
  });

  it("deducts refunds", () => {
    expect(netPaid({ status: "succeeded", total: 20, refunded: 5 })).toBe(15);
  });

  it("is zero for a reversal — no money was ever taken", () => {
    expect(netPaid({ status: "reversed", total: 20, refunded: 0 })).toBe(0);
  });

  it("is zero for an attempt that never completed", () => {
    expect(netPaid({ status: "pending", total: 20, refunded: 0 })).toBe(0);
  });

  it("never goes negative", () => {
    // The database enforces the refund limit; this guards the document
    // against a rounding artefact rendering a negative total, which would
    // undermine the whole thing.
    expect(netPaid({ status: "succeeded", total: 20, refunded: 20.004 })).toBe(
      0,
    );
  });
});
