// @vitest-environment jsdom
//
// The Chef's entry points outside the chat: the shared "ask" button (dish
// page, empty search, empty order) and the bottom dock. With the Chef on,
// they carry its face and say "Ask the Chef"; with it off, nothing changes.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const waiter = {
  available: true,
  chef: true,
  openWaiter: vi.fn(),
};
vi.mock("@/components/customer/ai-waiter", () => ({
  useAiWaiter: () => waiter,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/r/rasoi/menu",
}));

const { AskWaiterButton } =
  await import("@/components/customer/ask-waiter-card");
const { DinerDock } = await import("@/components/customer/diner-dock");

afterEach(() => {
  cleanup();
  waiter.available = true;
  waiter.chef = true;
  waiter.openWaiter.mockReset();
});

const poses = () =>
  [...document.querySelectorAll("[data-chef-pose]")].map((el) =>
    el.getAttribute("data-chef-pose"),
  );

describe("AskWaiterButton", () => {
  it("with the Chef: its face and the Chef label, asking the same question", () => {
    render(
      <AskWaiterButton
        prompt="Tell me about the Masala Dosa."
        chefLabel="Ask the Chef about this dish"
      >
        Ask the waiter about this dish
      </AskWaiterButton>,
    );
    const button = screen.getByRole("button", {
      name: "Ask the Chef about this dish",
    });
    expect(poses()).toEqual(["neutral"]);
    fireEvent.click(button);
    expect(waiter.openWaiter).toHaveBeenCalledWith(
      "Tell me about the Masala Dosa.",
      button,
    );
  });

  it("without the Chef: unchanged", () => {
    waiter.chef = false;
    render(
      <AskWaiterButton chefLabel="Ask the Chef">
        Ask the waiter
      </AskWaiterButton>,
    );
    expect(
      screen.getByRole("button", { name: "Ask the waiter" }),
    ).toBeVisible();
    expect(poses()).toEqual([]);
  });

  it("isn't there at all when the waiter is off", () => {
    waiter.available = false;
    render(
      <AskWaiterButton chefLabel="Ask the Chef">
        Ask the waiter
      </AskWaiterButton>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("DinerDock", () => {
  it("says Ask the Chef with the Chef's face, and keeps it the button's name beside the order", () => {
    render(<DinerDock restaurantSlug="rasoi" cartCount={2} />);
    // Shows "Chef" or "Ask the Chef" by width; the name is always the full one.
    expect(screen.getByRole("button", { name: "Ask the Chef" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: "View your order, 2 items" }),
    ).toBeVisible();
    expect(poses()).toEqual(["neutral"]);
  });

  it("says Ask the Chef in full with an empty order", () => {
    render(<DinerDock restaurantSlug="rasoi" cartCount={0} />);
    expect(screen.getByRole("button", { name: "Ask the Chef" })).toBeVisible();
  });

  it("without the Chef: the bell and the waiter, as before", () => {
    waiter.chef = false;
    render(<DinerDock restaurantSlug="rasoi" cartCount={2} />);
    expect(
      screen.getByRole("button", { name: "Ask the waiter" }),
    ).toBeVisible();
    expect(poses()).toEqual([]);
  });
});
