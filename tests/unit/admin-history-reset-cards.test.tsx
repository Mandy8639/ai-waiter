// @vitest-environment jsdom
//
// The Admin page's Change history and Emergency reset: both ask once
// before acting, and say what happened (src/components/admin/).
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const undoChange = vi.fn();
const resetAllModels = vi.fn();
vi.mock("@/lib/admin/actions", () => ({
  undoChange: (...args: unknown[]) => undoChange(...args),
  resetAllModels: (...args: unknown[]) => resetAllModels(...args),
}));

import { HistoryCard, type HistoryRow } from "@/components/admin/history-card";
import { ResetCard } from "@/components/admin/reset-card";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function dialogButton(name: string) {
  return screen
    .getAllByRole("button", { name })
    .find((b) => b.closest("[role='alertdialog']"))!;
}

const row: HistoryRow = {
  id: "00000000-0000-4000-8000-000000000001",
  when: "19 Oct, 16:40 UTC",
  who: "you",
  what: "Diner's AI waiter",
  change: "dots → paid",
  test: "test passed, 3.1 s, 0.8¢",
  undo: "This tests dots for Diner's AI waiter again and puts it back only if it passes today.",
};

describe("HistoryCard", () => {
  it("asks first, then undoes and says what happened", async () => {
    undoChange.mockResolvedValue({ ok: true, message: "Back on dots." });
    render(<HistoryCard rows={[row]} failedToLoad={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText(/puts it back only if it passes/),
    ).toBeInTheDocument();
    expect(undoChange).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(dialogButton("Undo"));
    });
    expect(undoChange).toHaveBeenCalledWith(row.id);
    expect(screen.getByText("Back on dots.")).toBeInTheDocument();
  });

  it("shows why an Undo was refused", async () => {
    undoChange.mockResolvedValue({
      ok: false,
      error: "The earlier list failed its Test today, so it wasn't put back.",
    });
    render(<HistoryCard rows={[row]} failedToLoad={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await act(async () => {
      fireEvent.click(dialogButton("Undo"));
    });
    expect(screen.getByText(/failed its Test today/)).toBeInTheDocument();
  });

  it("has no Undo where there's nothing to undo, and says when it can't load", () => {
    render(
      <HistoryCard rows={[{ ...row, undo: null }]} failedToLoad={false} />,
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    cleanup();
    render(<HistoryCard rows={[]} failedToLoad />);
    expect(screen.getByText(/Couldn't load the history/)).toBeInTheDocument();
  });
});

describe("ResetCard", () => {
  it("asks first, then resets", async () => {
    resetAllModels.mockResolvedValue({ ok: true });
    render(<ResetCard savedCount={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset all models" }));
    expect(
      await screen.findByText(/The 2 jobs with a list saved here/),
    ).toBeInTheDocument();
    expect(resetAllModels).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(dialogButton("Reset all models"));
    });
    expect(resetAllModels).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/Every job is back on its default/),
    ).toBeInTheDocument();
  });

  it("is off when nothing is saved", () => {
    render(<ResetCard savedCount={0} />);
    expect(
      screen.getByRole("button", { name: "Reset all models" }),
    ).toBeDisabled();
  });
});
