import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { ReserveForm } from "@/components/customer/reserve-form";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import { createClient } from "@/lib/supabase/server";
import { requestReservation } from "@/lib/reservations/request-actions";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { restaurantShareImage } from "@/lib/seo/restaurant";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  if (!restaurant) return { title: "Book a table" };
  return publicPageMetadata({
    title: `Book a table — ${restaurant.name}`,
    description: `Ask ${restaurant.name} for a table: choose a day, a time and how many people, and the restaurant confirms.`,
    path: `/r/${restaurant.slug}/reserve`,
    image: restaurantShareImage(restaurant),
  });
}

/**
 * Requesting a table.
 *
 * Unlike every other customer page this one does NOT require an active
 * session: a diner booking for Friday is at home, not at a table, and has
 * scanned nothing. Identity is established by the server action when they
 * submit — see src/lib/reservations/request-actions.ts.
 *
 * An inactive restaurant is a 404 rather than a form that would take a
 * booking nobody is reading.
 */
export default async function ReservePage({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);

  if (!restaurant || !restaurant.isActive) {
    notFound();
  }

  // The timezone is not part of PublicRestaurant, and it matters here: the
  // diner is typing the restaurant's wall clock, which may not be their
  // own.
  const supabase = await createClient();
  const { data: row } = await supabase
    .from("restaurants")
    .select("timezone")
    .eq("id", restaurant.id)
    .maybeSingle();

  const action = requestReservation.bind(null, restaurant.id, restaurant.slug);

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Book a table</h1>
        <p className="text-muted-foreground text-sm">
          Tell {restaurant.name} when you&apos;d like to come in.
        </p>
      </div>

      <ReserveForm
        action={action}
        restaurantName={restaurant.name}
        timeZone={row?.timezone ?? "UTC"}
      />

      {/* A phone number is the escape hatch for everything this form
          refuses — a party of sixty, tonight in ten minutes, a date next
          year. Worth showing when the restaurant has one. */}
      {restaurant.phone && (
        <p className="text-muted-foreground text-center text-sm">
          Or call them on{" "}
          <a href={`tel:${restaurant.phone}`} className="underline">
            {restaurant.phone}
          </a>
          .
        </p>
      )}

      <Link
        href={`/r/${restaurantSlug}`}
        className={buttonVariants({ variant: "ghost" })}
      >
        Back to {restaurant.name}
      </Link>
    </div>
  );
}
