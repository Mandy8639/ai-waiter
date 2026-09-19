import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { deleteIngredient } from "@/lib/ingredients/actions";

export const metadata = {
  title: "Ingredients — AI Waiter",
};

export default async function IngredientsPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: ingredients } = await supabase
    .from("ingredients")
    .select("id, name, description")
    .eq("restaurant_id", restaurant.id)
    .order("name");

  const canManage =
    restaurant.role === "owner" || restaurant.role === "manager";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ingredients</h1>
          <p className="text-muted-foreground text-sm">
            What your dishes are made of. Diners see them on each dish, and the
            AI waiter uses them to describe your food.
          </p>
        </div>
        {canManage && (
          <Link
            href="/dashboard/ingredients/new"
            className={buttonVariants({ variant: "default" })}
          >
            New ingredient
          </Link>
        )}
      </div>

      {!ingredients || ingredients.length === 0 ? (
        <EmptyState
          title="No ingredients yet"
          description="Add ingredients to describe what's in your dishes."
          actionHref={canManage ? "/dashboard/ingredients/new" : undefined}
          actionLabel={canManage ? "New ingredient" : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {ingredients.map((ingredient) => (
            <Card key={ingredient.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">{ingredient.name}</p>
                  {ingredient.description && (
                    <p className="text-muted-foreground text-sm">
                      {ingredient.description}
                    </p>
                  )}
                </div>
                {canManage && (
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/ingredients/${ingredient.id}/edit`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      Edit
                    </Link>
                    <DeleteButton
                      onDelete={deleteIngredient.bind(
                        null,
                        restaurant.id,
                        ingredient.id,
                      )}
                      confirmTitle={`Delete "${ingredient.name}"?`}
                      confirmDescription="This removes it from any menu items that use it. This can't be undone."
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
