"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getUserRestaurants } from "./get-user-restaurants";
import { CURRENT_RESTAURANT_COOKIE } from "./current-restaurant";

/**
 * Sets which restaurant the dashboard should show. Re-derives the caller's
 * actual memberships and only accepts a restaurantId found there — the
 * cookie can never be used to view a restaurant the user doesn't belong
 * to, even though (belt and suspenders) RLS would refuse the data anyway.
 */
export async function selectRestaurant(formData: FormData): Promise<void> {
  const user = await requireUser();
  const restaurantId = formData.get("restaurantId");

  if (typeof restaurantId !== "string" || restaurantId.length === 0) {
    redirect("/dashboard");
  }

  const restaurants = await getUserRestaurants(user.id);
  const isMember = restaurants.some((r) => r.id === restaurantId);

  if (isMember) {
    const cookieStore = await cookies();
    cookieStore.set(CURRENT_RESTAURANT_COOKIE, restaurantId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  redirect("/dashboard");
}
