import { describe, expect, it } from "vitest";
import {
  canOpenDashboardPath,
  dashboardHomeFor,
  navItemFor,
} from "@/lib/dashboard/access-core";
import { NAV_ITEMS } from "@/components/dashboard/nav-items";

/**
 * Kitchen mode: which dashboard pages each role may open. One table feeds
 * the menu bar and the server's redirect, so these are both "what you
 * see" and "where you can go".
 */

describe("the kitchen account", () => {
  it.each(["/dashboard/kitchen", "/dashboard/kitchen/sold-out"])(
    "opens %s",
    (path) => {
      expect(canOpenDashboardPath("kitchen", path)).toBe(true);
    },
  );

  it.each([
    "/dashboard",
    "/dashboard/orders",
    "/dashboard/checkout",
    "/dashboard/payments",
    "/dashboard/reports",
    "/dashboard/reports/export",
    "/dashboard/settings",
    "/dashboard/staff",
    "/dashboard/tables/print",
    "/dashboard/menu",
    "/dashboard/menu/abc/edit",
    "/dashboard/modifiers",
    "/dashboard/reservations",
  ])("is turned away from %s", (path) => {
    expect(canOpenDashboardPath("kitchen", path)).toBe(false);
  });

  it("is turned away from a page nobody listed, rather than let in", () => {
    expect(canOpenDashboardPath("kitchen", "/dashboard/something-new")).toBe(
      false,
    );
  });

  it("lands on the board", () => {
    expect(dashboardHomeFor("kitchen")).toBe("/dashboard/kitchen");
    expect(canOpenDashboardPath("kitchen", dashboardHomeFor("kitchen"))).toBe(
      true,
    );
  });
});

describe("front-of-house staff", () => {
  it.each([
    "/dashboard",
    "/dashboard/kitchen",
    "/dashboard/orders",
    "/dashboard/checkout",
    "/dashboard/reservations",
    "/dashboard/reservations/new",
  ])("opens %s", (path) => {
    expect(canOpenDashboardPath("staff", path)).toBe(true);
  });

  it.each([
    "/dashboard/kitchen/sold-out",
    "/dashboard/menu",
    "/dashboard/payments",
    "/dashboard/settings",
    "/dashboard/staff",
    "/dashboard/reports",
  ])("is turned away from %s", (path) => {
    expect(canOpenDashboardPath("staff", path)).toBe(false);
  });

  it("lands on the overview", () => {
    expect(dashboardHomeFor("staff")).toBe("/dashboard");
  });
});

describe("owners and managers", () => {
  it.each(["owner", "manager"] as const)(
    "open every page in the nav (%s)",
    (role) => {
      for (const item of NAV_ITEMS) {
        expect(canOpenDashboardPath(role, item.href)).toBe(true);
      }
    },
  );
});

describe("navItemFor", () => {
  it("picks the deepest match, so Sold out isn't also Kitchen", () => {
    expect(navItemFor("/dashboard/kitchen/sold-out")?.label).toBe("Sold out");
    expect(navItemFor("/dashboard/kitchen")?.label).toBe("Kitchen");
    expect(navItemFor("/dashboard/menu/1/edit")?.label).toBe("Menu");
  });

  it("does not confuse a page with one whose name starts the same", () => {
    // /dashboard/tables-archive (hypothetical) is not under Tables & QR.
    expect(navItemFor("/dashboard/tables-archive")?.label).toBe("Overview");
  });

  it("ignores everything outside the dashboard", () => {
    expect(navItemFor("/account")).toBeNull();
    expect(canOpenDashboardPath("kitchen", "/account")).toBe(true);
  });
});
