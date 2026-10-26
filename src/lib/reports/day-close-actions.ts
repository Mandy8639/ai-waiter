"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";
import { parseCash } from "./day-close-core";

/**
 * Reports → End of day → Close the day. Owners and managers; close_day()
 * checks the role again, works out what the drawer should hold, and
 * freezes the closing report.
 */

export type CloseResult =
  { ok: true; closeId: string } | { ok: false; error: string };

const MESSAGES: Record<string, string> = {
  CLOSE_FORBIDDEN: "Only an owner or manager can close the day.",
  CLOSE_TOO_SOON: "The day was just closed.",
};

export async function closeDay(
  restaurantId: string,
  input: { openingFloat: string; countedCash: string; note: string },
): Promise<CloseResult> {
  if (!z.uuid().safeParse(restaurantId).success)
    return { ok: false, error: "That restaurant wasn't found." };
  const float = parseCash(input.openingFloat || "0");
  const counted = parseCash(input.countedCash);
  if (float === null)
    return { ok: false, error: "Enter the cash the drawer started with." };
  if (counted === null)
    return { ok: false, error: "Enter the cash counted in the drawer." };
  const note = input.note.trim();
  if (note.length > 500)
    return { ok: false, error: "Keep the note under 500 characters." };

  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const { data, error } = await rpc("close_day", {
    p_restaurant_id: restaurantId,
    p_opening_float: float,
    p_counted_cash: counted,
    p_note: note || null,
  });
  if (error) {
    const code = /^(CLOSE_[A-Z_]+):\s*(.*)$/.exec(error.message);
    if (!code) reportError(error, { scope: "reports.close_day" });
    return {
      ok: false,
      error: code
        ? (MESSAGES[code[1]] ??
          code[2].charAt(0).toUpperCase() + code[2].slice(1) + ".")
        : "Couldn't close the day. Try again.",
    };
  }
  revalidatePath("/dashboard/reports/close");
  revalidatePath("/dashboard/reports");
  return { ok: true, closeId: String(data) };
}
