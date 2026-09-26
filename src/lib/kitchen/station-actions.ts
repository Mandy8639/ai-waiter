"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";

/**
 * Kitchen stations (phase I). Everything runs as the signed-in member
 * through the RLS-respecting client: kitchen_stations' policies let owners
 * and managers write, and set_order_station_done() checks the kitchen
 * roles itself. database.types.ts predates 20261001090000, hence the
 * untyped handles.
 */

type Untyped = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ error: { message: string; code?: string } | null }>;
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => Promise<{
      error: { message: string; code?: string } | null;
    }>;
    update: (row: Record<string, unknown>) => {
      eq: (
        column: string,
        value: string,
      ) => {
        eq: (
          column: string,
          value: string,
        ) => Promise<{ error: { message: string; code?: string } | null }>;
      };
    };
    delete: () => {
      eq: (
        column: string,
        value: string,
      ) => {
        eq: (
          column: string,
          value: string,
        ) => Promise<{ error: { message: string; code?: string } | null }>;
      };
    };
  };
};

export interface StationActionResult {
  error?: string;
}

const uuid = z.uuid();

/** A station marks its part of an order done, or undoes it. Never changes the order's status. */
export async function setStationDone(
  orderId: string,
  stationId: string,
  done: boolean,
): Promise<StationActionResult> {
  await requireUser();
  if (!uuid.safeParse(orderId).success || !uuid.safeParse(stationId).success) {
    return { error: "That order or station no longer exists." };
  }
  const supabase = (await createClient()) as unknown as Untyped;
  const { error } = await supabase.rpc("set_order_station_done", {
    p_order_id: orderId,
    p_station_id: stationId,
    p_done: done,
  });
  if (error) {
    if (error.message.includes("STATION_FORBIDDEN")) {
      return { error: "Only the kitchen, a manager or the owner can do that." };
    }
    if (error.message.includes("STATION_ORDER_NOT_ACTIVE")) {
      return { error: "Accept the order first." };
    }
    return { error: "Couldn't update the station. Please try again." };
  }
  revalidatePath("/dashboard/kitchen");
  return {};
}

const nameSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Give the station a name.")
      .max(40, "Keep it to 40 characters."),
  );

function friendly(error: { message: string; code?: string }): string {
  if (error.code === "23505" || error.message.includes("name_unique")) {
    return "There's already a station with that name.";
  }
  return "Couldn't save. Please try again.";
}

export async function createStation(
  restaurantId: string,
  name: string,
): Promise<StationActionResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = auth.context.supabase as unknown as Untyped;
  const { error } = await supabase
    .from("kitchen_stations")
    .insert({ restaurant_id: restaurantId, name: parsed.data });
  if (error) return { error: friendly(error) };
  revalidatePath("/dashboard/kitchen/stations");
  revalidatePath("/dashboard/kitchen");
  return {};
}

export async function renameStation(
  restaurantId: string,
  stationId: string,
  name: string,
): Promise<StationActionResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };
  if (!uuid.safeParse(stationId).success)
    return { error: "Station not found." };
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = auth.context.supabase as unknown as Untyped;
  const { error } = await supabase
    .from("kitchen_stations")
    .update({ name: parsed.data })
    .eq("id", stationId)
    .eq("restaurant_id", restaurantId);
  if (error) return { error: friendly(error) };
  revalidatePath("/dashboard/kitchen/stations");
  revalidatePath("/dashboard/kitchen");
  return {};
}

/** Its dishes and open lines become unassigned (shown on every station); nothing is deleted with it. */
export async function deleteStation(
  restaurantId: string,
  stationId: string,
): Promise<StationActionResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };
  if (!uuid.safeParse(stationId).success)
    return { error: "Station not found." };

  const supabase = auth.context.supabase as unknown as Untyped;
  const { error } = await supabase
    .from("kitchen_stations")
    .delete()
    .eq("id", stationId)
    .eq("restaurant_id", restaurantId);
  if (error) return { error: friendly(error) };
  revalidatePath("/dashboard/kitchen/stations");
  revalidatePath("/dashboard/kitchen");
  return {};
}

/** Send a dish to a station, or to none. Takes effect for orders placed from now on. */
export async function assignDishStation(
  restaurantId: string,
  menuItemId: string,
  stationId: string | null,
): Promise<StationActionResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };
  if (!uuid.safeParse(menuItemId).success) return { error: "Dish not found." };
  if (stationId !== null && !uuid.safeParse(stationId).success) {
    return { error: "Station not found." };
  }

  const supabase = auth.context.supabase as unknown as Untyped;
  const { error } = await supabase
    .from("menu_items")
    .update({ station_id: stationId })
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurantId);
  if (error) return { error: "Couldn't save. Please try again." };
  revalidatePath("/dashboard/kitchen/stations");
  return {};
}
