import { describe, expect, it } from "vitest";
import {
  formatReservationTime,
  resolveTimeZone,
  zonedWallClockToUtc,
} from "@/lib/reservations/timezone";

describe("zonedWallClockToUtc()", () => {
  it("treats the entry as the restaurant's local time, not UTC", () => {
    // 7pm on a January evening in New York is EST (UTC-5) -> midnight UTC.
    expect(zonedWallClockToUtc("2027-01-15T19:00", "America/New_York")).toBe(
      "2027-01-16T00:00:00.000Z",
    );
  });

  it("accounts for daylight saving time", () => {
    // The same 7pm in July is EDT (UTC-4) -> 23:00 UTC, an hour earlier
    // than the January case. A fixed offset would get one of these wrong.
    expect(zonedWallClockToUtc("2027-07-15T19:00", "America/New_York")).toBe(
      "2027-07-15T23:00:00.000Z",
    );
  });

  it("handles zones ahead of UTC, including half-hour offsets", () => {
    expect(zonedWallClockToUtc("2027-01-15T19:00", "Asia/Kolkata")).toBe(
      "2027-01-15T13:30:00.000Z",
    );
  });

  it("is the identity for a restaurant actually on UTC", () => {
    expect(zonedWallClockToUtc("2027-01-15T19:00", "UTC")).toBe(
      "2027-01-15T19:00:00.000Z",
    );
  });

  it("accepts a value that already carries seconds", () => {
    expect(zonedWallClockToUtc("2027-01-15T19:00:00", "America/New_York")).toBe(
      "2027-01-16T00:00:00.000Z",
    );
  });

  /**
   * The actual defect this module exists to fix: before it, "7pm" was
   * stored as 19:00Z regardless of where the restaurant was, so two
   * restaurants in different zones booked the same instant for what their
   * staff each called 7pm.
   */
  it("gives two restaurants in different zones different instants for the same wall clock", () => {
    const newYork = zonedWallClockToUtc("2027-01-15T19:00", "America/New_York");
    const london = zonedWallClockToUtc("2027-01-15T19:00", "Europe/London");
    const kolkata = zonedWallClockToUtc("2027-01-15T19:00", "Asia/Kolkata");

    expect(new Set([newYork, london, kolkata]).size).toBe(3);
  });

  it("returns null for a malformed value rather than storing something wrong", () => {
    for (const bad of ["", "not-a-date", "2027-13-45T99:99", "2027-01-15"]) {
      expect(zonedWallClockToUtc(bad, "America/New_York")).toBeNull();
    }
  });

  it("survives a DST spring-forward gap without throwing", () => {
    // 02:30 on 14 March 2027 never happens in New York — the clock jumps
    // 02:00 -> 03:00. Staff should get a booking, not a crash.
    const result = zonedWallClockToUtc("2027-03-14T02:30", "America/New_York");
    expect(result).not.toBeNull();
    expect(Number.isNaN(new Date(result as string).getTime())).toBe(false);
  });

  it("resolves an ambiguous DST fall-back time deterministically", () => {
    // 01:30 on 7 November 2027 happens twice in New York.
    const first = zonedWallClockToUtc("2027-11-07T01:30", "America/New_York");
    const second = zonedWallClockToUtc("2027-11-07T01:30", "America/New_York");
    expect(first).toBe(second);
    expect(
      formatReservationTime(first as string, "America/New_York"),
    ).toContain("1:30");
  });
});

describe("formatReservationTime()", () => {
  it("renders a stored instant back in the restaurant's own zone", () => {
    const formatted = formatReservationTime(
      "2027-01-16T00:00:00.000Z",
      "America/New_York",
    );
    expect(formatted).toContain("Jan 15");
    expect(formatted).toContain("7:00");
  });

  it("names the zone so the time is never ambiguous", () => {
    expect(
      formatReservationTime("2027-01-16T00:00:00.000Z", "America/New_York"),
    ).toContain("EST");
  });

  it("round-trips: what staff typed is what staff see", () => {
    for (const zone of ["America/New_York", "Asia/Kolkata", "Europe/London"]) {
      const stored = zonedWallClockToUtc("2027-07-04T18:45", zone) as string;
      const shown = formatReservationTime(stored, zone);
      expect(shown).toContain("Jul 4");
      expect(shown).toContain("6:45");
    }
  });

  it("degrades to a dash for an unparseable stored value", () => {
    expect(formatReservationTime("nonsense", "UTC")).toBe("—");
  });
});

describe("resolveTimeZone()", () => {
  it("passes through a valid zone", () => {
    expect(resolveTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("falls back to UTC for junk, since restaurants.timezone is free text", () => {
    // A crashed reservations page is worse than a time shown in UTC.
    for (const junk of ["Mars/Olympus", "", null, undefined]) {
      expect(resolveTimeZone(junk)).toBe("UTC");
    }
  });
});
