"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { sendTestPush } from "./dispatch";
import { describeTestResults } from "./dispatch-core";
import { pushConfigured } from "./config";
import { apnsConfig, type NativeTarget } from "./apns";
import { fcmConfig } from "./fcm";
import type { PushTarget } from "./dispatch-core";

/** Either kind of device can be reached: web push, or the iOS app's APNs. */
function anyPushConfigured(): boolean {
  return pushConfigured() || apnsConfig() !== null || fcmConfig() !== null;
}

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
  /** How the calling device is registered, so the answer can say whether it got the test. */
  mine: { nativeToken?: string | null; endpoint?: string | null } = {},
): Promise<
  PushActionResult & { delivered?: number; total?: number; message?: string }
> {
  if (!anyPushConfigured()) {
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
  // The store apps' phones, read the same way: native_push_tokens_select_own.
  const { data: nativeData } = await db
    .from("native_push_tokens")
    .select("id, token, environment, platform")
    .eq("restaurant_id", restaurantId);
  const nativeTargets = (nativeData ?? []) as NativeTarget[];
  if (targets.length + nativeTargets.length === 0) {
    return {
      ok: false,
      error: "Alerts aren't on for any of your devices yet.",
    };
  }
  const { delivered, total, results } = await sendTestPush(
    targets,
    nativeTargets,
  );
  // The tokens and endpoints stay here; the page only learns which result
  // is its own.
  const message = describeTestResults(
    results.map((r) => ({
      kind: r.kind,
      ok: r.ok,
      statusCode: r.statusCode,
      thisDevice:
        (!!mine.nativeToken && r.key === mine.nativeToken) ||
        (!!mine.endpoint && r.key === mine.endpoint),
    })),
  );
  return delivered > 0
    ? { ok: true, delivered, total, message }
    : { ok: false, delivered, total, message, error: message };
}

export type NativePlatform = "ios" | "android";

/** APNs device tokens are hex; FCM registration tokens are not, and are case-sensitive. */
const nativeTokenSchemas = {
  ios: z.string().regex(/^[0-9a-fA-F]{64,200}$/, "Not an APNs device token."),
  android: z
    .string()
    .regex(/^[A-Za-z0-9_:-]{100,4096}$/, "Not an FCM registration token."),
} as const;

/**
 * A store app turning this phone's alerts on: the token it got from
 * registering (APNs on iPhone, FCM on Android), for this restaurant. Any
 * member, like web push; the database checks membership again
 * (save_native_push_token).
 */
export async function saveNativePushToken(
  restaurantId: string,
  token: string,
  platform: NativePlatform = "ios",
): Promise<PushActionResult> {
  const configured = platform === "android" ? fcmConfig() : apnsConfig();
  if (!configured) {
    return { ok: false, error: "Alerts aren't set up for Tableside yet." };
  }
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
    "kitchen",
    "staff",
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const schema = nativeTokenSchemas[platform];
  if (!schema) return { ok: false, error: "Unknown kind of phone." };
  const parsed = schema.safeParse(token);
  if (!parsed.success) {
    return { ok: false, error: "This phone returned an unusable token." };
  }
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as UntypedRpc;
  const { error } = await rpc("save_native_push_token", {
    target_restaurant_id: restaurantId,
    p_token: platform === "ios" ? parsed.data.toLowerCase() : parsed.data,
    p_platform: platform,
  });
  if (error) {
    return { ok: false, error: "Couldn't turn alerts on. Please try again." };
  }
  return { ok: true };
}

/** Turning this phone's alerts off: the caller's own rows only. */
export async function deleteNativePushToken(
  token: string,
): Promise<PushActionResult> {
  await requireUser();
  const parsed = [nativeTokenSchemas.ios, nativeTokenSchemas.android]
    .map((schema) => schema.safeParse(token))
    .find((result) => result.success);
  if (!parsed?.success) return { ok: false, error: "Not a device token." };
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc;
  // The database matches both as given and lower-cased (APNs tokens are
  // stored lower-case, FCM tokens as they are).
  const { error } = await rpc("delete_native_push_token", {
    p_token: parsed.data,
  });
  if (error) return { ok: false, error: "Couldn't turn alerts off." };
  return { ok: true };
}
