import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { deleteAllergen } from "@/lib/allergens/actions";

export const metadata = {
  title: "Allergens — AI Waiter",
};

export default async function AllergensPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: allergens } = await supabase
    .from("allergens")
    .select("id, name, description")
    .eq("restaurant_id", restaurant.id)
    .order("name");

  const canManage =
    restaurant.role === "owner" || restaurant.role === "manager";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Allergens</h1>
          <p className="text-muted-foreground text-sm">
            Your allergen catalog — the source of truth for allergen questions,
            including the future AI waiter&apos;s.
          </p>
        </div>
        {canManage && (
          <Link
            href="/dashboard/allergens/new"
            className={buttonVariants({ variant: "default" })}
          >
            New allergen
          </Link>
        )}
      </div>

      {!allergens || allergens.length === 0 ? (
        <EmptyState
          title="No allergens yet"
          description="Add allergens so customers (and eventually the AI) can trust accurate answers."
          actionHref={canManage ? "/dashboard/allergens/new" : undefined}
          actionLabel={canManage ? "New allergen" : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {allergens.map((allergen) => (
            <Card key={allergen.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">{allergen.name}</p>
                  {allergen.description && (
                    <p className="text-muted-foreground text-sm">
                      {allergen.description}
                    </p>
                  )}
                </div>
                {canManage && (
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/allergens/${allergen.id}/edit`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      Edit
                    </Link>
                    <DeleteButton
                      onDelete={deleteAllergen.bind(
                        null,
                        restaurant.id,
                        allergen.id,
                      )}
                      confirmTitle={`Delete "${allergen.name}"?`}
                      confirmDescription="This removes it from any menu items that reference it. This can't be undone."
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
