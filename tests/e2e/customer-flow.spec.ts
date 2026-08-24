import { test, expect } from "@playwright/test";
import { createConfirmedTestUser } from "./test-auth-helpers";

/**
 * The full restaurant-dashboard-to-customer-cart flow from spec section 32:
 * dashboard -> create table -> generate QR -> open the QR URL -> customer
 * session created -> menu appears -> filter by category -> item detail ->
 * select a modifier -> add to cart -> cart page -> change quantity ->
 * remove -> clear. No order submission (out of scope for this batch).
 *
 * Needs a real (test-only) Supabase project for the same reason
 * dashboard-flow.spec.ts does — Auth (both password and anonymous) and
 * Postgres round trips aren't something a placeholder URL can fake. Skipped
 * automatically otherwise. Anonymous sign-ins must be enabled on the
 * project's Auth settings for the QR step to work.
 *
 * Never use production credentials — use a disposable Supabase test project.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const hasRealSupabaseProject =
  supabaseUrl.length > 0 && !supabaseUrl.includes("placeholder");

test.describe("customer QR-to-cart flow", () => {
  test.skip(
    !hasRealSupabaseProject,
    "Requires a real Supabase test project (NEXT_PUBLIC_SUPABASE_URL unset or placeholder).",
  );

  test("dashboard setup -> QR scan -> browse -> modifiers -> cart -> quantity/remove/clear", async ({
    page,
  }) => {
    const testId = Date.now();
    const email = `e2e-customer-flow-${testId}@example.com`;
    const password = "TestPassword123!";

    // --- Staff: create a pre-confirmed account (Admin API — this test only
    // needs a working login, not the signup/email-confirmation flow itself;
    // see dashboard-flow.spec.ts for that) and sign in ---
    await createConfirmedTestUser(email, password);
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // signIn() (unlike signUp()) redirects to /dashboard, not straight to
    // /onboarding — a fresh user with zero restaurants lands on
    // DashboardLayout's own "Create your restaurant" prompt there and must
    // click through, matching the real user journey (see dashboard/layout.tsx).
    await page.waitForURL("/dashboard");
    await page.getByRole("link", { name: "Create your restaurant" }).click();
    await page.waitForURL("/onboarding");

    const slug = `e2e-customer-flow-${testId}`;
    await page
      .getByLabel("Restaurant name")
      .fill("Customer Flow Test Restaurant");
    await page.getByLabel("Slug").fill(slug);
    await page.getByRole("button", { name: "Create restaurant" }).click();
    await page.waitForURL("/dashboard");

    // --- Staff: category, menu item, a modifier with one option, a table ---
    await page.goto("/dashboard/categories/new");
    await page.getByLabel("Name").fill("Mains");
    await page.getByRole("button", { name: "Create category" }).click();
    await page.waitForURL("/dashboard/categories");

    await page.goto("/dashboard/menu/new");
    await page.getByLabel("Name").fill("Masala Dosa");
    await page.getByLabel("Slug").fill("masala-dosa");
    await page.getByLabel("Category").selectOption({ label: "Mains" });
    await page.getByLabel("Price ($)").fill("9.99");
    await page
      .getByLabel("Description (optional)")
      .fill("A crispy, savory crepe.");
    await page.getByRole("button", { name: "Create menu item" }).click();
    await page.waitForURL("/dashboard/menu");

    await page.goto("/dashboard/modifiers/new");
    await page.getByLabel("Menu item").selectOption({ label: "Masala Dosa" });
    await page.getByLabel("Group name").fill("Add-ons");
    await page.getByRole("button", { name: "Create group" }).click();
    await page.waitForURL(/\/dashboard\/modifiers\/.+/);
    await page.getByLabel("Option name").fill("Extra Chutney");
    await page.getByLabel("Price adjustment ($)").fill("1.50");
    await page.getByRole("button", { name: "Add option" }).click();
    await expect(page.getByText("Extra Chutney")).toBeVisible();

    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("7");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");

    // --- Staff: open the table's QR page and read the real customer URL ---
    // /dashboard/tables renders a card grid (data-slot="card"), not a
    // <table>, so getByRole("row", ...) never matches — filter cards by text.
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Table 7" })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();
    expect(customerUrl).toContain(`/r/${slug}/table/`);

    // --- "Scan" the QR: navigating there signs the staff member out and
    // establishes a fresh anonymous customer session (see src/app/r/[restaurantSlug]/table/[token]/route.ts) ---
    await page.goto(customerUrl);
    await page.waitForURL(new RegExp(`/r/${slug}/menu`));
    await expect(
      page
        .getByRole("heading", { name: "Masala Dosa" })
        .or(page.getByText("Masala Dosa")),
    ).toBeVisible();

    // --- Category filter ---
    await page.getByRole("link", { name: "Mains" }).click();
    await expect(page.getByText("Masala Dosa")).toBeVisible();

    // --- Item detail + modifier selection ---
    await page.getByText("Masala Dosa").click();
    await page.waitForURL(/\/item\//);
    await page.getByText("Extra Chutney").click();
    await page.getByRole("button", { name: /Add to cart/ }).click();
    await expect(page.getByText("Added to cart.")).toBeVisible();

    // --- Cart: view, change quantity, remove, clear ---
    await page.getByRole("link", { name: "View cart" }).click();
    await page.waitForURL(/\/cart/);
    await expect(page.getByText("Masala Dosa")).toBeVisible();
    await expect(page.getByText("Extra Chutney")).toBeVisible();

    await page.getByRole("button", { name: "Increase quantity" }).click();
    // "2" alone is ambiguous once the header cart badge also shows the new
    // item count — scope to the cart page's main content.
    await expect(
      page.getByRole("main").getByText("2", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Your cart is empty.")).toBeVisible();

    // Add it back once more so "Clear cart" has something real to clear.
    await page.goto(`/r/${slug}/menu`);
    await page.getByText("Masala Dosa").click();
    await page.waitForURL(/\/item\//);
    await page.getByRole("button", { name: /Add to cart/ }).click();
    await page.getByRole("link", { name: "View cart" }).click();
    await page.waitForURL(/\/cart/);

    // DeleteButton's trigger reads "Clear cart"; the dialog's confirm button
    // is always labeled "Delete" regardless of the trigger's own label.
    await page.getByRole("button", { name: "Clear cart" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Your cart is empty.")).toBeVisible();
  });
});
