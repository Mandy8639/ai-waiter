import { test, expect } from "@playwright/test";

/**
 * The full onboarding-to-management flow. Requires a real (test-only)
 * Supabase project — signup, restaurant creation, and every CRUD step
 * here need actual Auth + Postgres round trips, not something a
 * placeholder URL can fake. Skipped automatically unless
 * NEXT_PUBLIC_SUPABASE_URL points at a real project (not the
 * "placeholder" one used for local UI-only checks) — see the Batch 3
 * final report for how to run this for real.
 *
 * Never use production credentials here — use a disposable Supabase test
 * project.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const hasRealSupabaseProject =
  supabaseUrl.length > 0 && !supabaseUrl.includes("placeholder");

/**
 * Set only by playwright.e2e-disposable.config.ts. The header above has
 * always said "never use production credentials here" — this enforces it
 * rather than trusting it.
 *
 * Without this, `npm run test:e2e` (which points at the live project) ran
 * this spec's real /signup against production: it created auth users
 * there, and then failed after 30s because that project has "Confirm
 * email" on and nothing navigates to /onboarding without a human opening
 * an email. A test that cannot pass where it is being run should say so,
 * not time out.
 */
const isDisposableProject = process.env.E2E_DISPOSABLE_PROJECT === "1";

test.describe("full dashboard flow", () => {
  test.skip(
    !hasRealSupabaseProject,
    "Requires a real Supabase test project (NEXT_PUBLIC_SUPABASE_URL unset or placeholder).",
  );
  test.skip(
    !isDisposableProject,
    "Requires the disposable Supabase project — run `npm run test:e2e:disposable`, not `npm run test:e2e`. This spec signs up a real user and needs 'Confirm email' off; see docs/development.md#e2e-disposable.",
  );

  test("signup -> create restaurant -> manage menu -> logout -> redirected to login", async ({
    page,
  }) => {
    const testId = Date.now();
    const email = `e2e-test-${testId}@example.com`;
    const password = "TestPassword123!";

    // Sign up
    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    // Either lands on /onboarding directly (auto-confirmed dev project) or
    // shows a "check your email" message and stays on /signup
    // (confirmation required). Waits for one of these two REAL outcomes
    // rather than polling page.url() right after click(): the page is
    // already on /signup at this point, so a naive
    // `waitForURL(/\/(onboarding|signup)/)` matches the CURRENT,
    // unchanged URL instantly — resolving before the async signup/
    // redirect has even started, which made this always misreport
    // "confirmation required" even on a project with confirmation
    // genuinely off (confirmed directly: a manual signup against this
    // same build succeeded and redirected correctly, while this test's
    // original check still reported the URL as unchanged).
    await Promise.race([
      page.waitForURL("/onboarding"),
      page.getByText(/check your email/i).waitFor({ state: "visible" }),
    ]);
    if (page.url().includes("/signup")) {
      test.skip(
        true,
        "Project requires email confirmation — can't complete signup in an automated test.",
      );
    }

    // Create restaurant
    await expect(
      page.getByRole("heading", { name: "Create your restaurant" }),
    ).toBeVisible();
    const slug = `e2e-restaurant-${testId}`;
    await page.getByLabel("Restaurant name").fill("E2E Test Restaurant");
    await page.getByLabel("Web address").fill(slug);
    await page.getByRole("button", { name: "Create restaurant" }).click();

    await page.waitForURL("/dashboard");
    await expect(
      page.getByRole("heading", { name: "E2E Test Restaurant" }),
    ).toBeVisible();

    // Create category
    await page.goto("/dashboard/categories");
    // .first(): a fresh restaurant has zero categories, so both the header
    // toolbar's "New category" link and the empty-state CTA's "New
    // category" link render at once — both go to the same
    // /dashboard/categories/new destination, so which one is clicked
    // doesn't matter (see categories/page.tsx).
    await page.getByRole("link", { name: "New category" }).first().click();
    await page.getByLabel("Name").fill("Starters");
    await page.getByRole("button", { name: "Create category" }).click();
    await page.waitForURL("/dashboard/categories");
    await expect(page.getByText("Starters")).toBeVisible();

    // Create menu item
    await page.goto("/dashboard/menu/new");
    await page.getByLabel("Name").fill("Test Dish");
    await page.getByLabel("Slug").fill("test-dish");
    await page.getByLabel("Category").selectOption({ label: "Starters" });
    await page.getByLabel("Price ($)").fill("9.99");
    await page.getByRole("button", { name: "Create menu item" }).click();
    await page.waitForURL("/dashboard/menu");
    await expect(page.getByText("Test Dish")).toBeVisible();

    // Edit menu item
    await page
      .getByRole("row", { name: /Test Dish/ })
      .getByRole("link", { name: "Edit" })
      .click();
    await page.getByLabel("Name").fill("Test Dish (Edited)");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL("/dashboard/menu");
    await expect(page.getByText("Test Dish (Edited)")).toBeVisible();

    // Toggle availability
    await page
      .getByRole("row", { name: /Test Dish \(Edited\)/ })
      .getByRole("button", { name: "Mark unavailable" })
      .click();
    await expect(
      page
        .getByRole("row", { name: /Test Dish \(Edited\)/ })
        .getByText("Unavailable"),
    ).toBeVisible();

    // Create modifier group
    await page.goto("/dashboard/modifiers/new");
    await page
      .getByLabel("Menu item")
      .selectOption({ label: "Test Dish (Edited)" });
    await page.getByLabel("Group name").fill("Size");
    await page.getByRole("button", { name: "Create group" }).click();
    await page.waitForURL(/\/dashboard\/modifiers\/.+/);
    await expect(page.getByRole("heading", { name: "Size" })).toBeVisible();

    // Create table
    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("1");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");
    await expect(page.getByText("Table 1")).toBeVisible();

    // Logout
    await page.getByRole("button", { name: "Log out" }).click();
    await page.waitForURL("/login");

    // Attempting the dashboard again redirects to login
    await page.goto("/dashboard");
    await page.waitForURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
