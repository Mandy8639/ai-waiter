import { StaffAssistantPanel } from "@/components/dashboard/staff-assistant";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";

export const metadata = {
  title: "Waiter — Tableside",
};

/**
 * The Waiter, full-page: the same conversation as the floating "Waiter"
 * sheet (held by StaffAssistantProvider in the dashboard layout),
 * for the kitchen tablet's tab. Owner, manager and kitchen
 * (src/components/dashboard/nav-items.ts); every change runs through the
 * same database functions as the Sold out and Kitchen pages, as the
 * signed-in person. See src/lib/staff-assistant/.
 */
export default async function AssistantPage() {
  // Access is the layout's (access-core.ts); this keeps the page signed-in only.
  await requireCurrentRestaurant();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Waiter</h1>
        <p className="text-muted-foreground text-sm">
          Tell the Waiter what&apos;s changed and it&apos;s done straight away,
          with an undo. Price changes, and anything the Waiter isn&apos;t sure
          about, ask you first. The Waiter is on every page too: tap
          &ldquo;Waiter&rdquo; at the bottom.
        </p>
      </div>
      <StaffAssistantPanel />
    </div>
  );
}
