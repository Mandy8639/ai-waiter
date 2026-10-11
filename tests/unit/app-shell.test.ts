import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IOS_USER_AGENT_MARK,
  appShellFrom,
  appShellRedirect,
  canSellPlans,
  parseAppShell,
} from "@/lib/app-shell/core";

/**
 * App mode: inside the Android and iOS store apps, Tableside's own plans
 * are never offered for purchase (Apple 3.1.1, Google Play Payments) and
 * the landing page with its prices isn't shown. In a browser nothing
 * changes.
 */

describe("appShellFrom", () => {
  it("is nothing in a browser", () => {
    expect(
      appShellFrom({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      }),
    ).toBeNull();
    expect(appShellFrom({})).toBeNull();
  });

  it("takes the app announcing itself on launch, then the remembered cookie, then the iOS user agent", () => {
    expect(appShellFrom({ query: "android" })).toBe("android");
    expect(appShellFrom({ query: "ios", cookie: "android" })).toBe("ios");
    expect(appShellFrom({ cookie: "android" })).toBe("android");
    expect(
      appShellFrom({ userAgent: `Mozilla/5.0 ... ${IOS_USER_AGENT_MARK}` }),
    ).toBe("ios");
  });

  it("ignores anything that isn't one of the two apps", () => {
    for (const value of ["", "web", "ANDROID", "ios ", "1", null, undefined]) {
      expect(parseAppShell(value), String(value)).toBeNull();
    }
    expect(appShellFrom({ query: "web", cookie: "x" })).toBeNull();
  });
});

describe("what app mode changes", () => {
  it("sells plans only outside the apps", () => {
    expect(canSellPlans(null)).toBe(true);
    expect(canSellPlans("android")).toBe(false);
    expect(canSellPlans("ios")).toBe(false);
  });

  it("sends the apps from the landing page (prices, sign-up pitch) to the dashboard, and leaves everything else alone", () => {
    expect(appShellRedirect("/", "android")).toBe("/dashboard");
    expect(appShellRedirect("/", "ios")).toBe("/dashboard");
    expect(appShellRedirect("/", null)).toBeNull();
    for (const path of [
      "/dashboard",
      "/dashboard/payments",
      "/privacy",
      "/account",
      "/r/nashta/menu",
    ]) {
      expect(appShellRedirect(path, "ios"), path).toBeNull();
    }
  });

  it("is wired in: the plan card and the checkout action both ask, and the proxy remembers the app", () => {
    const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    expect(read("src/app/dashboard/payments/page.tsx")).toMatch(
      /plansForSale && \(allPlans \?\? \[\]\)\.length > 0/,
    );
    expect(read("src/lib/billing/subscription-actions.ts")).toContain(
      "canSellPlans(await getAppShell())",
    );
    const proxy = read("src/proxy.ts");
    expect(proxy).toContain("appShellRedirect(");
    expect(proxy).toContain("APP_SHELL_COOKIE");
  });
});
