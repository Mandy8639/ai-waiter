// @vitest-environment jsdom
//
// Settings → Point of sale → Not yet in Square: what's missing, and what
// sending it again reports back.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SquareSyncPanel } from "@/components/pos/square-sync-panel";
import { resendToSquare } from "@/lib/pos/square/sync-actions";

vi.mock("@/lib/pos/square/sync-actions", () => ({
  resendToSquare: vi.fn(async () => ({ ok: true, sent: 3, failed: 0 })),
}));

const RESTAURANT = "11111111-1111-4111-8111-111111111111";

describe("SquareSyncPanel", () => {
  afterEach(() => cleanup());

  it("says what's missing and sends it", async () => {
    render(
      <SquareSyncPanel restaurantId={RESTAURANT} payments={2} refunds={1} />,
    );
    expect(screen.getByText(/2 sales and 1 refund/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to Square now" }));
    await waitFor(() =>
      expect(resendToSquare).toHaveBeenCalledWith(RESTAURANT),
    );
    expect(await screen.findByText("Sent 3 to Square.")).toBeTruthy();
  });

  it("says when some still didn't go through", async () => {
    vi.mocked(resendToSquare).mockResolvedValueOnce({
      ok: true,
      sent: 1,
      failed: 2,
    });
    render(
      <SquareSyncPanel restaurantId={RESTAURANT} payments={3} refunds={0} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send to Square now" }));
    expect(await screen.findByText(/2 still didn't go through/)).toBeTruthy();
  });
});
