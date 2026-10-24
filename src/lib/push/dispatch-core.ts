/**
 * Kitchen push, the part with no network and no database in it (phase F).
 *
 * Everything that decides WHAT gets sent, to WHOM, and WHAT HAPPENS AFTER
 * lives here, with its I/O handed in as functions — so the rules can be
 * unit-tested without a push service, a VAPID key or a Supabase project.
 * src/lib/push/dispatch.ts supplies the real I/O. No `server-only`, per
 * the extract-the-core convention.
 *
 * The rules, each of which a test pins:
 *
 *   1. ONCE PER ORDER. submit_order() is idempotent — a double tap or a
 *      retry returns the same order — so the event is claimed first and a
 *      second call for the same order sends nothing.
 *   2. A DEAD DEVICE IS FORGOTTEN, A FLAKY ONE IS NOT. The push service
 *      answers 404 or 410 when a subscription no longer exists (the app
 *      was uninstalled, the permission revoked); that row is deleted. Any
 *      other failure only counts against it.
 *   3. NEVER THE DINER'S PROBLEM. This runs after the diner's response has
 *      gone out, and nothing here may throw back into the request that
 *      placed the order. A kitchen that misses a push still has the board;
 *      a diner whose order "failed" because a tablet was offline has
 *      nothing.
 */

export type PushEventKind = "order" | "table_request";

export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping the notification takes the member — always a dashboard path. */
  url: string;
  /**
   * Notifications with the same tag replace each other on the device, so
   * a re-sent order never stacks a second copy in the tray.
   */
  tag: string;
  /**
   * An order the kitchen must act on: rings with the app's order sound
   * and breaks through Focus on iPhone (apns-core.ts), and buzzes harder
   * on Android. Orders only; table requests and tests stay ordinary.
   */
  urgent?: boolean;
  /**
   * Alerts about the same thing. A device shows only the newest one of a
   * group: the service worker closes the others before showing it, and
   * APNs collapses them. Unlike a reused tag, a NEW tag in the same group
   * always rings on Android (the TWA replaces a same-tag notification
   * silently), which is what the repeat alerts need.
   */
  group?: string;
}

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type SendOutcome =
  { ok: true } | { ok: false; gone: boolean; statusCode?: number };

/**
 * Generic over the kind of device: web push subscriptions by default, and
 * the iOS app's APNs tokens (src/lib/push/apns.ts) through the same rules.
 */
export interface DispatchDeps<T extends { id: string } = PushTarget> {
  /** True when this call claimed the event; false when it was already sent. */
  claim: () => Promise<boolean>;
  targets: () => Promise<T[]>;
  send: (target: T, payload: PushPayload) => Promise<SendOutcome>;
  markDelivered: (ids: string[]) => Promise<void>;
  markFailed: (ids: string[]) => Promise<void>;
  remove: (ids: string[]) => Promise<void>;
}

export interface DispatchReport {
  skipped?: "already_sent" | "no_devices";
  delivered: number;
  failed: number;
  removed: number;
}

export async function dispatchPush<T extends { id: string } = PushTarget>(
  deps: DispatchDeps<T>,
  payload: PushPayload,
): Promise<DispatchReport> {
  const report: DispatchReport = { delivered: 0, failed: 0, removed: 0 };

  if (!(await deps.claim())) return { ...report, skipped: "already_sent" };

  const targets = await deps.targets();
  if (targets.length === 0) return { ...report, skipped: "no_devices" };

  // In parallel: a kitchen with three tablets should not wait for the
  // slowest push service before the other two ring.
  const outcomes = await Promise.all(
    targets.map(async (target) => {
      try {
        return { target, outcome: await deps.send(target, payload) };
      } catch {
        // A thrown send is a failure of unknown kind — not proof the
        // device is gone, so it is counted, not deleted.
        return {
          target,
          outcome: { ok: false, gone: false } as SendOutcome,
        };
      }
    }),
  );

  const delivered = outcomes
    .filter((o) => o.outcome.ok)
    .map((o) => o.target.id);
  const gone = outcomes
    .filter((o) => !o.outcome.ok && o.outcome.gone)
    .map((o) => o.target.id);
  const failed = outcomes
    .filter((o) => !o.outcome.ok && !o.outcome.gone)
    .map((o) => o.target.id);

  if (delivered.length) await deps.markDelivered(delivered);
  if (failed.length) await deps.markFailed(failed);
  if (gone.length) await deps.remove(gone);

  return {
    delivered: delivered.length,
    failed: failed.length,
    removed: gone.length,
  };
}

/** 404 and 410 are the push services' "this subscription no longer exists". */
export function isGoneStatus(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

// What the kitchen reads -------------------------------------------------------

function tableLabel(table: {
  number: string | null;
  displayName: string | null;
}): string {
  if (table.displayName && table.number) {
    return `Table ${table.number} (${table.displayName})`;
  }
  if (table.number) return `Table ${table.number}`;
  return table.displayName ?? "A table";
}

/**
 * "New order #1042" / "Table 4 · 3 items". Deliberately no dish names, no
 * prices and no diner note: a notification shows on a lock screen that
 * anyone passing the counter can read, and the kitchen board one tap away
 * has all of it. What the cook needs from the buzz is that there IS an
 * order, and from where.
 */
export function orderPayload(order: {
  id: string;
  orderNumber: number | null;
  itemCount: number;
  table: { number: string | null; displayName: string | null };
}): PushPayload {
  const items = order.itemCount === 1 ? "1 item" : `${order.itemCount} items`;
  return {
    title:
      order.orderNumber !== null
        ? `New order #${order.orderNumber}`
        : "New order",
    body: `${tableLabel(order.table)} · ${items}`,
    url: "/dashboard/kitchen",
    tag: `order-${order.id}`,
    group: `order-${order.id}`,
    urgent: true,
  };
}

/**
 * The repeat alert for an order still waiting to be accepted
 * (20261012090000_order_ring.sql). A new tag for every ring, so Android
 * rings for it rather than silently swapping the text, in the same group
 * as the first alert, so the device still shows just one alert per order.
 */
export function orderRingPayload(
  order: Parameters<typeof orderPayload>[0],
  ringCount: number,
): PushPayload {
  const first = orderPayload(order);
  return {
    ...first,
    tag: `${first.tag}-ring-${ringCount}`,
    title:
      order.orderNumber !== null
        ? `Order #${order.orderNumber} is waiting`
        : "An order is waiting",
    body: `${first.body} · tap to accept`,
  };
}

export function tableRequestPayload(request: {
  id: string;
  kind: "waiter" | "bill";
  table: { number: string | null; displayName: string | null };
}): PushPayload {
  const who = tableLabel(request.table);
  return {
    title:
      request.kind === "bill"
        ? `${who} asked for the bill`
        : `${who} is asking for a waiter`,
    body: "Tap to see who is waiting.",
    // The overview's "Tables waiting" is where these are resolved.
    url: "/dashboard",
    tag: `request-${request.id}`,
  };
}

/**
 * The only thing a notification click may open. The service worker trusts
 * the URL in the payload, so the payload builders above are the only
 * source of it — and this is checked again at send time, so a future
 * builder that got it wrong cannot turn a push into a link off-site.
 */
export function isSafeNotificationUrl(url: string): boolean {
  return /^\/dashboard(\/[a-z0-9/_-]*)?$/i.test(url);
}

/** One device's answer to "Send a test", without its token or endpoint. */
export interface TestDeviceResult {
  kind: "web" | "ios" | "android";
  ok: boolean;
  /** The push service's HTTP status when it refused. */
  statusCode?: number;
  /** Its reason, when it gave one (APNs: "BadDeviceToken", "InvalidProviderToken"…). */
  reason?: string;
  /** The device the test was sent from. */
  thisDevice: boolean;
}

const KIND_LABEL: Record<TestDeviceResult["kind"], string> = {
  web: "web browser",
  ios: "iPhone/iPad app",
  android: "Android app",
};

/**
 * What "Send a test" says: where each alert went, and whether this device
 * was one of them. A single "sent" used to hide a test that reached some
 * other device (an old phone, a browser on a laptop) but not this one.
 */
export function describeTestResults(results: TestDeviceResult[]): string {
  if (results.length === 0)
    return "Alerts aren't on for any of your devices yet.";
  const mine = results.filter((r) => r.thisDevice);
  const others = results.filter((r) => !r.thisDevice);
  const parts: string[] = [];
  for (const r of mine) {
    const why = [r.statusCode, r.reason].filter(Boolean).join(" ");
    parts.push(
      r.ok
        ? "Sent to this device."
        : `This device: refused${why ? ` (${why})` : ""}.`,
    );
  }
  if (mine.length === 0) {
    parts.push(
      "This device isn't registered for alerts here: turn alerts off and on again to add it.",
    );
  }
  if (others.length > 0) {
    const counts = new Map<string, { sent: number; refused: number }>();
    for (const r of others) {
      const label = KIND_LABEL[r.kind];
      const c = counts.get(label) ?? { sent: 0, refused: 0 };
      if (r.ok) c.sent += 1;
      else c.refused += 1;
      counts.set(label, c);
    }
    const list = [...counts.entries()].map(([label, c]) => {
      const n = c.sent + c.refused;
      const name = `${n} other ${label}${n === 1 ? "" : "s"}`;
      return c.refused === 0
        ? `${name} (sent)`
        : c.sent === 0
          ? `${name} (refused)`
          : `${name} (${c.sent} sent, ${c.refused} refused)`;
    });
    parts.push(`Also: ${list.join(", ")}.`);
  }
  return parts.join(" ");
}
