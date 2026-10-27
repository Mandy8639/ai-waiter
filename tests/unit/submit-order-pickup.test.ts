// submitOrder() at a pickup counter: the choice is saved on the cart
// before the order is placed, a bad choice comes back as the database's
// own sentence, and a retry of an order that already went through lands
// on that order even when its slot has filled since.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/customer/session", () => ({
  requireActiveCustomerSession: async () => ({
    ok: true,
    session: { id: "session-1" },
  }),
}));
vi.mock("@/lib/orders/rate-limit", () => ({
  isOrderSubmissionRateLimited: async () => false,
}));
vi.mock("@/lib/push/dispatch", () => ({ scheduleOrderPush: vi.fn() }));
vi.mock("@/lib/pos/clover/deliver", () => ({
  scheduleCloverDelivery: vi.fn(),
}));

const pickupRpc = vi.fn();
vi.mock("@/lib/pickup/queries", () => ({
  pickupRpc: async () => pickupRpc,
}));

const submitRpc = vi.fn();
const placed = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: submitRpc,
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: placed }) }),
      }),
    }),
  }),
}));

import { submitOrder } from "@/lib/orders/submit-order";

const choice = { at: "2026-10-19T16:30:00.000Z", name: "Priya" };

afterEach(() => vi.clearAllMocks());

describe("submitOrder with a pickup choice", () => {
  it("saves the choice, then places the order", async () => {
    pickupRpc.mockResolvedValue({ error: null });
    submitRpc.mockResolvedValue({ data: { id: "order-1" }, error: null });

    expect(await submitOrder("key-1", undefined, choice)).toEqual({
      orderId: "order-1",
    });
    expect(pickupRpc).toHaveBeenCalledWith("set_cart_pickup", {
      p_pickup_at: choice.at,
      p_pickup_name: "Priya",
    });
    expect(submitRpc).toHaveBeenCalledWith("submit_order", {
      p_idempotency_key: "key-1",
      p_customer_note: null,
    });
  });

  it("returns the database's reason when the time can't be used", async () => {
    pickupRpc.mockResolvedValue({
      error: {
        message:
          "ORDER_PICKUP: That pickup time just filled up. Please choose another.",
      },
    });
    placed.mockResolvedValue({ data: null });

    expect(await submitOrder("key-2", undefined, choice)).toEqual({
      error: "That pickup time just filled up. Please choose another.",
    });
    expect(submitRpc).not.toHaveBeenCalled();
  });

  it("lands on the order already placed when a retry finds its slot full", async () => {
    pickupRpc.mockResolvedValue({
      error: { message: "ORDER_PICKUP: That pickup time just filled up." },
    });
    placed.mockResolvedValue({ data: { id: "order-already" } });

    expect(await submitOrder("key-3", undefined, choice)).toEqual({
      orderId: "order-already",
    });
    expect(submitRpc).not.toHaveBeenCalled();
  });

  it("refuses a malformed choice before calling anything", async () => {
    expect(
      await submitOrder("key-4", undefined, { at: "noon", name: "Priya" }),
    ).toEqual({ error: "Choose a pickup time." });
    expect(
      await submitOrder("key-4", undefined, { at: choice.at, name: "  " }),
    ).toEqual({ error: "Add the name we should call out at pickup." });
    expect(pickupRpc).not.toHaveBeenCalled();
  });
});
