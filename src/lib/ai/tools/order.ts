import "server-only";
import { estimateOrderPrep } from "@/lib/orders/prep-estimate";
import type { z } from "zod";
import { submitOrder } from "@/lib/orders/submit-order";
import { getOrderById, getOrdersForSession } from "@/lib/orders/queries";
import { getCart } from "@/lib/cart/get-cart";
import {
  getLatestUserMessageTimestamp,
  getLatestSuccessfulToolCall,
} from "../conversation";
import {
  computeCartFingerprint,
  checkOrderConfirmation,
  type PendingConfirmation,
} from "./order-confirmation";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import {
  requestOrderConfirmationSchema,
  submitOrderSchema,
  getOrderStatusSchema,
  getCustomerOrderHistorySchema,
} from "./schemas";

const CONFIRMATION_TOOL_NAME = "request_order_confirmation";

/**
 * Reads back the fingerprint a prior request_order_confirmation call
 * logged (see requestOrderConfirmationTool below) — never throws on
 * malformed/unexpected content, since a parse failure here must mean "no
 * valid confirmation," not a crash.
 */
function parsePendingConfirmation(
  row: { content: string; createdAt: string } | null,
): PendingConfirmation | null {
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content) as {
      data?: { cartFingerprint?: unknown };
    };
    const fingerprint = parsed.data?.cartFingerprint;
    if (typeof fingerprint !== "string") return null;
    return { fingerprint, requestedAt: row.createdAt };
  } catch {
    return null;
  }
}

/**
 * submit_order here is a thin wrapper around the SAME submitOrder() used
 * by the customer-facing "Place order" button (src/lib/orders/submit-order.ts)
 * — which itself only ever calls the submit_order() Postgres function
 * (docs/database.md#order-submission-submit_order). There is no
 * AI-specific order-creation path; this tool cannot do anything the
 * normal checkout flow couldn't already do, and every price/availability
 * re-check submit_order() performs applies here identically.
 *
 * The idempotency key is never a model argument (spec section 14) — it's
 * `context.turnIdempotencyKey`, generated once per customer turn by the
 * orchestrator before the model is even called, so a model retry within
 * the same turn reuses it and collapses into the existing idempotency
 * mechanism rather than risking a second order.
 *
 * order lookups never accept an order id from the model (spec section
 * 15) — "what's my order status" and "show my orders" both derive the
 * order(s) from the caller's own customer session, the same ownership
 * check requireActiveCustomerSession()/getOrdersForSession() already
 * enforce for the customer-facing order pages.
 */

/**
 * Shows the customer the real, server-computed cart summary and total —
 * exactly the data get_cart already returns — and, as its side effect
 * (via the orchestrator's existing generic tool-call logging, unchanged),
 * durably records "a confirmation was requested for cart-fingerprint X at
 * time Y" for this session. That record, not anything the model claims,
 * is what submit_order checks below.
 */
async function requestOrderConfirmation(
  _args: z.infer<typeof requestOrderConfirmationSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const cart = await getCart(context.restaurantId, context.customerSessionId);
  if (cart.lines.length === 0) {
    return {
      ok: false,
      error: "The cart is empty — add something before requesting a total.",
    };
  }

  return {
    ok: true,
    data: {
      lines: cart.lines.map((line) => ({
        name: line.menuItemName,
        quantity: line.quantity,
        modifiers: line.modifiers.map((m) => m.name),
        lineTotal: line.lineTotal,
      })),
      subtotal: cart.subtotal,
      taxAmount: cart.taxAmount,
      total: cart.total,
      // Internal bookkeeping value, harmless if the model sees it in its
      // own context — submit_order never accepts this (or anything like
      // it) as an argument, it only ever reads the server's own log of
      // this call back from the database. See order-confirmation.ts.
      cartFingerprint: computeCartFingerprint(cart.lines),
    },
  };
}

/**
 * Blocked until a request_order_confirmation call for the CURRENT cart
 * contents was logged in an earlier turn (see order-confirmation.ts for
 * the exact rule) — never trusts the model's own claim that the customer
 * confirmed, and never accepts a confirmation id/token/hash as an
 * argument (submitOrderSchema is unchanged: customerNote only).
 */
async function submitOrderTool(
  args: z.infer<typeof submitOrderSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const [cart, latestUserMessageAt] = await Promise.all([
    getCart(context.restaurantId, context.customerSessionId),
    getLatestUserMessageTimestamp(context.customerSessionId),
  ]);

  // The confirmation lookup depends on latestUserMessageAt (it's the
  // "before" boundary), so it can't run in the Promise.all above — this
  // is the actual fix: filtering at the query level means a same-turn
  // request_order_confirmation re-verification (the model double-checking
  // the cart before calling submit_order) can never shadow a still-valid
  // confirmation from an earlier turn, because the query simply never
  // returns it as a candidate in the first place.
  const latestConfirmationCall = latestUserMessageAt
    ? await getLatestSuccessfulToolCall(
        context.customerSessionId,
        CONFIRMATION_TOOL_NAME,
        latestUserMessageAt,
      )
    : null;

  const decision = checkOrderConfirmation({
    pending: parsePendingConfirmation(latestConfirmationCall),
    currentFingerprint: computeCartFingerprint(cart.lines),
    currentTurnUserMessageAt: latestUserMessageAt,
  });

  if (!decision.confirmed) {
    return { ok: false, error: decision.reason };
  }

  const result = await submitOrder(
    context.turnIdempotencyKey,
    args.customerNote,
  );
  if (result.error) return { ok: false, error: result.error };

  return {
    ok: true,
    data: { orderId: result.orderId },
  };
}

async function getOrderStatus(
  _args: z.infer<typeof getOrderStatusSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const orders = await getOrdersForSession(context.customerSessionId);
  if (orders.length === 0) {
    return {
      ok: false,
      error: "No orders have been placed in this session yet.",
    };
  }

  const mostRecent = await getOrderById(orders[0].id);
  if (!mostRecent) return { ok: false, error: "Couldn't load that order." };

  // "How long will it be?" is the question a diner asks immediately after
  // ordering, and this tool could not answer it: it returned the status,
  // the total and the items, and nothing about time. The model fell back
  // to get_menu_item and quoted one drink's preparation time instead.
  const estimate = estimateOrderPrep({
    itemPrepMinutes: mostRecent.items.map((i) => i.prepMinutes),
    status: mostRecent.status,
    placedAt: mostRecent.createdAt,
  });

  return {
    ok: true,
    data: {
      orderNumber: mostRecent.orderNumber,
      status: mostRecent.status,
      total: mostRecent.total,
      currency: mostRecent.currency,
      createdAt: mostRecent.createdAt,
      // The whole order, not one dish: the longest item gates the plate.
      // null means no dish on the order has a recorded preparation time —
      // say the kitchen hasn't given a time, never guess one.
      estimatedTotalMinutes: estimate.totalMinutes,
      // Already accounts for how long ago the order was placed, so this
      // can be read out directly rather than worked out from createdAt.
      estimatedMinutesRemaining: estimate.minutesRemaining,
      items: mostRecent.items.map((i) => ({
        name: i.itemName,
        quantity: i.quantity,
        modifiers: i.modifiers.map((m) => m.optionName),
      })),
    },
  };
}

async function getCustomerOrderHistory(
  _args: z.infer<typeof getCustomerOrderHistorySchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const orders = await getOrdersForSession(context.customerSessionId);
  return {
    ok: true,
    data: {
      orders: orders.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        total: o.total,
        currency: o.currency,
        createdAt: o.createdAt,
      })),
    },
  };
}

export const orderTools: ToolDefinition[] = [
  {
    name: "request_order_confirmation",
    description:
      "Get the real, current cart summary and total, and show it to the customer, asking if they'd like you to place the order. Always call this before submit_order, in an earlier message — submit_order will be rejected if the customer hasn't separately confirmed a summary you showed them this way, even if they say something like 'place the order' or 'go ahead'.",
    schema: requestOrderConfirmationSchema,
    execute: requestOrderConfirmation as ToolDefinition["execute"],
  },
  {
    name: "submit_order",
    description:
      "Submit the customer's current cart as a real order. This will be REJECTED unless you already called request_order_confirmation in an earlier message and the customer then clearly said yes in a new, separate message. Never call this in the same turn as request_order_confirmation, and never call it on the customer's first request to order — always show the summary first and wait for their next message.",
    schema: submitOrderSchema,
    execute: submitOrderTool as ToolDefinition["execute"],
  },
  {
    name: "get_order_status",
    description:
      "Get the status and details of the customer's most recent order in this visit, including how long the whole order takes and how many minutes are left. Use this — never get_menu_item — when the customer asks how long their ORDER will be; get_menu_item answers how long one DISH takes, which is a different question.",
    schema: getOrderStatusSchema,
    execute: getOrderStatus as ToolDefinition["execute"],
  },
  {
    name: "get_customer_order_history",
    description:
      "List every order the customer has placed during this visit (this table session).",
    schema: getCustomerOrderHistorySchema,
    execute: getCustomerOrderHistory as ToolDefinition["execute"],
  },
];
