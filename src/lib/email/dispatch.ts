import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { emailConfig, type EmailConfig } from "./config";
import { sendWithResend } from "./resend";
import {
  dayLabel,
  localYesterday,
  sendToOwners,
  type EmailKind,
  type EmailReport,
  type Recipient,
} from "./send-core";
import {
  renderCardPaymentsDisabled,
  renderDailySummary,
  renderDinerPaymentFailed,
  renderSubscriptionPastDue,
  type EmailMessage,
} from "./templates";

/**
 * Owner email, the I/O half (phase F). Reads with the service-role client
 * and sends through Resend.
 *
 * WHY THE SERVICE-ROLE CLIENT. Nothing here runs on behalf of a signed-in
 * person: the daily summary is a scheduled job, and the alerts come from
 * Stripe webhooks. There is no auth.uid() for RLS to reason about. The
 * entry points are called only from the cron route (authenticated by
 * CRON_SECRET) and the two Stripe webhook routes (authenticated by their
 * signatures) — tests/unit/owner-email.test.ts pins that list. Not a
 * server action; no browser can call anything in this file.
 */

type Admin = ReturnType<typeof createAdminClient>;

/** database.types.ts predates 20260929090000; the new pieces are reached through one untyped handle. */
function untyped(admin: Admin) {
  return admin as unknown as {
    from: (table: string) => ReturnType<Admin["from"]>;
    rpc: (
      fn: string,
      args?: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

function log(event: string, fields: Record<string, unknown>) {
  // Never logs an address.
  console.info(
    JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }),
  );
}

async function recipients(
  admin: Admin,
  restaurantId: string,
  kind: "daily_summary" | "payment_alert",
): Promise<Recipient[]> {
  const { data, error } = await untyped(admin).rpc(
    "get_owner_email_recipients",
    { target_restaurant_id: restaurantId, p_kind: kind },
  );
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ user_id: string; email: string }>).map(
    (row) => ({ userId: row.user_id, email: row.email }),
  );
}

async function deliver(
  admin: Admin,
  config: EmailConfig,
  options: {
    restaurantId: string;
    kind: EmailKind;
    dedupeKey: string;
    recipients: Recipient[];
    message: EmailMessage;
  },
): Promise<EmailReport> {
  const db = untyped(admin);
  return sendToOwners(
    {
      claim: async (recipient) => {
        const { data, error } = await db
          .from("email_dispatches")
          .upsert(
            {
              restaurant_id: options.restaurantId,
              kind: options.kind,
              dedupe_key: options.dedupeKey,
              recipient_user_id: recipient.userId,
            },
            {
              onConflict: "kind,dedupe_key,recipient_user_id",
              ignoreDuplicates: true,
            },
          )
          .select("id");
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Array<{ id: string }>;
        return rows[0]?.id ?? null;
      },
      send: (to, message, idempotencyKey) =>
        sendWithResend({
          apiKey: config.apiKey,
          from: config.from,
          to,
          message,
          idempotencyKey,
        }),
      record: async (dispatchId, result) => {
        await db
          .from("email_dispatches")
          .update(
            (result.ok
              ? {
                  sent_at: new Date().toISOString(),
                  provider_message_id: result.id,
                }
              : { error: result.error.slice(0, 500) }) as never,
          )
          .eq("id", dispatchId);
      },
    },
    options,
  );
}

async function restaurantName(admin: Admin, restaurantId: string) {
  const { data } = await admin
    .from("restaurants")
    .select("name")
    .eq("id", restaurantId)
    .maybeSingle();
  return data?.name ?? "Your restaurant";
}

// The daily summary -------------------------------------------------------------

export interface DailySummaryRun {
  configured: boolean;
  restaurants: number;
  sent: number;
  skipped: number;
  failed: number;
  quiet: number;
}

/**
 * One pass of the daily job. Safe to run more than once for the same day:
 * every email is claimed before it is sent.
 *
 * Only restaurants with an order in the last two days are even looked at —
 * a cheap superset of "had an order yesterday in its own timezone" — and
 * a restaurant whose yesterday turns out to be empty gets no email.
 */
export async function runDailySummaries(
  now: Date = new Date(),
): Promise<DailySummaryRun> {
  const run: DailySummaryRun = {
    configured: false,
    restaurants: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    quiet: 0,
  };
  const config = emailConfig();
  if (!config) return run;
  run.configured = true;

  const admin = createAdminClient();
  const since = new Date(now.getTime() - 50 * 3_600_000).toISOString();
  const { data: recent, error } = await admin
    .from("orders")
    .select("restaurant_id")
    .gte("created_at", since);
  if (error) throw new Error(error.message);

  const restaurantIds = [
    ...new Set((recent ?? []).map((r) => r.restaurant_id)),
  ];

  for (const restaurantId of restaurantIds) {
    run.restaurants += 1;
    try {
      const { data: restaurant } = await admin
        .from("restaurants")
        .select("timezone")
        .eq("id", restaurantId)
        .maybeSingle();
      const day = localYesterday(now, restaurant?.timezone ?? "UTC");

      const { data: rows, error: summaryError } = await untyped(admin).rpc(
        "get_daily_summary",
        { target_restaurant_id: restaurantId, p_day: day },
      );
      if (summaryError) throw new Error(summaryError.message);
      const summary = (Array.isArray(rows) ? rows[0] : rows) as
        | {
            restaurant_name: string;
            currency: string;
            order_count: number;
            order_value: string | number;
            cancelled_count: number;
            table_request_count: number;
            top_items: Array<{ name: string; quantity: number }>;
          }
        | undefined;

      if (!summary || summary.order_count === 0) {
        run.quiet += 1;
        continue;
      }

      const report = await deliver(admin, config, {
        restaurantId,
        kind: "daily_summary",
        dedupeKey: day,
        recipients: await recipients(admin, restaurantId, "daily_summary"),
        message: renderDailySummary({
          restaurantName: summary.restaurant_name,
          dayLabel: dayLabel(day),
          currency: summary.currency,
          orderCount: summary.order_count,
          orderValue: Number(summary.order_value),
          cancelledCount: summary.cancelled_count,
          tableRequestCount: summary.table_request_count,
          topItems: summary.top_items,
          reportsUrl: `${config.appUrl}/dashboard/reports`,
          settingsUrl: `${config.appUrl}/dashboard/settings`,
        }),
      });
      run.sent += report.sent;
      run.skipped += report.skipped;
      run.failed += report.failed;
    } catch (error) {
      run.failed += 1;
      log("email_daily_summary_error", {
        restaurant_id: restaurantId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log("email_daily_summary_run", { ...run });
  return run;
}

// Payment alerts ------------------------------------------------------------------

async function sendAlert(
  restaurantId: string,
  kind: Exclude<EmailKind, "daily_summary">,
  dedupeKey: string,
  build: (name: string, config: EmailConfig) => EmailMessage,
): Promise<void> {
  const config = emailConfig();
  if (!config) return;
  try {
    const admin = createAdminClient();
    const name = await restaurantName(admin, restaurantId);
    const report = await deliver(admin, config, {
      restaurantId,
      kind,
      dedupeKey,
      recipients: await recipients(admin, restaurantId, "payment_alert"),
      message: build(name, config),
    });
    log("email_alert", { kind, restaurant_id: restaurantId, ...report });
  } catch (error) {
    // Never fail the webhook over an email.
    log("email_alert_error", {
      kind,
      restaurant_id: restaurantId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The restaurant's Tableside subscription has just become past due. */
export function alertSubscriptionPastDue(options: {
  restaurantId: string;
  subscriptionId: string;
  status: string;
  periodEnd: string | null;
}): Promise<void> {
  return sendAlert(
    options.restaurantId,
    "subscription_past_due",
    // Once per billing period per status: a second failed renewal next
    // month is a new email; a redelivered webhook for this one is not.
    `${options.subscriptionId}:${options.status}:${options.periodEnd ?? "none"}`,
    (restaurantName, config) =>
      renderSubscriptionPastDue({
        restaurantName,
        billingUrl: `${config.appUrl}/dashboard/settings`,
        settingsUrl: `${config.appUrl}/dashboard/settings`,
      }),
  );
}

/** Card payments have just switched from enabled to disabled on the restaurant's Stripe account. */
export function alertCardPaymentsDisabled(options: {
  restaurantId: string;
  stripeAccountId: string;
  /** The event that reported it — a later re-disable is a new email. */
  eventId: string;
}): Promise<void> {
  return sendAlert(
    options.restaurantId,
    "card_payments_disabled",
    `${options.stripeAccountId}:${options.eventId}`,
    (restaurantName, config) =>
      renderCardPaymentsDisabled({
        restaurantName,
        paymentsUrl: `${config.appUrl}/dashboard/payments`,
        settingsUrl: `${config.appUrl}/dashboard/settings`,
      }),
  );
}

/** A diner's delayed payment has failed after they left. */
export async function alertDinerPaymentFailed(
  checkoutSessionId: string,
): Promise<void> {
  const config = emailConfig();
  if (!config) return;
  try {
    const admin = createAdminClient();
    const { data: payment } = await admin
      .from("order_payments")
      .select("id, restaurant_id, total_amount, currency")
      .eq("stripe_checkout_session_id", checkoutSessionId)
      .maybeSingle();
    if (!payment) return;
    // A tab settles several orders with one payment; payment_orders is the
    // only record of which (20260902090000_tab_payments.sql).
    const { data: covered } = await admin
      .from("payment_orders")
      .select("order_id")
      .eq("payment_id", payment.id);
    const orderIds = (covered ?? []).map((row) => row.order_id);
    const { data: orders } = orderIds.length
      ? await admin.from("orders").select("order_number").in("id", orderIds)
      : { data: [] };
    const orderNumbers = (orders ?? []).map((row) => Number(row.order_number));

    await sendAlert(
      payment.restaurant_id,
      "diner_payment_failed",
      checkoutSessionId,
      (restaurantName) =>
        renderDinerPaymentFailed({
          restaurantName,
          orderNumbers,
          amount: Number(payment.total_amount),
          currency: payment.currency,
          ordersUrl: `${config.appUrl}/dashboard/orders`,
          settingsUrl: `${config.appUrl}/dashboard/settings`,
        }),
    );
  } catch (error) {
    log("email_alert_error", {
      kind: "diner_payment_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
