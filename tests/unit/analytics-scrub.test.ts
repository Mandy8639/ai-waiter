import { describe, expect, it } from "vitest";
import { analyticsUrl } from "@/lib/analytics/scrub";

/**
 * What Vercel Web Analytics may record: the page, never a token, an id or
 * a query string.
 */
describe("analyticsUrl", () => {
  it("keeps the owner journey's pages as they are", () => {
    for (const page of ["/", "/signup", "/onboarding", "/dashboard"]) {
      expect(analyticsUrl(`https://tableside.menu${page}`)).toBe(
        `https://tableside.menu${page}`,
      );
    }
  });

  it("drops the query string entirely, reset tokens included", () => {
    expect(
      analyticsUrl(
        "https://tableside.menu/auth/confirm?token_hash=abc&type=recovery",
      ),
    ).toBe("https://tableside.menu/auth/confirm");
    expect(analyticsUrl("https://tableside.menu/r/x/menu?category=1")).toBe(
      "https://tableside.menu/r/x/menu",
    );
  });

  it("redacts table, invitation, split, order and receipt links", () => {
    expect(analyticsUrl("https://tableside.menu/r/x/table/tok123")).toBe(
      "https://tableside.menu/r/x/table/[redacted]",
    );
    expect(analyticsUrl("https://tableside.menu/join/tok456")).toBe(
      "https://tableside.menu/join/[redacted]",
    );
    expect(analyticsUrl("https://tableside.menu/r/x/split/tok789")).toBe(
      "https://tableside.menu/r/x/split/[redacted]",
    );
    expect(analyticsUrl("https://tableside.menu/r/x/order/o1")).toBe(
      "https://tableside.menu/r/x/order/[redacted]",
    );
  });

  it("never passes through something it can't read", () => {
    expect(analyticsUrl("http://[bad")).toBe("[unparseable-url]");
  });
});
