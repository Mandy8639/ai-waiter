import {
  BusyModeBanners,
  BusyModeButton,
  BusyModeProvider,
} from "@/components/kitchen/busy-mode-control";
import { buttonVariants } from "@/components/ui/button";
import { KitchenBoard } from "@/components/kitchen/kitchen-board";
import { getKitchenStatusRow } from "@/lib/kitchen/busy-queries";
import { PushAlertsToggle } from "@/components/kitchen/push-alerts-toggle";
import { apnsConfig } from "@/lib/push/apns";
import { fcmConfig } from "@/lib/push/fcm";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import Link from "next/link";
import {
  getActiveOrdersForRestaurant,
  getKitchenStations,
} from "@/lib/orders/kitchen";
import { getPrintCapabilities } from "@/lib/printing/capabilities";

export const metadata = {
  title: "Kitchen — Tableside",
};

/**
 * Server-rendered initial paint (so a hard refresh — or an initial tablet
 * boot — shows real orders immediately, no loading flash), then
 * KitchenBoard (client) takes over via Supabase Realtime for live updates.
 * Every restaurant role can view (spec section 4: "staff: view orders");
 * which action buttons render is role-scoped inside KitchenBoard/OrderCard,
 * though the actual enforcement is server-side regardless
 * (transition_order_status()) — see docs/security.md#order-status-transitions.
 */
export default async function KitchenPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const [orders, stations, busy, print] = await Promise.all([
    getActiveOrdersForRestaurant(restaurant.id),
    getKitchenStations(restaurant.id),
    getKitchenStatusRow(restaurant.id),
    getPrintCapabilities(restaurant.id),
  ]);
  const canManageStations =
    restaurant.role === "owner" || restaurant.role === "manager";

  return (
    <BusyModeProvider
      restaurantId={restaurant.id}
      initial={busy}
      canChange={restaurant.role !== "staff"}
    >
      <div className="flex flex-col gap-4">
        {/* Only what's on right now gets a full-width banner; every control
            sits in one row of buttons beside the board's title. */}
        <BusyModeBanners />
        <KitchenBoard
          restaurantId={restaurant.id}
          restaurantName={restaurant.name}
          timeZone={restaurant.timezone}
          role={restaurant.role}
          initialOrders={orders}
          stations={stations}
          kitchenPrinter={print.kitchen}
          toolbar={
            <>
              <BusyModeButton />
              {/* Renders nothing when push isn't configured for this deployment. */}
              <PushAlertsToggle
                restaurantId={restaurant.id}
                nativeAlerts={{
                  ios: apnsConfig() !== null,
                  android: fcmConfig() !== null,
                }}
              />
              {canManageStations && (
                <Link
                  href="/dashboard/kitchen/stations"
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  Stations
                </Link>
              )}
            </>
          }
        />
      </div>
    </BusyModeProvider>
  );
}
