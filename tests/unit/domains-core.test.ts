import { describe, expect, it } from "vitest";
import { oldHostRedirect } from "@/lib/domains/core";

const OLD = "order.beacondigitalconsulting.org";

describe("oldHostRedirect", () => {
  it("sends old-host pages to the same page on tableside.menu", () => {
    expect(oldHostRedirect(OLD, "/", "")).toBe("https://tableside.menu/");
    expect(oldHostRedirect(OLD, "/r/my-restaurant/table/abc-123", "?x=1")).toBe(
      "https://tableside.menu/r/my-restaurant/table/abc-123?x=1",
    );
    expect(
      oldHostRedirect(
        "Order.BeaconDigitalConsulting.org:443",
        "/dashboard",
        "",
      ),
    ).toBe("https://tableside.menu/dashboard");
  });

  it("keeps every /api/ address answering in place", () => {
    for (const p of [
      "/api/webhooks/stripe",
      "/api/webhooks/stripe/platform",
      "/api/webhooks/square",
      "/api/health",
      "/api",
    ]) {
      expect(oldHostRedirect(OLD, p, "")).toBeNull();
    }
  });

  it("leaves tableside.menu and everything else alone", () => {
    expect(oldHostRedirect("tableside.menu", "/", "")).toBeNull();
    expect(oldHostRedirect("localhost:3000", "/", "")).toBeNull();
    expect(oldHostRedirect("ai-waiter-abc.vercel.app", "/", "")).toBeNull();
    expect(oldHostRedirect(null, "/", "")).toBeNull();
  });
});
