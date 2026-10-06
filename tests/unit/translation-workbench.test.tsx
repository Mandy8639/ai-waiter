// @vitest-environment jsdom
//
// Phase K: the owner's translation screen. Found live: after "Draft with
// AI", each row kept the empty box it first rendered, so the drafts were
// invisible and could not be approved. A draft arriving from the server
// must show up in its row with the Approve button.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchRow } from "@/lib/translations/queries";

vi.mock("@/lib/translations/actions", () => ({
  approveTranslation: vi.fn(async () => ({})),
  deleteTranslation: vi.fn(async () => ({})),
  draftMissingTranslations: vi.fn(async () => ({})),
  saveTranslation: vi.fn(async () => ({})),
}));

const { TranslationWorkbench } =
  await import("@/components/dashboard/translation-workbench");

afterEach(cleanup);

const missing: WorkbenchRow = {
  entity: "menu_item",
  entityId: "d1",
  field: "name",
  context: "Dish name",
  source: "Masala Dosa",
  translationId: null,
  text: null,
  origin: null,
  state: "missing",
};

describe("TranslationWorkbench", () => {
  it("shows a draft that arrives after the page rendered, ready to approve", () => {
    const { rerender } = render(
      <TranslationWorkbench restaurantId="r1" language="hi" rows={[missing]} />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("");

    rerender(
      <TranslationWorkbench
        restaurantId="r1"
        language="hi"
        rows={[
          {
            ...missing,
            translationId: "t1",
            text: "मसाला डोसा",
            origin: "ai",
            state: "draft",
          },
        ]}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("मसाला डोसा");
    expect(
      screen.getByRole("button", { name: "Approve — show to diners" }),
    ).toBeInTheDocument();
    expect(screen.getByText("AI draft")).toBeInTheDocument();
  });

  it("offers re-approval, not plain approval, when the original has changed", () => {
    render(
      <TranslationWorkbench
        restaurantId="r1"
        language="hi"
        rows={[
          {
            ...missing,
            translationId: "t1",
            text: "मसाला डोसा",
            origin: "owner",
            state: "stale",
          },
        ]}
      />,
    );
    expect(
      screen.getByText("Original changed — not shown"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve for the new original" }),
    ).toBeInTheDocument();
  });

  it("only offers AI drafting when something is missing or out of date", () => {
    render(
      <TranslationWorkbench
        restaurantId="r1"
        language="hi"
        rows={[{ ...missing, translationId: "t1", text: "x", state: "draft" }]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Draft missing Hindi with AI/ }),
    ).toBeDisabled();
  });
});
