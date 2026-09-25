"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { sendTestPush } from "./dispatch";
import { pushConfigured } from "./config";
import type { PushTarget } from "./dispatch-core";

/**
 * What the kitchen page calls to turn this device's alerts on and off
 * (phase F). Everything here runs as the signed-in member through the
 * RLS-respecting client; the service-role sender is not reachable from
 * these actions except through sendTestPush, which is only ever handed the
 * caller's OWN subscriptions, read through their own RLS.
 */

type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

const subscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(1000)
    .refine((value) => value.startsWith("https://"), "Not a push endpoint."),
  keys: z.object({
    p256dh: z.string().min(20).max(200),
    auth: z.string().min(8).max(100),
  }),
});

export interface PushActionResult {
  ok: boolean;
  error?: string;
}

export async function savePushSubscription(
  restaurantId: string,
  subscription: unknown,
): Promise<PushActionResult> {
  if (!pushConfigured()) {
    return { ok: false, error: "Alerts aren't set up for Tableside yet." };
  }

  // Any member — a cook's tablet is who this is for. The database checks
  // membership again (save_push_subscription), this is for the message.
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
    "kitchen",
    "staff",
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = subscriptionSchema.safeParse(subscription);
  if (!parsed.success) {
    return {
      ok: false,
      error: "This browser returned an unusable subscription.",
    };
  }

  const userAgent = (await headers()).get("user-agent")?.slice(0, 300) ?? null;
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as UntypedRpc;
  const { error } = await rpc("save_push_subscription", {
    target_restaurant_id: restaurantId,
    p_endpoint: parsed.data.endpoint,
    p_p256dh: parsed.data.keys.p256dh,
    p_auth: parsed.data.keys.auth,
    p_user_agent: userAgent,
  });
  if (error) {
    return { ok: false, error: "Couldn't turn alerts on. Please try again." };
  }
  return { ok: true };
}

export async function deletePushSubscription(
  endpoint: string,
): Promise<PushActionResult> {
  await requireUser();
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return { ok: false, error: "Not a push endpoint." };
  }
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc;
  // The function deletes only the caller's own rows.
  const { error } = await rpc("delete_push_subscription", {
    p_endpoint: endpoint,
  });
  if (error) return { ok: false, error: "Couldn't turn alerts off." };
  return { ok: true };
}

/**
 * "Send a test" — to every device THIS member has turned alerts on for at
 * this restaurant, and to nobody else's. Read through the member's own
 * client, so push_subscriptions_select_own decides which devices those are.
 */
export async function sendTestPushToMyDevices(
  restaurantId: string,
): Promise<PushActionResult & { delivered?: number; total?: number }> {
  if (!pushConfigured()) {
    return { ok: false, error: "Alerts aren't set up for Tableside yet." };
  }
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
    "kitchen",
    "staff",
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };

  const db = auth.context.supabase as unknown as {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (
          column: string,
          value: string,
        ) => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
  const { data, error } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("restaurant_id", restaurantId);
  if (error) return { ok: false, error: "Couldn't find your devices." };

  const targets = (data ?? []) as PushTarget[];
  if (targets.length === 0) {
    return {
      ok: false,
      error: "Alerts aren't on for any of your devices yet.",
    };
  }
  const { delivered, total } = await sendTestPush(targets);
  return delivered > 0
    ? { ok: true, delivered, total }
    : {
        ok: false,
        delivered,
        total,
        error: "The test didn't reach any device.",
      };
}
