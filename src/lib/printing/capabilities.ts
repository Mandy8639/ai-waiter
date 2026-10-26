import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface PrintCapabilities {
  kitchen: boolean;
  receipt: boolean;
  drawer: boolean;
}

const NONE: PrintCapabilities = {
  kitchen: false,
  receipt: false,
  drawer: false,
};

/**
 * Which kinds of print job have an active network printer, for showing a
 * print button only where it will print somewhere. Any member may ask
 * (restaurant_print_capabilities()); the printers themselves stay
 * visible to owners and managers only.
 */
export async function getPrintCapabilities(
  restaurantId: string,
): Promise<PrintCapabilities> {
  const supabase = await createClient();
  // 20261112090000 is newer than database.types.ts.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: PrintCapabilities[] | null }>;
  const { data } = await rpc("restaurant_print_capabilities", {
    p_restaurant_id: restaurantId,
  });
  return data?.[0] ?? NONE;
}
