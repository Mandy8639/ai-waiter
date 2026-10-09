import { describe, expect, it, vi } from "vitest";
import { retryDraft, type DraftAttempt } from "@/lib/ai/free-draft-core";

/**
 * Owner-side AI drafting retries, because the free router is uneven: it
 * sometimes doesn't answer, and once answered with a content-safety
 * model's "User Safety: safe" — a reply with nothing usable in it.
 */

const usable = (m: Map<string, string>) => m.size > 0;
const ok = (
  entries: Array<[string, string]>,
): DraftAttempt<Map<string, string>> => ({
  ok: true,
  value: new Map(entries),
});
const failed: DraftAttempt<Map<string, string>> = {
  ok: false,
  reason: "failed",
};

/** A clock that only moves when an attempt "takes" time. */
function fakeClock() {
  let t = 0;
  return { now: () => t, spend: (ms: number) => (t += ms) };
}

describe("retryDraft", () => {
  it("returns the first usable answer without retrying", async () => {
    const attempt = vi.fn(async () => ok([["f0", "मसाला डोसा"]]));
    const result = await retryDraft(attempt, { usable });
    expect(result).toEqual(ok([["f0", "मसाला डोसा"]]));
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries a failure and an answer with nothing usable in it", async () => {
    const attempt = vi
      .fn<(timeoutMs: number) => Promise<DraftAttempt<Map<string, string>>>>()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(ok([])) // "User Safety: safe" parses to nothing
      .mockResolvedValueOnce(ok([["f0", "Masala dosa"]]));
    const result = await retryDraft(attempt, { usable });
    expect(result).toEqual(ok([["f0", "Masala dosa"]]));
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("gives up after three attempts and reports the last result", async () => {
    const attempt = vi.fn(async () => ok([]));
    const result = await retryDraft(attempt, { usable });
    expect(attempt).toHaveBeenCalledTimes(3);
    // The model answered; nothing passed the checks. The caller tells the
    // owner "couldn't give usable drafts", not "didn't answer".
    expect(result).toEqual(ok([]));
  });

  it("stays inside the time budget, shrinking the last attempt's timeout", async () => {
    const clock = fakeClock();
    const timeouts: number[] = [];
    const attempt = vi.fn(async (timeoutMs: number) => {
      timeouts.push(timeoutMs);
      clock.spend(timeoutMs); // each attempt times out
      return failed;
    });
    const result = await retryDraft(attempt, { usable, now: clock.now });
    // 45 s budget: a full 30 s attempt, then the 15 s that's left, then stop.
    expect(timeouts).toEqual([30_000, 15_000]);
    expect(result).toEqual(failed);
  });

  it("doesn't start an attempt with under five seconds left", async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async () => {
      clock.spend(41_000);
      return failed;
    });
    await retryDraft(attempt, { usable, now: clock.now });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
