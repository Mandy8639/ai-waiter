import { describe, expect, it } from "vitest";
import { formatFeeBps, formatMonthlyPrice } from "@/lib/billing/format";

/**
 * These numbers sit next to a real charge on a real restaurant's billing
 * page, so a misread is a support ticket at best.
 */

describe("formatFeeBps", () => {
  it("renders whole percents without decimals", () => {
    expect(formatFeeBps(100)).toBe("1%");
    expect(formatFeeBps(200)).toBe("2%");
  });

  it("renders fractions without inventing precision", () => {
    // "0.50%" reads like a precision claim nobody made.
    expect(formatFeeBps(50)).toBe("0.5%");
    expect(formatFeeBps(25)).toBe("0.25%");
  });

  it("renders a zero fee plainly", () => {
    expect(formatFeeBps(0)).toBe("0%");
  });
});

describe("formatMonthlyPrice", () => {
  it("calls a zero price Free, which is a different fact from $0.00", () => {
    expect(formatMonthlyPrice(0, "USD")).toBe("Free");
  });

  it("formats cents as currency", () => {
    expect(formatMonthlyPrice(4900, "USD")).toMatch(/49\.00/);
    expect(formatMonthlyPrice(14900, "USD")).toMatch(/149\.00/);
  });

  it("falls back rather than throwing on an unknown currency code", () => {
    // Intl throws on a bad code; a billing page must still render.
    expect(formatMonthlyPrice(4900, "NOTACURRENCY")).toBe("NOTACURRENCY 49.00");
  });
});
