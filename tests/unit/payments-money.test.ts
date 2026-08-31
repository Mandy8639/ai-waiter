import { describe, expect, it } from "vitest";
import {
  InvalidAmountError,
  UnsupportedCurrencyError,
  fromMinorUnits,
  minorUnitDigits,
  sumMinorUnits,
  toMinorUnits,
} from "@/lib/payments/money";

describe("toMinorUnits()", () => {
  it("converts a two-decimal amount", () => {
    expect(toMinorUnits("12.34", "USD")).toBe(1234);
    expect(toMinorUnits("0.05", "USD")).toBe(5);
    expect(toMinorUnits("100.00", "GBP")).toBe(10000);
  });

  it("accepts the string form supabase-js actually returns for numeric", () => {
    // Postgres numeric comes back as a string, not a number — see
    // src/lib/orders/queries.ts, which coerces with Number().
    expect(toMinorUnits("18.00", "USD")).toBe(1800);
  });

  it("pads a short fraction rather than misreading it", () => {
    // "12.3" is twelve-thirty, not twelve-oh-three.
    expect(toMinorUnits("12.3", "USD")).toBe(1230);
  });

  it("handles a whole number with no decimal point", () => {
    expect(toMinorUnits("7", "USD")).toBe(700);
  });

  it("treats zero-decimal currencies as having no minor unit", () => {
    expect(toMinorUnits("500", "JPY")).toBe(500);
    expect(toMinorUnits("1200", "KRW")).toBe(1200);
  });

  /**
   * The reason this module is string-based: 12.34 * 100 is
   * 1233.9999999999998 in IEEE-754. Any implementation multiplying floats
   * is one unlucky value away from charging a cent wrong.
   */
  it("is exact where float multiplication is not", () => {
    for (const [amount, expected] of [
      ["12.34", 1234],
      ["1.15", 115],
      ["8.29", 829],
      ["19.99", 1999],
      ["0.29", 29],
      ["4.35", 435],
    ] as const) {
      expect(toMinorUnits(amount, "USD")).toBe(expected);
    }
  });

  it("accepts a number as well as a string", () => {
    expect(toMinorUnits(12.34, "USD")).toBe(1234);
    expect(toMinorUnits(500, "JPY")).toBe(500);
  });

  it("refuses more precision than the currency can hold, rather than rounding it away", () => {
    expect(() => toMinorUnits("12.345", "USD")).toThrow(InvalidAmountError);
    expect(() => toMinorUnits("500.5", "JPY")).toThrow(InvalidAmountError);
  });

  it("ignores trailing zeros that carry no extra precision", () => {
    expect(toMinorUnits("12.3400", "USD")).toBe(1234);
    expect(toMinorUnits("500.00", "JPY")).toBe(500);
  });

  it("rejects values that are not amounts at all", () => {
    for (const bad of ["", "abc", "1.2.3", "$5", "1e3"]) {
      expect(() => toMinorUnits(bad, "USD")).toThrow(InvalidAmountError);
    }
  });

  it("handles negative amounts, for refunds", () => {
    expect(toMinorUnits("-12.34", "USD")).toBe(-1234);
  });
});

describe("fromMinorUnits()", () => {
  it("is the inverse of toMinorUnits", () => {
    for (const [amount, currency] of [
      ["12.34", "USD"],
      ["0.05", "USD"],
      ["19.99", "GBP"],
      ["500", "JPY"],
      ["-12.34", "USD"],
    ] as const) {
      expect(fromMinorUnits(toMinorUnits(amount, currency), currency)).toBe(
        amount,
      );
    }
  });

  it("formats small amounts with a leading zero", () => {
    expect(fromMinorUnits(5, "USD")).toBe("0.05");
    expect(fromMinorUnits(0, "USD")).toBe("0.00");
  });

  it("omits the decimal point for zero-decimal currencies", () => {
    expect(fromMinorUnits(500, "JPY")).toBe("500");
  });

  it("rejects a fractional minor unit, which cannot exist", () => {
    expect(() => fromMinorUnits(12.5, "USD")).toThrow(InvalidAmountError);
  });
});

describe("sumMinorUnits()", () => {
  it("sums a session tab in integers, not floats", () => {
    // 0.1 + 0.2 is famously 0.30000000000000004 as floats.
    expect(sumMinorUnits(["0.10", "0.20"], "USD")).toBe(30);
  });

  it("sums several order totals", () => {
    expect(sumMinorUnits(["18.00", "12.50", "6.25"], "USD")).toBe(3675);
    expect(
      fromMinorUnits(sumMinorUnits(["18.00", "12.50", "6.25"], "USD"), "USD"),
    ).toBe("36.75");
  });

  it("is zero for an empty tab", () => {
    expect(sumMinorUnits([], "USD")).toBe(0);
  });
});

describe("minorUnitDigits()", () => {
  it("defaults to two", () => {
    expect(minorUnitDigits("USD")).toBe(2);
    expect(minorUnitDigits("eur")).toBe(2);
  });

  it("knows the zero-decimal currencies", () => {
    expect(minorUnitDigits("JPY")).toBe(0);
  });

  /**
   * numeric(10,2) cannot represent a third decimal place, so accepting
   * these would mean charging a rounded amount without saying so.
   */
  it("refuses three-decimal currencies loudly", () => {
    for (const code of ["BHD", "KWD", "OMR"]) {
      expect(() => minorUnitDigits(code)).toThrow(UnsupportedCurrencyError);
    }
  });
});
