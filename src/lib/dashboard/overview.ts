import "server-only";

import { createClient } from "@/lib/supabase/server";
import { rangeBounds } from "@/lib/reports/range";
import { getReportData } from "@/lib/reports/queries";
import { countPendingReservationRequests } from "@/lib/notifications/pending-requests";
import { getOrderHistory, type HistoryOrder } from "@/lib/orders/history";
import { ACTIVE_KITCHEN_STATUSES, type OrderStatus } from "@/lib/orders/status";
import type { RestaurantRole } from "@/lib/restaurants/get-user-restaurants";

/**
 * Everything the dashboard overview shows, read in one place.
 *
 * Every number here is a count or a sum of real rows — nothing is
 * estimated, trended or invented. Where a viewer isn't allowed to see a
 * figure (takings are owner/manager only, enforced again in SQL by
 * assert_can_view_reports) the field is null and the page simply leaves
 * that card out, rather than showing a zero that would read as "nothing
 * was taken".
 */
export interface DashboardOverview {
  timeZone: string;
  currency: string;
  isActive: boolean;
  acceptingOrders: boolean;
  aiWaiterEnabled: boolean;
  ordersToday: number;
  cancelledToday: number;
  inKitchenNow: number;
  awaitingAcceptance: number;
  /** null when the viewer can't see takings, or the read failed. */
  takingsToday: { net: string; paymentCount: number } | null;
  pendingBookings: number | null;
  menuItems: number;
  unavailableItems: number;
  categories: number;
  tables: number;
  allergenSuggestionsToConfirm: number;
  /** null when the viewer can't see payment setup (owner/manager only). */
  canTakeCardPayments: boolean | null;
  recentOrders: HistoryOrder[];
}

const MANAGES_MONEY: RestaurantRole[] = ["owner", "manager"];
const FRONT_OF_HOUSE: RestaurantRole[] = ["owner", "manager", "staff"];

export async function getDashboardOverview(
  restaurantId: string,
  role: RestaurantRole,
): Promise<DashboardOverview> {
  const supabase = await createClient();

  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("timezone, currency, is_active")
    .eq("id", restaurantId)
    .single();

  const timeZone = restaurant?.timezone ?? "UTC";
  const today = rangeBounds("today", timeZone);
  const canSeeMoney = MANAGES_MONEY.includes(role);

  const [
    ordersToday,
    menuItems,
    unavailableItems,
    categories,
    tables,
    allergenSuggestions,
    settings,
    paymentAccount,
    pendingBookings,
    takings,
    recent,
  ] = await Promise.all([
    supabase
      .from("orders")
      .select("status")
      .eq("restaurant_id", restaurantId)
      .gte("created_at", today.from)
      .lt("created_at", today.to),
    supabase
      .from("menu_items")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantId),
    supabase
      .from("menu_items")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantId)
      .eq("is_available", false),
    supabase
      .from("categories")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantId),
    supabase
      .from("tables")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantId),
    supabase
      .from("menu_item_allergens")
      .select("menu_item_id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantId)
      .is("confirmed_at", null),
    supabase
      .from("restaurant_settings")
      .select("accepting_orders, allow_ai_recommendations")
      .eq("restaurant_id", restaurantId)
      .maybeSingle(),
    canSeeMoney
      ? supabase
          .from("restaurant_payment_accounts")
          .select("charges_enabled")
          .eq("restaurant_id", restaurantId)
          .maybeSingle()
      : Promise.resolve(null),
    FRONT_OF_HOUSE.includes(role)
      ? countPendingReservationRequests(restaurantId)
      : Promise.resolve(null),
    // A failed takings read leaves the card out rather than failing the
    // whole overview — the reports page is where a money error is loud.
    canSeeMoney
      ? getReportData(restaurantId, today).catch(() => null)
      : Promise.resolve(null),
    getOrderHistory(restaurantId, timeZone, {
      range: "today",
      status: null,
      search: "",
      page: 0,
    }).catch(() => ({ orders: [] as HistoryOrder[], hasMore: false })),
  ]);

  const statuses = (ordersToday.data ?? []).map(
    (row) => row.status as OrderStatus,
  );

  return {
    timeZone,
    currency: restaurant?.currency ?? "USD",
    isActive: restaurant?.is_active ?? false,
    acceptingOrders: settings.data?.accepting_orders ?? false,
    aiWaiterEnabled: settings.data?.allow_ai_recommendations ?? false,
    ordersToday: statuses.filter((s) => s !== "cancelled").length,
    cancelledToday: statuses.filter((s) => s === "cancelled").length,
    inKitchenNow: statuses.filter((s) => ACTIVE_KITCHEN_STATUSES.includes(s))
      .length,
    awaitingAcceptance: statuses.filter((s) => s === "pending").length,
    takingsToday: takings
      ? {
          net: takings.summary.net,
          paymentCount: takings.summary.paymentCount,
        }
      : null,
    pendingBookings,
    menuItems: menuItems.count ?? 0,
    unavailableItems: unavailableItems.count ?? 0,
    categories: categories.count ?? 0,
    tables: tables.count ?? 0,
    allergenSuggestionsToConfirm: allergenSuggestions.count ?? 0,
    canTakeCardPayments:
      paymentAccount === null
        ? null
        : (paymentAccount.data?.charges_enabled ?? false),
    recentOrders: recent.orders.slice(0, 6),
  };
}
