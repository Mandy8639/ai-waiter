import "server-only";
import { createClient } from "@/lib/supabase/server";
import { parsePickupOptions, type PickupOptions } from "./format-core";

type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;

/** database.types.ts predates 20261022090000_pickup_ordering.sql. */
export async function pickupRpc(): Promise<UntypedRpc> {
  const supabase = await createClient();
  return supabase.rpc.bind(supabase) as unknown as UntypedRpc;
}

/**
 * Whether the signed-in diner's visit is at a pickup counter, and if so
 * the open slots and their current choice. A failed read counts as "not a
 * counter": the order trigger still refuses a counter order without a
 * valid time, so the worst a failed read can do is show the wrong form.
 */
export async function getPickupOptions(): Promise<PickupOptions> {
  const rpc = await pickupRpc();
  const { data, error } = await rpc("get_pickup_options");
  return error ? { isCounter: false } : parsePickupOptions(data);
}
