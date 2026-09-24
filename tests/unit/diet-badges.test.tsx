// @vitest-environment jsdom
//
// What a diner actually reads.
//
// The claims logic is covered without any rendering in
// tests/unit/dietary-claims.test.ts. This file exists because the risk in
// phase B is a wording risk: a badge that says the wrong thing, or says
// anything at all about a claim the restaurant never made, is the failure
// mode — and neither is visible from testing the pure functions.
// jest-dom is a devDependency but this project registers no global setup
// file, so its matchers are pulled in per test file.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DietBadges } from "@/components/customer/diet-badges";

afterEach(cleanup);

const nothingClaimed = {
  isVegetarian: false,
  isVegan: false,
  isSpicy: false,
  isHalal: false,
  isKosher: false,
};

describe("DietBadges", () => {
  it("renders nothing at all for a dish with no claims", () => {
    const { container } = render(<DietBadges {...nothingClaimed} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a claim the restaurant made", () => {
    render(<DietBadges {...nothingClaimed} isHalal />);
    expect(screen.getByText("Halal")).toBeInTheDocument();
  });

  it("says NOTHING about a claim the restaurant did not make", () => {
    // The whole feature in one assertion. An unstated claim produces no
    // text — not "Not halal", not a struck-through badge, not a greyed
    // one. Silence is the only honest rendering of "nobody has said".
    render(<DietBadges {...nothingClaimed} isHalal />);
    expect(screen.queryByText(/kosher/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not halal/i)).not.toBeInTheDocument();
  });

  it("never renders the word 'not' against any claim", () => {
    const { container } = render(
      <DietBadges {...nothingClaimed} isHalal isKosher />,
    );
    // "Not spicy" is a filter chip, not a badge; no badge negates anything.
    expect(container.textContent).not.toMatch(/\bnot\b/i);
  });

  it("shows several claims together", () => {
    render(<DietBadges {...nothingClaimed} isHalal isKosher />);
    expect(screen.getByText("Halal")).toBeInTheDocument();
    expect(screen.getByText("Kosher")).toBeInTheDocument();
  });

  it("carries no icon on a claim", () => {
    // A tick or badge glyph reads as "verified", and this app verifies
    // nothing — the restaurant is the one asserting it. The vegetarian
    // and spicy labels keep their icons; those are descriptions.
    const { container } = render(<DietBadges {...nothingClaimed} isHalal />);
    expect(container.querySelectorAll("svg")).toHaveLength(0);
  });

  it("still shows the conventional labels alongside a claim", () => {
    render(<DietBadges {...nothingClaimed} isVegetarian isHalal />);
    expect(screen.getByText("Vegetarian")).toBeInTheDocument();
    expect(screen.getByText("Halal")).toBeInTheDocument();
  });

  it("renders for a claim even when nothing else is set", () => {
    // Regression guard: the early return used to bail whenever the three
    // original flags were false, which would have hidden every claim on a
    // dish that was neither vegetarian nor spicy.
    const { container } = render(<DietBadges {...nothingClaimed} isKosher />);
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByText("Kosher")).toBeInTheDocument();
  });
});
