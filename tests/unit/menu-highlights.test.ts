import { describe, expect, it } from "vitest";
import {
  MAX_HOUSE_FAVORITES,
  highlightFor,
  highlightSections,
} from "@/lib/menu/highlights";

/** "House favorites" and "Most ordered this month" on the diner menu. */
describe("highlightSections", () => {
  const card = (id: string, isHouseFavorite = false) => ({
    id,
    isHouseFavorite,
  });

  it("lists starred dishes in menu order, then the most ordered in rank order", () => {
    const cards = [card("a"), card("b", true), card("c"), card("d", true)];
    expect(highlightSections(cards, ["c", "a"])).toEqual({
      favorites: [card("b", true), card("d", true)],
      mostOrdered: [card("c"), card("a")],
    });
  });

  it("doesn't repeat a house favorite under Most ordered", () => {
    const cards = [card("a", true), card("b")];
    expect(highlightSections(cards, ["a", "b"]).mostOrdered).toEqual([
      card("b"),
    ]);
  });

  it("skips ranked dishes that aren't on this page (filtered out or hidden)", () => {
    expect(highlightSections([card("a")], ["gone", "a"]).mostOrdered).toEqual([
      card("a"),
    ]);
  });

  it("keeps the favorites section short", () => {
    const many = Array.from({ length: 12 }, (_, i) => card(`d${i}`, true));
    expect(highlightSections(many, []).favorites).toHaveLength(
      MAX_HOUSE_FAVORITES,
    );
  });

  it("shows nothing when there's nothing to highlight", () => {
    expect(highlightSections([card("a")], [])).toEqual({
      favorites: [],
      mostOrdered: [],
    });
  });
});

describe("highlightFor", () => {
  const popular = new Set(["b"]);
  it("prefers the restaurant's own star over popularity", () => {
    expect(highlightFor({ id: "b", isHouseFavorite: true }, popular)).toBe(
      "house_favorite",
    );
    expect(highlightFor({ id: "b", isHouseFavorite: false }, popular)).toBe(
      "most_ordered",
    );
    expect(highlightFor({ id: "c", isHouseFavorite: false }, popular)).toBe(
      null,
    );
  });
});
