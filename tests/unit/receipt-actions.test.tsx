// @vitest-environment jsdom
//
// A guest's receipt after paying: emailed from Settle up or Reports.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiptActions } from "@/components/payments/receipt-actions";
import { emailReceipt } from "@/lib/payments/receipt-actions";

vi.mock("@/lib/payments/receipt-actions", () => ({
  emailReceipt: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/printing/actions", () => ({ requestPrint: vi.fn() }));

const RESTAURANT = "11111111-1111-4111-8111-111111111111";
const PAYMENT = "22222222-2222-4222-8222-222222222222";

describe("ReceiptActions", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(emailReceipt).mockClear();
  });

  it("emails the receipt to the address typed, and says so", async () => {
    render(
      <ReceiptActions
        restaurantId={RESTAURANT}
        paymentId={PAYMENT}
        canPrint={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /print receipt/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /email receipt/i }));
    fireEvent.change(screen.getByLabelText("Guest's email"), {
      target: { value: "guest@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(emailReceipt).toHaveBeenCalledWith(
        RESTAURANT,
        PAYMENT,
        "guest@example.com",
      ),
    );
    expect(await screen.findByText("Sent to guest@example.com.")).toBeTruthy();
  });

  it("offers printing when there's a receipt printer", () => {
    render(
      <ReceiptActions restaurantId={RESTAURANT} paymentId={PAYMENT} canPrint />,
    );
    expect(screen.getByRole("button", { name: /print receipt/i })).toBeTruthy();
  });
});
