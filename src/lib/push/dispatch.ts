import "server-only";
import webpush from "web-push";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  dispatchPush,
  isGoneStatus,
  isSafeNotificationUrl,
  orderPayload,
  tableRequestPayload,
  type PushEventKind,
  type PushPayload,
  type PushTarget,
  type SendOutcome,
} from "./dispatch-core";
import { pushServerConfig } from "./config";
import { apnsConfig, sendApns, type NativeTarget } from "./apns";
import type { ApnsEnvironment } from "./apns-core";

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

  log("push_dispatch", {
    kind,
    restaurant_id: restaurantId,
    skipped: report.skipped ?? null,
    delivered: report.delivered,
    failed: report.failed,
    removed: report.removed,
  });

  const apns = apnsConfig();
  if (!apns || !claimed) return;

  // The iOS app's phones, through APNs, with the same bookkeeping rules.
  // A token's gateway (sandbox for development builds, production for
  // TestFlight and the App Store) is learned on first delivery.
  const learned = new Map<string, ApnsEnvironment>();
  const nativeReport = await dispatchPush<NativeTarget>(
    {
      claim: async () => true,
      targets: async () => {
        const { data, error } = await db
          .from("native_push_tokens")
          .select("id, token, environment")
          .eq("restaurant_id", restaurantId);
        if (error) throw error;
        return (data ?? []) as unknown as NativeTarget[];
      },
      send: async (target, message) => {
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
  log("push_dispatch_ios", {
    kind,
    restaurant_id: restaurantId,
    skipped: nativeReport.skipped ?? null,
    delivered: nativeReport.delivered,
    failed: nativeReport.failed,
    removed: nativeReport.removed,
  });
}

async function notifyOrder(orderId: string) {
  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("id, restaurant_id, order_number, table_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return;

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

  await run(
    "order",
    order.id,
    order.restaurant_id,
    orderPayload({
      id: order.id,
      orderNumber:
        order.order_number === null ? null : Number(order.order_number),
      itemCount,
      table: {
        number: table?.table_number ?? null,
        displayName: table?.display_name ?? null,
      },
    }),
  );
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
  // Off only when neither kind of device can be reached.
  if (!configureVapid() && !apnsConfig()) return;
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
): Promise<{ delivered: number; total: number }> {
  const payload: PushPayload = {
    title: "Tableside alerts are on",
    body: "New orders and table requests will show up here, even with the app closed.",
    url: "/dashboard/kitchen",
    tag: "tableside-test",
  };
  const vapid = configureVapid();
  const apns = apnsConfig();
  const sends: Promise<{ ok: boolean }>[] = [
    ...(vapid ? targets.map((t) => sendOne(t, payload)) : []),
    ...(apns
      ? nativeTargets.map((t) =>
          sendApns(t, payload, apns)
            .then((r) => r.outcome)
            .catch(() => ({ ok: false })),
        )
      : []),
  ];
  const outcomes = await Promise.all(sends);
  return {
    delivered: outcomes.filter((o) => o.ok).length,
    total: targets.length + nativeTargets.length,
  };
}
