import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Clock } from "lucide-react";
import { AllergenNote } from "@/components/customer/allergen-note";
import {
  assertedClaims,
  claimSentence,
  statedAllergens,
} from "@/lib/menu/diet-filters";
import { AskWaiterButton } from "@/components/customer/ask-waiter-card";
import { DietBadges } from "@/components/customer/diet-badges";
import { ItemDetailForm } from "@/components/customer/item-detail-form";
import { formatPrice } from "@/lib/format/price";
import { DishPhoto } from "@/components/customer/dish-photo";
import { DishViewBeacon } from "@/components/customer/dish-view-beacon";
import { getDinerTranslations } from "@/lib/translations/queries";
import { getPublicMenus } from "@/lib/menus/queries";
import { getConfirmedNutrition } from "@/lib/nutrition/queries";
import { nutritionRows } from "@/lib/nutrition/core";
import { menusForCategory, onNowFilter, servedWhen } from "@/lib/menus/core";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { DETAIL_SIZES, resolveDinerImage } from "@/lib/menu-images/resolve";
import type { MenuItemDetailRow } from "@/lib/menu-images/menu-item-rows";
import {
  getPublicRestaurantBySlug,
  getPublicOrderSettings,
} from "@/lib/customer/restaurant";
import { addToCart } from "@/lib/cart/actions";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { restaurantShareImage, trimForSnippet } from "@/lib/seo/restaurant";
import { JsonLd } from "@/components/seo/json-ld";
import { breadcrumbJsonLd } from "@/lib/seo/structured-data";

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
    .select("name, description")
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();
  if (!item) return { title: `Menu item — ${restaurant.name}` };
  return publicPageMetadata({
    title: `${item.name} — ${restaurant.name}`,
    description: item.description?.trim()
      ? trimForSnippet(item.description)
      : `${item.name}, on the menu at ${restaurant.name}.`,
    path: `/r/${restaurant.slug}/item/${id}`,
    image: restaurantShareImage(restaurant),
  });
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

  const { data: itemRow } = await supabase
    .from("menu_items")
    .select(
      "id, name, description, price, image_url, active_image_id, image_source, image_variants, is_vegetarian, is_vegan, is_spicy, is_halal, is_kosher, spice_level, contains_nuts, contains_dairy, contains_gluten, preparation_time, portion_note, spice_level, category_id",
    )
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  if (!itemRow) {
    notFound();
  }

  // database.types.ts predates phase 1, so the generated client cannot
  // describe the image columns and degrades the whole row. Asserted once
  // here against the migration; see src/lib/menu-images/menu-item-rows.ts.
  const item = itemRow as unknown as MenuItemDetailRow;

  // Phase K: approved translations in the diner's language, if any.
  const translations = await getDinerTranslations(restaurant.id);

  // Phase L: is this dish's menu on right now? If not, the page still
  // describes it but says when it's served instead of offering to add it.
  const menusResult = await getPublicMenus(restaurant.id, supabase);
  const onNow = onNowFilter(menusResult);
  const menus = menusResult ?? [];
  const categoryId = (itemRow as unknown as { category_id: string })
    .category_id;
  const servedNow = !onNow || onNow.has(categoryId);
  const servedAt = servedNow
    ? ""
    : servedWhen(menusForCategory(menus, categoryId));
  const translatedName = translations.dishName(item.id);
  // Phase M: confirmed values only — a draft is never shown, even to an
  // owner previewing the page.
  const nutrition =
    (await getConfirmedNutrition([item.id], supabase)).get(item.id) ?? null;
  const translatedDescription = item.description
    ? translations.dishDescription(item.id)
    : null;

  // database.types.ts predates phase 1, so the image columns are asserted
  // against the migration here; see src/lib/menu-images/menu-item-rows.ts.
  const photo = resolveDinerImage({
    activeImageId: item.active_image_id,
    imageSource: item.image_source,
    imageVariants: item.image_variants,
    legacyImageUrl: item.image_url,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
  });

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

  // The confirmed allergens plus the dish's own ticked yes/no boxes, in one
  // "Contains …" line, so the page never says "no allergens listed" while a
  // box says it contains dairy. The AI waiter gets the same list.
  const containsList = statedAllergens(
    (allergens ?? []).map((a) => a.name),
    {
      containsNuts: item.contains_nuts,
      containsDairy: item.contains_dairy,
      containsGluten: item.contains_gluten,
    },
  );
  // Only the claims that were actually asserted; claimSentence returns null
  // for the conventional ones (vegetarian, vegan) that need no attribution.
  const claimSentences = assertedClaims({
    isVegetarian: item.is_vegetarian,
    isVegan: item.is_vegan,
    isSpicy: item.is_spicy,
    isHalal: item.is_halal,
    isKosher: item.is_kosher,
  })
    .map((claim) => claimSentence(claim, restaurant.name))
    .filter((sentence): sentence is string => sentence !== null);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <DishViewBeacon menuItemId={item.id} />
      {/* The trail back to the menu. Looks like a back link; to a screen
          reader and a search engine it is "Menu > this dish" (the dish
          name is the h1 just below, so it isn't shown twice). */}
      <nav aria-label="Breadcrumb">
        <ol className="flex">
          <li>
            <Link
              href={`/r/${restaurantSlug}/menu`}
              className="type-label text-muted-foreground hover:text-foreground -ml-1 inline-flex w-fit items-center gap-1 rounded-lg px-1 py-1 transition-colors"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              Menu
            </Link>
          </li>
          <li className="sr-only" aria-current="page">
            {item.name}
          </li>
        </ol>
      </nav>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Menu", path: `/r/${restaurantSlug}/menu` },
          { name: item.name, path: `/r/${restaurantSlug}/item/${item.id}` },
        ])}
      />

      {/* The one image above the fold, so it loads eagerly. Renders
          nothing at all when the dish has no photo — no reserved box, no
          placeholder, so the page simply starts with the dish name. */}
      <DishPhoto
        image={photo}
        alt={item.name}
        sizes={DETAIL_SIZES}
        priority
        caption="full"
        className="aspect-[4/3] w-full rounded-2xl"
      />

      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="type-title text-balance">{item.name}</h1>
            {translatedName && translatedName !== item.name && (
              <p
                lang={translations.language ?? undefined}
                className="type-body text-foreground/80"
              >
                {translatedName}
              </p>
            )}
          </div>
          <p className="type-price shrink-0 pt-0.5 text-xl">
            {formatPrice(Number(item.price), restaurant.currency)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <DietBadges
            isVegetarian={item.is_vegetarian}
            isVegan={item.is_vegan}
            isSpicy={item.is_spicy}
            isHalal={item.is_halal}
            isKosher={item.is_kosher}
            spiceLabel={
              item.spice_level ? spiceLevelLabels[item.spice_level] : null
            }
            language={translations.language}
          />
          {item.preparation_time != null && (
            <span className="type-caption text-muted-foreground inline-flex items-center gap-1 font-medium">
              <Clock className="size-3.5" aria-hidden="true" />
              About {item.preparation_time} min
            </span>
          )}
        </div>

        {translatedDescription ? (
          // The restaurant's own words stay one tap away: a translation,
          // however reviewed, is not the original.
          <div className="flex flex-col gap-1">
            <p
              lang={translations.language ?? undefined}
              className="type-body text-muted-foreground text-pretty"
            >
              {translatedDescription}
            </p>
            <details className="type-body-sm text-muted-foreground">
              <summary className="w-fit cursor-pointer">
                Show the original
              </summary>
              <p className="mt-1 text-pretty">{item.description}</p>
            </details>
          </div>
        ) : (
          item.description && (
            <p className="type-body text-muted-foreground text-pretty">
              {item.description}
            </p>
          )
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
        Claims the restaurant has made, written out and attributed by name.
        The card shows "Halal" as a word because two words is all a card
        has room for; here there is room for the sentence, and a diner who
        keeps halal deserves to know exactly who is saying it. This app
        verifies none of it.

        Nothing is rendered when a claim is absent. "Not stated" is not
        printed either — a line saying the restaurant has not confirmed
        something invites reading it as a denial, which is the mistake this
        whole feature is built to avoid.
      */}
      {claimSentences.length > 0 && (
        <section
          aria-labelledby="claims-heading"
          className="flex flex-col gap-1"
        >
          <h2
            id="claims-heading"
            className="type-overline text-muted-foreground"
          >
            From the restaurant
          </h2>
          {claimSentences.map((sentence) => (
            <p key={sentence} className="type-body-sm text-muted-foreground">
              {sentence}
            </p>
          ))}
        </section>
      )}

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
        <AllergenNote
          allergens={containsList}
          language={translations.language}
        />
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

      {/*
        Only CONFIRMED numbers reach this point: a person at the restaurant
        checked them. Nothing is shown when there are none — no "0 kcal",
        no estimate.
      */}
      {nutrition && (
        <section
          aria-labelledby="nutrition-heading"
          className="flex flex-col gap-2"
        >
          <h2
            id="nutrition-heading"
            className="type-overline text-muted-foreground"
          >
            Nutrition · per serving
          </h2>
          <dl className="grid grid-cols-4 gap-2">
            {nutritionRows(nutrition).map((r) => (
              <div
                key={r.label}
                className="bg-muted/60 flex flex-col rounded-lg px-2 py-2 text-center"
              >
                <dt className="text-muted-foreground text-[0.6875rem]">
                  {r.label}
                </dt>
                <dd className="type-body-sm font-medium">{r.value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-xs">
            From the restaurant. Approximate — portions and recipes vary.
          </p>
        </section>
      )}

      <AskWaiterButton
        prompt={`Tell me about the ${item.name}.`}
        chefLabel="Ask the Chef about this dish"
      >
        Ask the waiter about this dish
      </AskWaiterButton>

      {!servedNow ? (
        <div
          role="note"
          className="bg-muted/60 type-body-sm flex flex-col gap-1 rounded-xl px-4 py-3"
        >
          <p className="font-medium">Not being served right now</p>
          <p className="text-muted-foreground">
            {servedAt
              ? `It's on ${servedAt}.`
              : "It isn't on a menu that's on at the moment."}
          </p>
        </div>
      ) : (
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
      )}
    </div>
  );
}
