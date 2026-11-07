import {
  CalendarDays,
  Carrot,
  ChartColumn,
  ChefHat,
  ClipboardPen,
  CircleSlash,
  CreditCard,
  HandCoins,
  HeartHandshake,
  LayoutDashboard,
  LayoutGrid,
  LayoutList,
  MessageSquare,
  QrCode,
  ReceiptText,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
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
  /**
   * Hidden and closed in basic mode (restaurants.basic_mode,
   * 20261125090000): the pages about taking money and bookings. A basic
   * restaurant is the QR menu, the AI waiter and the kitchen.
   */
  fullOnly?: true;
}

/**
 * Who opens what:
 *   - owner, manager: everything.
 *   - staff (floor and front desk): Overview, Floor, Kitchen, Take order, Orders,
 *     Settle up, Reservations.
 *   - kitchen (the screen on the pass): Kitchen, Sold out and Waiter.
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
  // The room at a glance: each table's most urgent state, live
  // (src/lib/floor/). The kitchen account works the pass, not the room.
  {
    label: "Floor",
    href: "/dashboard/floor",
    group: "Service",
    icon: LayoutGrid,
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
  // The Waiter, the staff assistant (the diners' "Chef" character): "86 the salmon", typed. The same switches as Sold out and the
  // kitchen's pause and running-behind controls (src/lib/staff-assistant/).
  {
    label: "Waiter",
    href: "/dashboard/assistant",
    group: "Service",
    icon: Sparkles,
    roles: KITCHEN_SIDE,
  },
  // The till: staff ring up walk-ins, phone orders and tables
  // (staff_place_order(), 20261107090000).
  {
    label: "Take order",
    href: "/dashboard/pos",
    group: "Service",
    icon: ClipboardPen,
    roles: FRONT_OF_HOUSE,
    fullOnly: true,
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
    fullOnly: true,
  },
  {
    label: "Reservations",
    href: "/dashboard/reservations",
    group: "Service",
    icon: CalendarDays,
    roles: FRONT_OF_HOUSE,
    fullOnly: true,
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
    fullOnly: true,
  },
  {
    label: "Reports",
    href: "/dashboard/reports",
    group: "Business",
    icon: ChartColumn,
    roles: MANAGERS,
    fullOnly: true,
  },
  // Who comes, when, and how they use the AI waiter
  // (docs/guest-insights.md). Counts only, owners and managers.
  {
    label: "Guests",
    href: "/dashboard/guests",
    group: "Business",
    icon: HeartHandshake,
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
