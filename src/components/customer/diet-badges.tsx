import { Flame, Leaf, Sprout } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The restaurant's own dietary flags for a dish, as quiet inline labels.
 *
 * Only flags a restaurant sets directly. Nothing here is derived from
 * missing allergen data — see src/lib/menu/diet-filters.ts for why
 * "dairy-free" and friends are never shown.
 *
 * halal, kosher and high-protein appear as plain words with no icon. Every
 * icon that fits would overclaim: a tick or a badge reads as "verified",
 * and this software verifies nothing — the restaurant is the one asserting
 * it. On the dish page the claim is written out in full and attributed by
 * name (see claimSentence); here, where a card has room for two words, the
 * word alone is the most that can honestly be said.
 */
export function DietBadges({
  isVegetarian,
  isVegan,
  isSpicy,
  isHalal = false,
  isKosher = false,
  isHighProtein = false,
  spiceLabel,
  hideVegetarian = false,
  className,
}: {
  /** True when the whole menu is vegetarian and says so once, above it. */
  hideVegetarian?: boolean;
  isVegetarian: boolean;
  isVegan: boolean;
  isSpicy: boolean;
  isHalal?: boolean;
  isKosher?: boolean;
  isHighProtein?: boolean;
  /** A specific heat ("Medium", "Hot") when known; otherwise "Spicy". */
  spiceLabel?: string | null;
  className?: string;
}) {
  const showVegetarian = isVegetarian && !hideVegetarian;
  const claims = [
    isHalal && "Halal",
    isKosher && "Kosher",
    isHighProtein && "High protein",
  ].filter((c): c is string => Boolean(c));
  if (!showVegetarian && !isVegan && !isSpicy && claims.length === 0) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex flex-wrap items-center gap-x-2.5 gap-y-1",
        className,
      )}
    >
      {isVegan ? (
        <span className="text-success type-caption inline-flex items-center gap-1 font-medium">
          <Sprout className="size-3.5" aria-hidden="true" />
          Vegan
        </span>
      ) : (
        showVegetarian && (
          <span className="text-success type-caption inline-flex items-center gap-1 font-medium">
            <Leaf className="size-3.5" aria-hidden="true" />
            Vegetarian
          </span>
        )
      )}
      {isSpicy && (
        <span className="text-spice type-caption inline-flex items-center gap-1 font-medium">
          <Flame className="size-3.5" aria-hidden="true" />
          {spiceLabel ?? "Spicy"}
        </span>
      )}
      {claims.map((claim) => (
        <span key={claim} className="text-muted-foreground type-caption">
          {claim}
        </span>
      ))}
    </span>
  );
}
