import { describe, expect, it } from "vitest";
import {
  formatPickupTime,
  parsePickupOptions,
  pickupLabel,
} from "@/lib/pickup/format-core";

describe("formatPickupTime", () => {
  const now = new Date("2026-10-19T15:00:00Z"); // 11:00 in New York

  it("shows the restaurant's clock, not the device's", () => {
    expect(
      formatPickupTime("2026-10-19T16:30:00Z", "America/New_York", now),
    ).toBe("12:30");
    expect(formatPickupTime("2026-10-19T16:30:00Z", "Asia/Kolkata", now)).toBe(
      "22:00",
    );
  });

  it("says Tomorrow for a slot after the restaurant's midnight", () => {
    expect(
      formatPickupTime("2026-10-20T04:15:00Z", "America/New_York", now),
    ).toBe("Tomorrow 00:15");
  });

  it("stays on the restaurant's clock across a daylight-saving change", () => {
    // New York falls back at 02:00 on 2026-11-01: 05:30Z is 01:30 EDT and
    // 06:30Z is 01:30 EST.
    const night = new Date("2026-11-01T04:00:00Z");
    expect(
      formatPickupTime("2026-11-01T05:30:00Z", "America/New_York", night),
    ).toBe("01:30");
    expect(
      formatPickupTime("2026-11-01T06:30:00Z", "America/New_York", night),
    ).toBe("01:30");
    expect(
      formatPickupTime("2026-11-01T07:30:00Z", "America/New_York", night),
    ).toBe("02:30");
  });
});

describe("pickupLabel", () => {
  it("reads like a table's name on a ticket", () => {
    expect(
      pickupLabel(
        "2026-10-19T16:30:00Z",
        "Priya",
        "America/New_York",
        new Date("2026-10-19T15:00:00Z"),
      ),
    ).toBe("Pickup 12:30 · Priya");
  });
});

describe("parsePickupOptions", () => {
  it("treats anything but a counter as a dine-in visit", () => {
    expect(parsePickupOptions({ is_counter: false })).toEqual({
      isCounter: false,
    });
    expect(parsePickupOptions(null)).toEqual({ isCounter: false });
  });

  it("normalises slot times so they can be matched to the cart's choice", () => {
    const parsed = parsePickupOptions({
      is_counter: true,
      timezone: "America/New_York",
      chosen_at: "2026-10-19T16:30:00+00:00",
      chosen_name: "Priya",
      slots: [{ at: "2026-10-19T12:30:00-04:00", places_left: 2 }],
    });
    expect(parsed).toEqual({
      isCounter: true,
      timeZone: "America/New_York",
      chosenAt: "2026-10-19T16:30:00.000Z",
      chosenName: "Priya",
      slots: [{ at: "2026-10-19T16:30:00.000Z", placesLeft: 2 }],
    });
  });
});
