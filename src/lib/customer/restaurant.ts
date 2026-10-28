import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { HeroVideoPointer } from "@/lib/hero-video/resolve";

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
  /**
   * The hero video, denormalised onto restaurants so a diner can read it
   * without access to the members-only lifecycle table. Null for almost
   * every restaurant, which is the normal state of a menu.
   */
  activeHeroVideoId: string | null;
  heroVideo: HeroVideoPointer | null;
  /** QR menu, AI waiter and kitchen only: no booking, no paying in the app (20261125090000). */
  basicMode: boolean;
}

/**
 * cache()-wrapped so every customer page for this restaurant (layout +
 * page, both rendering in the same request) shares one query instead of
 * fetching the restaurant twice.
 */
export const getPublicRestaurantBySlug = cache(
  async (slug: string): Promise<PublicRestaurant | null> => {
    const supabase = await createClient();
    // The hero video columns postdate database.types.ts, so the generated
    // client types reject them by name. Asserted rather than inferred, in
    // one place — the same approach as src/lib/menu-images/menu-item-rows.ts,
    // and deletable once the types are regenerated.
    const from = supabase.from.bind(supabase) as unknown as (table: string) => {
      select: (columns: string) => {
        eq: (
          column: string,
          value: string,
        ) => {
          maybeSingle: () => Promise<{
            data: Record<string, unknown> | null;
            error: { code?: string } | null;
          }>;
        };
      };
    };
    const columns =
      "id, name, slug, description, logo_url, cover_image_url, phone, address, city, state, currency, is_active, active_hero_video_id, hero_video";
    let { data, error } = await from("restaurants")
      .select(`${columns}, basic_mode`)
      .eq("slug", slug)
      .maybeSingle();
    // basic_mode not there yet (the app deployed before its migration,
    // 20261125090000): without this every menu would read "not found".
    if (error?.code === "42703") {
      ({ data, error } = await from("restaurants")
        .select(columns)
        .eq("slug", slug)
        .maybeSingle());
    }

    if (!data) return null;

    return {
      id: data.id as string,
      name: data.name as string,
      slug: data.slug as string,
      description: data.description as string | null,
      logoUrl: data.logo_url as string | null,
      coverImageUrl: data.cover_image_url as string | null,
      phone: data.phone as string | null,
      address: data.address as string | null,
      city: data.city as string | null,
      state: data.state as string | null,
      currency: data.currency as string,
      isActive: data.is_active as boolean,
      activeHeroVideoId: (data.active_hero_video_id as string | null) ?? null,
      heroVideo: (data.hero_video as HeroVideoPointer | null) ?? null,
      basicMode: (data.basic_mode as boolean | undefined) ?? true,
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
