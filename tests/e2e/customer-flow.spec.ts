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
    context,
  }) => {
    // A second browser context means a second cold page load on top of the
    // dashboard setup this test already does, which pushes it past the 30s
    // default. Raised here rather than globally so every other spec keeps
    // the tighter budget.
    test.setTimeout(60_000);

    const testId = Date.now();
    const email = `e2e-customer-flow-${testId}@example.com`;
    const password = "TestPassword123!";

    // --- Staff: create a pre-confirmed account (Admin API — this test only
    // needs a working login, not the signup/email-confirmation flow itself;
    // see dashboard-flow.spec.ts for that) and sign in ---
    await createConfirmedTestUser(email, password);
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
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
    await page.getByLabel("Web address").fill(slug);
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

    // --- "Scan" the QR in a SEPARATE browser context ---
    //
    // Scanning while signed in as staff no longer signs them out: the route
    // now redirects them to an explanation instead, so their dashboard
    // session survives (see src/app/r/[restaurantSlug]/table/[token]/route.ts).
    // A diner is a different person on a different device, so the test says
    // so — the same separation kitchen-flow.spec.ts has always used.
    // baseURL is NOT inherited by a context created this way, and several
    // diner steps navigate with a relative path. Without it those gotos
    // resolve against about:blank and the page never arrives.
    const customerContext = await context.browser()!.newContext({
      baseURL: "http://localhost:3000",
    });
    const customerPage = await customerContext.newPage();
    await customerPage.goto(customerUrl);
    await customerPage.waitForURL(new RegExp(`/r/${slug}/menu`));
    await expect(
      customerPage
        .getByRole("heading", { name: "Masala Dosa" })
        .or(customerPage.getByText("Masala Dosa")),
    ).toBeVisible();

    // --- Category filter ---
    await customerPage.getByRole("link", { name: "Mains" }).click();
    await expect(customerPage.getByText("Masala Dosa")).toBeVisible();

    // --- Item detail + modifier selection ---
    await customerPage.getByText("Masala Dosa").click();
    await customerPage.waitForURL(/\/item\//);
    await customerPage.getByText("Extra Chutney").click();
    await customerPage
      .getByRole("button", { name: /Add to order|Add another/ })
      .click();
    // 15s, not the 5s default: this is a persistent <Alert> bound to the
    // form action's success state (item-detail-form.tsx) with no
    // auto-dismiss, so a longer timeout tolerates a loaded server without
    // weakening the assertion — the element cannot vanish on its own.
    // Observed failing at 5s only when the suite ran fully parallel
    // alongside the 2-minute live-model AI spec, which is contention on
    // the shared dev server, not a product defect.
    await expect(customerPage.getByText("Added to your order")).toBeVisible({
      timeout: 15_000,
    });

    // --- Cart: view, change quantity, remove, clear ---
    await customerPage
      .getByRole("link", { name: "View order", exact: true })
      .click();
    await customerPage.waitForURL(/\/cart/);
    await expect(customerPage.getByText("Masala Dosa")).toBeVisible();
    await expect(customerPage.getByText("Extra Chutney")).toBeVisible();

    await customerPage.getByRole("button", { name: /One more/ }).click();
    // "2" alone is ambiguous once the header cart badge also shows the new
    // item count — scope to the cart page's main content.
    await expect(
      customerPage.getByRole("main").getByText("2", { exact: true }),
    ).toBeVisible();

    await customerPage.getByRole("button", { name: "Remove" }).click();
    await expect(customerPage.getByText("Your order is empty")).toBeVisible();

    // Add it back once more so "Clear cart" has something real to clear.
    await customerPage.goto(`/r/${slug}/menu`);
    await customerPage.getByText("Masala Dosa").click();
    await customerPage.waitForURL(/\/item\//);
    await customerPage
      .getByRole("button", { name: /Add to order|Add another/ })
      .click();
    await customerPage
      .getByRole("link", { name: "View order", exact: true })
      .click();
    await customerPage.waitForURL(/\/cart/);

    // DeleteButton's trigger reads "Clear cart"; the dialog's confirm button
    // is always labeled "Delete" regardless of the trigger's own label.
    await customerPage.getByRole("button", { name: "Clear order" }).click();
    await customerPage
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(customerPage.getByText("Your order is empty")).toBeVisible();
  });
});
