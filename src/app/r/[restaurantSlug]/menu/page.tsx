import Link from "next/link";
import { notFound } from "next/navigation";
import { HeroVideo } from "@/components/customer/hero-video";
import { resolveHeroVideo } from "@/lib/hero-video/resolve";
import { Flame, Leaf, Search, SearchX, Sprout, Wind, X } from "lucide-react";
import {
  AskWaiterButton,
  AskWaiterCard,
} from "@/components/customer/ask-waiter-card";
import { FilterChip } from "@/components/customer/filter-chip";
import {
  MenuItemCard,
  type MenuItemCardData,
} from "@/components/customer/menu-item-card";
import { RestaurantHero } from "@/components/customer/restaurant-hero";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { resolveDinerImage } from "@/lib/menu-images/resolve";
import {
  asRowsWithNewColumns,
  type DietFlagRow,
  type MenuListRow,
} from "@/lib/menu-images/menu-item-rows";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import { MenuLanguagePicker } from "@/components/customer/menu-language-picker";
import { getDinerTranslations } from "@/lib/translations/queries";
import { getPublicMenus } from "@/lib/menus/queries";
import { hoursLabel, onNowFilter } from "@/lib/menus/core";
import {
  availableDietFilters,
  menuHref,
  parseDietFilters,
  toggleDietFilter,
  type DietFilterKey,
} from "@/lib/menu/diet-filters";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  return { title: restaurant ? `Menu — ${restaurant.name}` : "Menu" };
}

/**
 * halal and kosher are deliberately text-only.
 *
 * Every candidate icon makes a claim the chip should not: a check or
 * badge reads as "verified by this app", and we verify nothing — the
 * restaurant is the one asserting it. A religious symbol would be worse
 * still. Plain words say exactly as much as we know.
 */
const DIET_ICONS: Record<DietFilterKey, React.ReactNode> = {
  vegetarian: <Leaf className="size-3.5" aria-hidden="true" />,
  vegan: <Sprout className="size-3.5" aria-hidden="true" />,
  halal: null,
  kosher: null,
  spicy: <Flame className="size-3.5" aria-hidden="true" />,
  mild: <Wind className="size-3.5" aria-hidden="true" />,
};

export default async function MenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ restaurantSlug: string }>;
  searchParams: Promise<{
    category?: string;
    q?: string;
    diet?: string | string[];
  }>;
}) {
  const { restaurantSlug } = await params;
  const { category: categoryId, q, diet: dietParam } = await searchParams;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);

  if (!restaurant || !restaurant.isActive) {
    notFound();
  }

  // Null for almost every restaurant; a menu without a video is the menu.
  const heroVideo = resolveHeroVideo({
    activeHeroVideoId: restaurant.activeHeroVideoId,
    heroVideo: restaurant.heroVideo,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
  });

  const search = q?.trim() ?? "";
  const diet = parseDietFilters(dietParam);
  const supabase = await createClient();
  // Phase K: approved translations in the diner's language, if any.
  const translations = await getDinerTranslations(restaurant.id);

  let itemsQuery = supabase
    .from("menu_items")
    .select(
      "id, name, description, price, image_url, active_image_id, image_source, image_variants, is_vegetarian, is_vegan, is_spicy, is_halal, is_kosher, category_id",
    )
    .eq("restaurant_id", restaurant.id)
    .order("display_order", { ascending: true })
    .limit(500);

  if (categoryId) {
    itemsQuery = itemsQuery.eq("category_id", categoryId);
  }
  if (search) {
    // Deterministic name/description search — no AI, no embeddings, just a
    // plain ILIKE (see spec's "menu search" requirement).
    const escaped = search.replace(/[%_]/g, (match) => `\\${match}`);
    itemsQuery = itemsQuery.or(
      `name.ilike.%${escaped}%,description.ilike.%${escaped}%`,
    );
  }
  // Mirrors matchesDietFilter() in src/lib/menu/diet-filters.ts, in SQL.
  for (const key of diet) {
    if (key === "vegetarian") {
      itemsQuery = itemsQuery.or("is_vegetarian.eq.true,is_vegan.eq.true");
    } else if (key === "vegan") {
      itemsQuery = itemsQuery.eq("is_vegan", true);
    } else if (key === "spicy") {
      itemsQuery = itemsQuery.eq("is_spicy", true);
    } else if (key === "mild") {
      itemsQuery = itemsQuery.eq("is_spicy", false);
    }
  }

  // Independent queries — run concurrently (Batch 8 performance audit).
  // The flags query reads three booleans for the whole menu so the page
  // only offers dietary filters that would actually narrow it.
  const [
    { data: allCategories },
    { data: menuItems },
    { data: flagRows },
    menusResult,
  ] = await Promise.all([
    supabase
      .from("categories")
      .select("id, name")
      .eq("restaurant_id", restaurant.id)
      .order("display_order", { ascending: true }),
    itemsQuery,
    // Same untyped-column problem as the list query above: the dietary
    // claim columns postdate database.types.ts.
    (
      supabase.from("menu_items") as unknown as {
        select: (columns: string) => {
          eq: (
            column: string,
            value: string,
          ) => { limit: (n: number) => Promise<{ data: unknown }> };
        };
      }
    )
      .select("is_vegetarian, is_vegan, is_spicy, is_halal, is_kosher")
      .eq("restaurant_id", restaurant.id)
      .limit(500),
    // Phase L: which menus are on right now (decided in the database,
    // in the restaurant's timezone).
    getPublicMenus(restaurant.id, supabase),
  ]);

  // Only sections on a menu that's on now. Null means the lookup failed:
  // show everything rather than an empty menu — ordering is enforced in
  // the database either way.
  const onNow = onNowFilter(menusResult);
  const menus = menusResult ?? [];
  const categories = (allCategories ?? []).filter(
    (c) => !onNow || onNow.has(c.id),
  );
  const nothingServedNow = onNow !== null && onNow.size === 0;

  // database.types.ts predates phase 1, so the generated client cannot
  // describe the image columns. Asserted once here against the migration;
  // see src/lib/menu-images/menu-item-rows.ts.
  const itemRows = asRowsWithNewColumns<MenuListRow>(menuItems).filter(
    (item) => !onNow || onNow.has(item.category_id),
  );

  const flags = asRowsWithNewColumns<DietFlagRow>(flagRows).map((row) => ({
    isVegetarian: row.is_vegetarian,
    isVegan: row.is_vegan,
    isSpicy: row.is_spicy,
    isHalal: row.is_halal,
    isKosher: row.is_kosher,
  }));
  const dietChoices = availableDietFilters(flags);
  // Said once, in the restaurant's own terms (its flags), instead of a
  // "Vegetarian" label repeated on every one of a hundred-odd cards.
  const menuIsAllVegetarian =
    flags.length > 0 && flags.every((f) => f.isVegetarian || f.isVegan);

  // Confirmed allergens for everything on this page, in two queries rather
  // than one per dish. RLS already restricts these rows to this restaurant;
  // `confirmed_at is not null` is what keeps unconfirmed SUGGESTIONS away
  // from diners — see 20260904140000_allergen_confirmation.sql.
  const itemIds = itemRows.map((item) => item.id);
  const allergensByItem = new Map<string, string[]>();

  if (itemIds.length > 0) {
    const { data: links } = await supabase
      .from("menu_item_allergens")
      .select("menu_item_id, allergen_id")
      .in("menu_item_id", itemIds)
      .not("confirmed_at", "is", null);

    const allergenIds = [...new Set((links ?? []).map((l) => l.allergen_id))];
    const { data: allergenRows } = allergenIds.length
      ? await supabase
          .from("allergens")
          .select("id, name")
          .in("id", allergenIds)
      : { data: [] as { id: string; name: string }[] };

    const nameById = new Map((allergenRows ?? []).map((a) => [a.id, a.name]));
    for (const link of links ?? []) {
      const name = nameById.get(link.allergen_id);
      if (!name) continue;
      const current = allergensByItem.get(link.menu_item_id) ?? [];
      current.push(name);
      allergensByItem.set(link.menu_item_id, current);
    }
  }

  const cards: Array<MenuItemCardData & { categoryId: string }> = itemRows.map(
    (item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      price: Number(item.price),
      image: resolveDinerImage({
        activeImageId: item.active_image_id,
        imageSource: item.image_source,
        imageVariants: item.image_variants,
        legacyImageUrl: item.image_url,
        supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
      }),
      isVegetarian: item.is_vegetarian,
      isVegan: item.is_vegan,
      isSpicy: item.is_spicy,
      isHalal: item.is_halal,
      isKosher: item.is_kosher,
      allergens: allergensByItem.get(item.id) ?? [],
      categoryId: item.category_id,
      translatedName: translations.dishName(item.id),
      translatedDescription: translations.dishDescription(item.id),
      language: translations.language,
    }),
  );

  const isFiltered = Boolean(categoryId || search || diet.length > 0);
  const activeCategory = categories?.find((c) => c.id === categoryId);

  // Browsing the whole menu: group by the restaurant's own categories, in
  // its own order, so the page reads like a menu rather than a feed. A
  // search or a single category is shown as one list.
  const knownCategoryIds = new Set((categories ?? []).map((c) => c.id));
  const uncategorised = cards.filter(
    (card) => !knownCategoryIds.has(card.categoryId),
  );
  const sections =
    !categoryId && !search
      ? [
          ...(categories ?? []).map((category) => ({
            id: category.id,
            name: translations.categoryName(category.id) ?? category.name,
            items: cards.filter((card) => card.categoryId === category.id),
          })),
          // Never silently drop a dish the flat list used to show: anything
          // whose category this page can't see still gets listed.
          { id: "more", name: "More dishes", items: uncategorised },
        ].filter((section) => section.items.length > 0)
      : [
          {
            id: "results",
            name: activeCategory
              ? (translations.categoryName(activeCategory.id) ??
                activeCategory.name)
              : "",
            items: cards,
          },
        ];

  const currentParams = { category: categoryId, q: search, diet };

  return (
    <div className="flex flex-1 flex-col gap-6">
      {!isFiltered ? (
        <>
          {heroVideo && (
            <HeroVideo video={heroVideo} restaurantName={restaurant.name} />
          )}
          <RestaurantHero restaurant={restaurant} eyebrow="Menu" />
          {menus.length > 1 && (
            <p className="type-body-sm text-muted-foreground -mt-2">
              {menus
                .filter((m) => m.onNow)
                .map((m) => m.name)
                .join(" · ") || "Nothing is being served right now"}
              {menus.some((m) => !m.onNow) && (
                <>
                  {" — "}
                  {menus
                    .filter((m) => !m.onNow)
                    .map((m) => `${m.name}: ${hoursLabel(m.hours)}`)
                    .join(" · ")}
                </>
              )}
            </p>
          )}
          {menuIsAllVegetarian && (
            <p className="type-label text-success -mt-2 inline-flex items-center gap-1.5">
              <Leaf className="size-4" aria-hidden="true" />
              Everything on this menu is vegetarian
            </p>
          )}
          <AskWaiterCard />
        </>
      ) : (
        <h1 className="sr-only">{restaurant.name} menu</h1>
      )}

      <div className="flex flex-col gap-3">
        <MenuLanguagePicker
          current={translations.language}
          available={translations.available}
        />
        <form
          role="search"
          action={`/r/${restaurantSlug}/menu`}
          method="get"
          className="relative"
        >
          {categoryId && (
            <input type="hidden" name="category" value={categoryId} />
          )}
          {diet.length > 0 && (
            <input type="hidden" name="diet" value={diet.join(",")} />
          )}
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <label htmlFor="menu-search" className="sr-only">
            Search the menu
          </label>
          <input
            id="menu-search"
            type="search"
            name="q"
            defaultValue={search}
            placeholder="Search dishes or ingredients"
            enterKeyHint="search"
            autoComplete="off"
            className="bg-card placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/40 type-body shadow-card h-11 w-full rounded-xl border pr-11 pl-10 transition-colors focus-visible:ring-3 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {search ? (
            <Link
              href={menuHref(restaurantSlug, { ...currentParams, q: null })}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg transition-colors"
            >
              <X className="size-4" aria-hidden="true" />
            </Link>
          ) : (
            <button type="submit" className="sr-only">
              Search
            </button>
          )}
        </form>

        {dietChoices.length > 0 && (
          <nav aria-label="Dietary filters" className="flex flex-wrap gap-2">
            {dietChoices.map((choice) => (
              <FilterChip
                key={choice.key}
                href={menuHref(restaurantSlug, {
                  ...currentParams,
                  diet: toggleDietFilter(diet, choice.key),
                })}
                active={diet.includes(choice.key)}
                icon={DIET_ICONS[choice.key]}
              >
                {choice.label}
              </FilterChip>
            ))}
          </nav>
        )}
      </div>

      {categories && categories.length > 0 && (
        <div className="bg-background/90 supports-backdrop-filter:bg-background/80 sticky top-14 z-10 -mx-4 border-b px-4 py-2.5 backdrop-blur-md sm:-mx-6 sm:px-6">
          <nav
            aria-label="Menu categories"
            className="-mx-4 flex scrollbar-none gap-2 overflow-x-auto px-4 sm:-mx-6 sm:px-6"
          >
            <FilterChip
              href={menuHref(restaurantSlug, {
                ...currentParams,
                category: null,
              })}
              active={!categoryId}
              scroll
            >
              All
            </FilterChip>
            {categories.map((category) => (
              <FilterChip
                key={category.id}
                href={menuHref(restaurantSlug, {
                  ...currentParams,
                  category: category.id,
                })}
                active={categoryId === category.id}
                scroll
              >
                {translations.categoryName(category.id) ?? category.name}
              </FilterChip>
            ))}
          </nav>
        </div>
      )}

      {isFiltered && cards.length > 0 && (
        <div className="flex items-baseline justify-between gap-3">
          <p className="type-body-sm text-muted-foreground" aria-live="polite">
            {search ? (
              <>
                {cards.length} {cards.length === 1 ? "dish" : "dishes"} for{" "}
                <span className="text-foreground font-medium">
                  &ldquo;{search}&rdquo;
                </span>
              </>
            ) : (
              <>
                {cards.length} {cards.length === 1 ? "dish" : "dishes"}
              </>
            )}
          </p>
          <Link
            href={menuHref(restaurantSlug, {})}
            className="type-label text-primary shrink-0 hover:underline"
          >
            Clear all
          </Link>
        </div>
      )}

      {cards.length === 0 ? (
        <EmptyState
          icon={<SearchX />}
          title={
            nothingServedNow
              ? "Nothing is being served right now"
              : search
                ? `Nothing matches “${search}”`
                : "No dishes here"
          }
          description={
            nothingServedNow
              ? menus
                  .map((m) => `${m.name}: ${hoursLabel(m.hours)}`)
                  .join(" · ")
              : isFiltered
                ? "Try a different word, or clear the filters to see the whole menu."
                : "This restaurant hasn't added any dishes yet."
          }
        >
          {isFiltered && (
            <Link
              href={menuHref(restaurantSlug, {})}
              className={buttonVariants({ variant: "outline", size: "lg" })}
            >
              See the whole menu
            </Link>
          )}
          {search && (
            <AskWaiterButton prompt={`Do you have anything like ${search}?`}>
              Ask the waiter
            </AskWaiterButton>
          )}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-8">
          {sections.map((section) => (
            <section
              key={section.id}
              aria-labelledby={
                section.name ? `section-${section.id}` : undefined
              }
              aria-label={section.name ? undefined : "Menu results"}
              className="flex scroll-mt-32 flex-col gap-3"
            >
              {section.name && (
                <h2
                  id={`section-${section.id}`}
                  className="type-heading flex items-baseline justify-between gap-3"
                >
                  {section.name}
                  <span className="type-caption text-muted-foreground font-normal">
                    {section.items.length}
                  </span>
                </h2>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                {section.items.map((item) => (
                  <MenuItemCard
                    key={item.id}
                    restaurantSlug={restaurantSlug}
                    currency={restaurant.currency}
                    menuIsAllVegetarian={menuIsAllVegetarian}
                    item={item}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
