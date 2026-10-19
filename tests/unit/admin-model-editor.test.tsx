// @vitest-environment jsdom
//
// The Admin page's model editor: Save stays locked until a Test passes on
// exactly the list shown, and changing the list after a pass locks it
// again (src/components/admin/model-editor.tsx).
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const testModelList = vi.fn();
const saveModelList = vi.fn();
vi.mock("@/lib/admin/actions", () => ({
  testModelList: (...args: unknown[]) => testModelList(...args),
  saveModelList: (...args: unknown[]) => saveModelList(...args),
}));

import { ModelEditor } from "@/components/admin/model-editor";

const TEST_ID = "00000000-0000-4000-8000-0000000000aa";
const options = [
  { model: "a/one:free", note: "Tested", price: "Free", available: true },
  { model: "b/two:free", note: "Tested", price: "Free", available: true },
  { model: "c/paid", note: "Tested", price: "$1.00 in", available: true },
];

function passed(models: string[]) {
  return {
    result: {
      job: "vision",
      models,
      passed: true,
      checks: [{ label: "Invented no price", ok: true }],
      reply: "Samosa: 4.99",
      ms: 3100,
      costUsd: 0.008,
    },
    testId: TEST_ID,
  };
}

function renderEditor() {
  render(
    <ModelEditor
      job="vision"
      label="Menu photo reader"
      freeOnly={false}
      current={["a/one:free"]}
      options={options}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
}

const save = () => screen.getByRole("button", { name: "Save" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelEditor", () => {
  it("keeps Save locked until a Test passes on the list shown", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Main model"), {
      target: { value: "c/paid" },
    });
    expect(save()).toBeDisabled();

    testModelList.mockResolvedValue(passed(["c/paid"]));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test" }));
    });
    expect(testModelList).toHaveBeenCalledWith("vision", ["c/paid"]);
    expect(screen.getByText("Test passed")).toBeInTheDocument();
    expect(screen.getByText(/0\.8¢/)).toBeInTheDocument();
    expect(save()).toBeEnabled();
  });

  it("locks Save again when the list changes after a pass", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Main model"), {
      target: { value: "c/paid" },
    });
    testModelList.mockResolvedValue(passed(["c/paid"]));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test" }));
    });
    fireEvent.change(screen.getByLabelText("Backup 1"), {
      target: { value: "b/two:free" },
    });
    expect(save()).toBeDisabled();
    expect(
      screen.getByText(/This result is for a different list/),
    ).toBeInTheDocument();
  });

  it("keeps Save locked after a failed Test", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Main model"), {
      target: { value: "c/paid" },
    });
    const failed = passed(["c/paid"]);
    testModelList.mockResolvedValue({
      result: { ...failed.result, passed: false },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test" }));
    });
    expect(screen.getByText("Test failed")).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it("takes any OpenRouter name under Other…", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Main model"), {
      target: { value: "__other__" },
    });
    fireEvent.change(
      screen.getByLabelText("Main model: OpenRouter model name"),
      { target: { value: " x/new-model " } },
    );
    testModelList.mockResolvedValue({ error: "OpenRouter doesn't list it." });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test" }));
    });
    expect(testModelList).toHaveBeenCalledWith("vision", ["x/new-model"]);
    expect(screen.getByText("OpenRouter doesn't list it.")).toBeInTheDocument();
  });

  it("asks once more, then saves with the passing test", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Main model"), {
      target: { value: "c/paid" },
    });
    testModelList.mockResolvedValue(passed(["c/paid"]));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test" }));
    });
    fireEvent.click(save());
    expect(
      await screen.findByText(/will start using c\/paid within about a minute/),
    ).toBeInTheDocument();

    saveModelList.mockResolvedValue({ ok: true });
    const confirm = screen
      .getAllByRole("button", { name: "Save" })
      .find((b) => b.closest("[role='alertdialog']"));
    await act(async () => {
      fireEvent.click(confirm!);
    });
    expect(saveModelList).toHaveBeenCalledWith("vision", ["c/paid"], TEST_ID);
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
  });
});
