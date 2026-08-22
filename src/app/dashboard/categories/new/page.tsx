import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryForm } from "@/components/categories/category-form";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createCategory } from "@/lib/categories/actions";

export const metadata = {
  title: "New category — AI Waiter",
};

export default async function NewCategoryPage() {
  const { restaurant } = await requireCurrentRestaurant();

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New category</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Category details</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryForm
            action={createCategory.bind(null, restaurant.id)}
            submitLabel="Create category"
            pendingLabel="Creating…"
          />
        </CardContent>
      </Card>
    </div>
  );
}
