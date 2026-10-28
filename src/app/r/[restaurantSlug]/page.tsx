import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Phone, Store, UtensilsCrossed } from "lucide-react";
import { AskWaiterCard } from "@/components/customer/ask-waiter-card";
import { FilterChip } from "@/components/customer/filter-chip";
import { RestaurantHero } from "@/components/customer/restaurant-hero";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import { publicPageMetadata } from "@/lib/seo/metadata";
import {
  restaurantDescription,
  restaurantShareImage,
} from "@/lib/seo/restaurant";
import { JsonLd } from "@/components/seo/json-ld";
import { restaurantJsonLd } from "@/lib/seo/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  if (!restaurant) return { title: "Restaurant not found" };
  return publicPageMetadata({
    title: `${restaurant.name} — Tableside`,
    description: restaurantDescription(restaurant),
    path: `/r/${restaurant.slug}`,
    image: restaurantShareImage(restaurant),
  });
}

export default async function RestaurantLandingPage({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);

  if (!restaurant) {
    notFound();
  }

  if (!restaurant.isActive) {
    return (
      <EmptyState
        icon={<Store />}
        title={`${restaurant.name} isn't open for orders right now`}
        description="Online browsing and ordering are paused. Please check back later, or ask a member of staff."
      />
    );
  }

  const supabase = await createClient();
  const { data: categories } = await supabase
    .from("categories")
    .select("id, name")
    .eq("restaurant_id", restaurant.id)
    .order("display_order", { ascending: true });

  return (
    <div className="flex flex-1 flex-col gap-6">
      <JsonLd data={restaurantJsonLd(restaurant)} />
      <RestaurantHero restaurant={restaurant} />

      <div className="flex flex-col gap-2.5 sm:flex-row">
        <Link
          href={`/r/${restaurantSlug}/menu`}
          className={cn(buttonVariants({ size: "lg" }), "sm:flex-1")}
        >
          <UtensilsCrossed aria-hidden="true" />
          See the menu
        </Link>
        {/* Secondary to the menu on purpose: most people reaching this page
            scanned a code and are already sitting down. Booking is for the
            ones who are not, and is closed in basic mode. */}
        {!restaurant.basicMode && (
          <Link
            href={`/r/${restaurantSlug}/reserve`}
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "sm:flex-1",
            )}
          >
            <CalendarDays aria-hidden="true" />
            Book a table
          </Link>
        )}
      </div>

      <AskWaiterCard />

      {categories && categories.length > 0 && (
        <section
          aria-labelledby="categories-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="categories-heading" className="type-heading">
            On the menu
          </h2>
          <nav aria-label="Menu categories" className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <FilterChip
                key={category.id}
                href={`/r/${restaurantSlug}/menu?category=${category.id}`}
                active={false}
                scroll
              >
                {category.name}
              </FilterChip>
            ))}
          </nav>
        </section>
      )}

      {restaurant.phone && (
        <p className="type-caption text-muted-foreground inline-flex items-center gap-1.5">
          <Phone className="size-3.5" aria-hidden="true" />
          {restaurant.phone}
        </p>
      )}
    </div>
  );
}
