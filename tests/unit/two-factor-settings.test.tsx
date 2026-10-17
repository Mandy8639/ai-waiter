// @vitest-environment jsdom
//
// The Account page's two-step verification card: off → scan the QR code
// and enter the first code → on; on → turning it off takes a second click.
// The server actions are stubbed; their rules are tested against Postgres
// and in tests/unit/two-factor.test.ts.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const actions = vi.hoisted(() => ({
  startTwoFactorSetup: vi.fn(),
  confirmTwoFactorSetup: vi.fn(),
  removeTwoFactor: vi.fn(),
}));
vi.mock("@/lib/auth/two-factor-actions", () => actions);

import { TwoFactorSettings } from "@/components/account/two-factor-settings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TwoFactorSettings", () => {
  it("sets up: QR code and key, then the first code turns it on", async () => {
    actions.startTwoFactorSetup.mockResolvedValue({
      setup: {
        factorId: "factor-1",
        qrCode: "data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E",
        secret: "ABCDEFGHIJKLMNOP",
      },
    });
    actions.confirmTwoFactorSetup.mockResolvedValue({ done: true });

    render(<TwoFactorSettings enabledFactorId={null} />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Turn on two-step verification" }),
      );
    });

    expect(
      await screen.findByRole("img", { name: /QR code/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("ABCD EFGH IJKL MNOP")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "123 456" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    });

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const sent = actions.confirmTwoFactorSetup.mock.calls[0][1] as FormData;
    expect(sent.get("factorId")).toBe("factor-1");
    expect(sent.get("code")).toBe("123 456");
  });

  it("shows a wrong code without leaving the setup", async () => {
    actions.startTwoFactorSetup.mockResolvedValue({
      setup: { factorId: "f", qrCode: "data:,", secret: "AAAA" },
    });
    actions.confirmTwoFactorSetup.mockResolvedValue({
      error: "That code didn't work.",
    });

    render(<TwoFactorSettings enabledFactorId={null} />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Turn on two-step verification" }),
      );
    });
    fireEvent.change(await screen.findByLabelText("Verification code"), {
      target: { value: "000000" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That code didn't work.",
    );
    expect(screen.getByRole("img", { name: /QR code/ })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says why setup couldn't start", async () => {
    actions.startTwoFactorSetup.mockResolvedValue({
      error: "Couldn't start the setup. Please try again.",
    });
    render(<TwoFactorSettings enabledFactorId={null} />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Turn on two-step verification" }),
      );
    });
    expect(
      await screen.findByText("Couldn't start the setup. Please try again."),
    ).toBeInTheDocument();
  });

  it("when on, turning it off needs a second click", async () => {
    actions.removeTwoFactor.mockResolvedValue({ done: true });
    render(<TwoFactorSettings enabledFactorId="factor-9" />);

    expect(
      screen.getByText(/On\. Signing in asks for a code/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(actions.removeTwoFactor).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, turn it off" }));
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const sent = actions.removeTwoFactor.mock.calls[0][1] as FormData;
    expect(sent.get("factorId")).toBe("factor-9");
  });
});
