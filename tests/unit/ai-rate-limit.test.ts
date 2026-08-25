import { describe, expect, it, vi } from "vitest";
import { isRateLimited } from "@/lib/ai/rate-limit-core";

/**
 * Function-level tests for the AI message rate limiter — previously
 * untested anywhere, despite AI being the most expensive attack surface
 * this app exposes (see the Item-6 production-reliability audit). A
 * small, purpose-built fake Supabase client — not a general mock library
 * — implementing only the exact chain shape rate-limit-core.ts uses
 * (.from().select().eq().eq().gte()), returning a controllable count.
 */
function fakeSupabaseWithCount(count: number) {
  const gte = vi.fn().mockResolvedValue({ count, error: null });
  const eqSecond = vi.fn(() => ({ gte }));
  const eqFirst = vi.fn(() => ({ eq: eqSecond }));
  const select = vi.fn(() => ({ eq: eqFirst }));
  const from = vi.fn(() => ({ select }));
  return {
    client: { from } as unknown as Parameters<typeof isRateLimited>[0],
    from,
    select,
    eqFirst,
    eqSecond,
    gte,
  };
}

const WINDOW = { windowMinutes: 5, maxMessagesPerWindow: 20 };

describe("isRateLimited (AI message rate limiter)", () => {
  it("is not rate limited when the count is below the threshold", async () => {
    const { client } = fakeSupabaseWithCount(19);
    expect(await isRateLimited(client, "session-1", WINDOW)).toBe(false);
  });

  it("is rate limited once the count reaches the threshold", async () => {
    const { client } = fakeSupabaseWithCount(20);
    expect(await isRateLimited(client, "session-1", WINDOW)).toBe(true);
  });

  it("is rate limited when the count exceeds the threshold", async () => {
    const { client } = fakeSupabaseWithCount(25);
    expect(await isRateLimited(client, "session-1", WINDOW)).toBe(true);
  });

  it("treats a null count (no rows matched) as zero, not rate limited", async () => {
    const gte = vi.fn().mockResolvedValue({ count: null, error: null });
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ eq: vi.fn(() => ({ gte })) })),
        })),
      })),
    } as unknown as Parameters<typeof isRateLimited>[0];

    expect(await isRateLimited(client, "session-1", WINDOW)).toBe(false);
  });

  it("scopes the query to this exact customer session and role='user'", async () => {
    const { client, from, select, eqFirst, eqSecond } =
      fakeSupabaseWithCount(0);

    await isRateLimited(client, "session-abc", WINDOW);

    expect(from).toHaveBeenCalledWith("ai_conversation_messages");
    expect(select).toHaveBeenCalledWith("id", {
      count: "exact",
      head: true,
    });
    expect(eqFirst).toHaveBeenCalledWith("customer_session_id", "session-abc");
    expect(eqSecond).toHaveBeenCalledWith("role", "user");
  });

  it("filters to the configured trailing window, not all-time history", async () => {
    const { client, gte } = fakeSupabaseWithCount(0);
    const before = Date.now();

    await isRateLimited(client, "session-1", {
      windowMinutes: 5,
      maxMessagesPerWindow: 20,
    });

    expect(gte).toHaveBeenCalledWith("created_at", expect.any(String));
    const windowStartArg = gte.mock.calls[0][1] as string;
    const windowStartMs = new Date(windowStartArg).getTime();
    // Roughly "now minus 5 minutes" — bounded, not an exact-timestamp match,
    // since a few ms pass between `before` and the call inside the function.
    expect(before - windowStartMs).toBeGreaterThanOrEqual(5 * 60_000 - 100);
    expect(before - windowStartMs).toBeLessThanOrEqual(5 * 60_000 + 5_000);
  });

  it("respects a different configured threshold", async () => {
    const { client } = fakeSupabaseWithCount(3);
    expect(
      await isRateLimited(client, "session-1", {
        windowMinutes: 5,
        maxMessagesPerWindow: 3,
      }),
    ).toBe(true);
    expect(
      await isRateLimited(client, "session-1", {
        windowMinutes: 5,
        maxMessagesPerWindow: 4,
      }),
    ).toBe(false);
  });
});
