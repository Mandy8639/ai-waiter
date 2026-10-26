// @vitest-environment jsdom
//
// Reports → Refund: once a refund goes through, only Done is left, so a
// second tap can't refund again; opening it later starts a fresh form.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefundDialog } from "@/components/reports/refund-dialog";

describe("RefundDialog", () => {
  afterEach(() => cleanup());

  it("swaps the form for a confirmation after a refund, and starts fresh next time", async () => {
    const refundAction = vi.fn(async () => ({
      success: "Recorded a refund of $1.00.",
    }));
    render(
      <RefundDialog
        refundAction={refundAction}
        paymentLabel="#8"
        refundableAmount="6.00"
        currency="USD"
        method="cash"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    fireEvent.change(await screen.findByLabelText("Amount"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Refund" }).at(-1)!);

    expect(await screen.findByText("Recorded a refund of $1.00.")).toBeTruthy();
    expect(screen.queryByLabelText("Amount")).toBeNull();
    // No Refund button left to tap (the one behind the dialog is hidden
    // while it's open).
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
    expect(refundAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    expect(await screen.findByLabelText("Amount")).toBeTruthy();
    expect(screen.queryByText("Recorded a refund of $1.00.")).toBeNull();
  });
});
