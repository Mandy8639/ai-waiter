import {
  CalendarDays,
  Carrot,
  ChartColumn,
  ChefHat,
  CreditCard,
  HandCoins,
  LayoutDashboard,
  LayoutList,
  MessageSquare,
  QrCode,
  ReceiptText,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  UtensilsCrossed,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { RestaurantRole } from "@/lib/restaurants/get-user-restaurants";

/**
 * Three groups, by what the person is doing: running service right now,
 * shaping the menu, or running the business. The old flat list of fifteen
 * links mixed "the kitchen is on fire" with "change the tax rate".
 */
export type NavGroup = "Service" | "Menu" | "Business";
export const NAV_GROUPS: NavGroup[] = ["Service", "Menu", "Business"];

export interface NavItem {
  label: string;
  href: string;
  group: NavGroup;
  icon: LucideIcon;
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
  {
    label: "Overview",
    href: "/dashboard",
    group: "Service",
    icon: LayoutDashboard,
  },
  {
    label: "Kitchen",
    href: "/dashboard/kitchen",
    group: "Service",
    icon: ChefHat,
  },
  // No role restriction: a waiter settling a dispute needs order history
  // as much as an owner does. Takings stay owner/manager-only (Reports).
  {
    label: "Orders",
    href: "/dashboard/orders",
    group: "Service",
    icon: ReceiptText,
  },
  {
    label: "Settle up",
    href: "/dashboard/checkout",
    group: "Service",
    icon: HandCoins,
  },
  {
    label: "Reservations",
    href: "/dashboard/reservations",
    group: "Service",
    icon: CalendarDays,
  },
  {
    label: "Menu",
    href: "/dashboard/menu",
    group: "Menu",
    icon: UtensilsCrossed,
  },
  {
    label: "Categories",
    href: "/dashboard/categories",
    group: "Menu",
    icon: LayoutList,
  },
  {
    label: "Modifiers",
    href: "/dashboard/modifiers",
    group: "Menu",
    icon: SlidersHorizontal,
  },
  {
    label: "Ingredients",
    href: "/dashboard/ingredients",
    group: "Menu",
    icon: Carrot,
  },
  {
    label: "Allergens",
    href: "/dashboard/allergens",
    group: "Menu",
    icon: ShieldAlert,
  },
  {
    label: "Tables & QR",
    href: "/dashboard/tables",
    group: "Business",
    icon: QrCode,
  },
  { label: "Staff", href: "/dashboard/staff", group: "Business", icon: Users },
  {
    label: "Payments",
    href: "/dashboard/payments",
    group: "Business",
    icon: CreditCard,
  },
  {
    label: "Reports",
    href: "/dashboard/reports",
    group: "Business",
    icon: ChartColumn,
    roles: ["owner", "manager"],
  },
  // Phase N: private diner feedback. Owners and managers only, matching
  // the database: comments can name staff.
  {
    label: "Feedback",
    href: "/dashboard/feedback",
    group: "Business",
    icon: MessageSquare,
    roles: ["owner", "manager"],
  },
  {
    label: "Settings",
    href: "/dashboard/settings",
    group: "Business",
    icon: Settings,
  },
];
