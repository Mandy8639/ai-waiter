import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Clock } from "lucide-react";
import { AllergenNote } from "@/components/customer/allergen-note";
import { AskWaiterButton } from "@/components/customer/ask-waiter-card";
import { DietBadges } from "@/components/customer/diet-badges";
import { ItemDetailForm } from "@/components/customer/item-detail-form";
import { formatPrice } from "@/lib/format/price";
import { createClient } from "@/lib/supabase/server";
import {
  getPublicRestaurantBySlug,
  getPublicOrderSettings,
} from "@/lib/customer/restaurant";
import { addToCart } from "@/lib/cart/actions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string; id: string }>;
}) {
  const { restaurantSlug, id } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  if (!restaurant) return { title: "Menu item" };
  const supabase = await createClient();
  const { data: item } = await supabase
    .from("menu_items")
    .select("name")
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();
  return {
    title: item
      ? `${item.name} — ${restaurant.name}`
      : `Menu item — ${restaurant.name}`,
  };
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
      "id, name, description, price, image_url, is_vegetarian, is_vegan, is_spicy, spice_level, contains_nuts, contains_dairy, contains_gluten, preparation_time, portion_note, spice_level",
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
      .eq("menu_item_id", item.id)
      // Confirmed allergens only. An unconfirmed row is a SUGGESTION —
      // typically inferred from a dish name during menu import — and this
      // platform never states an allergen on its own authority. Omitting it
      // makes the app say "the menu doesn't specify, check with staff",
      // which is the safe answer; including it would be an assertion a
      // diner with an allergy acts on. See
      // supabase/migrations/20260904140000_allergen_confirmation.sql.
      .not("confirmed_at", "is", null),
    supabase
      .from("menu_item_modifiers")
      .select(
        "id, name, description, is_required, min_selections, max_selections, display_order",
      )
      .eq("menu_item_id", item.id)
      .order("display_order", { ascending: true }),
  ]);

  // Via the SECURITY DEFINER function, not a direct read: restaurant_settings
  // is member-only and has no public SELECT policy, so a diner reading it
  // directly gets null and silently loses the note box — which is exactly
  // what happened the first time this was written.
  const settings = await getPublicOrderSettings(restaurant.id);

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

  // The dish's own yes/no flags, folded into the same "Contains …" line as
  // the confirmed allergens so the page never says "no allergens listed"
  // while a flag says it contains dairy. Skipped when a confirmed allergen
  // already says the same thing more precisely.
  const allergenNames = (allergens ?? []).map((a) => a.name);
  const lower = allergenNames.map((n) => n.toLowerCase());
  const flagged = [
    item.contains_dairy && !lower.includes("milk") && "Dairy",
    item.contains_nuts && !lower.some((n) => n.includes("nut")) && "Nuts",
    item.contains_gluten && !lower.includes("gluten") && "Gluten",
  ].filter((v): v is string => Boolean(v));
  const containsList = [...allergenNames, ...flagged];

  return (
    <div className="flex flex-1 flex-col gap-6">
      <Link
        href={`/r/${restaurantSlug}/menu`}
        className="type-label text-muted-foreground hover:text-foreground -ml-1 inline-flex w-fit items-center gap-1 rounded-lg px-1 py-1 transition-colors"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        Menu
      </Link>

      {item.image_url && (
        // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL
        <img
          src={item.image_url}
          alt={item.name}
          width={800}
          height={600}
          fetchPriority="high"
          className="bg-muted aspect-[4/3] w-full rounded-2xl object-cover"
        />
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <h1 className="type-title text-balance">{item.name}</h1>
          <p className="type-price shrink-0 pt-0.5 text-xl">
            {formatPrice(Number(item.price), restaurant.currency)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <DietBadges
            isVegetarian={item.is_vegetarian}
            isVegan={item.is_vegan}
            isSpicy={item.is_spicy}
            spiceLabel={
              item.spice_level ? spiceLevelLabels[item.spice_level] : null
            }
          />
          {item.preparation_time != null && (
            <span className="type-caption text-muted-foreground inline-flex items-center gap-1 font-medium">
              <Clock className="size-3.5" aria-hidden="true" />
              About {item.preparation_time} min
            </span>
          )}
        </div>

        {item.description && (
          <p className="type-body text-muted-foreground text-pretty">
            {item.description}
          </p>
        )}
        {/*
          Sits with the description rather than among the badges: it is a
          sentence in the restaurant's voice, not a data point, and a diner
          deciding whether to order one biryani or two is reading prose at
          this moment, not scanning chips.
        */}
        {item.portion_note && (
          <p className="type-body-sm text-muted-foreground">
            <span className="text-foreground font-medium">Portion: </span>
            {item.portion_note}
          </p>
        )}
      </div>

      {/*
        Only CONFIRMED allergens reach this point — the query above filters
        unconfirmed suggestions out — so this is the restaurant's own
        statement, and AllergenNote words it that way.
      */}
      <section
        aria-labelledby="allergens-heading"
        className="flex flex-col gap-2"
      >
        <h2
          id="allergens-heading"
          className="type-overline text-muted-foreground"
        >
          Allergens
        </h2>
        <AllergenNote allergens={containsList} />
      </section>

      {ingredients && ingredients.length > 0 && (
        <section
          aria-labelledby="ingredients-heading"
          className="flex flex-col gap-2"
        >
          <h2
            id="ingredients-heading"
            className="type-overline text-muted-foreground"
          >
            Ingredients
          </h2>
          <p className="type-body-sm">
            {ingredients.map((i) => i.name).join(", ")}
          </p>
        </section>
      )}

      <AskWaiterButton prompt={`Tell me about the ${item.name}.`}>
        Ask the waiter about this dish
      </AskWaiterButton>

      <ItemDetailForm
        action={addToCart}
        menuItemId={item.id}
        basePrice={Number(item.price)}
        currency={restaurant.currency}
        groups={groups}
        restaurantSlug={restaurantSlug}
        dishSpiceLevel={item.spice_level}
        offerSpiceChoice={
          item.is_spicy ||
          (item.spice_level !== null && item.spice_level !== "none")
        }
        allowNotes={settings.allowCustomerNotes}
      />
    </div>
  );
}
