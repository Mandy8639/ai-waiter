import { test, expect } from "@playwright/test";
import { createConfirmedTestUser } from "./test-auth-helpers";

/**
 * A signed-in staff member who follows a table QR link keeps their session.
 *
 * This behaviour has no other coverage. It cannot be tested in jsdom — it
 * depends on a real Supabase session and the route handler's redirect — and
 * when it was introduced, five existing specs broke precisely because
 * nothing asserted it and they all silently relied on the previous
 * behaviour (scanning while signed in logged staff out and turned them into
 * a diner).
 *
 * The failure this guards against is not cosmetic: a waiter tapping a table
 * code mid-service would be signed out of the dashboard with no
 * explanation.
 *
 * Needs a real (test-only) Supabase project, same as the other flow specs.
 * Never use production credentials.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const hasRealSupabaseProject =
  supabaseUrl.length > 0 && !supabaseUrl.includes("placeholder");

test.describe("staff scanning a table QR code", () => {
  test.skip(
    !hasRealSupabaseProject,
    "Requires a real Supabase test project (NEXT_PUBLIC_SUPABASE_URL unset or placeholder).",
  );

  test("keeps the staff session and explains, instead of signing them out", async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);

    const testId = Date.now();
    const email = `e2e-staff-qr-${testId}@example.com`;
    const password = "TestPassword123!";
    const slug = `e2e-staff-qr-${testId}`;

    // --- Staff: sign in and create a restaurant with one table ---
    await createConfirmedTestUser(email, password);
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("/dashboard");
    await page.getByRole("link", { name: "Create your restaurant" }).click();
    await page.waitForURL("/onboarding");

    await page.getByLabel("Restaurant name").fill("Staff QR Test Restaurant");
    await page.getByLabel("Slug").fill(slug);
    await page.getByRole("button", { name: "Create restaurant" }).click();
    await page.waitForURL("/dashboard");

    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("3");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");

    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Table 3" })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();

    // --- The whole point: scan it while still signed in as staff ---
    await page.goto(customerUrl);

    // Redirected to an explanation, NOT into the diner menu.
    await page.waitForURL(/\/table\/.+\/staff$/);
    await expect(
      page.getByRole("heading", { name: /signed in as staff/i }),
    ).toBeVisible();

    // The claim that page makes about itself must actually be true: the
    // dashboard session survived. Asserted by reaching a dashboard page
    // rather than by trusting the copy.
    await page.getByRole("link", { name: "Back to the dashboard" }).click();
    await page.waitForURL("/dashboard");
    await expect(page.getByRole("link", { name: "Tables" })).toBeVisible();

    // --- And a real diner, in their own context, is unaffected ---
    const dinerContext = await context.browser()!.newContext({
      baseURL: "http://localhost:3000",
    });
    const dinerPage = await dinerContext.newPage();
    await dinerPage.goto(customerUrl);
    await dinerPage.waitForURL(new RegExp(`/r/${slug}/menu`));

    await dinerContext.close();
  });
});
