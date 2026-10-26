// @vitest-environment jsdom
//
// The print button on Settle up and the kitchen board: it sends one job
// through requestPrint() and says beside itself how that went.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrintButton } from "@/components/printing/print-button";
import { requestPrint } from "@/lib/printing/actions";

vi.mock("@/lib/printing/actions", () => ({
  requestPrint: vi.fn(),
}));

const RESTAURANT = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";

describe("PrintButton", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(requestPrint).mockReset();
  });

  function press() {
    render(
      <PrintButton
        restaurantId={RESTAURANT}
        kind="bill"
        orderIds={[ORDER]}
        label="Print bill"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /print bill/i }));
  }

  it("sends the bill for the table's orders and says it went", async () => {
    vi.mocked(requestPrint).mockResolvedValue({ ok: true, printers: 1 });
    press();
    expect(await screen.findByText("Sent to the printer.")).toBeTruthy();
    expect(requestPrint).toHaveBeenCalledWith({
      restaurantId: RESTAURANT,
      kind: "bill",
      orderIds: [ORDER],
    });
  });

  it("says so when no printer took the job", async () => {
    vi.mocked(requestPrint).mockResolvedValue({ ok: true, printers: 0 });
    press();
    expect(
      await screen.findByText("No printer is set up for that."),
    ).toBeTruthy();
  });

  it("shows the database's reason when it refuses", async () => {
    vi.mocked(requestPrint).mockResolvedValue({
      ok: false,
      error: "your account can't print that",
    });
    press();
    expect(
      await screen.findByText("your account can't print that"),
    ).toBeTruthy();
  });
});
