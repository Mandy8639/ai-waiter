import "server-only";
import webpush from "web-push";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  dispatchPush,
  isGoneStatus,
  isSafeNotificationUrl,
  orderPayload,
  orderRingPayload,
  tableRequestPayload,
  type PushEventKind,
  type PushPayload,
  type PushTarget,
  type SendOutcome,
} from "./dispatch-core";
import { pushServerConfig } from "./config";
import { apnsConfig, sendApns, type NativeTarget } from "./apns";
import type { ApnsEnvironment } from "./apns-core";
import { fcmConfig, sendFcm } from "./fcm";

/** The native platforms that can be sent to right now. */
function nativePlatforms(): Array<"ios" | "android"> {
  return [
    ...(apnsConfig() ? (["ios"] as const) : []),
    ...(fcmConfig() ? (["android"] as const) : []),
  ];
}

/**
 * Sends kitchen push notifications (phase F). The I/O half of
 * dispatch-core.ts.
 *
 * WHY THIS USES THE SERVICE-ROLE CLIENT. docs/security.md keeps the admin
 * client out of application code, with named exceptions; this is one, for
 * the reason the Stripe webhook is: there is no signed-in person on whose
 * behalf it acts. The order was placed by a diner, whose session must
 * never read a single push subscription — each one is a credential that can
 * put a notification on a staff device. So the diner's request creates the
 * order as before, through the RLS-respecting client, and this module reads
 * the subscriptions as the system.
 *
 * What keeps that contained:
 *   - Not a server action. This file has no "use server", so nothing here
 *     is callable from a browser. The two entry points take an id that the
 *     CALLER's own server code just got back from the database — never an
 *     id from a request body.
 *   - It reads only what it needs: the one order or request, its table,
 *     and that restaurant's subscriptions. It writes only push_dispatches
 *     and the subscriptions' delivery bookkeeping.
 *   - Everything runs inside `after()`, once the diner's response has gone,
 *     and every failure is swallowed and logged. See dispatch-core.ts rule 3.
 *   - With no VAPID keys configured it does nothing at all.
 */

let vapidConfigured = false;

function configureVapid(): boolean {
  const config = pushServerConfig();
  if (!config) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails(
      config.subject,
      config.publicKey,
      config.privateKey,
    );
    vapidConfigured = true;
  }
  return true;
}

async function sendOne(
  target: PushTarget,
  payload: PushPayload,
): Promise<SendOutcome> {
  try {
    await webpush.sendNotification(
      {
        endpoint: target.endpoint,
        keys: { p256dh: target.p256dh, auth: target.auth },
      },
      JSON.stringify(payload),
      {
        // An order nobody saw within ten minutes has been noticed on the
        // board by then, or needs a human; a push arriving an hour later
        // is noise. Push services drop it after this.
        TTL: 600,
        urgency: "high",
        // Timeout on our side, so a hung push service cannot hold the
        // function open.
        timeout: 8_000,
      },
    );
    return { ok: true };
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    return { ok: false, gone: isGoneStatus(statusCode), statusCode };
  }
}

function log(event: string, fields: Record<string, unknown>) {
  // Same one-line JSON shape as src/lib/ai/logging.ts, so it can be found
  // the same way. Never logs an endpoint or a key.
  console.info(
    JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }),
  );
}

async function run(
  kind: PushEventKind,
  sourceId: string,
  restaurantId: string,
  payload: PushPayload,
  // A repeat ring for an order still waiting (ringPendingOrders): its
  // round was already claimed by claim_order_rings(), so the once-per-event
  // claim is skipped.
  options: { repeat?: boolean } = {},
) {
  if (!isSafeNotificationUrl(payload.url)) {
    log("push_refused_unsafe_url", { kind, restaurant_id: restaurantId });
    return;
  }

  const admin = createAdminClient();
  // database.types.ts predates 20260928090000; the two new tables are
  // reached through an untyped handle confined to this function.
  const db = admin as unknown as {
    from: (table: string) => ReturnType<typeof admin.from>;
  };

  // The claim (once per event) happens inside the web dispatch below, even
  // when web push isn't configured, so it's shared by both kinds of device:
  // the iOS app's tokens are only sent to when this call won the claim.
  const vapid = configureVapid();
  let claimed = false;

  const report = await dispatchPush(
    {
      claim: async () => {
        if (options.repeat) {
          claimed = true;
          return true;
        }
        const { data, error } = await db
          .from("push_dispatches")
          .upsert(
            { restaurant_id: restaurantId, kind, source_id: sourceId },
            { onConflict: "kind,source_id", ignoreDuplicates: true },
          )
          .select("id");
        if (error) throw error;
        claimed = Array.isArray(data) && data.length > 0;
        return claimed;
      },
      targets: async () => {
        if (!vapid) return [];
        const { data, error } = await db
          .from("push_subscriptions")
          .select("id, endpoint, p256dh, auth")
          .eq("restaurant_id", restaurantId);
        if (error) throw error;
        return (data ?? []) as unknown as PushTarget[];
      },
      send: sendOne,
      markDelivered: async (ids) => {
        await db
          .from("push_subscriptions")
          .update({
            last_success_at: new Date().toISOString(),
            failure_count: 0,
          } as never)
          .in("id", ids);
      },
      markFailed: async (ids) => {
        // Read-modify-write is fine here: a lost increment under a race
        // only delays noticing a dead device by one failure.
        const { data } = await db
          .from("push_subscriptions")
          .select("id, failure_count")
          .in("id", ids);
        for (const row of (data ?? []) as unknown as Array<{
          id: string;
          failure_count: number;
        }>) {
          await db
            .from("push_subscriptions")
            .update({ failure_count: row.failure_count + 1 } as never)
            .eq("id", row.id);
        }
      },
      remove: async (ids) => {
        await db.from("push_subscriptions").delete().in("id", ids);
      },
    },
    payload,
  );

  log(options.repeat ? "push_ring" : "push_dispatch", {
    kind,
    restaurant_id: restaurantId,
    skipped: report.skipped ?? null,
    delivered: report.delivered,
    failed: report.failed,
    removed: report.removed,
  });

  const apns = apnsConfig();
  const fcm = fcmConfig();
  const platforms = nativePlatforms();
  if (platforms.length === 0 || !claimed) return;

  // The store apps' phones, with the same bookkeeping rules: iPhones
  // through APNs, Android phones through FCM. An iPhone token's gateway
  // (sandbox for development builds, production for TestFlight and the
  // App Store) is learned on first delivery.
  const learned = new Map<string, ApnsEnvironment>();
  const nativeReport = await dispatchPush<NativeTarget>(
    {
      claim: async () => true,
      targets: async () => {
        const { data, error } = await db
          .from("native_push_tokens")
          .select("id, token, environment, platform")
          .eq("restaurant_id", restaurantId)
          .in("platform", platforms);
        if (error) throw error;
        return (data ?? []) as unknown as NativeTarget[];
      },
      send: async (target, message) => {
        if (target.platform === "android") {
          return fcm
            ? sendFcm(target.token, { kind: "alert", payload: message }, fcm)
            : { ok: false, gone: false };
        }
        if (!apns) return { ok: false, gone: false };
        const { outcome, environment } = await sendApns(target, message, apns);
        if (environment && environment !== target.environment) {
          learned.set(target.id, environment);
        }
        return outcome;
      },
      markDelivered: async (ids) => {
        for (const id of ids) {
          await db
            .from("native_push_tokens")
            .update({
              last_success_at: new Date().toISOString(),
              failure_count: 0,
              ...(learned.has(id) ? { environment: learned.get(id) } : {}),
            } as never)
            .eq("id", id);
        }
      },
      markFailed: async (ids) => {
        const { data } = await db
          .from("native_push_tokens")
          .select("id, failure_count")
          .in("id", ids);
        for (const row of (data ?? []) as unknown as Array<{
          id: string;
          failure_count: number;
        }>) {
          await db
            .from("native_push_tokens")
            .update({ failure_count: row.failure_count + 1 } as never)
            .eq("id", row.id);
        }
      },
      remove: async (ids) => {
        await db.from("native_push_tokens").delete().in("id", ids);
      },
    },
    payload,
  );
  log(options.repeat ? "push_ring_native" : "push_dispatch_native", {
    kind,
    restaurant_id: restaurantId,
    skipped: nativeReport.skipped ?? null,
    delivered: nativeReport.delivered,
    failed: nativeReport.failed,
    removed: nativeReport.removed,
  });
}

async function loadOrderForPush(orderId: string) {
  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("id, restaurant_id, order_number, table_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return null;

  const [{ data: table }, { data: items }] = await Promise.all([
    admin
      .from("tables")
      .select("table_number, display_name")
      .eq("id", order.table_id)
      .maybeSingle(),
    admin.from("order_items").select("quantity").eq("order_id", orderId),
  ]);

  const itemCount = (items ?? []).reduce(
    (sum, item) => sum + (item.quantity ?? 0),
    0,
  );

  return {
    restaurantId: order.restaurant_id,
    order: {
      id: order.id,
      orderNumber:
        order.order_number === null ? null : Number(order.order_number),
      itemCount,
      table: {
        number: table?.table_number ?? null,
        displayName: table?.display_name ?? null,
      },
    },
  };
}

async function notifyOrder(orderId: string) {
  const loaded = await loadOrderForPush(orderId);
  if (!loaded) return;
  await run(
    "order",
    loaded.order.id,
    loaded.restaurantId,
    orderPayload(loaded.order),
  );
}

/**
 * One round of "keep ringing until accepted", called by the scheduler
 * every 30 seconds (src/app/api/cron/order-ring/route.ts) while some order
 * is waiting. claim_order_rings() picks every order still 'pending' whose
 * last alert is at least 30 seconds old (for up to 10 minutes) and stamps
 * it, so overlapping rounds never ring an order twice. An order stops
 * ringing the moment anyone confirms or cancels it.
 */
export async function ringPendingOrders(): Promise<{
  rung: number;
  stopped: number;
  skipped?: "not_configured";
}> {
  const admin = createAdminClient();
  // First the orders that stopped waiting by any path the kitchen board's
  // Confirm/Cancel didn't already cover: their Android phones may still be
  // ringing. Claimed (and stamped) even when FCM is off, so they don't
  // keep the scheduler awake.
  const stopped = await stopHandledOrders(admin);

  if (!configureVapid() && nativePlatforms().length === 0) {
    return { rung: 0, stopped, skipped: "not_configured" };
  }
  const rpc = admin.rpc as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data: Array<{ order_id: string; ring_count: number }> | null;
    error: { message: string } | null;
  }>;
  const { data, error } = await rpc.call(admin, "claim_order_rings", {
    p_interval_seconds: 30,
    p_window_minutes: 10,
  });
  if (error) throw new Error(error.message);

  let rung = 0;
  for (const claim of data ?? []) {
    try {
      const loaded = await loadOrderForPush(claim.order_id);
      if (!loaded) continue;
      await run(
        "order",
        loaded.order.id,
        loaded.restaurantId,
        orderRingPayload(loaded.order, claim.ring_count),
        { repeat: true },
      );
      rung += 1;
    } catch (failure) {
      // One order's failure must not silence the others in this round.
      log("push_ring_error", {
        order_id: claim.order_id,
        message: failure instanceof Error ? failure.message : String(failure),
      });
    }
  }
  return { rung, stopped };
}

type AdminClient = ReturnType<typeof createAdminClient>;

async function stopHandledOrders(admin: AdminClient): Promise<number> {
  const rpc = admin.rpc as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data: Array<{ order_id: string; restaurant_id: string }> | null;
    error: { message: string } | null;
  }>;
  const { data, error } = await rpc.call(admin, "claim_orders_handled", {
    p_window_minutes: 60,
  });
  if (error) throw new Error(error.message);
  let stopped = 0;
  for (const claim of data ?? []) {
    stopped += await sendStop(admin, claim.restaurant_id, claim.order_id);
  }
  return stopped;
}

/** Tells this restaurant's Android phones to stop ringing for the order. */
async function sendStop(
  admin: AdminClient,
  restaurantId: string,
  orderId: string,
): Promise<number> {
  const fcm = fcmConfig();
  if (!fcm) return 0;
  const db = admin as unknown as {
    from: (table: string) => ReturnType<typeof admin.from>;
  };
  const { data } = await db
    .from("native_push_tokens")
    .select("token")
    .eq("restaurant_id", restaurantId)
    .eq("platform", "android");
  const tokens = (data ?? []) as unknown as Array<{ token: string }>;
  const outcomes = await Promise.all(
    tokens.map((t) =>
      sendFcm(t.token, { kind: "stop", group: `order-${orderId}` }, fcm),
    ),
  );
  log("push_stop", {
    restaurant_id: restaurantId,
    delivered: outcomes.filter((o) => o.ok).length,
    total: tokens.length,
  });
  return outcomes.filter((o) => o.ok).length;
}

/**
 * Called by transitionOrderStatus() right after the database accepted a
 * staff member's Confirm or Cancel, with that order's id: the Android
 * phones ringing for it go quiet now instead of at the next round. The
 * database already checked the caller may act on the order; this reads
 * only its restaurant and that restaurant's Android tokens.
 */
export function scheduleOrderHandledPush(orderId: string): void {
  if (!fcmConfig()) return;
  after(async () => {
    try {
      const admin = createAdminClient();
      const { data: order } = await admin
        .from("orders")
        .select("id, restaurant_id, status")
        .eq("id", orderId)
        .maybeSingle();
      if (!order || order.status === "pending") return;
      const db = admin as unknown as {
        from: (table: string) => ReturnType<typeof admin.from>;
      };
      // Stamp it so the backstop round doesn't send the same stop again.
      await db
        .from("push_dispatches")
        .update({ handled_notified_at: new Date().toISOString() } as never)
        .eq("kind", "order")
        .eq("source_id", order.id);
      await sendStop(admin, order.restaurant_id, order.id);
    } catch (error) {
      log("push_error", {
        kind: "order_handled",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function notifyTableRequest(requestId: string) {
  const admin = createAdminClient();
  const db = admin as unknown as {
    from: (table: string) => ReturnType<typeof admin.from>;
  };
  const { data } = await db
    .from("table_requests")
    .select("id, restaurant_id, table_id, kind, status")
    .eq("id", requestId)
    .maybeSingle();
  const request = data as unknown as {
    id: string;
    restaurant_id: string;
    table_id: string;
    kind: "waiter" | "bill";
    status: string;
  } | null;
  // An already-resolved or cancelled request needs nobody.
  if (!request || request.status !== "open") return;

  const { data: table } = await admin
    .from("tables")
    .select("table_number, display_name")
    .eq("id", request.table_id)
    .maybeSingle();

  await run(
    "table_request",
    request.id,
    request.restaurant_id,
    tableRequestPayload({
      id: request.id,
      kind: request.kind,
      table: {
        number: table?.table_number ?? null,
        displayName: table?.display_name ?? null,
      },
    }),
  );
}

function schedule(label: string, work: () => Promise<void>) {
  // Off only when no kind of device can be reached.
  if (!configureVapid() && nativePlatforms().length === 0) return;
  after(async () => {
    try {
      await work();
    } catch (error) {
      log("push_error", {
        kind: label,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Called by submitOrder() with the id submit_order() just returned. Safe
 * to call on every retry of the same order: the claim makes it once-only.
 */
export function scheduleOrderPush(orderId: string): void {
  schedule("order", () => notifyOrder(orderId));
}

/** Called by both paths that raise a table request, with the id the database returned. */
export function scheduleTableRequestPush(requestId: string): void {
  schedule("table_request", () => notifyTableRequest(requestId));
}

/**
 * A test push to the calling member's OWN devices, from the kitchen page's
 * "Send a test" button. The caller's devices are read through their own
 * RLS-scoped client by the action, so this takes targets rather than
 * reading any.
 */
export async function sendTestPush(
  targets: PushTarget[],
  nativeTargets: NativeTarget[] = [],
): Promise<{
  delivered: number;
  total: number;
  /** Per device, keyed by its endpoint or token so the caller can spot its own. */
  results: {
    kind: "web" | "ios" | "android";
    key: string;
    ok: boolean;
    statusCode?: number;
    reason?: string;
  }[];
}> {
  const payload: PushPayload = {
    title: "Tableside alerts are on",
    body: "New orders and table requests will show up here, even with the app closed.",
    url: "/dashboard/kitchen",
    tag: "tableside-test",
  };
  const vapid = configureVapid();
  const apns = apnsConfig();
  const fcm = fcmConfig();
  type Result = {
    kind: "web" | "ios" | "android";
    key: string;
    ok: boolean;
    statusCode?: number;
    reason?: string;
  };
  const fromOutcome = (
    kind: Result["kind"],
    key: string,
    outcome: { ok: boolean; statusCode?: number },
  ): Result => ({
    kind,
    key,
    ok: outcome.ok,
    statusCode: outcome.ok ? undefined : outcome.statusCode,
  });
  const sends: Promise<Result>[] = [
    ...(vapid
      ? targets.map((t) =>
          sendOne(t, payload).then((o) => fromOutcome("web", t.endpoint, o)),
        )
      : []),
    ...nativeTargets.map((t): Promise<Result> => {
      if (t.platform === "android") {
        return fcm
          ? sendFcm(t.token, { kind: "alert", payload }, fcm).then((o) =>
              fromOutcome("android", t.token, o),
            )
          : Promise.resolve({ kind: "android", key: t.token, ok: false });
      }
      return apns
        ? sendApns(t, payload, apns)
            .then((r) => ({
              ...fromOutcome("ios", t.token, r.outcome),
              reason: r.outcome.ok ? undefined : r.reason,
            }))
            .catch(() => ({ kind: "ios" as const, key: t.token, ok: false }))
        : Promise.resolve({ kind: "ios", key: t.token, ok: false });
    }),
  ];
  const results = await Promise.all(sends);
  log("push_test", {
    devices: results.map((r) => ({
      kind: r.kind,
      ok: r.ok,
      status: r.statusCode,
      reason: r.reason,
    })),
  });
  return {
    delivered: results.filter((r) => r.ok).length,
    total: targets.length + nativeTargets.length,
    results,
  };
}
