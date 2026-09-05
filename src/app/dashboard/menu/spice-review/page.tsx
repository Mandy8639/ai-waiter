import {
  SpiceReviewList,
  type DraftSpiceItem,
} from "@/components/dashboard/spice-review-list";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import type { SpiceLevel } from "@/lib/menu-import/suggestions";

export const metadata = {
  title: "Review spice levels — AI Waiter",
};

export default async function SpiceReviewPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  // Drafts only. A level a person has already set is not a question.
  const { data: items } = await supabase
    .from("menu_items")
    .select("id, name, spice_level")
    .eq("restaurant_id", restaurant.id)
    .eq("spice_level_source", "ai_draft")
    .not("spice_level", "is", null)
    .order("name");

  const pending: DraftSpiceItem[] = (items ?? []).map((i) => ({
    menuItemId: i.id,
    itemName: i.name,
    suggested: (i.spice_level ?? "none") as SpiceLevel,
  }));

  return (
    <div className="flex max-w-2xl flex-1 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Review spice levels
        </h1>
        <p className="text-muted-foreground text-sm">
          These were guessed from each dish&apos;s name when your menu was
          imported, and the guess is already selected. Confirm the ones that
          look right, change the ones that don&apos;t.
        </p>
        {/*
          Said plainly, because it is the difference between this page and
          the allergen one and a reviewer should not have to infer it.
        */}
        <p className="text-muted-foreground text-sm">
          Diners can already see these, unlike allergens — reviewing corrects
          them rather than revealing them.
        </p>
      </div>

      <SpiceReviewList restaurantId={restaurant.id} items={pending} />
    </div>
  );
}
