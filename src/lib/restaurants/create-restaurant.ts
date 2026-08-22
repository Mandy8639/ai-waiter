import "server-only";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The only application-layer entry point for creating a restaurant.
 *
 * This is a thin wrapper around the `create_restaurant` Postgres function
 * (see supabase/migrations/20260821131500_create_restaurant_function.sql) —
 * validation happens here, authorization and the actual writes happen in
 * the database function. Uses the per-request server client (not the admin
 * client), so the RPC call runs as the signed-in user and `auth.uid()`
 * inside the function resolves to them, not to some server-chosen value.
 *
 * There is deliberately no `role` parameter: the database function always
 * makes the caller the owner. A client cannot request a different role for
 * itself through this path or any other.
 */
export const createRestaurantInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'slug must be lowercase kebab-case (e.g. "my-restaurant")',
    ),
  description: z.string().trim().max(2000).optional(),
  timezone: z.string().trim().min(1).optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter code (e.g. "USD")')
    .optional(),
});

export type CreateRestaurantInput = z.input<typeof createRestaurantInputSchema>;
export type Restaurant = Database["public"]["Tables"]["restaurants"]["Row"];

export async function createRestaurant(
  input: CreateRestaurantInput,
): Promise<Restaurant> {
  const parsed = createRestaurantInputSchema.parse(input);
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("create_restaurant", {
    p_name: parsed.name,
    p_slug: parsed.slug,
    p_description: parsed.description ?? null,
    p_timezone: parsed.timezone ?? null,
    p_currency: parsed.currency ?? null,
  });

  if (error) {
    throw new Error(`Failed to create restaurant: ${error.message}`);
  }

  return data;
}
