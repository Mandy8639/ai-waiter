import {
  CalendarDays,
  Carrot,
  ChartColumn,
  ChefHat,
  CircleSlash,
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

/**
 * Who opens what:
 *   - owner, manager: everything.
 *   - staff (floor and front desk): Overview, Kitchen, Orders, Settle up,
 *     Reservations.
 *   - kitchen (the screen on the pass): Kitchen and Sold out only.
 * src/lib/dashboard/access-core.ts enforces the same table on the server.
 */
const MANAGERS: readonly RestaurantRole[] = ["owner", "manager"];
const FRONT_OF_HOUSE: readonly RestaurantRole[] = ["owner", "manager", "staff"];
const KITCHEN_SIDE: readonly RestaurantRole[] = ["owner", "manager", "kitchen"];

export const NAV_ITEMS: NavItem[] = [
  {
    label: "Overview",
    href: "/dashboard",
    group: "Service",
    icon: LayoutDashboard,
    roles: FRONT_OF_HOUSE,
  },
  {
    label: "Kitchen",
    href: "/dashboard/kitchen",
    group: "Service",
    icon: ChefHat,
  },
  // Marking a dish or an add-on sold out mid-service, without the rest of
  // the menu editor: the kitchen knows first when something runs out.
  {
    label: "Sold out",
    href: "/dashboard/kitchen/sold-out",
    group: "Service",
    icon: CircleSlash,
    roles: KITCHEN_SIDE,
  },
  // Front of house: a waiter settling a dispute needs order history as
  // much as an owner does. Takings stay owner/manager-only (Reports).
  {
    label: "Orders",
    href: "/dashboard/orders",
    group: "Service",
    icon: ReceiptText,
    roles: FRONT_OF_HOUSE,
  },
  {
    label: "Settle up",
    href: "/dashboard/checkout",
    group: "Service",
    icon: HandCoins,
    roles: FRONT_OF_HOUSE,
  },
  {
    label: "Reservations",
    href: "/dashboard/reservations",
    group: "Service",
    icon: CalendarDays,
    roles: FRONT_OF_HOUSE,
  },
  {
    label: "Menu",
    href: "/dashboard/menu",
    group: "Menu",
    icon: UtensilsCrossed,
    roles: MANAGERS,
  },
  {
    label: "Categories",
    href: "/dashboard/categories",
    group: "Menu",
    icon: LayoutList,
    roles: MANAGERS,
  },
  {
    label: "Modifiers",
    href: "/dashboard/modifiers",
    group: "Menu",
    icon: SlidersHorizontal,
    roles: MANAGERS,
  },
  {
    label: "Ingredients",
    href: "/dashboard/ingredients",
    group: "Menu",
    icon: Carrot,
    roles: MANAGERS,
  },
  {
    label: "Allergens",
    href: "/dashboard/allergens",
    group: "Menu",
    icon: ShieldAlert,
    roles: MANAGERS,
  },
  {
    label: "Tables & QR",
    href: "/dashboard/tables",
    group: "Business",
    icon: QrCode,
    roles: MANAGERS,
  },
  {
    label: "Staff",
    href: "/dashboard/staff",
    group: "Business",
    icon: Users,
    roles: MANAGERS,
  },
  {
    label: "Payments",
    href: "/dashboard/payments",
    group: "Business",
    icon: CreditCard,
    roles: MANAGERS,
  },
  {
    label: "Reports",
    href: "/dashboard/reports",
    group: "Business",
    icon: ChartColumn,
    roles: MANAGERS,
  },
  // Phase N: private diner feedback. Owners and managers only, matching
  // the database: comments can name staff.
  {
    label: "Feedback",
    href: "/dashboard/feedback",
    group: "Business",
    icon: MessageSquare,
    roles: MANAGERS,
  },
  {
    label: "Settings",
    href: "/dashboard/settings",
    group: "Business",
    icon: Settings,
    roles: MANAGERS,
  },
];
