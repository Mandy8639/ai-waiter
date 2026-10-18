// @vitest-environment jsdom
//
// The password forms: a mismatch is caught before submitting (nothing is
// sent, nothing typed is lost), and what the server says is shown. The
// server action is stubbed; its rules are in tests/unit/password-reset.test.ts.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  changePassword: vi.fn(),
  setNewPassword: vi.fn(),
  requestPasswordReset: vi.fn(),
}));
vi.mock("@/lib/auth/password-actions", () => actions);

import { ChangePasswordForm } from "@/components/account/change-password-form";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const field = (label: string) =>
  screen.getByLabelText(label, { selector: "input" }) as HTMLInputElement;

describe("ChangePasswordForm", () => {
  it("catches a mismatch before sending anything", () => {
    render(<ChangePasswordForm />);
    fireEvent.change(field("Current password"), {
      target: { value: "old-pass-1" },
    });
    fireEvent.change(field("New password"), {
      target: { value: "new-pass-1" },
    });
    fireEvent.change(field("Confirm new password"), {
      target: { value: "new-pass-2" },
    });
    fireEvent.submit(field("New password").form!);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Passwords don't match.",
    );
    expect(actions.changePassword).not.toHaveBeenCalled();
    expect(field("Current password").value).toBe("old-pass-1");
  });

  it("shows a wrong current password on that field", async () => {
    actions.changePassword.mockResolvedValue({
      fieldErrors: { currentPassword: ["That isn't your current password."] },
    });
    render(<ChangePasswordForm />);
    fireEvent.change(field("Current password"), {
      target: { value: "wrong-one" },
    });
    fireEvent.change(field("New password"), {
      target: { value: "new-pass-1" },
    });
    fireEvent.change(field("Confirm new password"), {
      target: { value: "new-pass-1" },
    });
    await act(async () => {
      fireEvent.submit(field("New password").form!);
    });

    expect(
      await screen.findByText("That isn't your current password."),
    ).toBeInTheDocument();
    expect(field("Current password")).toHaveAttribute("aria-invalid", "true");
  });

  it("each password field has its own eye button", () => {
    render(<ChangePasswordForm />);
    for (const name of [
      "Show current password",
      "Show new password",
      "Show confirm new password",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

describe("ForgotPasswordForm", () => {
  it("swaps the form for the same message whatever the email", async () => {
    actions.requestPasswordReset.mockResolvedValue({
      message: "If there's an account for that email, we've sent a link.",
    });
    render(<ForgotPasswordForm />);
    fireEvent.change(field("Email"), { target: { value: "a@example.com" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    });

    expect(
      await screen.findByText(/If there's an account for that email/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send reset link" }),
    ).toBeNull();
  });
});
