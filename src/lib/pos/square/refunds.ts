import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { toMinorUnits } from "@/lib/payments/money";
import { reportError } from "@/lib/observability/report";
import { getPayment, getSquareRefund, refundSquarePayment } from "./api";
import { buildSquareRefund } from "./refund-core";

/**
 * Refunds through Square (20261114090000), for a refund start_refund()
 * has already recorded as pending. Callers pass the signed-in owner's or
 * manager's own client: attach_refund_square_id() checks the role again,
 * and api.ts only reads the restaurant's token after that has passed in
 * start_refund().
 */

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

const rpcOf = (supabase: SupabaseClient) =>
  supabase.rpc.bind(supabase) as unknown as Rpc;

export type SquareRefundOutcome =
  | { ok: true; status: "succeeded" | "pending" | "failed" }
  | { ok: false; sent: boolean; error: string };

export async function sendSquareRefund(input: {
  supabase: SupabaseClient;
  restaurantId: string;
  refundId: string;
  squarePaymentId: string;
  amount: string | number;
  currency: string;
  reason: string;
}): Promise<SquareRefundOutcome> {
  const rpc = rpcOf(input.supabase);
  let squareRefundId: string;
  let squareStatus: string;
  try {
    const payment = await getPayment(input.restaurantId, input.squarePaymentId);
    const refund = await refundSquarePayment(
      input.restaurantId,
      buildSquareRefund({
        refundId: input.refundId,
        squarePaymentId: input.squarePaymentId,
        amountMinorUnits: toMinorUnits(String(input.amount), input.currency),
        currency: input.currency,
        paymentTotalMinorUnits: payment.totalMinorUnits,
        appFeeMinorUnits: payment.appFeeMinorUnits,
        reason: input.reason,
      }),
    );
    squareRefundId = refund.id;
    squareStatus = refund.status;
  } catch (error) {
    reportError(error, {
      scope: "payments.refund.square",
      extra: { refundId: input.refundId },
    });
    // Square refused or was unreachable: release what the pending row
    // held, so a retry isn't blocked by money that never moved.
    await rpc("cancel_pending_refund", { p_refund_id: input.refundId });
    return {
      ok: false,
      sent: false,
      error: "Square wouldn't process that refund. Nothing has been sent.",
    };
  }

  const { data, error } = await rpc("attach_refund_square_id", {
    p_refund_id: input.refundId,
    p_square_refund_id: squareRefundId,
    p_status: squareStatus,
  });
  if (error) {
    // The money went back; only the record of it failed.
    reportError(error, {
      scope: "payments.refund.square.attach",
      extra: { refundId: input.refundId, squareRefundId },
    });
    return {
      ok: false,
      sent: true,
      error:
        "The refund was sent, but recording it failed. Check the payment in Square before retrying.",
    };
  }
  const status = String(data);
  return {
    ok: true,
    status: status === "succeeded" || status === "failed" ? status : "pending",
  };
}

/**
 * Asks Square about refunds still pending (Square settles most at once,
 * some minutes later), so Reports shows where each one ended up. Quietly
 * leaves any it can't check for the next look.
 */
export async function checkPendingSquareRefunds(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<void> {
  const { data } = await supabase
    .from("payment_refunds")
    .select("id, square_refund_id")
    .eq("restaurant_id", restaurantId)
    .eq("status", "pending")
    .not("square_refund_id", "is", null)
    .limit(10);
  const rpc = rpcOf(supabase);
  for (const row of (data ?? []) as {
    id: string;
    square_refund_id: string;
  }[]) {
    try {
      const refund = await getSquareRefund(restaurantId, row.square_refund_id);
      if (refund.status === "PENDING") continue;
      await rpc("attach_refund_square_id", {
        p_refund_id: row.id,
        p_square_refund_id: row.square_refund_id,
        p_status: refund.status,
      });
    } catch (error) {
      reportError(error, {
        scope: "payments.refund.square.check",
        extra: { refundId: row.id },
      });
    }
  }
}
