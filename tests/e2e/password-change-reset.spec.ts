import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createConfirmedTestUser } from "./test-auth-helpers";

/**
 * "Change password" (/account) and "Forgot password?" end to end, against
 * real Supabase Auth: the current-password check, signing in with the new
 * password, and a real recovery link through /auth/confirm to
 * /reset-password.
 *
 * Disposable project only (it creates users and changes their passwords);
 * run with `npm run test:e2e:disposable`. The reset link comes from the
 * admin API (generateLink) rather than an inbox, and uses the token_hash
 * form, since an admin-made link has no PKCE half in this browser. The
 * ?code= form that the default email template produces goes through the
 * same route; see src/app/auth/confirm/route.ts.
 */
const isDisposableProject = process.env.E2E_DISPOSABLE_PROJECT === "1";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("password change and reset", () => {
  test.skip(
    !isDisposableProject,
    "Requires the disposable Supabase project — run `npm run test:e2e:disposable`.",
  );

  test("change it on /account, then reset it from an emailed link", async ({
    page,
  }) => {
    const email = `e2e-password-${Date.now()}@example.com`;
    const first = `First-${crypto.randomUUID()}`;
    const second = `Second-${crypto.randomUUID()}`;
    const third = `Third-${crypto.randomUUID()}`;
    await createConfirmedTestUser(email, first);

    // Change password: the wrong current one is refused, the right one works.
    await signIn(page, email, first);
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    await page.goto("/account");

    await page
      .getByLabel("Current password", { exact: true })
      .fill("wrong-password");
    await page.getByLabel("New password", { exact: true }).fill(second);
    await page.getByLabel("Confirm new password", { exact: true }).fill(second);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(
      page.getByText("That isn't your current password."),
    ).toBeVisible();

    await page.getByLabel("Current password", { exact: true }).fill(first);
    await page.getByLabel("New password", { exact: true }).fill(second);
    await page.getByLabel("Confirm new password", { exact: true }).fill(second);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText(/^Password changed\./)).toBeVisible();

    // The new password signs in; the old one doesn't.
    await page.context().clearCookies();
    await signIn(page, email, first);
    await expect(page.getByText(/invalid login credentials/i)).toBeVisible();
    await signIn(page, email, second);
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));

    // Without a reset link, /reset-password offers no form.
    await page.goto("/reset-password");
    await expect(page.getByText("Send a new reset link")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save new password" }),
    ).toHaveCount(0);

    // Forgot password: the page always gives the same answer.
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await page.waitForURL(/\/forgot-password$/);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(
      page.getByText(/If there's an account for that email/),
    ).toBeVisible();

    // A real recovery link, opened in a fresh browser.
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data, error } = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
    });
    expect(error).toBeNull();
    const tokenHash = data.properties!.hashed_token;

    await page.context().clearCookies();
    await page.goto(
      `/auth/confirm?token_hash=${tokenHash}&type=recovery&next=/reset-password`,
    );
    await expect(page).toHaveURL(/\/reset-password$/);
    await page.getByLabel("New password", { exact: true }).fill(third);
    await page.getByLabel("Confirm new password", { exact: true }).fill(third);
    await page.getByRole("button", { name: "Save new password" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/reset-password"));

    // A used link doesn't work twice.
    await page.context().clearCookies();
    await page.goto(
      `/auth/confirm?token_hash=${tokenHash}&type=recovery&next=/reset-password`,
    );
    await expect(page).toHaveURL(/\/forgot-password\?link=expired$/);

    // The reset password signs in.
    await signIn(page, email, third);
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));

    await admin.auth.admin.deleteUser(
      (await admin.auth.admin.listUsers()).data.users.find(
        (u) => u.email === email,
      )!.id,
    );
  });
});
