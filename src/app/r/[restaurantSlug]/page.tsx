import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  return {
    title: restaurant
      ? `${restaurant.name} — AI Waiter`
      : "Restaurant not found",
  };
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
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
        <Badge variant="outline">Currently unavailable</Badge>
        <h1 className="text-xl font-semibold tracking-tight">
          {restaurant.name}
        </h1>
        <p className="text-muted-foreground max-w-xs text-sm">
          This restaurant isn&apos;t accepting online browsing or orders right
          now. Please check back later.
        </p>
      </div>
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
      {restaurant.coverImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL, not a static asset
        <img
          src={restaurant.coverImageUrl}
          alt=""
          className="-mx-4 -mt-4 h-40 w-[calc(100%+2rem)] object-cover sm:rounded-b-lg"
        />
      )}

      <div className="flex flex-col gap-2 text-center">
        {restaurant.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL
          <img
            src={restaurant.logoUrl}
            alt={`${restaurant.name} logo`}
            className="mx-auto size-16 rounded-full border object-cover"
          />
        )}
        <h1 className="text-2xl font-semibold tracking-tight">
          {restaurant.name}
        </h1>
        {restaurant.description && (
          <p className="text-muted-foreground text-sm">
            {restaurant.description}
          </p>
        )}
        {(restaurant.address || restaurant.city) && (
          <p className="text-muted-foreground text-xs">
            {[restaurant.address, restaurant.city, restaurant.state]
              .filter(Boolean)
              .join(", ")}
          </p>
        )}
        {restaurant.phone && (
          <p className="text-muted-foreground text-xs">{restaurant.phone}</p>
        )}
      </div>

      <Link
        href={`/r/${restaurantSlug}/menu`}
        className={buttonVariants({ variant: "default" })}
      >
        View full menu
      </Link>

      {categories && categories.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium tracking-tight">Categories</h2>
          <div className="grid grid-cols-2 gap-2">
            {categories.map((category) => (
              <Link
                key={category.id}
                href={`/r/${restaurantSlug}/menu?category=${category.id}`}
              >
                <Card className="hover:bg-secondary/50 transition-colors">
                  <CardContent className="py-4 text-center text-sm font-medium">
                    {category.name}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
