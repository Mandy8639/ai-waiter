// @vitest-environment jsdom
//
// Sign-up asks for the password twice and every password field has an eye
// button, so a typo is caught before the account is created. The server
// rule (signUpSchema) is the one that counts; the form checks first so a
// mismatch doesn't clear what was typed.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthForm } from "@/components/auth/auth-form";
import {
  PASSWORD_MISMATCH_MESSAGE,
  signInSchema,
  signUpSchema,
} from "@/lib/auth/auth-schemas";

afterEach(cleanup);

const EMAIL = "owner@example.com";

describe("signUpSchema", () => {
  it("accepts matching passwords", () => {
    const parsed = signUpSchema.safeParse({
      email: EMAIL,
      password: "abcdefgh",
      confirmPassword: "abcdefgh",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a mismatch, on the confirm field", () => {
    const parsed = signUpSchema.safeParse({
      email: EMAIL,
      password: "abcdefgh",
      confirmPassword: "abcdefgx",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["confirmPassword"],
        message: PASSWORD_MISMATCH_MESSAGE,
      }),
    ]);
  });

  it("refuses a missing confirmation", () => {
    for (const confirmPassword of [null, ""]) {
      const parsed = signUpSchema.safeParse({
        email: EMAIL,
        password: "abcdefgh",
        confirmPassword,
      });
      expect(parsed.success, String(confirmPassword)).toBe(false);
    }
  });

  it("sign-in doesn't ask for a confirmation", () => {
    expect(
      signInSchema.safeParse({ email: EMAIL, password: "x" }).success,
    ).toBe(true);
  });
});

function renderForm(confirmPassword: boolean) {
  const action = vi.fn(async () => ({}));
  render(
    <AuthForm
      action={action}
      submitLabel="Go"
      pendingLabel="Going"
      passwordAutoComplete={
        confirmPassword ? "new-password" : "current-password"
      }
      confirmPassword={confirmPassword}
    />,
  );
  return action;
}

const field = (label: string) =>
  screen.getByLabelText(label, { selector: "input" }) as HTMLInputElement;

describe("AuthForm", () => {
  it("sign-in has one password field", () => {
    renderForm(false);
    expect(field("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Confirm password")).toBeNull();
  });

  it("the eye button shows and hides the password", () => {
    renderForm(false);
    const input = field("Password");
    expect(input.type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.type).toBe("text");
    const hide = screen.getByRole("button", { name: "Hide password" });
    expect(hide).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(hide);
    expect(input.type).toBe("password");
  });

  it("sign-up's two fields each have their own eye button", () => {
    renderForm(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Show confirm password" }),
    );
    expect(field("Confirm password").type).toBe("text");
    expect(field("Password").type).toBe("password");
  });

  it("a mismatch is shown and not submitted, and clears on retyping", () => {
    const action = renderForm(true);
    fireEvent.change(field("Email"), { target: { value: EMAIL } });
    fireEvent.change(field("Password"), { target: { value: "abcdefgh" } });
    fireEvent.change(field("Confirm password"), {
      target: { value: "abcdefgx" },
    });
    fireEvent.submit(field("Password").form!);

    expect(screen.getByRole("alert")).toHaveTextContent(
      PASSWORD_MISMATCH_MESSAGE,
    );
    expect(field("Confirm password")).toHaveAttribute("aria-invalid", "true");
    expect(action).not.toHaveBeenCalled();
    // What was typed is kept.
    expect(field("Password").value).toBe("abcdefgh");

    fireEvent.change(field("Confirm password"), {
      target: { value: "abcdefgh" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
