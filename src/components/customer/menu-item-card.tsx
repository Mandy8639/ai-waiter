import Link from "next/link";
import { AllergenLine } from "@/components/customer/allergen-note";
import { DietBadges } from "@/components/customer/diet-badges";
import { formatPrice } from "@/lib/format/price";
import { DishPhoto } from "@/components/customer/dish-photo";
import { CARD_SIZES, type DinerImage } from "@/lib/menu-images/resolve";
import type { MenuLanguage } from "@/lib/translations/languages";

export interface MenuItemCardData {
  id: string;
  name: string;
  description: string | null;
  price: number;
  /** Resolved by resolveDinerImage() on the server; null means no photo. */
  image: DinerImage | null;
  isVegetarian: boolean;
  isVegan: boolean;
  isSpicy: boolean;
  isHalal: boolean;
  isKosher: boolean;
  /** Confirmed allergens only — never suggestions. */
  allergens: string[];
  /** Phase K: approved translations in the diner's chosen language, when there are any. */
  translatedName?: string | null;
  translatedDescription?: string | null;
  language?: MenuLanguage | null;
  /** Phase M: confirmed calories per serving, when the restaurant has confirmed them. */
  calories?: number | null;
}

/**
 * One dish in the menu list.
 *
 * Text-first by design: the name leads, the description supports, the
 * price and dietary labels close the card. When the restaurant has a photo
 * it takes the right-hand side at a fixed square, so a menu with some
 * photos and some without still lines up — and a menu with none (most of
 * them, today) never shows a wall of empty placeholders pretending to be
 * food.
 */
export function MenuItemCard({
  item,
  restaurantSlug,
  currency,
  menuIsAllVegetarian = false,
}: {
  item: MenuItemCardData;
  restaurantSlug: string;
  currency: string;
  /** Skip the per-card "Vegetarian" label when the page already says it once. */
  menuIsAllVegetarian?: boolean;
}) {
  return (
    <Link
      href={`/r/${restaurantSlug}/item/${item.id}`}
      className="group bg-card shadow-card focus-visible:ring-ring/50 hover:border-foreground/15 flex gap-4 rounded-xl border p-4 transition-[border-color,background-color] duration-150 focus-visible:ring-3 focus-visible:outline-none"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="type-dish text-foreground group-hover:text-primary transition-colors">
          {item.name}
        </h3>
        {/* The name as written stays first: it's what the kitchen and the
            waiter call it. The translation helps the diner read it. */}
        {item.translatedName && item.translatedName !== item.name && (
          <p
            lang={item.language ?? undefined}
            className="type-body-sm text-foreground/80 -mt-1"
          >
            {item.translatedName}
          </p>
        )}
        {(item.translatedDescription ?? item.description) && (
          <p
            lang={
              item.translatedDescription
                ? (item.language ?? undefined)
                : undefined
            }
            className="type-body-sm text-muted-foreground line-clamp-2"
          >
            {item.translatedDescription ?? item.description}
          </p>
        )}
        {/*
          Shown on the card, not just the item page: someone avoiding an
          allergen is scanning a long menu, and making them open every dish
          to find out is how a mistake happens. Confirmed allergens only.
        */}
        <AllergenLine allergens={item.allergens} language={item.language} />
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <span className="type-price text-foreground text-[0.9375rem]">
            {formatPrice(item.price, currency)}
          </span>
          {item.calories != null && (
            <span className="type-body-sm text-muted-foreground">
              {item.calories} kcal
            </span>
          )}
          <DietBadges
            isVegetarian={item.isVegetarian}
            isVegan={item.isVegan}
            isSpicy={item.isSpicy}
            isHalal={item.isHalal}
            isKosher={item.isKosher}
            hideVegetarian={menuIsAllVegetarian}
            language={item.language}
          />
        </div>
      </div>

      <DishPhoto
        image={item.image}
        alt={item.name}
        sizes={CARD_SIZES}
        className="size-24 shrink-0 self-start rounded-lg sm:size-28"
        caption="short"
        figureClassName="w-24 shrink-0 self-start sm:w-28"
      />
    </Link>
  );
}
