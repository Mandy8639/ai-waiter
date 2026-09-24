import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { deleteCategory, toggleCategoryActive } from "@/lib/categories/actions";

export const metadata = {
  title: "Categories — Tableside",
};

export default async function CategoriesPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: categories } = await supabase
    .from("categories")
    .select("id, name, description, display_order, is_active")
    .eq("restaurant_id", restaurant.id)
    .order("display_order", { ascending: true });

  const canManage =
    restaurant.role === "owner" || restaurant.role === "manager";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>
          <p className="text-muted-foreground text-sm">
            Organize your menu into sections.
          </p>
        </div>
        {canManage && (
          <Link
            href="/dashboard/categories/new"
            className={buttonVariants({ variant: "default" })}
          >
            New category
          </Link>
        )}
      </div>

      {!categories || categories.length === 0 ? (
        <EmptyState
          title="No categories yet"
          description="Categories organize your menu — create one to get started."
          actionHref={canManage ? "/dashboard/categories/new" : undefined}
          actionLabel={canManage ? "New category" : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {categories.map((category) => (
            <Card key={category.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{category.name}</p>
                    <Badge
                      variant={category.is_active ? "secondary" : "outline"}
                    >
                      {category.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  {category.description && (
                    <p className="text-muted-foreground text-sm">
                      {category.description}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    Order: {category.display_order}
                  </p>
                </div>

                {canManage && (
                  <div className="flex items-center gap-2">
                    <form
                      action={toggleCategoryActive.bind(
                        null,
                        restaurant.id,
                        category.id,
                        !category.is_active,
                      )}
                    >
                      <button
                        type="submit"
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                      >
                        {category.is_active ? "Disable" : "Enable"}
                      </button>
                    </form>
                    <Link
                      href={`/dashboard/categories/${category.id}/edit`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      Edit
                    </Link>
                    <DeleteButton
                      onDelete={deleteCategory.bind(
                        null,
                        restaurant.id,
                        category.id,
                      )}
                      confirmTitle={`Delete "${category.name}"?`}
                      confirmDescription="This can't be undone. If menu items still use this category, deletion will be blocked."
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
