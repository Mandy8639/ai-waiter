// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DINER_CONFIRMATIONS,
  DINER_LABELS,
  OVERDUE_AFTER_MS,
  REQUEST_KINDS,
  STAFF_LABELS,
  isOverdue,
  isRequestKind,
  requestErrorMessage,
  tableLabel,
  waitingLabel,
} from "@/lib/table-requests/core";

/**
 * The words and the waiting maths. Both are pure, and both are read by a
 * person under time pressure — a diner who wants someone, or a floor
 * manager scanning a queue mid-service — so they are worth pinning.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;

describe("request kinds", () => {
  it("accepts only the two kinds the database allows", () => {
    expect(REQUEST_KINDS).toEqual(["waiter", "bill"]);
    expect(isRequestKind("waiter")).toBe(true);
    expect(isRequestKind("bill")).toBe(true);
    expect(isRequestKind("dessert")).toBe(false);
    expect(isRequestKind(undefined)).toBe(false);
  });

  it("has diner and staff wording for every kind", () => {
    // A kind added without its words would render a raw enum value at a
    // table.
    for (const kind of REQUEST_KINDS) {
      expect(DINER_LABELS[kind]).toBeTruthy();
      expect(DINER_CONFIRMATIONS[kind]).toBeTruthy();
      expect(STAFF_LABELS[kind]).toBeTruthy();
    }
  });

  it("confirms in the past tense, because by then it has happened", () => {
    expect(DINER_CONFIRMATIONS.waiter).toMatch(/on their way/i);
    expect(DINER_CONFIRMATIONS.bill).toMatch(/asked/i);
  });
});

describe("waitingLabel", () => {
  it("reads 'just now' under a minute — nobody has ignored it yet", () => {
    expect(waitingLabel(ago(0), NOW)).toBe("just now");
    expect(waitingLabel(ago(59_000), NOW)).toBe("just now");
  });

  it("counts whole minutes after that", () => {
    expect(waitingLabel(ago(MINUTE), NOW)).toBe("1 min");
    expect(waitingLabel(ago(7 * MINUTE), NOW)).toBe("7 min");
    expect(waitingLabel(ago(59 * MINUTE), NOW)).toBe("59 min");
  });

  it("stops counting precisely once it is embarrassing", () => {
    expect(waitingLabel(ago(60 * MINUTE), NOW)).toBe("over an hour");
    expect(waitingLabel(ago(150 * MINUTE), NOW)).toBe("over 2 hours");
  });

  it("never renders a negative wait from a clock that disagrees", () => {
    // The browser's clock and the database's are not the same clock.
    expect(waitingLabel(new Date(NOW.getTime() + 30_000), NOW)).toBe(
      "just now",
    );
  });
});

describe("isOverdue", () => {
  it("turns over at five minutes", () => {
    expect(isOverdue(ago(OVERDUE_AFTER_MS - 1), NOW)).toBe(false);
    expect(isOverdue(ago(OVERDUE_AFTER_MS), NOW)).toBe(true);
  });
});

describe("tableLabel", () => {
  it("prefers the name a restaurant chose", () => {
    expect(tableLabel("7", "Window booth")).toBe("Window booth");
  });

  it("falls back to the number, with a word in front of it", () => {
    expect(tableLabel("7", null)).toBe("Table 7");
    expect(tableLabel("7", "   ")).toBe("Table 7");
  });
});

describe("requestErrorMessage", () => {
  it("tells a diner what to do, not what went wrong", () => {
    expect(requestErrorMessage("TABLE_REQUEST_NO_SESSION")).toMatch(
      /scan the QR code/i,
    );
    expect(requestErrorMessage("TABLE_REQUEST_RATE_LIMITED")).toMatch(
      /shortly/i,
    );
  });

  it("never leaks the database's vocabulary", () => {
    const codes = [
      "TABLE_REQUEST_NO_SESSION",
      "TABLE_REQUEST_RATE_LIMITED",
      "TABLE_REQUEST_FORBIDDEN",
      "TABLE_REQUEST_NOT_OPEN",
      "TABLE_REQUEST_NOT_FOUND",
      "TABLE_REQUEST_INVALID_KIND",
    ];
    for (const code of codes) {
      const message = requestErrorMessage(code);
      expect(message).not.toContain("TABLE_REQUEST");
      expect(message).not.toMatch(/\b(row|constraint|null|sql)\b/i);
    }
  });

  it("has a safe answer for something it has never seen", () => {
    expect(requestErrorMessage("23505 duplicate key value")).toBe(
      "That didn't go through. Please try again.",
    );
  });
});
