import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getLineMenuInfo } from "@/lib/cart/get-cart";
import { parseGroupState, type GroupLine, type TableGroupState } from "./core";

/** The table group functions postdate database.types.ts. */
type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function rpc() {
  const supabase = await createClient();
  return {
    supabase,
    call: supabase.rpc.bind(supabase) as unknown as UntypedRpc,
  };
}

/** Whether the caller is in a shared order, could join one, or neither. */
export async function getTableGroupState(): Promise<TableGroupState> {
  const { call } = await rpc();
  const { data, error } = await call("table_group_state");
  if (error) return { kind: "none" };
  return parseGroupState(data);
}

/**
 * Every member's lines, named and checked against the menu as it is now,
 * like the diner's own cart (getCart). Empty for anyone not in a live group.
 */
export async function getTableGroupLines(
  restaurantId: string,
): Promise<GroupLine[]> {
  const { supabase, call } = await rpc();
  const { data, error } = await call("table_group_cart");
  if (error || !Array.isArray(data)) return [];

  const rows = data as {
    cart_item_id: string;
    member_position: number;
    is_mine: boolean;
    menu_item_id: string;
    quantity: number;
    line_total: number | string;
    spice_preference: string | null;
    notes: string | null;
    modifiers: { name?: unknown }[] | null;
  }[];
  const info = await getLineMenuInfo(
    restaurantId,
    rows.map((r) => r.menu_item_id),
    supabase,
  );

  return rows.map((r) => {
    const menu = info.get(r.menu_item_id);
    return {
      id: r.cart_item_id,
      memberPosition: r.member_position,
      isMine: r.is_mine,
      menuItemId: r.menu_item_id,
      name: menu?.name ?? "Item no longer available",
      quantity: r.quantity,
      lineTotal: Number(r.line_total),
      modifiers: (r.modifiers ?? [])
        .map((m) => (typeof m?.name === "string" ? m.name : null))
        .filter((n): n is string => n !== null),
      spicePreference: r.spice_preference,
      notes: r.notes,
      stillAvailable: menu?.stillAvailable ?? false,
    };
  });
}
