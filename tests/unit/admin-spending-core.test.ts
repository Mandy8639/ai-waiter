// The Admin page's Spending card: OpenRouter's figures, and "not
// reported" rather than $0 when they're missing
// (src/lib/admin/spending-core.ts).
import { describe, expect, it } from "vitest";
import {
  combineSpending,
  formatUsd,
  limitUsedPercent,
  NOTHING_REPORTED,
  nothingReported,
  parseCredits,
  parseKeyInfo,
  resetLabel,
} from "@/lib/admin/spending-core";

describe("parseKeyInfo", () => {
  it("reads this key's spend and limit", () => {
    expect(
      parseKeyInfo({
        data: {
          usage: 7.5,
          usage_daily: 0.42,
          usage_monthly: 3.1,
          limit: 20,
          limit_remaining: 16.9,
          limit_reset: "monthly",
        },
      }),
    ).toEqual({
      monthUsd: 3.1,
      todayUsd: 0.42,
      limitUsd: 20,
      limitRemainingUsd: 16.9,
      limitReset: "monthly",
    });
  });

  it("leaves out what wasn't sent, rather than calling it zero", () => {
    expect(parseKeyInfo({ data: { limit: null } })).toEqual({
      monthUsd: null,
      todayUsd: null,
      limitUsd: null,
      limitRemainingUsd: null,
      limitReset: null,
    });
  });

  it("returns nothing for a body it doesn't recognise", () => {
    expect(parseKeyInfo(null)).toBeNull();
    expect(parseKeyInfo({ error: "nope" })).toBeNull();
  });
});

describe("parseCredits", () => {
  it("is what was bought minus what was used", () => {
    expect(
      parseCredits({ data: { total_credits: 10, total_usage: 1.25 } }),
    ).toBe(8.75);
  });

  it("is unknown when either half is missing", () => {
    expect(parseCredits({ data: { total_credits: 10 } })).toBeNull();
    expect(parseCredits(null)).toBeNull();
  });
});

describe("combineSpending", () => {
  it("knows when OpenRouter couldn't be reached at all", () => {
    expect(nothingReported(combineSpending(null, null))).toBe(true);
    expect(nothingReported(combineSpending(null, 4))).toBe(false);
  });
});

describe("formatting", () => {
  it("shows money plainly, and never turns unknown into $0", () => {
    expect(formatUsd(null)).toBe("not reported");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.034)).toBe("3.4¢");
    expect(formatUsd(12.4)).toBe("$12.40");
  });

  it("measures the limit used", () => {
    expect(
      limitUsedPercent({
        ...NOTHING_REPORTED,
        limitUsd: 20,
        limitRemainingUsd: 15,
      }),
    ).toBe(25);
    expect(
      limitUsedPercent({
        ...NOTHING_REPORTED,
        limitUsd: 20,
        monthUsd: 30,
        limitReset: "monthly",
      }),
    ).toBe(100);
    expect(limitUsedPercent({ ...NOTHING_REPORTED, limitUsd: 20 })).toBeNull();
    expect(limitUsedPercent(NOTHING_REPORTED)).toBeNull();
  });

  it("words the limit's period", () => {
    expect(resetLabel("monthly")).toBe("per month");
    expect(resetLabel(null)).toBe("in total");
  });
});
