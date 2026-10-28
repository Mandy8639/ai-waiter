import { describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../../src/lib/supabase/fetch-timeout";

// A request to an overloaded Supabase must fail in seconds, not hang until
// Node's 300 s limit: one hung request froze a kitchen tablet for six
// minutes in the 2026-10-28 busy-night simulation.

/** A fetch that never answers, but stops when its signal aborts. */
const hangingFetch = vi.fn(
  (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason),
      );
    }),
) as unknown as typeof fetch;

describe("fetchWithTimeout", () => {
  it("gives up on a request that never answers", async () => {
    const started = Date.now();
    await expect(
      fetchWithTimeout(
        50,
        hangingFetch,
      )("https://example.supabase.co/rest/v1/orders"),
    ).rejects.toThrow(/timeout|aborted/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still honours the caller's own abort", async () => {
    const controller = new AbortController();
    const pending = fetchWithTimeout(60_000, hangingFetch)("https://x.test", {
      signal: controller.signal,
    });
    controller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });

  it("passes the request through untouched otherwise", async () => {
    const ok = vi.fn(async () => new Response("[]")) as unknown as typeof fetch;
    const res = await fetchWithTimeout(1000, ok)("https://x.test/a", {
      method: "POST",
      body: "{}",
    });
    expect(await res.text()).toBe("[]");
    expect(ok).toHaveBeenCalledWith(
      "https://x.test/a",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });
});
