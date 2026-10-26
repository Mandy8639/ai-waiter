import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toMinorUnits } from "@/lib/payments/money";
import { parsePaymentError } from "@/lib/payments/errors";
import { reportError } from "@/lib/observability/report";
import {
  SquareError,
  cancelTerminalCheckout,
  createCashPayment,
  createOrder,
  createTerminalCheckout,
  getPayment,
  getTerminalCheckout,
  settleFromSquare,
  squareLocationFor,
} from "./api";
import {
  buildCashSaleRequests,
  buildTerminalRequests,
  type BillLine,
} from "./checkout-core";

/**
 * Square in person (phase 3): a staff member sends a table's bill to a
 * Square Terminal, waits for the diner's card, and cash recorded in
 * Tableside is copied to Square as a cash sale.
 *
 * Every function takes the staff member's own Supabase client: the
 * database functions it calls check membership and the restaurant's
 * settings. Like Tap to Pay, nothing is marked paid until the server has
 * read the payment back from Square (settleFromSquare), and the webhook
 * does the same as a backstop.
 */

export type TerminalOutcome =
  | { state: "waiting" }
  | { state: "paid"; tip: number }
  | { state: "cancelled" };

function report(e: unknown, scope: string, extra: Record<string, string>) {
  reportError(e, {
    scope,
    extra: {
      ...extra,
      detail: e instanceof SquareError ? e.detail : undefined,
    },
  });
}

async function fee(
  supabase: SupabaseClient,
  paymentId: string,
  amount: string,
  currency: string,
) {
  // Same rule as every card payment: the fee is on the bill without the
  // tip, and failing to work it out never stops a payment.
  try {
    const { data, error } = await supabase.rpc("platform_fee_for_payment", {
      p_payment_id: paymentId,
      p_amount_minor_units: toMinorUnits(amount, currency),
    });
    if (error) throw error;
    return Number(data ?? 0);
  } catch (e) {
    report(e, "platform.fee.square_terminal", { paymentId });
    return 0;
  }
}

export async function sendToTerminal(args: {
  supabase: unknown;
  restaurantId: string;
  restaurantName: string;
  orderIds: string[];
  deviceId: string;
}): Promise<{ ok: true; paymentId: string } | { ok: false; error: string }> {
  const supabase = args.supabase as SupabaseClient;

  // Only a Terminal this restaurant has paired (read through the member's
  // own RLS view of pos_devices).
  const { data: device } = await supabase
    .from("pos_devices")
    .select("device_id")
    .eq("restaurant_id", args.restaurantId)
    .eq("device_id", args.deviceId)
    .eq("status", "paired")
    .maybeSingle();
  if (!device)
    return {
      ok: false,
      error: "That Terminal isn't paired with this restaurant.",
    };

  const { data, error } = await supabase.rpc("start_square_terminal_payment", {
    p_order_ids: args.orderIds,
  });
  if (error) return { ok: false, error: parsePaymentError(error.message) };
  const payment = (
    data as
      | {
          payment_id: string;
          amount: string;
          currency: string;
          tipping_enabled: boolean;
        }[]
      | null
  )?.[0];
  if (!payment) return { ok: false, error: "Couldn't start the payment." };

  try {
    const { data: lines, error: linesError } = await supabase.rpc(
      "payment_bill_lines",
      {
        p_payment_id: payment.payment_id,
      },
    );
    if (linesError) throw linesError;
    return await pushToTerminal({
      supabase,
      restaurantId: args.restaurantId,
      restaurantName: args.restaurantName,
      deviceId: args.deviceId,
      payment,
      lines: (lines ?? []) as BillLine[],
    });
  } catch (e) {
    report(e, "square.terminal.send", { paymentId: payment.payment_id });
    await supabase.rpc("cancel_square_terminal_payment", {
      p_payment_id: payment.payment_id,
    });
    return {
      ok: false,
      error: "Couldn't send the bill to the Terminal. Please try again.",
    };
  }
}

interface StartedTerminalPayment {
  payment_id: string;
  amount: string;
  currency: string;
  tipping_enabled: boolean;
}

/**
 * Puts a started Terminal payment on the device: the itemised order in
 * Square, then the checkout, then the link back to our payment. Throws on
 * any failure; the caller cancels the payment.
 */
async function pushToTerminal(args: {
  supabase: SupabaseClient;
  restaurantId: string;
  restaurantName: string;
  deviceId: string;
  payment: StartedTerminalPayment;
  lines: BillLine[];
}): Promise<{ ok: true; paymentId: string }> {
  const { supabase, payment } = args;
  const requests = buildTerminalRequests({
    paymentId: payment.payment_id,
    locationId: await squareLocationFor(args.restaurantId),
    currency: payment.currency,
    amount: payment.amount,
    lines: args.lines,
    deviceId: args.deviceId,
    tippingEnabled: payment.tipping_enabled,
    appFeeMinorUnits: await fee(
      supabase,
      payment.payment_id,
      payment.amount,
      payment.currency,
    ),
    note: `Tableside: ${args.restaurantName}`,
  });
  const squareOrderId = await createOrder(
    args.restaurantId,
    requests.createOrder,
  );
  const checkout = await createTerminalCheckout(
    args.restaurantId,
    requests.checkout(squareOrderId),
  );
  const { error: attachError } = await supabase.rpc(
    "attach_square_terminal_checkout",
    {
      p_payment_id: payment.payment_id,
      p_square_order_id: squareOrderId,
      p_checkout_id: checkout.id,
    },
  );
  if (attachError) {
    // The checkout exists on the Terminal but couldn't be recorded, so
    // it could never be settled: take it back off the device.
    await cancelTerminalCheckout(args.restaurantId, checkout.id).catch(
      () => undefined,
    );
    throw attachError;
  }
  return { ok: true, paymentId: payment.payment_id };
}

/**
 * Some parts of a split bill (20261115090000) on a Square Terminal. The
 * parts cover no orders until the whole split is paid, so Square gets one
 * line for exactly what they come to ("Share 1 of 3", or the dishes),
 * rather than the itemised orders.
 */
export async function sendSplitToTerminal(args: {
  supabase: unknown;
  restaurantId: string;
  restaurantName: string;
  tableLabel: string;
  splitId: string;
  unitIds: string[];
  deviceId: string;
}): Promise<{ ok: true; paymentId: string } | { ok: false; error: string }> {
  const supabase = args.supabase as SupabaseClient;

  const { data: device } = await supabase
    .from("pos_devices")
    .select("device_id")
    .eq("restaurant_id", args.restaurantId)
    .eq("device_id", args.deviceId)
    .eq("status", "paired")
    .maybeSingle();
  if (!device)
    return {
      ok: false,
      error: "That Terminal isn't paired with this restaurant.",
    };

  const { data, error } = await supabase.rpc("start_split_terminal_payment", {
    p_split_id: args.splitId,
    p_unit_ids: args.unitIds,
  });
  if (error) return { ok: false, error: parsePaymentError(error.message) };
  const payment = (
    data as (StartedTerminalPayment & { label: string | null })[] | null
  )?.[0];
  if (!payment) return { ok: false, error: "Couldn't start the payment." };

  try {
    return await pushToTerminal({
      supabase,
      restaurantId: args.restaurantId,
      restaurantName: args.restaurantName,
      deviceId: args.deviceId,
      payment,
      lines: [
        {
          order_id: payment.payment_id,
          item_name: `${args.tableLabel}: ${payment.label ?? "Part of the bill"}`,
          options: null,
          quantity: 1,
          unit_amount: payment.amount,
          line_total: payment.amount,
          order_total: payment.amount,
        },
      ],
    });
  } catch (e) {
    report(e, "square.terminal.split", { paymentId: payment.payment_id });
    await supabase.rpc("cancel_square_terminal_payment", {
      p_payment_id: payment.payment_id,
    });
    return {
      ok: false,
      error: "Couldn't send that part to the Terminal. Please try again.",
    };
  }
}

async function loadTerminalPayment(
  supabase: SupabaseClient,
  restaurantId: string,
  paymentId: string,
) {
  const { data } = await supabase
    .from("order_payments")
    .select("status, tip_amount, tip_on_device, square_terminal_checkout_id")
    .eq("id", paymentId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  return data?.tip_on_device ? data : null;
}

/** Where a Terminal payment is: asks Square, and settles if the card went through. */
export async function checkTerminal(args: {
  supabase: unknown;
  restaurantId: string;
  paymentId: string;
}): Promise<
  { ok: true; outcome: TerminalOutcome } | { ok: false; error: string }
> {
  const supabase = args.supabase as SupabaseClient;
  const row = await loadTerminalPayment(
    supabase,
    args.restaurantId,
    args.paymentId,
  );
  if (!row?.square_terminal_checkout_id)
    return { ok: false, error: "That payment wasn't found." };
  if (row.status === "succeeded")
    return {
      ok: true,
      outcome: { state: "paid", tip: Number(row.tip_amount) },
    };
  if (row.status === "cancelled")
    return { ok: true, outcome: { state: "cancelled" } };

  try {
    const checkout = await getTerminalCheckout(
      args.restaurantId,
      row.square_terminal_checkout_id,
    );
    if (checkout.status === "CANCELED") {
      await supabase.rpc("cancel_square_terminal_payment", {
        p_payment_id: args.paymentId,
      });
      return { ok: true, outcome: { state: "cancelled" } };
    }
    if (checkout.status !== "COMPLETED" || checkout.paymentIds.length === 0) {
      return { ok: true, outcome: { state: "waiting" } };
    }
    const payment = await getPayment(args.restaurantId, checkout.paymentIds[0]);
    if (payment.status !== "COMPLETED")
      return { ok: true, outcome: { state: "waiting" } };
    const result = await settleFromSquare(payment);
    if (result === "settled" || result === "already") {
      const minor = payment.currency === "JPY" ? 1 : 100;
      return {
        ok: true,
        outcome: { state: "paid", tip: payment.tipMinorUnits / minor },
      };
    }
    report(
      new Error(`Terminal payment not settled: ${result}`),
      "square.terminal.settle",
      {
        paymentId: args.paymentId,
      },
    );
    return {
      ok: false,
      error:
        "Square took the card, but Tableside couldn't match it to this bill. Check Square's transactions before taking payment again.",
    };
  } catch (e) {
    report(e, "square.terminal.check", { paymentId: args.paymentId });
    return {
      ok: false,
      error: "Couldn't reach Square. Try again in a moment.",
    };
  }
}

export async function cancelTerminal(args: {
  supabase: unknown;
  restaurantId: string;
  paymentId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = args.supabase as SupabaseClient;
  const row = await loadTerminalPayment(
    supabase,
    args.restaurantId,
    args.paymentId,
  );
  if (!row?.square_terminal_checkout_id)
    return { ok: false, error: "That payment wasn't found." };
  if (row.status === "succeeded")
    return { ok: false, error: "This bill has already been paid." };
  try {
    const checkout = await cancelTerminalCheckout(
      args.restaurantId,
      row.square_terminal_checkout_id,
    );
    // A checkout the diner already paid can't be cancelled; let the next
    // check settle it rather than marking it cancelled here.
    if (checkout.status === "COMPLETED") {
      return {
        ok: false,
        error: "The card already went through. Checking the payment instead.",
      };
    }
  } catch (e) {
    report(e, "square.terminal.cancel", { paymentId: args.paymentId });
    return { ok: false, error: "Couldn't cancel on the Terminal. Try again." };
  }
  await supabase.rpc("cancel_square_terminal_payment", {
    p_payment_id: args.paymentId,
  });
  return { ok: true };
}

/**
 * Copy a cash payment staff just recorded into Square as a cash sale, so
 * Square's reports include cash. Best effort: the cash is already recorded
 * in Tableside whatever happens here, and a failure is reported, not shown
 * to the staff member mid-service.
 */
/**
 * Copies a cash or card-machine payment into Square's reports
 * (20261118090000): the itemised orders, or, for part of a split bill,
 * one line for exactly that part. Best effort; returns whether it reached
 * Square, and anything that didn't is listed on Settings → Point of sale
 * (square_unsynced()) to send again.
 */
export async function copyInPersonSaleToSquare(args: {
  supabase: unknown;
  paymentId: string;
}): Promise<boolean> {
  const supabase = args.supabase as SupabaseClient;
  try {
    const { data: payment } = await supabase
      .from("order_payments")
      .select(
        "restaurant_id, amount, tip_amount, currency, method, square_payment_id, split_id",
      )
      .eq("id", args.paymentId)
      .maybeSingle();
    if (
      !payment ||
      (payment.method !== "cash" && payment.method !== "card_terminal")
    )
      return false;
    if (payment.square_payment_id) return true;
    // Only restaurants taking payments through Square copy sales there.
    const { data: provider } = await supabase.rpc("restaurant_card_provider", {
      p_restaurant_id: payment.restaurant_id,
    });
    if (provider !== "square") return false;
    const restaurantId: string = payment.restaurant_id;

    let lines: BillLine[];
    if (payment.split_id) {
      // A split part's payment covers no orders until the whole bill is
      // paid, and then covers whole orders it paid only part of: one line
      // for what this part came to.
      const { data: parts } = await supabase
        .from("tab_split_units")
        .select("label, position")
        .eq("payment_id", args.paymentId)
        .order("position");
      const label = ((parts ?? []) as { label: string }[])
        .map((p) => p.label)
        .join(", ");
      lines = [
        {
          order_id: args.paymentId,
          item_name: `Part of a split bill${label ? `: ${label}` : ""}`,
          options: null,
          quantity: 1,
          unit_amount: payment.amount,
          line_total: payment.amount,
          order_total: payment.amount,
        },
      ];
    } else {
      const { data, error: linesError } = await supabase.rpc(
        "payment_bill_lines",
        { p_payment_id: args.paymentId },
      );
      if (linesError) throw linesError;
      lines = (data ?? []) as BillLine[];
    }
    const requests = buildCashSaleRequests({
      paymentId: args.paymentId,
      locationId: await squareLocationFor(restaurantId),
      currency: payment.currency,
      amount: payment.amount,
      tipAmount: payment.tip_amount,
      lines,
      method: payment.method,
    });
    const squareOrderId = await createOrder(restaurantId, requests.createOrder);
    const squarePaymentId = await createCashPayment(
      restaurantId,
      requests.payment(squareOrderId),
    );
    const { error } = await supabase.rpc("attach_square_cash_sale", {
      p_payment_id: args.paymentId,
      p_square_order_id: squareOrderId,
      p_square_payment_id: squarePaymentId,
    });
    if (error) throw error;
    return true;
  } catch (e) {
    report(e, "square.in_person.copy", { paymentId: args.paymentId });
    return false;
  }
}
