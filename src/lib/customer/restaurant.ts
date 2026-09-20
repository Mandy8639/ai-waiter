import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export interface PublicRestaurant {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  coverImageUrl: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  /** ISO 4217 code every diner-facing price is shown in — see src/lib/format/price.ts. */
  currency: string;
  isActive: boolean;
}

/**
 * cache()-wrapped so every customer page for this restaurant (layout +
 * page, both rendering in the same request) shares one query instead of
 * fetching the restaurant twice.
 */
export const getPublicRestaurantBySlug = cache(
  async (slug: string): Promise<PublicRestaurant | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("restaurants")
      .select(
        "id, name, slug, description, logo_url, cover_image_url, phone, address, city, state, currency, is_active",
      )
      .eq("slug", slug)
      .maybeSingle();

    if (!data) return null;

    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      description: data.description,
      logoUrl: data.logo_url,
      coverImageUrl: data.cover_image_url,
      phone: data.phone,
      address: data.address,
      city: data.city,
      state: data.state,
      currency: data.currency,
      isActive: data.is_active,
    };
  },
);

export interface PublicOrderSettings {
  acceptingOrders: boolean;
  allowCustomerNotes: boolean;
  allowAiRecommendations: boolean;
  allowUpselling: boolean;
}

/**
 * The order/AI-related settings the cart page and AI waiter need, via
 * get_public_order_settings() — never a direct read of restaurant_settings,
 * which has no public SELECT policy (see the migration's comment).
 * Defaults to everything off if the restaurant has no settings row at all
 * (shouldn't happen — create_restaurant() always creates one — but failing
 * closed here is cheap insurance, and specifically means a restaurant that
 * hasn't opted in never gets an AI waiter it didn't ask for).
 */
export const getPublicOrderSettings = cache(
  async (restaurantId: string): Promise<PublicOrderSettings> => {
    const supabase = await createClient();
    const { data } = await supabase
      .rpc("get_public_order_settings", { target_restaurant_id: restaurantId })
      .maybeSingle();

    return {
      acceptingOrders: data?.accepting_orders ?? false,
      allowCustomerNotes: data?.allow_customer_notes ?? false,
      allowAiRecommendations: data?.allow_ai_recommendations ?? false,
      allowUpselling: data?.allow_upselling ?? false,
    };
  },
);
