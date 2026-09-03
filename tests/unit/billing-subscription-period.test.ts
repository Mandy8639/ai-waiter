import { describe, expect, it } from "vitest";
import { resolvePeriodEnd } from "@/lib/billing/subscription-period";

/**
 * Stripe moved this field. Reading only the old location does not fail —
 * it yields undefined and stores null, producing a subscription with no
 * renewal date that looks like missing data rather than a bug. These pin
 * both locations.
 */

const SEP = 1791056784; // 2026-10-03T19:46:24Z
const OCT = 1793648784; // a month later

describe("resolvePeriodEnd", () => {
  it("reads the item, where dahlia puts it", () => {
    expect(
      resolvePeriodEnd({ items: { data: [{ current_period_end: SEP }] } }),
    ).toBe("2026-10-03T19:46:24.000Z");
  });

  it("still reads the top level, for the pre-dahlia shape", () => {
    expect(resolvePeriodEnd({ current_period_end: SEP })).toBe(
      "2026-10-03T19:46:24.000Z",
    );
  });

  it("takes the latest when both are present and disagree", () => {
    // Understating it would show a restaurant as lapsed while it is still
    // paid up.
    expect(
      resolvePeriodEnd({
        current_period_end: SEP,
        items: { data: [{ current_period_end: OCT }] },
      }),
    ).toBe(new Date(OCT * 1000).toISOString());
  });

  it("takes the latest across several items", () => {
    expect(
      resolvePeriodEnd({
        items: {
          data: [{ current_period_end: SEP }, { current_period_end: OCT }],
        },
      }),
    ).toBe(new Date(OCT * 1000).toISOString());
  });

  it("returns null when there is genuinely no period", () => {
    // An incomplete subscription has none, and that is a real state.
    expect(resolvePeriodEnd({ items: { data: [] } })).toBeNull();
    expect(resolvePeriodEnd({})).toBeNull();
  });

  it("survives the shapes a webhook can actually deliver", () => {
    expect(resolvePeriodEnd(null)).toBeNull();
    expect(resolvePeriodEnd(undefined)).toBeNull();
    expect(resolvePeriodEnd("not an object")).toBeNull();
    expect(resolvePeriodEnd({ items: { data: [{}] } })).toBeNull();
    expect(resolvePeriodEnd({ current_period_end: null })).toBeNull();
  });

  it("refuses a nonsensical timestamp rather than producing Invalid Date", () => {
    expect(resolvePeriodEnd({ current_period_end: 0 })).toBeNull();
    expect(resolvePeriodEnd({ current_period_end: -1 })).toBeNull();
    expect(resolvePeriodEnd({ current_period_end: Number.NaN })).toBeNull();
  });
});
