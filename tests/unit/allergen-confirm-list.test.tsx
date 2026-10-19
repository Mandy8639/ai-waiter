// @vitest-environment jsdom
//
// Allergens are reviewed dish by dish and confirmed together: marking a
// dish freezes its ticks, and "Confirm all reviewed" sends only the marked
// dishes, with the ticks that were reviewed.
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

const confirmReviewedAllergens = vi.fn();
vi.mock("@/lib/review/actions", () => ({
  confirmReviewedAllergens: (...args: unknown[]) =>
    confirmReviewedAllergens(...args),
}));
vi.mock("@/lib/menu-import/suggest-actions", () => ({
  confirmAllergensForItem: vi.fn(async () => ({})),
}));

import {
  AllergenConfirmList,
  type PendingItem,
} from "@/components/dashboard/allergen-confirm-list";

const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";

function item(id: string, name: string, suggested: string[]): PendingItem {
  return {
    menuItemId: id,
    itemName: name,
    options: ["Milk", "Wheat", "Soy"].map((n) => ({
      name: n,
      suggested: suggested.includes(n),
    })),
  };
}

const items = [
  item(ID_A, "Paneer Pakoda", ["Milk", "Wheat"]),
  item(ID_B, "Pepper Shrimp", ["Soy"]),
];

function dish(name: string) {
  return screen.getByText(name).closest("li") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("AllergenConfirmList", () => {
  it("has no confirm button until a dish is marked reviewed", () => {
    render(<AllergenConfirmList restaurantId="r1" items={items} />);
    expect(screen.getByText(/of 2 reviewed/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Confirm 0 reviewed/ }),
    ).toBeDisabled();
  });

  it("freezes a reviewed dish's ticks until the mark is taken off", () => {
    render(<AllergenConfirmList restaurantId="r1" items={items} />);
    const pakoda = dish("Paneer Pakoda");
    fireEvent.click(
      within(pakoda).getByRole("button", { name: "Mark reviewed" }),
    );
    expect(
      within(pakoda).getByRole("checkbox", { name: /Soy/ }),
    ).toBeDisabled();

    fireEvent.click(within(pakoda).getByRole("button", { name: "Reviewed" }));
    expect(
      within(pakoda).getByRole("checkbox", { name: /Soy/ }),
    ).not.toBeDisabled();
  });

  it("confirms only the reviewed dishes, with the ticks as reviewed", async () => {
    confirmReviewedAllergens.mockResolvedValue({
      confirmedIds: [ID_A],
      changedIds: [],
    });
    render(<AllergenConfirmList restaurantId="r1" items={items} />);
    const pakoda = dish("Paneer Pakoda");
    // Untick Wheat, then review.
    fireEvent.click(within(pakoda).getByRole("checkbox", { name: /Wheat/ }));
    fireEvent.click(
      within(pakoda).getByRole("button", { name: "Mark reviewed" }),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Confirm 1 reviewed/ }),
      );
    });

    expect(confirmReviewedAllergens).toHaveBeenCalledWith("r1", [
      { menuItemId: ID_A, allergenNames: ["Milk"] },
    ]);
    expect(screen.queryByText("Paneer Pakoda")).toBeNull();
    expect(screen.getByText("Pepper Shrimp")).toBeInTheDocument();
  });

  it("remembers marks and their ticks across a reload", () => {
    const { unmount } = render(
      <AllergenConfirmList restaurantId="r1" items={items} />,
    );
    const pakoda = dish("Paneer Pakoda");
    fireEvent.click(within(pakoda).getByRole("checkbox", { name: /Wheat/ }));
    fireEvent.click(
      within(pakoda).getByRole("button", { name: "Mark reviewed" }),
    );
    unmount();

    render(<AllergenConfirmList restaurantId="r1" items={items} />);
    const again = dish("Paneer Pakoda");
    expect(
      within(again).getByRole("button", { name: "Reviewed" }),
    ).toBeInTheDocument();
    expect(
      within(again).getByRole("checkbox", { name: /Wheat/ }),
    ).not.toBeChecked();
    expect(screen.getByText(/of 2 reviewed/).textContent).toMatch(/^1 of 2/);
  });
});
