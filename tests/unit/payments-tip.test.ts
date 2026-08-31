import { describe, expect, it } from "vitest";
import { parseTip, TIP_MAX } from "@/lib/payments/tip";

// A tip is the only figure a diner types that lands on a card charge, so
// these lean on the ways free text goes wrong rather than the happy path.
describe("parseTip", () => {
  it("treats absent, empty and whitespace input as no tip", () => {
    for (const input of [undefined, null, "", "   "]) {
      expect(parseTip(input)).toEqual({ ok: true, value: 0 });
    }
  });

  it("accepts whole numbers and two decimal places", () => {
    expect(parseTip("0")).toEqual({ ok: true, value: 0 });
    expect(parseTip("4")).toEqual({ ok: true, value: 4 });
    expect(parseTip("4.5")).toEqual({ ok: true, value: 4.5 });
    expect(parseTip("4.50")).toEqual({ ok: true, value: 4.5 });
    expect(parseTip(" 12.75 ")).toEqual({ ok: true, value: 12.75 });
  });

  it("rejects more precision than the column can hold, rather than rounding", () => {
    // numeric(10,2) cannot store 4.567. Rounding it would charge a number
    // the diner never typed, so this refuses instead.
    expect(parseTip("4.567")).toMatchObject({ ok: false });
    expect(parseTip("0.001")).toMatchObject({ ok: false });
  });

  it("rejects negatives, including a minus sign the pattern must not allow", () => {
    // A negative tip would reduce the charge below the order total.
    expect(parseTip("-5")).toMatchObject({ ok: false });
    expect(parseTip("-0.01")).toMatchObject({ ok: false });
  });

  it("rejects text, symbols and formatted currency", () => {
    for (const input of ["abc", "4,50", "£4.50", "4.50p", "1e3", "+5", " "]) {
      const result = parseTip(input);
      if (input === " ") {
        expect(result).toEqual({ ok: true, value: 0 });
      } else {
        expect(result).toMatchObject({ ok: false });
      }
    }
  });

  it("rejects Infinity and NaN however they are spelled", () => {
    for (const input of ["Infinity", "-Infinity", "NaN", Infinity, NaN]) {
      expect(parseTip(input)).toMatchObject({ ok: false });
    }
  });

  it("caps the tip", () => {
    expect(parseTip(String(TIP_MAX))).toEqual({ ok: true, value: TIP_MAX });
    expect(parseTip(String(TIP_MAX + 1))).toMatchObject({ ok: false });
  });

  it("accepts a number as readily as its string form", () => {
    expect(parseTip(4.5)).toEqual({ ok: true, value: 4.5 });
    expect(parseTip(0)).toEqual({ ok: true, value: 0 });
  });
});
