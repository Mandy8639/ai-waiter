// @vitest-environment jsdom
//
// At a pickup counter the order form asks when and whose name to call,
// and sends both with the order; at a table it asks neither.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const submitOrder = vi.fn();
vi.mock("@/lib/table-groups/actions", () => ({
  submitTableGroupOrder: vi.fn(),
}));
vi.mock("@/lib/orders/submit-order", () => ({
  submitOrder: (...args: unknown[]) => submitOrder(...args),
}));

import { PlaceOrderForm } from "@/components/customer/place-order-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// 16:30Z and 16:45Z are 12:30 and 12:45 in New York; 17:00Z is full.
const pickup = {
  isCounter: true as const,
  timeZone: "America/New_York",
  chosenAt: null,
  chosenName: null,
  slots: [
    { at: "2026-10-19T16:30:00.000Z", placesLeft: 0 },
    { at: "2026-10-19T16:45:00.000Z", placesLeft: 2 },
    { at: "2026-10-19T17:00:00.000Z", placesLeft: 1 },
  ],
};

describe("PlaceOrderForm at a pickup counter", () => {
  it("marks a full time, starts on the first open one, and waits for a name", () => {
    render(
      <PlaceOrderForm
        restaurantSlug="r"
        disabled={false}
        allowCustomerNotes={false}
        pickup={pickup}
      />,
    );
    const select = screen.getByLabelText("Pickup time") as HTMLSelectElement;
    expect(select.value).toBe("2026-10-19T16:45:00.000Z");
    expect(screen.getByRole("option", { name: /\(full\)/ })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Place pickup order" }),
    ).toBeDisabled();
  });

  it("sends the chosen time and name with the order", async () => {
    submitOrder.mockResolvedValue({ orderId: "o1" });
    render(
      <PlaceOrderForm
        restaurantSlug="r"
        disabled={false}
        allowCustomerNotes={false}
        pickup={pickup}
      />,
    );
    fireEvent.change(screen.getByLabelText("Pickup time"), {
      target: { value: "2026-10-19T17:00:00.000Z" },
    });
    fireEvent.change(screen.getByLabelText("Name for pickup"), {
      target: { value: " Priya " },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Place pickup order" }),
      );
    });
    expect(submitOrder).toHaveBeenCalledWith(expect.any(String), undefined, {
      at: "2026-10-19T17:00:00.000Z",
      name: "Priya",
    });
    expect(push).toHaveBeenCalledWith("/r/r/order/o1");
  });

  it("says so when no time is open, and can't be placed", () => {
    render(
      <PlaceOrderForm
        restaurantSlug="r"
        disabled={false}
        allowCustomerNotes={false}
        pickup={{ ...pickup, slots: [] }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/no pickup times open/);
    expect(
      screen.getByRole("button", { name: "Place pickup order" }),
    ).toBeDisabled();
  });

  it("asks nothing extra at a table", async () => {
    submitOrder.mockResolvedValue({ orderId: "o2" });
    render(
      <PlaceOrderForm
        restaurantSlug="r"
        disabled={false}
        allowCustomerNotes={false}
      />,
    );
    expect(screen.queryByLabelText("Pickup time")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    });
    expect(submitOrder).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      undefined,
    );
  });
});
