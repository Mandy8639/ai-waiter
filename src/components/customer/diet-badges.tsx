import { Flame, Leaf, Sprout } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The restaurant's own dietary flags for a dish, as quiet inline labels.
 *
 * Only the three flags a restaurant sets directly. Nothing here is derived
 * from missing allergen data — see src/lib/menu/diet-filters.ts for why
 * "dairy-free" and friends are never shown.
 */
export function DietBadges({
  isVegetarian,
  isVegan,
  isSpicy,
  spiceLabel,
  hideVegetarian = false,
  className,
}: {
  /** True when the whole menu is vegetarian and says so once, above it. */
  hideVegetarian?: boolean;
  isVegetarian: boolean;
  isVegan: boolean;
  isSpicy: boolean;
  /** A specific heat ("Medium", "Hot") when known; otherwise "Spicy". */
  spiceLabel?: string | null;
  className?: string;
}) {
  const showVegetarian = isVegetarian && !hideVegetarian;
  if (!showVegetarian && !isVegan && !isSpicy) return null;

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
    </span>
  );
}
