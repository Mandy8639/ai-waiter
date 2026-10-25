import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Square webhook rules, pure and unit-tested (tests/unit/square-payments.test.ts).
 *
 * Square signs each notification with HMAC-SHA256 over the notification
 * URL followed by the raw body, keyed with the subscription's signature
 * key, base64-encoded in `x-square-hmacsha256-signature`. The URL is part
 * of what's signed, so it must be exactly the one registered with Square
 * (SQUARE_WEBHOOK_URL), not whatever host the request happened to reach.
 */
export function verifySquareSignature(args: {
  body: string;
  signature: string | null;
  signatureKey: string;
  notificationUrl: string;
}): boolean {
  if (!args.signature || !args.signatureKey) return false;
  const expected = createHmac("sha256", args.signatureKey)
    .update(args.notificationUrl + args.body)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(args.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CompletedSquarePayment {
  paymentId: string;
  orderId: string;
  totalMinorUnits: number;
  currency: string;
}

/**
 * A payment.created / payment.updated event for a payment that has
 * completed and belongs to an order, or null for anything else (pending,
 * failed, other event types), which the route acknowledges and ignores.
 */
export function completedPaymentFrom(
  event: unknown,
): CompletedSquarePayment | null {
  const e = (event ?? {}) as {
    type?: string;
    data?: { object?: { payment?: Record<string, unknown> } };
  };
  if (e.type !== "payment.created" && e.type !== "payment.updated") return null;
  const payment = e.data?.object?.payment;
  if (!payment || payment.status !== "COMPLETED") return null;
  const total = payment.total_money as
    { amount?: unknown; currency?: unknown } | undefined;
  if (
    typeof payment.id !== "string" ||
    typeof payment.order_id !== "string" ||
    typeof total?.amount !== "number" ||
    typeof total.currency !== "string"
  ) {
    return null;
  }
  return {
    paymentId: payment.id,
    orderId: payment.order_id,
    totalMinorUnits: total.amount,
    currency: total.currency,
  };
}
