import { describe, expect, it } from "vitest";
import {
  afterAttempt,
  isClaimable,
  retryDelaySeconds,
  MAX_ATTEMPTS,
} from "@/lib/pos/outbox-core";

describe("retryDelaySeconds", () => {
  it("backs off exponentially", () => {
    expect(retryDelaySeconds(1)).toBe(15);
    expect(retryDelaySeconds(2)).toBe(30);
    expect(retryDelaySeconds(3)).toBe(60);
  });

  it("caps the delay", () => {
    // Without a ceiling the eighth retry is hours out, and an order that
    // reaches the till after the diner has eaten is not a recovered
    // order, it is a confusing one.
    expect(retryDelaySeconds(20)).toBe(15 * 60);
  });
});

describe("afterAttempt", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");

  it("marks a successful push delivered and stops retrying", () => {
    const r = afterAttempt({ ok: true, attemptsBefore: 2, now });
    expect(r.status).toBe("delivered");
    expect(r.nextAttemptAt).toBeNull();
    expect(r.lastError).toBeNull();
  });

  it("keeps a retryable failure PENDING, not 'failed'", () => {
    // A row saying "failed" while it is still going to be retried tells
    // whoever reads the dashboard the opposite of the truth.
    const r = afterAttempt({ ok: false, attemptsBefore: 0, error: "503", now });
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(1);
    expect(r.nextAttemptAt).toBe("2026-09-08T12:00:15.000Z");
    expect(r.lastError).toBe("503");
  });

  it("abandons once the attempts run out", () => {
    const r = afterAttempt({
      ok: false,
      attemptsBefore: MAX_ATTEMPTS - 1,
      error: "still down",
      now,
    });
    expect(r.status).toBe("abandoned");
    expect(r.nextAttemptAt).toBeNull();
  });

  it("bounds the stored error", () => {
    // A POS returning an HTML error page would otherwise put a whole
    // document in a column somebody reads in a dashboard.
    const r = afterAttempt({
      ok: false,
      attemptsBefore: 0,
      error: "x".repeat(5000),
      now,
    });
    expect(r.lastError!.length).toBe(500);
  });
});

describe("isClaimable", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");

  it("claims a pending row whose time has come", () => {
    expect(
      isClaimable(
        { status: "pending", nextAttemptAt: "2026-09-08T11:59:00.000Z" },
        now,
      ),
    ).toBe(true);
  });

  it("leaves a pending row that is not due yet", () => {
    expect(
      isClaimable(
        { status: "pending", nextAttemptAt: "2026-09-08T12:05:00.000Z" },
        now,
      ),
    ).toBe(false);
  });

  it.each(["delivered", "abandoned", "failed"] as const)(
    "never re-claims a %s row",
    (status) => {
      expect(
        isClaimable({ status, nextAttemptAt: "2026-01-01T00:00:00.000Z" }, now),
      ).toBe(false);
    },
  );

  it("treats an unreadable timestamp as due rather than stuck", () => {
    // A row that can never be claimed is an order the POS silently never
    // gets — the exact failure this whole table exists to prevent.
    expect(
      isClaimable({ status: "pending", nextAttemptAt: "nonsense" }, now),
    ).toBe(true);
  });
});
