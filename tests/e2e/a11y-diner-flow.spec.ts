import { test, expect } from "@playwright/test";
import { createConfirmedTestUser } from "./test-auth-helpers";

/**
 * WCAG 2.2 AA regressions on the diner flow, asserted through real keyboard
 * interaction rather than by reading markup.
 *
 * Every check here corresponds to a barrier that was actually present and
 * measured on the deployed app (see docs/accessibility.md):
 *
 *   - the menu page had NO heading at all, the only page in the flow
 *     without one, leaving screen reader users nothing to navigate by on
 *     the app's busiest screen (SC 1.3.1 / 2.4.6)
 *   - the AI chat dialog had no close button anywhere in the app —
 *     `DialogClose` was exported and never used — and Escape did not close
 *     it, so a keyboard user who opened it had no intended way out
 *     (SC 2.1.2 / 2.4.3)
 *   - the chat transcript was not a live region, so the typing indicator
 *     announced "Thinking…" and the reply that followed was never
 *     announced at all (SC 4.1.3)
 *
 * Driven by Playwright specifically because ad-hoc browser automation
 * proved unreliable for focus and key events while this was being fixed —
 * a test that is flaky about focus is worse than no test, since it teaches
 * you to ignore it.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const hasRealSupabaseProject =
  supabaseUrl.length > 0 && !supabaseUrl.includes("placeholder");

test.describe("diner flow accessibility", () => {
  test.skip(
    !hasRealSupabaseProject,
    "Requires a real Supabase test project (NEXT_PUBLIC_SUPABASE_URL unset or placeholder).",
  );

  test("menu has a heading, and the AI dialog is operable by keyboard alone", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);

    const testId = Date.now();
    const email = `e2e-a11y-${testId}@example.com`;
    const password = "TestPassword123!";
    const slug = `e2e-a11y-${testId}`;

    await createConfirmedTestUser(email, password);
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("/dashboard");
    await page.getByRole("link", { name: "Create your restaurant" }).click();
    await page.waitForURL("/onboarding");
    await page.getByLabel("Restaurant name").fill("A11y Test Restaurant");
    await page.getByLabel("Slug").fill(slug);
    await page.getByRole("button", { name: "Create restaurant" }).click();
    await page.waitForURL("/dashboard");

    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("1");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Table 1" })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();

    // The diner gets their own context — a staff session would be
    // redirected to the explanation page instead of the menu.
    const dinerContext = await context.browser()!.newContext({
      baseURL: "http://localhost:3000",
    });
    const dinerPage = await dinerContext.newPage();
    await dinerPage.goto(customerUrl);
    await dinerPage.waitForURL(new RegExp(`/r/${slug}/menu`));

    // --- SC 1.3.1 / 2.4.6: the menu page must expose a heading ---
    // Visually hidden by design (the restaurant name is already in the
    // header); what matters is that it exists in the accessibility tree.
    await expect(
      dinerPage.getByRole("heading", { level: 1, includeHidden: false }),
    ).toHaveCount(1);

    // The category strip is navigation between filtered views — but it only
    // renders when the restaurant HAS categories, and this fixture is a
    // fresh restaurant with none. Asserted conditionally so the test says
    // something true either way, rather than demanding markup that is
    // correctly absent.
    const categoryNav = dinerPage.getByRole("navigation", {
      name: "Menu categories",
    });
    if ((await categoryNav.count()) > 0) {
      await expect(categoryNav).toBeAttached();
    }

    const trigger = dinerPage.getByRole("button", {
      name: "Open AI waiter chat",
    });
    if ((await trigger.count()) === 0) {
      // The AI waiter is only offered when a provider key is configured
      // and the restaurant opted in. Skipping is correct here; silently
      // passing would claim coverage this run did not have.
      test.skip(true, "AI waiter not available in this environment.");
    }

    // --- SC 2.1.2 / 2.4.3: open, operate and close using only the keyboard ---
    await trigger.focus();
    await dinerPage.keyboard.press("Enter");

    const dialog = dinerPage.getByRole("dialog", { name: "AI Waiter" });
    await expect(dialog).toBeVisible();

    // Focus must land inside the dialog, not stay on the trigger behind it.
    await expect(dialog.locator(":focus-within").first()).toBeAttached();

    // --- SC 4.1.3: the transcript is a live region, so replies are announced ---
    const transcript = dialog.getByRole("log");
    await expect(transcript).toHaveAttribute("aria-live", "polite");

    // --- A close affordance exists and works from the keyboard ---
    const close = dialog.getByRole("button", { name: "Close" });
    await expect(close).toBeVisible();
    await close.focus();
    await dinerPage.keyboard.press("Enter");
    await expect(dialog).toBeHidden();

    // --- Escape is the other expected way out ---
    await trigger.focus();
    await dinerPage.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dinerPage.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await dinerContext.close();
  });
});
