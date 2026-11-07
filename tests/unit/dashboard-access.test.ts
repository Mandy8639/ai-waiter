import { describe, expect, it } from "vitest";
import {
  canOpenDashboardPath,
  dashboardHomeFor,
  navItemFor,
  navItemsFor,
} from "@/lib/dashboard/access-core";
import { NAV_ITEMS } from "@/components/dashboard/nav-items";
import type { RestaurantRole } from "@/lib/restaurants/get-user-restaurants";

/** A full restaurant (basic mode off): every page that exists. */
const canOpen = (role: RestaurantRole, path: string) =>
  canOpenDashboardPath(role, path, false);

/**
 * Kitchen mode: which dashboard pages each role may open. One table feeds
 * the menu bar and the server's redirect, so these are both "what you
 * see" and "where you can go".
 */

describe("the kitchen account", () => {
  it.each([
    "/dashboard/kitchen",
    "/dashboard/kitchen/sold-out",
    "/dashboard/assistant",
  ])("opens %s", (path) => {
    expect(canOpen("kitchen", path)).toBe(true);
  });

  it.each([
    "/dashboard",
    "/dashboard/orders",
    "/dashboard/floor",
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
    expect(canOpen("kitchen", path)).toBe(false);
  });

  it("is turned away from a page nobody listed, rather than let in", () => {
    expect(canOpen("kitchen", "/dashboard/something-new")).toBe(false);
  });

  it("lands on the board", () => {
    expect(dashboardHomeFor("kitchen")).toBe("/dashboard/kitchen");
    expect(canOpen("kitchen", dashboardHomeFor("kitchen"))).toBe(true);
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
    "/dashboard/floor",
  ])("opens %s", (path) => {
    expect(canOpen("staff", path)).toBe(true);
  });

  it.each([
    "/dashboard/kitchen/sold-out",
    "/dashboard/assistant",
    "/dashboard/menu",
    "/dashboard/payments",
    "/dashboard/settings",
    "/dashboard/staff",
    "/dashboard/reports",
  ])("is turned away from %s", (path) => {
    expect(canOpen("staff", path)).toBe(false);
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
        expect(canOpen(role, item.href)).toBe(true);
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
    expect(canOpen("kitchen", "/account")).toBe(true);
  });
});

describe("basic mode: QR menu, AI waiter and kitchen only", () => {
  const closed = [
    "/dashboard/pos",
    "/dashboard/checkout",
    "/dashboard/reservations",
    "/dashboard/reservations/new",
    "/dashboard/payments",
    "/dashboard/reports",
    "/dashboard/reports/close",
  ];

  it.each(["owner", "manager", "staff"] as const)(
    "closes the pages about money and bookings, even to %s",
    (role) => {
      for (const path of closed) {
        expect(canOpenDashboardPath(role, path, true)).toBe(false);
      }
    },
  );

  it.each([
    "/dashboard",
    "/dashboard/kitchen",
    "/dashboard/kitchen/sold-out",
    "/dashboard/assistant",
    "/dashboard/orders",
    "/dashboard/menu",
    "/dashboard/allergens",
    "/dashboard/tables",
    "/dashboard/staff",
    "/dashboard/guests",
    "/dashboard/feedback",
    "/dashboard/settings",
  ])("still opens %s for an owner", (path) => {
    expect(canOpenDashboardPath("owner", path, true)).toBe(true);
  });

  it("keeps the kitchen's tabs as they were", () => {
    expect(navItemsFor("kitchen", true).map((i) => i.label)).toEqual(
      navItemsFor("kitchen", false).map((i) => i.label),
    );
  });

  it("shows staff only what's left: the overview, the floor, the board and orders", () => {
    expect(navItemsFor("staff", true).map((i) => i.label)).toEqual([
      "Overview",
      "Floor",
      "Kitchen",
      "Orders",
    ]);
  });
});
