"use server";

import { revalidatePath } from "next/cache";
import {
  authorizeRestaurantAction,
  type AuthorizedContext,
} from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";
import { BUSY_FOR_MINUTES } from "./busy-core";

/**
 * Kitchen busy mode: pause new orders, resume them, or tell diners the
 * kitchen is running behind. Each calls a database function that checks
 * the role itself (owner, manager or kitchen) — see
 * supabase/migrations/20261015090000_kitchen_busy_mode.sql. The check
 * here only saves a round trip.
 */

export interface BusyResult {
  error?: string;
}

const KITCHEN_SIDE = ["owner", "manager", "kitchen"] as const;

async function run(
  restaurantId: string,
  scope: string,
  call: (
    supabase: AuthorizedContext["supabase"],
  ) => PromiseLike<{ error: { message: string } | null }>,
): Promise<BusyResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [...KITCHEN_SIDE]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await call(auth.context.supabase);
  if (error) {
    reportError(error, { scope, extra: { restaurantId } });
    return { error: "Couldn't change that. Please try again." };
  }
  revalidatePath("/dashboard/kitchen");
  return {};
}

/** Pause for `minutes`, or until resumed when null. */
export async function pauseNewOrders(
  restaurantId: string,
  minutes: number | null,
): Promise<BusyResult> {
  return run(restaurantId, "kitchen.busy.pause", (supabase) =>
    supabase.rpc("pause_new_orders", {
      p_restaurant_id: restaurantId,
      p_minutes: minutes,
    }),
  );
}

export async function resumeNewOrders(
  restaurantId: string,
): Promise<BusyResult> {
  return run(restaurantId, "kitchen.busy.resume", (supabase) =>
    supabase.rpc("resume_new_orders", { p_restaurant_id: restaurantId }),
  );
}

/** Tell diners food is taking `extraMinutes` longer for the next hour; 0 clears it. */
export async function setRunningBehind(
  restaurantId: string,
  extraMinutes: number,
): Promise<BusyResult> {
  return run(restaurantId, "kitchen.busy.behind", (supabase) =>
    supabase.rpc("set_kitchen_busy", {
      p_restaurant_id: restaurantId,
      p_extra_minutes: extraMinutes,
      p_for_minutes: BUSY_FOR_MINUTES,
    }),
  );
}
