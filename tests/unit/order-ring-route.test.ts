// @vitest-environment node
//
// The order-ring endpoint is called by a Supabase pg_cron job every 30
// seconds while an order is waiting (20261012090000_order_ring.sql). It
// reaches the service-role sender, so it must refuse everyone without the
// shared secret, and everyone at all when the secret isn't set.
import { afterEach, describe, expect, it, vi } from "vitest";

const ringPendingOrders = vi.fn(async () => ({ rung: 2 }));
vi.mock("@/lib/push/dispatch", () => ({ ringPendingOrders }));

const { POST, GET } = await import("@/app/api/cron/order-ring/route");

function call(handler: typeof POST, authorization?: string) {
  return handler(
    new Request("https://tableside.menu/api/cron/order-ring", {
      method: "POST",
      headers: authorization ? { authorization } : {},
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  ringPendingOrders.mockClear();
});

describe("the order-ring endpoint", () => {
  it("refuses everything when ORDER_RING_SECRET isn't set", async () => {
    vi.stubEnv("ORDER_RING_SECRET", "");
    const response = await call(POST, "Bearer ");
    expect(response.status).toBe(401);
    expect(ringPendingOrders).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong secret", async () => {
    vi.stubEnv("ORDER_RING_SECRET", "s3cret-value");
    for (const auth of [undefined, "Bearer nope", "s3cret-value"]) {
      expect((await call(POST, auth)).status, String(auth)).toBe(401);
    }
    expect(ringPendingOrders).not.toHaveBeenCalled();
  });

  it("rings with the right secret, by POST (pg_net) or GET", async () => {
    vi.stubEnv("ORDER_RING_SECRET", "s3cret-value");
    for (const handler of [POST, GET]) {
      const response = await call(handler, "Bearer s3cret-value");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ rung: 2 });
    }
    expect(ringPendingOrders).toHaveBeenCalledTimes(2);
  });

  it("doesn't take the daily-summary secret", async () => {
    vi.stubEnv("ORDER_RING_SECRET", "ring-secret");
    vi.stubEnv("CRON_SECRET", "cron-secret");
    expect((await call(POST, "Bearer cron-secret")).status).toBe(401);
  });
});
