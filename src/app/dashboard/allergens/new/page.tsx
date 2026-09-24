import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NameDescriptionForm } from "@/components/dashboard/name-description-form";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createAllergen } from "@/lib/allergens/actions";

export const metadata = {
  title: "New allergen — Tableside",
};

export default async function NewAllergenPage() {
  const { restaurant } = await requireCurrentRestaurant();

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New allergen</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Allergen details</CardTitle>
        </CardHeader>
        <CardContent>
          <NameDescriptionForm
            action={createAllergen.bind(null, restaurant.id)}
            submitLabel="Create allergen"
            pendingLabel="Creating…"
          />
        </CardContent>
      </Card>
    </div>
  );
}
