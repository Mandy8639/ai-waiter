import { StaffAssistantPanel } from "@/components/dashboard/staff-assistant";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";

export const metadata = {
  title: "Chef — Tableside",
};

/**
 * The Chef, full-page: the same conversation as the floating "Ask the
 * Chef" sheet (held by StaffAssistantProvider in the dashboard layout),
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
        <h1 className="text-2xl font-semibold tracking-tight">Ask the Chef</h1>
        <p className="text-muted-foreground text-sm">
          Tell the Chef what&apos;s changed and it&apos;s done straight away,
          with an undo. Price changes, and anything the Chef isn&apos;t sure
          about, ask you first. The Chef is on every page too: tap &ldquo;Ask
          the Chef&rdquo; at the bottom.
        </p>
      </div>
      <StaffAssistantPanel />
    </div>
  );
}
