import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ItemDetailForm } from "@/components/customer/item-detail-form";
import { createClient } from "@/lib/supabase/server";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import { addToCart } from "@/lib/cart/actions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string; id: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  return { title: restaurant ? `Menu item — ${restaurant.name}` : "Menu item" };
}

const spiceLevelLabels: Record<string, string> = {
  none: "Not spicy",
  mild: "Mild",
  medium: "Medium",
  hot: "Hot",
  very_hot: "Very hot",
};

export default async function MenuItemDetailPage({
  params,
}: {
  params: Promise<{ restaurantSlug: string; id: string }>;
}) {
  const { restaurantSlug, id } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);

  if (!restaurant || !restaurant.isActive) {
    notFound();
  }

  const supabase = await createClient();

  const { data: item } = await supabase
    .from("menu_items")
    .select(
      "id, name, description, price, image_url, is_vegetarian, is_vegan, is_spicy, spice_level, contains_nuts, contains_dairy, contains_gluten, preparation_time",
    )
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  if (!item) {
    notFound();
  }

  const [
    { data: ingredientLinks },
    { data: allergenLinks },
    { data: groupRows },
  ] = await Promise.all([
    supabase
      .from("menu_item_ingredients")
      .select("ingredient_id")
      .eq("menu_item_id", item.id),
    supabase
      .from("menu_item_allergens")
      .select("allergen_id")
      .eq("menu_item_id", item.id),
    supabase
      .from("menu_item_modifiers")
      .select(
        "id, name, description, is_required, min_selections, max_selections, display_order",
      )
      .eq("menu_item_id", item.id)
      .order("display_order", { ascending: true }),
  ]);

  const ingredientIds = (ingredientLinks ?? []).map((l) => l.ingredient_id);
  const allergenIds = (allergenLinks ?? []).map((l) => l.allergen_id);
  const groupIds = (groupRows ?? []).map((g) => g.id);

  const [{ data: ingredients }, { data: allergens }, { data: optionRows }] =
    await Promise.all([
      ingredientIds.length > 0
        ? supabase
            .from("ingredients")
            .select("id, name")
            .in("id", ingredientIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      allergenIds.length > 0
        ? supabase.from("allergens").select("id, name").in("id", allergenIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      groupIds.length > 0
        ? supabase
            .from("modifier_options")
            .select(
              "id, modifier_id, name, price_adjustment, is_available, display_order",
            )
            .in("modifier_id", groupIds)
            .order("display_order", { ascending: true })
        : Promise.resolve({
            data: [] as {
              id: string;
              modifier_id: string;
              name: string;
              price_adjustment: number;
              is_available: boolean;
              display_order: number;
            }[],
          }),
    ]);

  const groups = (groupRows ?? []).map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    isRequired: group.is_required,
    minSelections: group.min_selections,
    maxSelections: group.max_selections,
    options: (optionRows ?? [])
      .filter((o) => o.modifier_id === group.id)
      .map((o) => ({
        id: o.id,
        name: o.name,
        priceAdjustment: Number(o.price_adjustment),
        isAvailable: o.is_available,
      })),
  }));

  const currency = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  });

  return (
    <div className="flex flex-1 flex-col gap-5">
      {item.image_url && (
        // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL
        <img
          src={item.image_url}
          alt=""
          className="-mx-4 -mt-4 h-48 w-[calc(100%+2rem)] object-cover"
        />
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{item.name}</h1>
          <p className="shrink-0 text-lg font-semibold">
            {currency.format(Number(item.price))}
          </p>
        </div>
        {item.description && (
          <p className="text-muted-foreground text-sm">{item.description}</p>
        )}

        <div className="flex flex-wrap gap-1.5">
          {item.is_vegetarian && <Badge variant="secondary">Vegetarian</Badge>}
          {item.is_vegan && <Badge variant="secondary">Vegan</Badge>}
          {item.is_spicy && item.spice_level && (
            <Badge variant="outline">
              {spiceLevelLabels[item.spice_level] ?? item.spice_level}
            </Badge>
          )}
          {item.contains_nuts && <Badge variant="outline">Contains nuts</Badge>}
          {item.contains_dairy && (
            <Badge variant="outline">Contains dairy</Badge>
          )}
          {item.contains_gluten && (
            <Badge variant="outline">Contains gluten</Badge>
          )}
          {item.preparation_time != null && (
            <Badge variant="outline">~{item.preparation_time} min</Badge>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Allergens</h2>
        {allergens && allergens.length > 0 ? (
          <p className="text-muted-foreground text-sm">
            {allergens.map((a) => a.name).join(", ")}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            This restaurant hasn&apos;t provided allergen information for this
            item.
          </p>
        )}
      </div>

      {ingredients && ingredients.length > 0 && (
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Ingredients</h2>
          <p className="text-muted-foreground text-sm">
            {ingredients.map((i) => i.name).join(", ")}
          </p>
        </div>
      )}

      <ItemDetailForm
        action={addToCart}
        menuItemId={item.id}
        basePrice={Number(item.price)}
        groups={groups}
        restaurantSlug={restaurantSlug}
      />
    </div>
  );
}
