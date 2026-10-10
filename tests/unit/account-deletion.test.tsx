// @vitest-environment jsdom
//
// Account deletion's app side: the typed confirmation, what each refusal
// says, the form only arming once DELETE is typed, /account needing a real
// sign-in, and the ways in (dashboard header, the pre-dashboard screens,
// the privacy policy). The rules themselves are tested against Postgres in
// tests/integration/db/delete-my-account.test.ts.
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteAccountForm } from "@/components/account/delete-account-form";
import {
  deletionErrorMessage,
  isDeletionConfirmed,
} from "@/lib/account/delete-core";
import { decideRouteAccess } from "@/lib/auth/route-access";
import { PRIVACY_CONTACT_EMAIL } from "@/lib/legal/privacy";

afterEach(cleanup);

describe("isDeletionConfirmed", () => {
  it("takes DELETE exactly, ignoring surrounding spaces", () => {
    expect(isDeletionConfirmed("DELETE")).toBe(true);
    expect(isDeletionConfirmed("  DELETE ")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const input of ["delete", "Delete", "DELET", "", "yes", null, 1]) {
      expect(isDeletionConfirmed(input), String(input)).toBe(false);
    }
  });
});

describe("deletionErrorMessage", () => {
  it("tells a restaurant's only owner what to do", () => {
    expect(
      deletionErrorMessage("SOLE_OWNER: make someone else an owner first"),
    ).toMatch(/only owner.*Staff page/);
  });

  it("asks a signed-out visitor or a diner to sign in", () => {
    expect(deletionErrorMessage("NOT_SIGNED_IN")).toBe(
      "Sign in to delete your account.",
    );
    expect(deletionErrorMessage("ANONYMOUS_SESSION: ...")).toBe(
      "Sign in to delete your account.",
    );
  });

  it("never shows a raw database error, and offers the privacy address", () => {
    const message = deletionErrorMessage(
      'update or delete on table "users" violates foreign key constraint',
    );
    expect(message).not.toMatch(/foreign key|users/);
    expect(message).toContain(PRIVACY_CONTACT_EMAIL);
  });
});

describe("DeleteAccountForm", () => {
  it("keeps the button disabled until DELETE is typed", () => {
    render(<DeleteAccountForm action={vi.fn(async () => ({}))} />);
    const button = screen.getByRole("button", { name: "Delete my account" });
    const input = screen.getByLabelText("Type DELETE to confirm");

    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: "delete" } });
    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: "DELETE" } });
    expect(button).toBeEnabled();
  });

  it("sends the confirmation and shows the refusal it gets back", async () => {
    const action = vi.fn(async (_state: unknown, formData: FormData) => {
      expect(formData.get("confirmation")).toBe("DELETE");
      return { error: deletionErrorMessage("SOLE_OWNER") };
    });
    render(<DeleteAccountForm action={action} />);
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));

    expect(
      await screen.findByText(/only owner of a restaurant/, undefined, {
        timeout: 5000,
      }),
    ).toBeVisible();
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
});

describe("reaching /account", () => {
  it("needs a real sign-in; a diner's visit or no session goes to sign-in", () => {
    expect(
      decideRouteAccess("/account", { signedIn: true, isAnonymous: false }),
    ).toEqual({ type: "continue" });
    for (const visitor of [
      { signedIn: false, isAnonymous: false },
      { signedIn: true, isAnonymous: true },
    ]) {
      expect(decideRouteAccess("/account", visitor)).toEqual({
        type: "redirect",
        to: "/login",
        redirectTo: "/account",
      });
    }
  });

  it.each([
    // The dashboard header, and both screens shown before a dashboard
    // exists (no restaurant yet, several to choose from).
    ["src/app/dashboard/layout.tsx", 3],
    ["src/app/privacy/page.tsx", 1],
  ])("is linked from %s", (file, count) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const links =
      (source.match(/href="\/account"/g) ?? []).length +
      (source.match(/<AccountLink \/>/g) ?? []).length;
    expect(links).toBeGreaterThanOrEqual(count);
  });
});
