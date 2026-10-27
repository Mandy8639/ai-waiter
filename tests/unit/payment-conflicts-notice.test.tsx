import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { acknowledge } = vi.hoisted(() => ({
  acknowledge: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/payments/payment-conflict-actions", () => ({
  acknowledgePaymentConflict: acknowledge,
}));

import { PaymentConflictsNotice } from "@/components/payments/payment-conflicts-notice";
import type { PaymentConflict } from "@/lib/payments/payment-conflicts";

const conflict = (
  overrides: Partial<PaymentConflict> = {},
): PaymentConflict => ({
  id: "c1",
  provider: "stripe",
  amount: 42.5,
  currency: "USD",
  refundStatus: "refunded",
  orderNumbers: [12, 14],
  detectedAt: "2026-10-27T20:00:00Z",
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the paid-twice notice on Settle up", () => {
  it("says nothing when no guest paid twice", () => {
    const { container } = render(
      <PaymentConflictsNotice conflicts={[]} canClose />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("says the guest was refunded", () => {
    render(<PaymentConflictsNotice conflicts={[conflict()]} canClose />);
    expect(screen.getByText("A guest paid twice for #12, #14")).toBeTruthy();
    expect(screen.getByText(/refunded it to their card/)).toBeTruthy();
  });

  it("says what to do when the refund didn't go through", () => {
    render(
      <PaymentConflictsNotice
        conflicts={[conflict({ refundStatus: "failed", provider: "square" })]}
        canClose
      />,
    );
    expect(
      screen.getByText(/refund \$42\.50 to the guest in your Square dashboard/),
    ).toBeTruthy();
  });

  it("lets a manager close it, and only a manager", () => {
    const { rerender } = render(
      <PaymentConflictsNotice conflicts={[conflict()]} canClose={false} />,
    );
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull();

    rerender(<PaymentConflictsNotice conflicts={[conflict()]} canClose />);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(acknowledge).toHaveBeenCalledWith("c1");
  });
});
