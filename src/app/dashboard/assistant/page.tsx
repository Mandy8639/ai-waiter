import { StaffAssistant } from "@/components/dashboard/staff-assistant";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";

export const metadata = {
  title: "Assistant — Tableside",
};

/**
 * The staff assistant: plain-English commands for the switches staff flip
 * mid-service. Owner, manager and kitchen (src/components/dashboard/
 * nav-items.ts); every change runs through the same database functions as
 * the Sold out and Kitchen pages, as the signed-in person. See
 * src/lib/staff-assistant/.
 */
export default async function AssistantPage() {
  const { restaurant } = await requireCurrentRestaurant();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
        <p className="text-muted-foreground text-sm">
          Type what&apos;s changed and it&apos;s done straight away, with an
          undo. Price changes, and anything it isn&apos;t sure about, ask you
          first.
        </p>
      </div>
      <StaffAssistant
        restaurantId={restaurant.id}
        canChangePrices={
          restaurant.role === "owner" || restaurant.role === "manager"
        }
      />
    </div>
  );
}
