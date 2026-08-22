import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MenuItemCard } from "@/components/customer/menu-item-card";
import { createClient } from "@/lib/supabase/server";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import { cn } from "@/lib/utils";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  return { title: restaurant ? `Menu — ${restaurant.name}` : "Menu" };
}

export default async function MenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ restaurantSlug: string }>;
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const { restaurantSlug } = await params;
  const { category: categoryId, q } = await searchParams;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);

  if (!restaurant || !restaurant.isActive) {
    notFound();
  }

  const supabase = await createClient();

  let itemsQuery = supabase
    .from("menu_items")
    .select(
      "id, name, description, price, image_url, is_vegetarian, is_vegan, is_spicy, category_id",
    )
    .eq("restaurant_id", restaurant.id)
    .order("display_order", { ascending: true })
    .limit(500);

  if (categoryId) {
    itemsQuery = itemsQuery.eq("category_id", categoryId);
  }
  const search = q?.trim();
  if (search) {
    // Deterministic name/description search — no AI, no embeddings, just a
    // plain ILIKE (see spec's "menu search" requirement).
    const escaped = search.replace(/[%_]/g, (match) => `\\${match}`);
    itemsQuery = itemsQuery.or(
      `name.ilike.%${escaped}%,description.ilike.%${escaped}%`,
    );
  }

  // Independent queries (neither depends on the other's result) — run
  // concurrently rather than round-tripping twice sequentially (Batch 8
  // performance audit, docs/production-audit.md).
  const [{ data: categories }, { data: menuItems }] = await Promise.all([
    supabase
      .from("categories")
      .select("id, name")
      .eq("restaurant_id", restaurant.id)
      .order("display_order", { ascending: true }),
    itemsQuery,
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <form
        className="flex gap-2"
        action={`/r/${restaurantSlug}/menu`}
        method="get"
      >
        {categoryId && (
          <input type="hidden" name="category" value={categoryId} />
        )}
        <Input
          type="search"
          name="q"
          placeholder="Search the menu…"
          defaultValue={q ?? ""}
          className="flex-1"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {categories && categories.length > 0 && (
        <div className="-mx-4 flex scrollbar-none gap-2 overflow-x-auto px-4 pb-1">
          <Link
            href={`/r/${restaurantSlug}/menu${q ? `?q=${encodeURIComponent(q)}` : ""}`}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium whitespace-nowrap",
              !categoryId
                ? "bg-primary text-primary-foreground border-transparent"
                : "bg-background",
            )}
          >
            All
          </Link>
          {categories.map((category) => {
            const params = new URLSearchParams();
            params.set("category", category.id);
            if (q) params.set("q", q);
            return (
              <Link
                key={category.id}
                href={`/r/${restaurantSlug}/menu?${params.toString()}`}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium whitespace-nowrap",
                  categoryId === category.id
                    ? "bg-primary text-primary-foreground border-transparent"
                    : "bg-background",
                )}
              >
                {category.name}
              </Link>
            );
          })}
        </div>
      )}

      {!menuItems || menuItems.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <Badge variant="outline">No results</Badge>
          <p className="text-muted-foreground text-sm">
            {search
              ? `No items match "${search}".`
              : "No items in this category yet."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {menuItems.map((item) => (
            <MenuItemCard
              key={item.id}
              restaurantSlug={restaurantSlug}
              item={{
                id: item.id,
                name: item.name,
                description: item.description,
                price: Number(item.price),
                imageUrl: item.image_url,
                isVegetarian: item.is_vegetarian,
                isVegan: item.is_vegan,
                isSpicy: item.is_spicy,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
