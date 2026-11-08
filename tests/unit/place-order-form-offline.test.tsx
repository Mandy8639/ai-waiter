// @vitest-environment jsdom
//
// Offline mode, phase 1: a dropped connection while placing an order.
// The action throws instead of answering; the form must say the order
// wasn't sent (not crash to an error page), retry by itself when the
// phone is back online, and use the SAME key every time, so the database
// returns one order however many attempts it took.
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
const submitTableGroupOrder = vi.fn();
vi.mock("@/lib/orders/submit-order", () => ({
  submitOrder: (...args: unknown[]) => submitOrder(...args),
}));
vi.mock("@/lib/table-groups/actions", () => ({
  submitTableGroupOrder: (...args: unknown[]) => submitTableGroupOrder(...args),
}));

import { PlaceOrderForm } from "@/components/customer/place-order-form";

afterEach(() => {
  cleanup();
  // mockReset, not clearAllMocks: a queued once-value left by a failed
  // test must not leak into the next one.
  push.mockReset();
  submitOrder.mockReset();
  submitTableGroupOrder.mockReset();
});

const WAIT = { timeout: 5000 };

function renderForm(group = false) {
  render(
    <PlaceOrderForm
      restaurantSlug="lantern-table-demo"
      disabled={false}
      allowCustomerNotes={false}
      group={group}
    />,
  );
}

describe("PlaceOrderForm when the connection drops", () => {
  it("says the order wasn't sent, then sends it with the same key once back online", async () => {
    submitOrder
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ orderId: "order-1" });
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    expect(
      await screen.findByText(
        /your order hasn't been sent yet/,
        undefined,
        WAIT,
      ),
    ).toBeInTheDocument();
    const retry = await screen.findByRole(
      "button",
      { name: "Try again" },
      WAIT,
    );
    await vi.waitFor(() => expect(retry).toBeEnabled(), WAIT);
    expect(push).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await vi.waitFor(
      () =>
        expect(push).toHaveBeenCalledWith(
          "/r/lantern-table-demo/order/order-1",
        ),
      WAIT,
    );
    expect(submitOrder).toHaveBeenCalledTimes(2);
    expect(submitOrder.mock.calls[1][0]).toBe(submitOrder.mock.calls[0][0]);
  });

  it("lets the guest retry by hand", async () => {
    submitOrder
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ orderId: "order-2" });
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    const retry = await screen.findByRole(
      "button",
      { name: "Try again" },
      WAIT,
    );
    await vi.waitFor(() => expect(retry).toBeEnabled(), WAIT);
    fireEvent.click(retry);
    await vi.waitFor(
      () =>
        expect(push).toHaveBeenCalledWith(
          "/r/lantern-table-demo/order/order-2",
        ),
      WAIT,
    );
  });

  it("does the same for a table's shared order", async () => {
    submitTableGroupOrder
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ orderId: "order-3" });
    renderForm(true);

    fireEvent.click(screen.getByRole("button", { name: "Send to kitchen" }));
    await screen.findByText(/hasn't been sent yet/, undefined, WAIT);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalled(), WAIT);
    expect(submitTableGroupOrder.mock.calls[1][0]).toBe(
      submitTableGroupOrder.mock.calls[0][0],
    );
  });

  it("still shows the database's own answer as an error", async () => {
    submitOrder.mockResolvedValueOnce({ error: "That dish just sold out." });
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    expect(
      await screen.findByText("That dish just sold out.", undefined, WAIT),
    ).toBeInTheDocument();
    expect(screen.queryByText(/hasn't been sent yet/)).not.toBeInTheDocument();
  });
});
