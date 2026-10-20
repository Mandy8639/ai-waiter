// @vitest-environment jsdom
//
// The Admin page's side-by-side test card: sends both models and the
// question, then shows both answers and the notes under them
// (src/components/admin/compare-card.tsx).
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const compareModels = vi.fn();
vi.mock("@/lib/admin/actions", () => ({
  compareModels: (...args: unknown[]) => compareModels(...args),
}));

import { CompareCard } from "@/components/admin/compare-card";

const options = [
  { model: "a/one:free", note: "Tested", price: "Free", available: true },
  { model: "b/two:free", note: "Tested", price: "Free", available: true },
];

afterEach(() => {
  cleanup();
  compareModels.mockReset();
});

describe("CompareCard", () => {
  it("asks both models the question and shows both answers", async () => {
    compareModels.mockResolvedValueOnce({
      answers: [
        {
          model: "a/one:free",
          reply: "The Dal Makhani is mild.",
          tools: ["search_menu"],
          declined: false,
          ms: 1500,
          costUsd: 0,
        },
        {
          model: "b/two:free",
          reply: "",
          tools: [],
          declined: false,
          ms: 30000,
          costUsd: null,
          error: "busy",
          busy: true,
        },
      ],
    });
    render(<CompareCard options={options} current="a/one:free" />);
    fireEvent.click(
      screen.getByRole("button", { name: "What do you recommend?" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    });

    expect(compareModels).toHaveBeenCalledWith(
      ["a/one:free", "b/two:free"],
      "What do you recommend?",
    );
    expect(screen.getByText("The Dal Makhani is mild.")).toBeInTheDocument();
    expect(screen.getByText(/This model was busy/)).toBeInTheDocument();
    expect(screen.getByText("Only a/one:free answered.")).toBeInTheDocument();
  });

  it("shows why it couldn't compare", async () => {
    compareModels.mockResolvedValueOnce({
      error: "Choose two different models.",
    });
    render(<CompareCard options={options} current={null} />);
    fireEvent.change(screen.getByLabelText("Model A"), {
      target: { value: "b/two:free" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    });
    expect(
      screen.getByText("Choose two different models."),
    ).toBeInTheDocument();
  });
});
