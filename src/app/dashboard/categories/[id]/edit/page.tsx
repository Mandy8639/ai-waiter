import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryForm } from "@/components/categories/category-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { updateCategory } from "@/lib/categories/actions";

export const metadata = {
  title: "Edit category — AI Waiter",
};

export default async function EditCategoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: category } = await supabase
    .from("categories")
    .select("id, name, description, display_order, is_active")
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  if (!category) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Edit category</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Category details</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryForm
            action={updateCategory.bind(null, restaurant.id, category.id)}
            defaultValues={{
              name: category.name,
              description: category.description,
              displayOrder: category.display_order,
              isActive: category.is_active,
            }}
            submitLabel="Save changes"
            pendingLabel="Saving…"
          />
        </CardContent>
      </Card>
    </div>
  );
}
