import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  slugCandidates,
  slugify,
  SLUG_MAX_LENGTH,
} from "@/lib/restaurants/slug-core";

/**
 * A new restaurant's web address (tableside.menu/r/<slug>), made from its
 * name so the owner never has to invent one, and a free variant when
 * that's taken.
 */

describe("slugify", () => {
  it.each([
    ["Spice Garden", "spice-garden"],
    ["  Café Spice & Grill! ", "cafe-spice-and-grill"],
    ["Nashta's Kitchen", "nashtas-kitchen"],
    ["Joe’s   Diner -- 24/7", "joes-diner-24-7"],
    ["!!!", "restaurant"],
    ["", "restaurant"],
  ])("%j → %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("matches the database's format and length", () => {
    const long = slugify("A ".repeat(100) + "Very Long Restaurant Name");
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("slugCandidates", () => {
  it("tries the name, then numbered, then a random tail", () => {
    expect(slugCandidates("spice-garden", () => "x7k2")).toEqual([
      "spice-garden",
      "spice-garden-2",
      "spice-garden-3",
      "spice-garden-4",
      "spice-garden-x7k2",
    ]);
  });

  it("stays inside the length limit", () => {
    const base = "a".repeat(SLUG_MAX_LENGTH);
    for (const c of slugCandidates(base, () => "zzzz")) {
      expect(c.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    }
  });
});

describe("isValidTimeZone", () => {
  it("accepts real zones and refuses anything else", () => {
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
