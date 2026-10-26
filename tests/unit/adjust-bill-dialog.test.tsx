// @vitest-environment jsdom
//
// Settle up → Adjust: what a manager's taps send to adjust_order(), and
// what's refused before anything is sent.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdjustBillDialog } from "@/components/payments/adjust-bill-dialog";
import {
  adjustOrder,
  removeAdjustment,
} from "@/lib/payments/adjustment-actions";
import type { BillOrder } from "@/lib/payments/unpaid-orders";

vi.mock("@/lib/payments/adjustment-actions", () => ({
  adjustOrder: vi.fn(async () => ({ ok: true })),
  removeAdjustment: vi.fn(async () => ({ ok: true })),
}));

const RESTAURANT = "11111111-1111-4111-8111-111111111111";

const order: BillOrder = {
  id: "22222222-2222-4222-8222-222222222222",
  orderNumber: 7,
  status: "served",
  total: 33,
  discountTotal: 0,
  currency: "USD",
  createdAt: "2026-10-26T18:00:00Z",
  items: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Chicken Biryani",
      options: null,
      quantity: 2,
      unitAmount: 15,
      voided: 0,
      comped: 0,
    },
  ],
  adjustments: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      kind: "discount",
      itemName: null,
      quantity: null,
      percent: 10,
      amount: 3,
      reason: "Regular guest",
    },
  ],
};

function openDialog(needsApproval = false) {
  render(
    <AdjustBillDialog
      restaurantId={RESTAURANT}
      tableLabel="Table 4"
      orders={[order]}
      currency="USD"
      needsApproval={needsApproval}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /adjust/i }));
}

describe("AdjustBillDialog", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(adjustOrder).mockClear();
    vi.mocked(removeAdjustment).mockClear();
  });

  it("comps the chosen number of a dish with a reason", async () => {
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Comp Chicken Biryani" }),
    );
    fireEvent.change(screen.getByLabelText("How many"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(adjustOrder).toHaveBeenCalledWith(
        {
          kind: "comp",
          restaurantId: RESTAURANT,
          orderId: order.id,
          itemId: order.items[0].id,
          quantity: 2,
          reason: "Quality issue",
        },
        undefined,
      ),
    );
  });

  it("writes an order off as 100% off, walked out", async () => {
    openDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Write off" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(adjustOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "discount",
          percent: 100,
          amount: null,
          reason: "Walked out",
        }),
        undefined,
      ),
    );
  });

  it("asks for the reason when Other is picked and left blank", async () => {
    openDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discount" }));
    fireEvent.change(screen.getByLabelText("Percent off"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Say what the reason is.")).toBeTruthy();
    expect(adjustOrder).not.toHaveBeenCalled();
  });

  it("undoes an adjustment", async () => {
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Undo: Discount" }),
    );
    await waitFor(() =>
      expect(removeAdjustment).toHaveBeenCalledWith(
        RESTAURANT,
        order.adjustments[0].id,
        undefined,
      ),
    );
  });

  it("asks a waiter for a manager's PIN, and sends it with the change", async () => {
    openDialog(true);
    fireEvent.click(await screen.findByRole("button", { name: "Write off" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      await screen.findByText(
        "A manager enters their PIN above to approve this.",
      ),
    ).toBeTruthy();
    expect(adjustOrder).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Manager PIN"), {
      target: { value: "48a21" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(adjustOrder).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "discount", percent: 100 }),
        "4821",
      ),
    );
  });
});
