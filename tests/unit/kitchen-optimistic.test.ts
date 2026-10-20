import { describe, expect, it } from "vitest";
import { withOverrides } from "@/components/kitchen/optimistic-core";

/**
 * Kitchen taps move the card at once; a refresh from the server (which
 * hasn't saved the tap yet) must not move it back.
 */
describe("withOverrides", () => {
  const fresh = [
    { id: "a", status: "preparing" as const },
    { id: "b", status: "pending" as const },
  ];

  it("shows a tap that hasn't been saved yet over the server's status", () => {
    expect(withOverrides(fresh, new Map([["a", "ready"]]))).toEqual([
      { id: "a", status: "ready" },
      { id: "b", status: "pending" },
    ]);
  });

  it("returns the server's list untouched when nothing is waiting", () => {
    expect(withOverrides(fresh, new Map())).toBe(fresh);
  });

  it("ignores a tap for an order no longer on the board", () => {
    expect(withOverrides(fresh, new Map([["gone", "ready"]]))).toEqual(fresh);
  });
});
