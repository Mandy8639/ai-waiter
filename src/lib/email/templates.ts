/**
 * The owner emails' words and markup (phase F). Pure — no network, no
 * database, no `server-only` — so every sentence an owner reads is
 * unit-tested.
 *
 * Written to be read, not skimmed past:
 *   - The subject line carries the answer ("Nashta yesterday: 12 orders,
 *     $184.50"), so the email is useful without opening it.
 *   - Plain markup, one column, no images, no tracking pixels. Images are
 *     blocked by default in most mail clients, and a pixel is surveillance
 *     an owner never asked for.
 *   - Every email says why it arrived and links to the setting that stops
 *     it.
 *   - Every value from the database is escaped. A dish name is text a
 *     restaurant typed; in an HTML email it must never become markup.
 */
import { formatMoney } from "@/lib/orders/format";

export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(options: {
  heading: string;
  bodyHtml: string;
  settingsUrl: string;
  reason: string;
}): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#faf8f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f1a17;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #ece6df;border-radius:12px;padding:24px;">
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${escapeHtml(options.heading)}</h1>
      ${options.bodyHtml}
      <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#7a716a;">
        ${escapeHtml(options.reason)}
        <a href="${escapeHtml(options.settingsUrl)}" style="color:#7a716a;">Change email settings</a>.
      </p>
    </div>
  </body>
</html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:20px 0 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#7a2e10;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a></p>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${escapeHtml(text)}</p>`;
}

// The daily summary ---------------------------------------------------------

export interface DailySummaryData {
  restaurantName: string;
  /** "Monday, September 28" — already in the restaurant's own calendar. */
  dayLabel: string;
  currency: string;
  orderCount: number;
  orderValue: number;
  cancelledCount: number;
  tableRequestCount: number;
  topItems: Array<{ name: string; quantity: number }>;
  reportsUrl: string;
  settingsUrl: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function renderDailySummary(data: DailySummaryData): EmailMessage {
  const value = formatMoney(data.orderValue, data.currency);
  const orders = plural(data.orderCount, "order", "orders");
  const subject = `${data.restaurantName} yesterday: ${orders}, ${value}`;

  const lines: string[] = [
    `${orders} worth ${value}.`,
    data.orderCount > 0
      ? `That's ${formatMoney(data.orderValue / data.orderCount, data.currency)} an order on average.`
      : "",
    data.cancelledCount > 0
      ? `${plural(data.cancelledCount, "order was", "orders were")} cancelled and left out of these numbers.`
      : "",
    data.tableRequestCount > 0
      ? `Tables asked for a waiter or the bill ${plural(data.tableRequestCount, "time", "times")}.`
      : "",
  ].filter(Boolean);

  const top = data.topItems.slice(0, 3);
  const topHtml = top.length
    ? `<p style="margin:16px 0 6px;font-size:13px;font-weight:600;color:#7a716a;text-transform:uppercase;letter-spacing:.04em;">Most ordered</p>
       <ol style="margin:0;padding-left:20px;font-size:15px;line-height:1.6;">
         ${top.map((item) => `<li>${escapeHtml(item.name)} &times; ${item.quantity}</li>`).join("")}
       </ol>`
    : "";
  const topText = top.length
    ? `\nMost ordered:\n${top.map((item, i) => `${i + 1}. ${item.name} x ${item.quantity}`).join("\n")}\n`
    : "";

  const reason = `You're getting this because you own ${data.restaurantName} on Tableside and daily summaries are on.`;

  return {
    subject,
    html: layout({
      heading: `${data.restaurantName} · ${data.dayLabel}`,
      bodyHtml:
        lines.map(paragraph).join("") +
        topHtml +
        `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#7a716a;">Order value counts orders placed, whether or not they've been paid yet. Money actually taken is on your Reports page.</p>` +
        button(data.reportsUrl, "Open Reports"),
      settingsUrl: data.settingsUrl,
      reason,
    }),
    text: `${data.restaurantName} · ${data.dayLabel}

${lines.join("\n")}
${topText}
Order value counts orders placed, whether or not they've been paid yet. Money actually taken is on your Reports page: ${data.reportsUrl}

${reason} Change email settings: ${data.settingsUrl}
`,
  };
}

// Payment alerts --------------------------------------------------------------

interface AlertBase {
  restaurantName: string;
  settingsUrl: string;
}

function alert(options: {
  subject: string;
  heading: string;
  paragraphs: string[];
  actionUrl: string;
  actionLabel: string;
  restaurantName: string;
  settingsUrl: string;
}): EmailMessage {
  const reason = `You're getting this because you own ${options.restaurantName} on Tableside and payment alerts are on.`;
  return {
    subject: options.subject,
    html: layout({
      heading: options.heading,
      bodyHtml:
        options.paragraphs.map(paragraph).join("") +
        button(options.actionUrl, options.actionLabel),
      settingsUrl: options.settingsUrl,
      reason,
    }),
    text: `${options.heading}

${options.paragraphs.join("\n\n")}

${options.actionLabel}: ${options.actionUrl}

${reason} Change email settings: ${options.settingsUrl}
`,
  };
}

/** The restaurant's own Tableside subscription failed to renew. */
export function renderSubscriptionPastDue(
  data: AlertBase & { billingUrl: string },
): EmailMessage {
  return alert({
    subject: `Action needed: your Tableside payment for ${data.restaurantName} didn't go through`,
    heading: "Your Tableside payment didn't go through",
    paragraphs: [
      `We couldn't take this period's payment for ${data.restaurantName}. Stripe usually tries again over the next few days.`,
      "Updating your card now avoids any interruption to your menu, orders and AI waiter.",
    ],
    actionUrl: data.billingUrl,
    actionLabel: "Update payment details",
    restaurantName: data.restaurantName,
    settingsUrl: data.settingsUrl,
  });
}

/** Their Stripe account can no longer take card payments from diners. */
export function renderCardPaymentsDisabled(
  data: AlertBase & { paymentsUrl: string },
): EmailMessage {
  return alert({
    subject: `Action needed: ${data.restaurantName} can't take card payments right now`,
    heading: "Card payments are switched off",
    paragraphs: [
      `Stripe has paused card payments for ${data.restaurantName}. This usually means Stripe needs more information from you.`,
      "Until it's resolved, diners can still order, but they can't pay by card through Tableside.",
    ],
    actionUrl: data.paymentsUrl,
    actionLabel: "See what Stripe needs",
    restaurantName: data.restaurantName,
    settingsUrl: data.settingsUrl,
  });
}

/** A diner's delayed payment (e.g. a bank payment) failed after they left. */
export function renderDinerPaymentFailed(
  data: AlertBase & {
    /** Every order the payment covered — a tab settles several at once. */
    orderNumbers: number[];
    amount: number;
    currency: string;
    ordersUrl: string;
  },
): EmailMessage {
  const numbers = [...data.orderNumbers].sort((a, b) => a - b);
  const order =
    numbers.length === 0
      ? "an order"
      : numbers.length === 1
        ? `order #${numbers[0]}`
        : `orders ${numbers.map((n) => `#${n}`).join(", ")}`;
  const amount = formatMoney(data.amount, data.currency);
  return alert({
    subject: `A payment of ${amount} for ${order} at ${data.restaurantName} failed`,
    heading: `A diner's payment failed (${amount})`,
    paragraphs: [
      `The payment for ${order} used a delayed payment method, and it has now failed. You have not been paid for ${numbers.length > 1 ? "them" : "it"}.`,
      "If the diner is still around, ask them to pay another way. Otherwise you may want to follow up.",
    ],
    actionUrl: data.ordersUrl,
    actionLabel: "Open orders",
    restaurantName: data.restaurantName,
    settingsUrl: data.settingsUrl,
  });
}
