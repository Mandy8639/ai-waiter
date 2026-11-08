import { describe, expect, it } from "vitest";
import {
  OFFLINE_BANNER_AFTER_MS,
  dropLaterTapsFor,
  enqueueTap,
  queuedTapsLabel,
  shouldShowOfflineBanner,
} from "@/lib/offline/core";

describe("kitchen taps made offline", () => {
  it("keeps every step, in order", () => {
    let q = enqueueTap([], { orderId: "a", target: "confirmed" });
    q = enqueueTap(q, { orderId: "b", target: "confirmed" });
    q = enqueueTap(q, { orderId: "a", target: "preparing" });
    expect(q.map((t) => `${t.orderId}:${t.target}`)).toEqual([
      "a:confirmed",
      "b:confirmed",
      "a:preparing",
    ]);
  });

  it("treats a double press as one tap", () => {
    let q = enqueueTap([], { orderId: "a", target: "confirmed" });
    q = enqueueTap(q, { orderId: "a", target: "confirmed" });
    expect(q).toHaveLength(1);
  });

  it("drops a refused card's later steps but keeps other cards", () => {
    const q = [
      { orderId: "a", target: "preparing" },
      { orderId: "b", target: "confirmed" },
      { orderId: "a", target: "ready" },
    ];
    expect(dropLaterTapsFor(q, "a")).toEqual([
      { orderId: "b", target: "confirmed" },
    ]);
  });

  it("says how many are waiting", () => {
    expect(queuedTapsLabel(0)).toBeNull();
    expect(queuedTapsLabel(1)).toBe("1 tap waiting to send");
    expect(queuedTapsLabel(3)).toBe("3 taps waiting to send");
  });
});

describe("the offline banner", () => {
  it("waits out a short blip, then shows", () => {
    expect(shouldShowOfflineBanner(null, 1_000_000)).toBe(false);
    expect(shouldShowOfflineBanner(1_000_000, 1_000_000 + 5_000)).toBe(false);
    expect(
      shouldShowOfflineBanner(1_000_000, 1_000_000 + OFFLINE_BANNER_AFTER_MS),
    ).toBe(true);
  });
});
