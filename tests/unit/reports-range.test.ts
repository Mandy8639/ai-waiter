import { describe, expect, it } from "vitest";
import {
  isRangePreset,
  localDate,
  rangeBounds,
  shiftDate,
} from "@/lib/reports/range";

// The bug these guard against is quiet: a range computed in the wrong zone
// shows yesterday's takings without looking broken.
describe("localDate", () => {
  it("uses the restaurant's zone, not UTC", () => {
    // 00:30 UTC on the 2nd is still the 1st in New York.
    const instant = new Date("2026-06-02T00:30:00Z");
    expect(localDate(instant, "UTC")).toBe("2026-06-02");
    expect(localDate(instant, "America/New_York")).toBe("2026-06-01");
  });

  it("handles a zone ahead of UTC", () => {
    // 23:30 UTC on the 1st is already the 2nd in Tokyo.
    const instant = new Date("2026-06-01T23:30:00Z");
    expect(localDate(instant, "Asia/Tokyo")).toBe("2026-06-02");
  });
});

describe("shiftDate", () => {
  it("moves whole days", () => {
    expect(shiftDate("2026-06-15", -1)).toBe("2026-06-14");
    expect(shiftDate("2026-06-15", 1)).toBe("2026-06-16");
  });

  it("crosses month and year boundaries", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("handles a leap day", () => {
    expect(shiftDate("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("does not drift across a DST change", () => {
    // Date-only arithmetic must not lose or gain an hour and roll into
    // the wrong day. 2026-03-08 is a US DST start.
    expect(shiftDate("2026-03-08", -1)).toBe("2026-03-07");
    expect(shiftDate("2026-03-07", 1)).toBe("2026-03-08");
  });
});

describe("rangeBounds", () => {
  const nyNoon = new Date("2026-06-15T16:00:00Z"); // noon in New York

  it("starts today at local midnight, not UTC midnight", () => {
    const r = rangeBounds("today", "America/New_York", nyNoon);
    // Midnight in New York on 15 June (EDT, UTC-4) is 04:00Z.
    expect(r.from).toBe("2026-06-15T04:00:00.000Z");
  });

  it("ends at tomorrow's local midnight so later payments still count", () => {
    // A range ending at "now" would make the page mean something
    // different depending on when it was loaded.
    const r = rangeBounds("today", "America/New_York", nyNoon);
    expect(r.to).toBe("2026-06-16T04:00:00.000Z");
    expect(new Date(r.to).getTime()).toBeGreaterThan(nyNoon.getTime());
  });

  it("covers seven calendar days including today for 7d", () => {
    const r = rangeBounds("7d", "America/New_York", nyNoon);
    expect(r.from).toBe("2026-06-09T04:00:00.000Z");
    expect(r.to).toBe("2026-06-16T04:00:00.000Z");
  });

  it("covers thirty calendar days including today for 30d", () => {
    const r = rangeBounds("30d", "America/New_York", nyNoon);
    expect(r.from).toBe("2026-05-17T04:00:00.000Z");
  });

  it("gives a different window in a different zone", () => {
    const ny = rangeBounds("today", "America/New_York", nyNoon);
    const tokyo = rangeBounds("today", "Asia/Tokyo", nyNoon);
    expect(ny.from).not.toBe(tokyo.from);
  });

  it("produces a half-open range that abuts the next day exactly", () => {
    // Consecutive days must not double-count a payment landing on the
    // boundary, and must not drop it either.
    const day1 = rangeBounds("today", "UTC", new Date("2026-06-15T12:00:00Z"));
    const day2 = rangeBounds("today", "UTC", new Date("2026-06-16T12:00:00Z"));
    expect(day1.to).toBe(day2.from);
  });

  it("tracks the DST shift rather than assuming a fixed offset", () => {
    // London is UTC+0 in winter and UTC+1 in summer; midnight local is a
    // different instant in each.
    const winter = rangeBounds(
      "today",
      "Europe/London",
      new Date("2026-01-15T12:00:00Z"),
    );
    const summer = rangeBounds(
      "today",
      "Europe/London",
      new Date("2026-07-15T12:00:00Z"),
    );
    expect(winter.from).toBe("2026-01-15T00:00:00.000Z");
    expect(summer.from).toBe("2026-07-14T23:00:00.000Z");
  });
});

describe("isRangePreset", () => {
  it("accepts the known presets", () => {
    expect(isRangePreset("today")).toBe(true);
    expect(isRangePreset("7d")).toBe(true);
    expect(isRangePreset("30d")).toBe(true);
  });

  it("rejects anything else, including junk from a query string", () => {
    for (const v of ["", "1d", "all", null, undefined, 7, {}]) {
      expect(isRangePreset(v)).toBe(false);
    }
  });
});
