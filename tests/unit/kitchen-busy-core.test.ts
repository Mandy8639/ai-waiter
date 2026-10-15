import { describe, expect, it } from "vitest";
import {
  KITCHEN_ON_TIME,
  PAUSE_CHOICES,
  dinerNotice,
  kitchenStatusFrom,
  minutesLeft,
  pauseChoiceLabel,
} from "@/lib/kitchen/busy-core";

const now = new Date("2026-10-15T18:00:00.000Z");
const inMinutes = (m: number) =>
  new Date(now.getTime() + m * 60_000).toISOString();

describe("kitchenStatusFrom", () => {
  it("reads no row, or nothing set, as on time", () => {
    expect(kitchenStatusFrom(null, now)).toEqual(KITCHEN_ON_TIME);
    expect(
      kitchenStatusFrom(
        { orders_paused_until: null, busy_extra_minutes: 0 },
        now,
      ),
    ).toEqual(KITCHEN_ON_TIME);
  });

  it("reads a pause that hasn't ended yet", () => {
    const s = kitchenStatusFrom(
      { orders_paused_until: inMinutes(20), busy_extra_minutes: 0 },
      now,
    );
    expect(s.paused).toBe(true);
    expect(s.pausedIndefinitely).toBe(false);
    expect(minutesLeft(s, now)).toBe(20);
  });

  it("lets a pause end by itself while the page is open", () => {
    const s = kitchenStatusFrom(
      { orders_paused_until: inMinutes(-1), busy_extra_minutes: 0 },
      now,
    );
    expect(s.paused).toBe(false);
  });

  it("reads Postgres's 'infinity' as paused until someone resumes", () => {
    const s = kitchenStatusFrom(
      { orders_paused_until: "infinity", busy_extra_minutes: 0 },
      now,
    );
    expect(s.paused).toBe(true);
    expect(s.pausedIndefinitely).toBe(true);
    expect(minutesLeft(s, now)).toBeNull();
  });
});

describe("dinerNotice", () => {
  it("says nothing when the kitchen is on time", () => {
    expect(dinerNotice(KITCHEN_ON_TIME, now)).toBeNull();
  });

  it("says how long a pause has left, in minutes not a clock time", () => {
    const s = kitchenStatusFrom(
      { orders_paused_until: inMinutes(12), busy_extra_minutes: 0 },
      now,
    );
    expect(dinerNotice(s, now)).toMatch(/about 12 more minutes/);
  });

  it("puts a pause before a delay: no new orders matters more", () => {
    const s = kitchenStatusFrom(
      { orders_paused_until: "infinity", busy_extra_minutes: 20 },
      now,
    );
    expect(dinerNotice(s, now)).toMatch(/paused new orders for now/);
  });

  it("tells diners how much longer food is taking", () => {
    const s = kitchenStatusFrom(
      { orders_paused_until: null, busy_extra_minutes: 20 },
      now,
    );
    expect(dinerNotice(s, now)).toMatch(/about 20 minutes longer/);
  });
});

describe("pause choices", () => {
  it("offers short pauses and one with no end", () => {
    expect(PAUSE_CHOICES.map(pauseChoiceLabel)).toEqual([
      "15 min",
      "30 min",
      "1 hour",
      "Until I resume",
    ]);
  });
});
