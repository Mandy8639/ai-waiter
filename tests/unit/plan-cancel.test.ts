import { describe, expect, it } from "vitest";
import { cancelControlsFor } from "@/lib/billing/subscription-cancel-core";

/** "Cancel plan" / "Keep my plan" on the Payments page. */
describe("cancelControlsFor", () => {
  const sub = (status: string, cancelAtPeriodEnd = false) => ({
    status,
    currentPeriodEnd: "2026-11-21T00:00:00Z",
    cancelAtPeriodEnd,
  });

  it("offers Cancel on a live plan, active until the paid period ends", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      expect(cancelControlsFor(sub(status))).toEqual({
        kind: "can_cancel",
        activeUntil: "2026-11-21T00:00:00Z",
      });
    }
  });

  it("offers Keep my plan once it's set to end", () => {
    expect(cancelControlsFor(sub("active", true))).toEqual({
      kind: "ending",
      endsOn: "2026-11-21T00:00:00Z",
    });
  });

  it("offers nothing without a live plan", () => {
    expect(cancelControlsFor(null)).toEqual({ kind: "none" });
    for (const status of [
      "canceled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
    ]) {
      expect(cancelControlsFor(sub(status))).toEqual({ kind: "none" });
    }
  });
});
