// @vitest-environment jsdom
//
// Nutrition is reviewed dish by dish and confirmed together: marking a
// draft locks its numbers, and "Confirm all reviewed" sends only marked
// drafts, with the numbers that were reviewed.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const confirmReviewedNutrition = vi.fn();
vi.mock("@/lib/review/actions", () => ({
  confirmReviewedNutrition: (...args: unknown[]) =>
    confirmReviewedNutrition(...args),
}));
vi.mock("@/lib/nutrition/actions", () => ({
  clearNutrition: vi.fn(),
  confirmNutrition: vi.fn(),
  estimateMissingNutrition: vi.fn(),
  saveNutrition: vi.fn(),
}));
vi.mock("@/lib/menu-import/suggest-actions", () => ({
  confirmAllergensForItem: vi.fn(),
}));

import { NutritionReview } from "@/components/dashboard/nutrition-review";
import type { NutritionReviewRow } from "@/lib/nutrition/queries";

function draft(
  itemId: string,
  name: string,
  values: NutritionReviewRow["values"],
): NutritionReviewRow {
  return {
    itemId,
    name,
    description: null,
    category: "SOUPS",
    state: "draft",
    source: "ai",
    values,
    expected: null,
    mismatch: false,
  };
}

const rows = [
  draft("a", "Natu Kodi Soup", {
    calories: 200,
    proteinG: 15,
    carbsG: 8,
    fatG: 11,
  }),
  draft("b", "Tomato Dal", {
    calories: 250,
    proteinG: 10,
    carbsG: 30,
    fatG: 8,
  }),
];

function dish(name: string) {
  return screen.getByText(name).closest("li") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("NutritionReview — reviewed, then confirm all", () => {
  it("locks a reviewed dish's numbers", () => {
    render(<NutritionReview restaurantId="r1" rows={rows} />);
    const soup = dish("Natu Kodi Soup");
    fireEvent.click(
      within(soup).getByRole("button", { name: "Mark reviewed" }),
    );
    expect(
      within(soup).getByRole("textbox", {
        name: /Calories for Natu Kodi Soup/,
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Confirm 1 reviewed/ }),
    ).toBeEnabled();
  });

  it("sends only reviewed dishes, each with the numbers reviewed", async () => {
    confirmReviewedNutrition.mockResolvedValue({
      confirmedIds: ["a"],
      changedIds: [],
    });
    render(<NutritionReview restaurantId="r1" rows={rows} />);
    fireEvent.click(
      within(dish("Natu Kodi Soup")).getByRole("button", {
        name: "Mark reviewed",
      }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Confirm 1 reviewed/ }),
      );
    });
    expect(confirmReviewedNutrition).toHaveBeenCalledWith("r1", [
      { itemId: "a", signature: "200|15|8|11" },
    ]);
    expect(screen.getByText(/Confirmed 1 dish\b/)).toBeInTheDocument();
  });

  it("says when numbers changed after review and weren't confirmed", async () => {
    confirmReviewedNutrition.mockResolvedValue({
      confirmedIds: [],
      changedIds: ["a"],
    });
    render(<NutritionReview restaurantId="r1" rows={rows} />);
    fireEvent.click(
      within(dish("Natu Kodi Soup")).getByRole("button", {
        name: "Mark reviewed",
      }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Confirm 1 reviewed/ }),
      );
    });
    expect(
      screen.getByText(/changed after you reviewed them/),
    ).toBeInTheDocument();
  });
});
