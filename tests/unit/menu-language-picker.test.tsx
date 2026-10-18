// @vitest-environment jsdom
//
// Switching the menu language: a failure (dropped connection) is said
// inline and leaves the menu where it was, rather than throwing to the
// error page.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const setMenuLanguage = vi.fn();
vi.mock("@/lib/translations/actions", () => ({
  setMenuLanguage: (code: string) => setMenuLanguage(code),
}));

import { MenuLanguagePicker } from "@/components/customer/menu-language-picker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MenuLanguagePicker", () => {
  it("switches and refreshes the menu", async () => {
    setMenuLanguage.mockResolvedValue(undefined);
    render(<MenuLanguagePicker current={null} available={["es"]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Español" }));
    });
    expect(setMenuLanguage).toHaveBeenCalledWith("es");
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when it fails, and keeps the menu", async () => {
    setMenuLanguage.mockRejectedValue(new Error("Failed to fetch"));
    render(<MenuLanguagePicker current={null} available={["es"]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Español" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't change the language",
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
