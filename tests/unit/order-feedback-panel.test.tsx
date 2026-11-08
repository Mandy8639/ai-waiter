// @vitest-environment jsdom
//
// Phase N: the diner's "How was everything?" panel. A low rating must end
// with an OFFER to have someone come over — never an automatic call — and
// a good one must not offer it at all.
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const submitOrderFeedback = vi.fn();
const askStaffAboutFeedback = vi.fn(async (_orderId: string) => ({
  ok: true,
}));
const recordGoogleReviewTap = vi.fn(async (_orderId: string) => undefined);
vi.mock("@/lib/reviews/actions", () => ({
  recordGoogleReviewTap: (orderId: string) => recordGoogleReviewTap(orderId),
}));
vi.mock("@/lib/feedback/actions", () => ({
  submitOrderFeedback: (...args: unknown[]) => submitOrderFeedback(...args),
  askStaffAboutFeedback: (orderId: string) => askStaffAboutFeedback(orderId),
}));

const { OrderFeedbackPanel } =
  await import("@/components/customer/order-feedback-panel");

// The full suite runs files in parallel, so allow more than the default
// second for a mocked action to settle.
const WAIT = { timeout: 5000 };

afterEach(() => {
  cleanup();
  submitOrderFeedback.mockReset();
  askStaffAboutFeedback.mockClear();
});

function renderPanel(alreadyGiven = false, googleReviewUrl?: string) {
  return render(
    <OrderFeedbackPanel
      restaurantSlug="nashta"
      orderId="o1"
      items={[
        { id: "i1", name: "Masala Dosa" },
        { id: "i2", name: "Mango Lassi" },
      ]}
      alreadyGiven={alreadyGiven}
      googleReviewUrl={googleReviewUrl}
    />,
  );
}

const REVIEW = "https://g.page/r/abc/review";

describe("OrderFeedbackPanel", () => {
  it("says it's private, and can't be sent without a rating", () => {
    renderPanel();
    expect(
      screen.getByText(/Only the restaurant sees this/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send to the restaurant" }),
    ).toBeDisabled();
  });

  it("sends the rating, comment and dish votes", async () => {
    submitOrderFeedback.mockResolvedValue({ ok: true, low: false });
    renderPanel();
    fireEvent.click(screen.getByLabelText(/4 stars/));
    fireEvent.click(screen.getByRole("button", { name: "Liked Masala Dosa" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Didn't like Mango Lassi" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Lassi too sweet" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send to the restaurant" }),
    );

    expect(
      await screen.findByText("Thanks for your feedback", undefined, WAIT),
    ).toBeInTheDocument();
    expect(submitOrderFeedback).toHaveBeenCalledWith(
      "nashta",
      "o1",
      ["i1", "i2"],
      {
        rating: 4,
        comment: "Lassi too sweet",
        votes: { i1: true, i2: false },
      },
    );
    expect(screen.queryByText(/come over/)).not.toBeInTheDocument();
  });

  it("lets a dish vote be taken back by pressing it again", async () => {
    submitOrderFeedback.mockResolvedValue({ ok: true, low: false });
    renderPanel();
    fireEvent.click(screen.getByLabelText(/5 stars/));
    const like = screen.getByRole("button", { name: "Liked Masala Dosa" });
    fireEvent.click(like);
    expect(like).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(like);
    expect(like).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(
      screen.getByRole("button", { name: "Send to the restaurant" }),
    );
    await screen.findByText("Thanks for your feedback", undefined, WAIT);
    expect(submitOrderFeedback.mock.calls[0][3].votes).toEqual({});
  });

  it("after a low rating, offers someone coming over, and only calls when asked", async () => {
    submitOrderFeedback.mockResolvedValue({ ok: true, low: true });
    renderPanel();
    fireEvent.click(screen.getByLabelText(/1 star\b/));
    fireEvent.click(
      screen.getByRole("button", { name: "Send to the restaurant" }),
    );

    expect(
      await screen.findByText("Sorry it wasn't right", undefined, WAIT),
    ).toBeInTheDocument();
    expect(askStaffAboutFeedback).not.toHaveBeenCalled();
    // The apology can render a moment before the send's transition ends,
    // while its buttons are still disabled; a click then does nothing.
    // Found in CI (#91), where the slower machine clicked in that moment.
    const yes = screen.getByRole("button", {
      name: "Yes, ask someone to come over",
    });
    await waitFor(() => expect(yes).toBeEnabled(), WAIT);
    fireEvent.click(yes);
    expect(
      await screen.findByText("Someone's on their way", undefined, WAIT),
    ).toBeInTheDocument();
    expect(askStaffAboutFeedback).toHaveBeenCalledWith("o1");
  });

  it("shows the database's sentence when sending fails", async () => {
    submitOrderFeedback.mockResolvedValue({
      ok: false,
      error: "You've already told us about this order — thank you.",
    });
    renderPanel();
    fireEvent.click(screen.getByLabelText(/3 stars/));
    fireEvent.click(
      screen.getByRole("button", { name: "Send to the restaurant" }),
    );
    expect(
      await screen.findByText(
        /already told us about this order/,
        undefined,
        WAIT,
      ),
    ).toBeInTheDocument();
  });

  it("just says thank you when feedback was already given", () => {
    renderPanel(true);
    expect(screen.getByText("Thanks for your feedback")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  describe("the Google review link (offered to every rating)", () => {
    it.each([5, 3])("is offered after %i stars", async (stars) => {
      submitOrderFeedback.mockResolvedValue({ ok: true, low: false });
      renderPanel(false, REVIEW);
      fireEvent.click(screen.getByLabelText(new RegExp(`${stars} stars`)));
      fireEvent.click(
        screen.getByRole("button", { name: "Send to the restaurant" }),
      );
      const link = await screen.findByRole(
        "link",
        { name: /Leave a Google review/ },
        WAIT,
      );
      expect(link).toHaveAttribute("href", REVIEW);
      expect(link).toHaveAttribute("target", "_blank");
      fireEvent.click(link);
      expect(recordGoogleReviewTap).toHaveBeenCalledWith("o1");
    });

    it("is offered after a low rating too, once the diner has answered", async () => {
      submitOrderFeedback.mockResolvedValue({ ok: true, low: true });
      renderPanel(false, REVIEW);
      fireEvent.click(screen.getByLabelText(/1 star\b/));
      fireEvent.click(
        screen.getByRole("button", { name: "Send to the restaurant" }),
      );
      await screen.findByText("Sorry it wasn't right", undefined, WAIT);
      const no = screen.getByRole("button", { name: "No thanks" });
      await waitFor(() => expect(no).toBeEnabled(), WAIT);
      fireEvent.click(no);
      expect(
        await screen.findByRole(
          "link",
          { name: /Leave a Google review/ },
          WAIT,
        ),
      ).toHaveAttribute("href", REVIEW);
    });

    it("is there before rating too, and absent with no link set", () => {
      renderPanel(false, REVIEW);
      expect(
        screen.getByRole("link", { name: /Or review us on Google/ }),
      ).toHaveAttribute("href", REVIEW);
      cleanup();
      renderPanel(false);
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });
  });
});
