import "server-only";
import type { z } from "zod";
import { submitOrder } from "@/lib/orders/submit-order";
import { getOrderById, getOrdersForSession } from "@/lib/orders/queries";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import {
  submitOrderSchema,
  getOrderStatusSchema,
  getCustomerOrderHistorySchema,
} from "./schemas";

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

async function submitOrderTool(
  args: z.infer<typeof submitOrderSchema>,
  context: ToolContext,
): Promise<ToolResult> {
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

  return {
    ok: true,
    data: {
      orderNumber: mostRecent.orderNumber,
      status: mostRecent.status,
      total: mostRecent.total,
      currency: mostRecent.currency,
      createdAt: mostRecent.createdAt,
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
    name: "submit_order",
    description:
      "Submit the customer's current cart as a real order — only call this after the customer has clearly confirmed the order summary (items, modifiers, and total) you gave them. Do not call this speculatively or to preview a total.",
    schema: submitOrderSchema,
    execute: submitOrderTool as ToolDefinition["execute"],
  },
  {
    name: "get_order_status",
    description:
      "Get the status and details of the customer's most recent order in this visit.",
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
