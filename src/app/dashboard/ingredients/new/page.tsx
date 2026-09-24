import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NameDescriptionForm } from "@/components/dashboard/name-description-form";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createIngredient } from "@/lib/ingredients/actions";

export const metadata = {
  title: "New ingredient — Tableside",
};

export default async function NewIngredientPage() {
  const { restaurant } = await requireCurrentRestaurant();

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New ingredient</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ingredient details</CardTitle>
        </CardHeader>
        <CardContent>
          <NameDescriptionForm
            action={createIngredient.bind(null, restaurant.id)}
            submitLabel="Create ingredient"
            pendingLabel="Creating…"
          />
        </CardContent>
      </Card>
    </div>
  );
}
