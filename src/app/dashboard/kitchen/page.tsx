import { KitchenBoard } from "@/components/kitchen/kitchen-board";
import { PushAlertsToggle } from "@/components/kitchen/push-alerts-toggle";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { getActiveOrdersForRestaurant } from "@/lib/orders/kitchen";

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
  const orders = await getActiveOrdersForRestaurant(restaurant.id);

  return (
    <div className="flex flex-col gap-4">
      {/* Renders nothing when push isn't configured for this deployment. */}
      <PushAlertsToggle restaurantId={restaurant.id} />
      <KitchenBoard
        restaurantId={restaurant.id}
        role={restaurant.role}
        initialOrders={orders}
      />
    </div>
  );
}
