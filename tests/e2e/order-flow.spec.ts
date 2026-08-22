import { test, expect } from "@playwright/test";

/**
 * Batch 5's order engine, end to end (spec section 33): QR scan -> menu
 * item -> modifiers -> cart -> submit order -> confirmation page -> order
 * number/status shown -> refresh keeps it visible -> a double submission
 * doesn't create a second order -> a different customer session can't open
 * this order by URL. No kitchen UI (out of scope for this batch).
 *
 * Needs a real (test-only) Supabase project for the same reason
 * customer-flow.spec.ts does — Auth (password + anonymous) and Postgres
 * round trips aren't something a placeholder URL can fake. Skipped
 * automatically otherwise.
 *
 * Never use production credentials — use a disposable Supabase test project.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const hasRealSupabaseProject =
  supabaseUrl.length > 0 && !supabaseUrl.includes("placeholder");

test.describe("customer QR-to-order flow", () => {
  test.skip(
    !hasRealSupabaseProject,
    "Requires a real Supabase test project (NEXT_PUBLIC_SUPABASE_URL unset or placeholder).",
  );

  test("dashboard setup -> QR scan -> cart -> submit order -> confirmation -> refresh persists -> no duplicate -> cross-session denied", async ({
    page,
    context,
  }) => {
    const testId = Date.now();
    const email = `e2e-order-flow-${testId}@example.com`;
    const password = "TestPassword123!";

    // --- Staff: sign up and create a restaurant ---
    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    await page.waitForURL(/\/(onboarding|signup)/);
    if (page.url().includes("/signup")) {
      test.skip(
        true,
        "Project requires email confirmation — can't complete signup in an automated test.",
      );
    }

    const slug = `e2e-order-flow-${testId}`;
    await page.getByLabel("Restaurant name").fill("Order Flow Test Restaurant");
    await page.getByLabel("Slug").fill(slug);
    await page.getByRole("button", { name: "Create restaurant" }).click();
    await page.waitForURL("/dashboard");

    // --- Staff: category, menu item, a table ---
    await page.goto("/dashboard/categories/new");
    await page.getByLabel("Name").fill("Mains");
    await page.getByRole("button", { name: "Create category" }).click();
    await page.waitForURL("/dashboard/categories");

    await page.goto("/dashboard/menu/new");
    await page.getByLabel("Name").fill("Paneer Tikka");
    await page.getByLabel("Slug").fill("paneer-tikka");
    await page.getByLabel("Category").selectOption({ label: "Mains" });
    await page.getByLabel("Price ($)").fill("11.00");
    await page.getByRole("button", { name: "Create menu item" }).click();
    await page.waitForURL("/dashboard/menu");

    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("3");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");

    // --- Staff: read the table's real customer URL ---
    await page
      .getByRole("row", { name: /Table 3/ })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();
    expect(customerUrl).toContain(`/r/${slug}/table/`);

    // --- "Scan" the QR: signs the staff member out, starts a fresh
    // anonymous customer session ---
    await page.goto(customerUrl);
    await page.waitForURL(new RegExp(`/r/${slug}/menu`));

    // --- Add the item to cart (no modifiers on this item) and submit ---
    await page.getByText("Paneer Tikka").click();
    await page.waitForURL(/\/item\//);
    await page.getByRole("button", { name: /Add to cart/ }).click();
    await expect(page.getByText("Added to cart.")).toBeVisible();

    await page.getByRole("link", { name: "View cart" }).click();
    await page.waitForURL(/\/cart/);

    await page.getByRole("button", { name: "Place order" }).click();
    await page.waitForURL(/\/order\/.+/);

    // --- Confirmation page: order number + status shown ---
    await expect(page.getByText(/Order #\d+/)).toBeVisible();
    await expect(page.getByText("Order received")).toBeVisible();
    await expect(page.getByText("Paneer Tikka")).toBeVisible();
    const orderUrl = page.url();

    // --- Refresh: the order is still visible (persisted, not client state) ---
    await page.reload();
    await expect(page.getByText(/Order #\d+/)).toBeVisible();
    await expect(page.getByText("Paneer Tikka")).toBeVisible();

    // --- No duplicate order was created. A double-tap on "Place order"
    // itself is covered precisely (including the concurrent-request race)
    // by the submit_order() idempotency tests in
    // tests/integration/db/orders.test.ts — this checks the real,
    // end-to-end, persisted outcome: exactly one order exists for this
    // session, not two, via the session-scoped order history page.
    await page.goto(`/r/${slug}/orders`);
    await expect(page.getByText(/Order #\d+/)).toHaveCount(1);

    // --- A different customer session (different anonymous identity, same
    // table) cannot open this order by URL — RLS-scoped, not just hidden
    // in the UI. ---
    const otherContext = await context.browser()!.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(customerUrl); // starts a brand-new anonymous session
    await otherPage.waitForURL(new RegExp(`/r/${slug}/menu`));
    const response = await otherPage.goto(orderUrl);
    expect(response?.status()).toBe(404);
    await otherContext.close();
  });
});
