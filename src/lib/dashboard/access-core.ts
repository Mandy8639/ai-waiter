import { NAV_ITEMS, type NavItem } from "@/components/dashboard/nav-items";
import type { RestaurantRole } from "@/lib/restaurants/get-user-restaurants";

/**
 * Which dashboard pages each role may open — one table (NAV_ITEMS) read by
 * both the menu bar and the server, so a page can't be hidden from the
 * nav yet still open, or the reverse.
 *
 * Every page under /dashboard belongs to the nav item whose href is its
 * longest matching prefix: /dashboard/menu/12/edit belongs to Menu,
 * /dashboard/kitchen/sold-out to Sold out. Anything matching no deeper
 * item falls back to Overview ("/dashboard"), so a new page nobody listed
 * is closed to the kitchen account rather than open to it.
 *
 * The kitchen account is a screen on the pass, not a manager: it gets the
 * board and the sold-out switches, nothing about money or staff. A staff
 * account is the floor and the front desk: orders, settling up,
 * reservations.
 *
 * A restaurant in basic mode (QR menu, AI waiter and kitchen only) has
 * the pages about money and bookings closed to every role.
 *
 * This decides what renders. Data access is still the database's job
 * (RLS and the functions' own role checks); this keeps people from
 * landing on screens that were never meant for them.
 */

/** Set by src/proxy.ts on every request: the path being rendered. */
export const PATHNAME_HEADER = "x-tableside-pathname";

function isUnder(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname.startsWith("/dashboard");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The nav item a dashboard path belongs to, or null outside /dashboard. */
export function navItemFor(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const item of NAV_ITEMS) {
    if (!isUnder(pathname, item.href)) continue;
    if (!best || item.href.length > best.href.length) best = item;
  }
  return best;
}

/** Whether a role, in a basic or full restaurant, may open this nav item. */
export function canOpenNavItem(
  item: NavItem,
  role: RestaurantRole,
  basicMode: boolean,
): boolean {
  if (basicMode && item.fullOnly) return false;
  return !item.roles || item.roles.includes(role);
}

/** The nav items a role sees, in order. */
export function navItemsFor(
  role: RestaurantRole,
  basicMode: boolean,
): NavItem[] {
  return NAV_ITEMS.filter((item) => canOpenNavItem(item, role, basicMode));
}

export function canOpenDashboardPath(
  role: RestaurantRole,
  pathname: string,
  basicMode: boolean,
): boolean {
  const item = navItemFor(pathname);
  // Not a dashboard page at all: not this rule's business.
  if (!item) return true;
  return canOpenNavItem(item, role, basicMode);
}

/** Where a role lands, and where it's sent from a page it can't open. */
export function dashboardHomeFor(role: RestaurantRole): string {
  return role === "kitchen" ? "/dashboard/kitchen" : "/dashboard";
}
