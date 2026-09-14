import type { RestaurantRole } from "@/lib/restaurants/get-user-restaurants";

export interface NavItem {
  label: string;
  href: string;
  /**
   * Roles that may open this page. Omitted means everyone in the
   * restaurant. Listing a link a viewer cannot open would send them to a
   * 404 — the nav should not advertise doors that are locked.
   *
   * This is presentation only. The page itself and the database functions
   * behind it do their own checks; hiding a link is not access control.
   */
  roles?: readonly RestaurantRole[];
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Kitchen", href: "/dashboard/kitchen" },
  // No role restriction: a waiter settling a dispute needs order history
  // as much as an owner does. Takings stay owner/manager-only (Reports).
  { label: "Orders", href: "/dashboard/orders" },
  { label: "Settle up", href: "/dashboard/checkout" },
  { label: "Menu", href: "/dashboard/menu" },
  { label: "Categories", href: "/dashboard/categories" },
  { label: "Modifiers", href: "/dashboard/modifiers" },
  { label: "Ingredients", href: "/dashboard/ingredients" },
  { label: "Allergens", href: "/dashboard/allergens" },
  { label: "Tables", href: "/dashboard/tables" },
  { label: "Reservations", href: "/dashboard/reservations" },
  { label: "Staff", href: "/dashboard/staff" },
  { label: "Payments", href: "/dashboard/payments" },
  {
    label: "Reports",
    href: "/dashboard/reports",
    roles: ["owner", "manager"],
  },
  { label: "Settings", href: "/dashboard/settings" },
];
