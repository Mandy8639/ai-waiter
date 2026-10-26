// @vitest-environment jsdom
//
// Settle up → a split's parts: what ticking parts and taking a payment
// sends, and that a split can be cancelled only before anything is paid.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplitPanel } from "@/components/payments/split-panel";
import {
  cancelStaffSplit,
  paySplitInPerson,
} from "@/lib/payments/staff-split-actions";
import type { OpenSplit } from "@/lib/payments/unpaid-orders";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/payments/staff-split-actions", () => ({
  cancelStaffSplit: vi.fn(async () => ({ ok: true })),
  paySplitInPerson: vi.fn(async () => ({ ok: true })),
  sendSplitPartsToTerminal: vi.fn(),
}));
vi.mock("@/lib/pos/square/terminal-actions", () => ({
  cancelTerminalPayment: vi.fn(),
  checkTerminalPayment: vi.fn(),
}));

const RESTAURANT = "11111111-1111-4111-8111-111111111111";

const split = (over: Partial<OpenSplit> = {}): OpenSplit => ({
  id: "22222222-2222-4222-8222-222222222222",
  mode: "equal",
  currency: "USD",
  total: 30,
  paidTotal: 0,
  byStaff: true,
  orderIds: [],
  parts: [
    { id: "p1", label: "Share 1 of 2", amount: 15, status: "open" },
    { id: "p2", label: "Share 2 of 2", amount: 15, status: "open" },
  ],
  ...over,
});

function show(s: OpenSplit) {
  render(
    <SplitPanel
      restaurantId={RESTAURANT}
      tableLabel="Table 4"
      split={s}
      acceptsCash
      acceptsCardTerminal={false}
      terminals={[]}
      tippingEnabled
    />,
  );
}

describe("SplitPanel", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(paySplitInPerson).mockClear();
    vi.mocked(cancelStaffSplit).mockClear();
  });

  it("takes cash for the ticked parts, with the tip", async () => {
    show(split());
    fireEvent.click(screen.getByText("Share 2 of 2"));
    fireEvent.change(screen.getByLabelText("Tip"), {
      target: { value: "3" },
    });
    expect(screen.getByText("Paying $15.00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take cash" }));
    await waitFor(() =>
      expect(paySplitInPerson).toHaveBeenCalledWith(
        RESTAURANT,
        split().id,
        ["p2"],
        "cash",
        "3",
      ),
    );
  });

  it("cancels a split nobody has paid toward, and not one somebody has", async () => {
    show(split());
    fireEvent.click(screen.getByRole("button", { name: "Cancel split" }));
    await waitFor(() =>
      expect(cancelStaffSplit).toHaveBeenCalledWith(RESTAURANT, split().id),
    );
    cleanup();
    show(
      split({
        paidTotal: 15,
        parts: [
          { id: "p1", label: "Share 1 of 2", amount: 15, status: "paid" },
          { id: "p2", label: "Share 2 of 2", amount: 15, status: "open" },
        ],
      }),
    );
    expect(screen.getByText("$15.00 of $30.00 paid")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel split" })).toBeNull();
  });
});
