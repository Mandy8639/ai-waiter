import { MapPin } from "lucide-react";
import type { PublicRestaurant } from "@/lib/customer/restaurant";

/**
 * Who you are eating with. Shows only what the restaurant entered — cover
 * photo, logo, description, address — and simply omits what it didn't.
 * Nothing here is invented or defaulted: no stock imagery, no ratings.
 */
export function RestaurantHero({
  restaurant,
  eyebrow,
}: {
  restaurant: PublicRestaurant;
  /** A short line above the name, e.g. "Menu". */
  eyebrow?: string;
}) {
  const place = [restaurant.address, restaurant.city, restaurant.state]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex flex-col gap-4">
      {restaurant.coverImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL
        <img
          src={restaurant.coverImageUrl}
          alt=""
          width={1200}
          height={525}
          fetchPriority="high"
          className="bg-muted aspect-[16/7] w-full rounded-2xl object-cover"
        />
      )}
      <div className="flex items-start gap-3.5">
        {restaurant.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL
          <img
            src={restaurant.logoUrl}
            alt={`${restaurant.name} logo`}
            width={56}
            height={56}
            className="bg-card size-14 shrink-0 rounded-2xl border object-cover"
          />
        )}
        <div className="flex min-w-0 flex-col gap-1.5">
          {eyebrow && <p className="type-overline text-primary">{eyebrow}</p>}
          <h1 className="type-display text-balance">{restaurant.name}</h1>
          {restaurant.description && (
            <p className="type-body text-muted-foreground max-w-prose text-pretty">
              {restaurant.description}
            </p>
          )}
          {place && (
            <p className="type-caption text-muted-foreground inline-flex items-center gap-1">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              {place}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
