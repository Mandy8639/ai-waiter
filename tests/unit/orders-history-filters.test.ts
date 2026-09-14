import { describe, expect, it } from "vitest";
import {
  HISTORY_RANGES,
  ORDER_STATUSES,
  escapeLikePattern,
  historyHref,
  isHistoryRange,
  parseHistoryFilters,
  parseOrderNumber,
} from "@/lib/orders/history-filters";

/**
 * The order history page's filters come straight from the URL, so these
 * are the rules deciding how much work a stranger can ask the database to
 * do, and whether a filter that looks applied actually is.
 */

describe("parseHistoryFilters", () => {
  it("defaults to today, every status, no search, first page", () => {
    expect(parseHistoryFilters({})).toEqual({
      range: "today",
      status: null,
      search: "",
      page: 0,
    });
  });

  it.each(HISTORY_RANGES)("accepts the %s range", (range) => {
    expect(parseHistoryFilters({ range }).range).toBe(range);
  });

  it("falls back to today for a range it does not offer", () => {
    expect(parseHistoryFilters({ range: "since-the-dawn-of-time" }).range).toBe(
      "today",
    );
  });

  it.each(ORDER_STATUSES)("accepts the %s status", (status) => {
    expect(parseHistoryFilters({ status }).status).toBe(status);
  });

  it("ignores a status that is not a real order status", () => {
    // Narrows to nothing rather than silently showing everything: a
    // filter that quietly does not apply is worse than an empty list.
    expect(parseHistoryFilters({ status: "refunded" }).status).toBeNull();
  });

  it("trims the search and caps its length", () => {
    expect(parseHistoryFilters({ q: "  biryani  " }).search).toBe("biryani");
    expect(parseHistoryFilters({ q: "x".repeat(500) }).search).toHaveLength(
      100,
    );
  });

  it.each([
    ["-1", 0],
    ["0", 0],
    ["abc", 0],
    ["1.5", 0],
    ["", 0],
    ["3", 3],
  ])("clamps page %s to %i", (input, expected) => {
    expect(parseHistoryFilters({ page: input }).page).toBe(expected);
  });

  it("rejects a page number too large to be exact", () => {
    expect(parseHistoryFilters({ page: "999999999999999999999" }).page).toBe(0);
  });
});

describe("parseOrderNumber", () => {
  it.each([
    ["42", 42],
    ["#42", 42],
    ["  #7  ", 7],
  ])("reads %s as an order number", (input, expected) => {
    expect(parseOrderNumber(input)).toBe(expected);
  });

  it.each(["biryani", "", "4a2", "-1", "0", "1.5", "9007199254740993"])(
    "treats %s as text, not an order number",
    (input) => {
      expect(parseOrderNumber(input)).toBeNull();
    },
  );
});

describe("escapeLikePattern", () => {
  it("escapes wildcards so a search means what it says", () => {
    // Without this, searching "100%" matches every dish on the menu.
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
  });

  it("escapes the escape character first", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeLikePattern("chicken biryani")).toBe("chicken biryani");
  });
});

describe("historyHref", () => {
  it("omits defaults so a plain link stays plain", () => {
    expect(historyHref({ range: "today", page: 0 })).toBe("/dashboard/orders");
  });

  it("carries the filters that differ from the default", () => {
    expect(
      historyHref({
        range: "30d",
        status: "served",
        search: "biryani",
        page: 2,
      }),
    ).toBe("/dashboard/orders?range=30d&status=served&q=biryani&page=2");
  });

  it("encodes a search that would otherwise break the URL", () => {
    expect(historyHref({ search: "a&b=c" })).toContain("q=a%26b%3Dc");
  });
});

describe("isHistoryRange", () => {
  it("accepts only the offered ranges", () => {
    expect(isHistoryRange("7d")).toBe(true);
    expect(isHistoryRange("all")).toBe(true);
    expect(isHistoryRange("1y")).toBe(false);
    expect(isHistoryRange(null)).toBe(false);
  });
});
