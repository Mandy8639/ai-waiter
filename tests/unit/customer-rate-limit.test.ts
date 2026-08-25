import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { isSessionCreationRateLimited } from "@/lib/customer/rate-limit-core";

/**
 * Function-level tests for the per-table session-creation rate limiter —
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
      typeof isSessionCreationRateLimited
    >[0],
    rpc,
  };
}

const WINDOW = { maxPerWindow: 30, windowSeconds: 300 };

describe("isSessionCreationRateLimited", () => {
  it("is not rate limited when the count is below the threshold", async () => {
    const { client } = fakeSupabaseWithRpcResult(29);
    expect(await isSessionCreationRateLimited(client, "table-1", WINDOW)).toBe(
      false,
    );
  });

  it("is rate limited once the count reaches the threshold", async () => {
    const { client } = fakeSupabaseWithRpcResult(30);
    expect(await isSessionCreationRateLimited(client, "table-1", WINDOW)).toBe(
      true,
    );
  });

  it("is rate limited when the count exceeds the threshold", async () => {
    const { client } = fakeSupabaseWithRpcResult(45);
    expect(await isSessionCreationRateLimited(client, "table-1", WINDOW)).toBe(
      true,
    );
  });

  it("treats a null count as zero, not rate limited", async () => {
    const { client } = fakeSupabaseWithRpcResult(null);
    expect(await isSessionCreationRateLimited(client, "table-1", WINDOW)).toBe(
      false,
    );
  });

  it("fails open (not rate limited) on an RPC error", async () => {
    const { client } = fakeSupabaseWithRpcResult(999, {
      message: "connection reset",
    });
    expect(await isSessionCreationRateLimited(client, "table-1", WINDOW)).toBe(
      false,
    );
  });

  it("calls the RPC with the given table and configured window", async () => {
    const { client, rpc } = fakeSupabaseWithRpcResult(0);

    await isSessionCreationRateLimited(client, "table-abc", WINDOW);

    expect(rpc).toHaveBeenCalledWith("count_recent_sessions_for_table", {
      p_table_id: "table-abc",
      p_window_seconds: 300,
    });
  });

  it("respects a different configured threshold", async () => {
    const tight = { maxPerWindow: 3, windowSeconds: 300 };
    expect(
      await isSessionCreationRateLimited(
        fakeSupabaseWithRpcResult(3).client,
        "table-1",
        tight,
      ),
    ).toBe(true);
    expect(
      await isSessionCreationRateLimited(
        fakeSupabaseWithRpcResult(2).client,
        "table-1",
        tight,
      ),
    ).toBe(false);
  });
});
