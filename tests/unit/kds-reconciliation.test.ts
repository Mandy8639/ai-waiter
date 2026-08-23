import { describe, expect, it } from "vitest";
import {
  resolvePollIntervalMs,
  shouldPollNow,
  isStaleResync,
  hasNewPendingOrder,
  KDS_NORMAL_POLL_INTERVAL_MS,
  KDS_DEGRADED_POLL_INTERVAL_MS,
} from "@/components/kitchen/kds-reconciliation";

describe("resolvePollIntervalMs", () => {
  it("uses the normal (10-15s) interval while Realtime is connected", () => {
    expect(resolvePollIntervalMs(true)).toBe(KDS_NORMAL_POLL_INTERVAL_MS);
    expect(KDS_NORMAL_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(KDS_NORMAL_POLL_INTERVAL_MS).toBeLessThanOrEqual(15_000);
  });

  it("uses the degraded (2-3s) interval while Realtime is disconnected", () => {
    expect(resolvePollIntervalMs(false)).toBe(KDS_DEGRADED_POLL_INTERVAL_MS);
    expect(KDS_DEGRADED_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(2_000);
    expect(KDS_DEGRADED_POLL_INTERVAL_MS).toBeLessThanOrEqual(3_000);
  });

  it("the degraded interval is meaningfully faster than the normal one", () => {
    expect(KDS_DEGRADED_POLL_INTERVAL_MS).toBeLessThan(
      KDS_NORMAL_POLL_INTERVAL_MS,
    );
  });
});

describe("shouldPollNow", () => {
  it("is false while the tab is hidden", () => {
    expect(shouldPollNow("hidden")).toBe(false);
  });

  it("is true while the tab is visible", () => {
    expect(shouldPollNow("visible")).toBe(true);
  });
});

describe("isStaleResync", () => {
  it("is false when the response is still the most recently issued one", () => {
    expect(isStaleResync(3, 3)).toBe(false);
  });

  it("is true when a newer resync was issued after this one started (a slow poll resolving after a newer Realtime-triggered resync)", () => {
    expect(isStaleResync(1, 2)).toBe(true);
  });

  it("is true even if the stale call resolves after the newer one already applied", () => {
    // seq 2 was issued after seq 1; by the time seq 1's response arrives,
    // resyncSeqRef has already moved to 2 — seq 1 must be discarded
    // regardless of resolution order.
    expect(isStaleResync(1, 2)).toBe(true);
    expect(isStaleResync(2, 2)).toBe(false);
  });
});

describe("hasNewPendingOrder", () => {
  it("is false when there are no orders", () => {
    expect(hasNewPendingOrder([], new Set())).toBe(false);
  });

  it("is false when every order is already known", () => {
    const known = new Set(["a", "b"]);
    expect(
      hasNewPendingOrder(
        [
          { id: "a", status: "pending" },
          { id: "b", status: "confirmed" },
        ],
        known,
      ),
    ).toBe(false);
  });

  it("is true when a NEW pending order isn't in the known set", () => {
    const known = new Set(["a"]);
    expect(
      hasNewPendingOrder(
        [
          { id: "a", status: "pending" },
          { id: "new-order", status: "pending" },
        ],
        known,
      ),
    ).toBe(true);
  });

  it("is false when a new order exists but isn't pending (e.g. it's already confirmed) — only a genuinely new PENDING order should chime", () => {
    const known = new Set(["a"]);
    expect(
      hasNewPendingOrder(
        [
          { id: "a", status: "pending" },
          { id: "new-order", status: "confirmed" },
        ],
        known,
      ),
    ).toBe(false);
  });
});
