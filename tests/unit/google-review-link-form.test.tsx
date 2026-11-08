// @vitest-environment jsdom
//
// The Google review link setting: a refused link stays in the field so
// the owner can fix it rather than paste it again (React resets a form
// after every submit; found checking the feature live on 2026-11-07), and
// a saved one shows as cleaned.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleReviewLinkForm } from "@/components/settings/google-review-link-form";

afterEach(() => {
  cleanup();
});

const field = () =>
  screen.getByLabelText("Google review link") as HTMLInputElement;

async function submit(value: string) {
  fireEvent.change(field(), { target: { value } });
  await act(async () => {
    fireEvent.submit(field().form!);
  });
}

describe("GoogleReviewLinkForm", () => {
  it("keeps a refused link in the field, with the reason", async () => {
    const action = vi.fn(async () => ({
      error: "Use the review link from your Google Business Profile.",
      value: "https://yelp.com/biz/x",
    }));
    render(
      <GoogleReviewLinkForm
        action={action}
        defaultValue={null}
        disabled={false}
      />,
    );
    await submit("https://yelp.com/biz/x");

    expect(await screen.findByText(/Use the review link/)).toBeInTheDocument();
    expect(field().value).toBe("https://yelp.com/biz/x");
  });

  it("shows the cleaned link once saved", async () => {
    const action = vi.fn(async () => ({
      success: true,
      value: "https://g.page/r/abc/review",
    }));
    render(
      <GoogleReviewLinkForm
        action={action}
        defaultValue={null}
        disabled={false}
      />,
    );
    await submit("g.page/r/abc/review");

    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(field().value).toBe("https://g.page/r/abc/review");
  });
});
