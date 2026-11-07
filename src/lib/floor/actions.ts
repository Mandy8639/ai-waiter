"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { floorErrorMessage, type FloorRow } from "./core";

/**
 * Server actions for the floor view. Thin: the rules live in
 * floor_tables() and clear_floor_table() (20261128090000), tested in
 * tests/integration/db/floor-tables.test.ts, and in ./core.ts.
 *
 * Front of house only, matching the page (nav-items.ts). The database
 * functions themselves accept any member; this narrows who reaches them
 * from here, it isn't the boundary.
 */
const FRONT_OF_HOUSE = ["owner", "manager", "staff"] as const;

/** floor_tables() postdates database.types.ts. */
type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * The floor's facts. Called on first render and again from the browser on
 * every live event, so there is one definition of what the floor shows.
 * Returns null on failure so the screen keeps what it had rather than
 * flashing every table to "free".
 */
export async function loadFloor(
  restaurantId: string,
): Promise<FloorRow[] | null> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    ...FRONT_OF_HOUSE,
  ]);
  if (!auth.ok) return null;

  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as UntypedRpc;
  const { data, error } = await rpc("floor_tables", {
    p_restaurant_id: restaurantId,
  });
  if (error || !Array.isArray(data)) return null;
  return data as FloorRow[];
}

/** "Clear table": the party has left. Changes no order or request. */
export async function clearFloorTable(
  restaurantId: string,
  tableId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    ...FRONT_OF_HOUSE,
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };

  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as UntypedRpc;
  const { error } = await rpc("clear_floor_table", { p_table_id: tableId });
  if (error) return { ok: false, error: floorErrorMessage(error.message) };

  revalidatePath("/dashboard/floor");
  return { ok: true };
}
