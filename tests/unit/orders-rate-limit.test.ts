import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { isOrderSubmissionRateLimited } from "@/lib/orders/rate-limit-core";

/**
 * Function-level tests for the per-session order-submission rate limiter —
 * previously untested (see the Item-6 production-reliability audit). The
 * underlying RPC's own count/window behavior is covered in
 * tests/integration/db/abuse-protection-rpcs.test.ts; this file covers the
 * threshold comparison and fail-open behavior around it, mirroring
 * tests/unit/ai-rate-limit.test.ts's fake-client approach.
 */
function fakeSupabaseWithRpcResult(data: number | null, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return {
    client: { rpc } as unknown as Parameters<
      typeof isOrderSubmissionRateLimited
    >[0],
    rpc,
  };
}

const WINDOW = { maxPerWindow: 10, windowSeconds: 600 };

describe("isOrderSubmissionRateLimited", () => {
  it("is not rate limited when the count is below the threshold", async () => {
    const { client } = fakeSupabaseWithRpcResult(9);
    expect(
      await isOrderSubmissionRateLimited(client, "session-1", WINDOW),
    ).toBe(false);
  });

  it("is rate limited once the count reaches the threshold", async () => {
    const { client } = fakeSupabaseWithRpcResult(10);
    expect(
      await isOrderSubmissionRateLimited(client, "session-1", WINDOW),
    ).toBe(true);
  });

  it("is rate limited when the count exceeds the threshold", async () => {
    const { client } = fakeSupabaseWithRpcResult(15);
    expect(
      await isOrderSubmissionRateLimited(client, "session-1", WINDOW),
    ).toBe(true);
  });

  it("treats a null count as zero, not rate limited", async () => {
    const { client } = fakeSupabaseWithRpcResult(null);
    expect(
      await isOrderSubmissionRateLimited(client, "session-1", WINDOW),
    ).toBe(false);
  });

  it("fails open (not rate limited) on an RPC error", async () => {
    const { client } = fakeSupabaseWithRpcResult(999, {
      message: "connection reset",
    });
    expect(
      await isOrderSubmissionRateLimited(client, "session-1", WINDOW),
    ).toBe(false);
  });

  it("calls the RPC with the given session and configured window", async () => {
    const { client, rpc } = fakeSupabaseWithRpcResult(0);

    await isOrderSubmissionRateLimited(client, "session-abc", WINDOW);

    expect(rpc).toHaveBeenCalledWith("count_recent_orders_for_session", {
      p_customer_session_id: "session-abc",
      p_window_seconds: 600,
    });
  });

  it("respects a different configured threshold", async () => {
    const tight = { maxPerWindow: 3, windowSeconds: 600 };
    expect(
      await isOrderSubmissionRateLimited(
        fakeSupabaseWithRpcResult(3).client,
        "session-1",
        tight,
      ),
    ).toBe(true);
    expect(
      await isOrderSubmissionRateLimited(
        fakeSupabaseWithRpcResult(2).client,
        "session-1",
        tight,
      ),
    ).toBe(false);
  });
});
