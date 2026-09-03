import { describe, expect, it } from "vitest";
import { scrubUrl } from "@/lib/observability/scrub-url";

/**
 * The browser SDK attaches the current URL to every event. A diner's URL
 * carries a table token, which is a bearer of table access — so this is a
 * disclosure boundary, not a formatting nicety.
 */

describe("scrubUrl", () => {
  it("redacts the table token, which is a bearer of table access", () => {
    expect(
      scrubUrl("/r/nashta/table/d4f6bdb8-4251-4e13-8b3e-609ccc339437"),
    ).toBe("/r/nashta/table/[redacted]");
  });

  it("redacts an order id", () => {
    expect(scrubUrl("/r/nashta/order/7d41676b-1572-4476")).toBe(
      "/r/nashta/order/[redacted]",
    );
  });

  it("redacts a receipt's payment id", () => {
    expect(scrubUrl("/r/nashta/receipt/a1253953-289f")).toBe(
      "/r/nashta/receipt/[redacted]",
    );
  });

  it("drops the query string wholesale", () => {
    // A per-parameter allowlist is open by default, and this one carries
    // Stripe session ids.
    expect(scrubUrl("/dashboard/reports?range=30d")).toBe(
      "/dashboard/reports?[redacted]",
    );
  });

  it("keeps an ordinary path, which is how you find the page", () => {
    expect(scrubUrl("/dashboard/reservations")).toBe("/dashboard/reservations");
    expect(scrubUrl("/r/nashta/menu")).toBe("/r/nashta/menu");
  });

  it("preserves the origin on an absolute URL", () => {
    expect(
      scrubUrl("https://ai-waiter-two.vercel.app/r/nashta/table/tok_secret"),
    ).toBe("https://ai-waiter-two.vercel.app/r/nashta/table/[redacted]");
  });

  it("redacts every sensitive segment, not just the first", () => {
    expect(scrubUrl("/table/tok/order/oid")).toBe(
      "/table/[redacted]/order/[redacted]",
    );
  });

  it("leaves a trailing keyword alone when nothing follows it", () => {
    // "/table" with no token is a path, not a leak.
    expect(scrubUrl("/r/nashta/table")).toBe("/r/nashta/table");
    expect(scrubUrl("/r/nashta/table/")).toBe("/r/nashta/table/");
  });

  it("never throws, because it runs inside beforeSend", () => {
    // Throwing there would lose the very event it was sanitising.
    expect(() => scrubUrl("")).not.toThrow();
    expect(() => scrubUrl("://////")).not.toThrow();
    expect(scrubUrl("")).toBe("");
  });

  it("returns a marker rather than the original when it cannot parse", () => {
    // The original is exactly what might be carrying a token.
    const out = scrubUrl("http://[bad");
    expect(out).not.toContain("bad");
  });
});
