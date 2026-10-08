import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { NutritionReview } from "@/components/dashboard/nutrition-review";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { getNutritionReview } from "@/lib/nutrition/queries";

// "Estimate missing with AI" runs on this page and waits on a free model
// that can take most of a minute per batch (src/lib/nutrition/estimate.ts).
export const maxDuration = 120;

export const metadata = {
  title: "Nutrition — Tableside",
};

/**
 * Phase M: calories and macros per dish. Owners and managers only; the
 * page doesn't exist for anyone else (the database refuses them
 * regardless).
 */
export default async function MenuNutritionPage() {
  const { restaurant } = await requireCurrentRestaurant();
  if (restaurant.role !== "owner" && restaurant.role !== "manager") {
    notFound();
  }

  const rows = await getNutritionReview(restaurant.id);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/dashboard/menu"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Menu
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Nutrition</h1>
        <p className="text-muted-foreground text-sm">
          Calories, protein, carbs and fat for one serving. Diners see them on
          the menu and can ask the AI waiter about them — so they have to be
          right. The AI can estimate a starting point, but nothing is shown
          until you confirm it against your recipe, and changing the numbers
          hides them again until you confirm.
        </p>
      </div>

      <NutritionReview restaurantId={restaurant.id} rows={rows} />
    </div>
  );
}
