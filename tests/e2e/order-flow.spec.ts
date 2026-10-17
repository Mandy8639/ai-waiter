import { test, expect } from "@playwright/test";
import { createConfirmedTestUser } from "./test-auth-helpers";

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
    // A second browser context means a second cold page load on top of the
    // dashboard setup this test already does, which pushes it past the 30s
    // default. Raised here rather than globally so every other spec keeps
    // the tighter budget.
    test.setTimeout(60_000);

    const testId = Date.now();
    const email = `e2e-order-flow-${testId}@example.com`;
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
    // /dashboard/tables renders a card grid (data-slot="card"), not a
    // <table>, so getByRole("row", ...) never matches — filter cards by text.
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Table 3" })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();
    expect(customerUrl).toContain(`/r/${slug}/table/`);

    // --- "Scan" the QR: signs the staff member out, starts a fresh
    // anonymous customer session ---
    // baseURL is NOT inherited by a context created this way, and several
    // diner steps navigate with a relative path. Without it those gotos
    // resolve against about:blank and the page never arrives.
    const customerContext = await context.browser()!.newContext({
      baseURL: "http://localhost:3000",
    });
    const customerPage = await customerContext.newPage();
    await customerPage.goto(customerUrl);
    await customerPage.waitForURL(new RegExp(`/r/${slug}/menu`));

    // --- Add the item to cart (no modifiers on this item) and submit ---
    await customerPage.getByText("Paneer Tikka").click();
    await customerPage.waitForURL(/\/item\//);
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

    await customerPage
      .getByRole("link", { name: "View order", exact: true })
      .click();
    await customerPage.waitForURL(/\/cart/);

    await customerPage.getByRole("button", { name: "Place order" }).click();
    await customerPage.waitForURL(/\/order\/.+/);

    // --- Confirmation page: order number + status shown ---
    // Scoped to the heading, not plain getByText: this page's <title> is
    // also "Order #N" (see generateMetadata in order/[orderId]/page.tsx),
    // so an unscoped text match becomes ambiguous once the page is fully
    // server-rendered (reliably reproduces after customerPage.reload() below).
    await expect(
      customerPage.getByRole("heading", { name: /Order #\d+/ }),
    ).toBeVisible();
    await expect(customerPage.getByText("Order received")).toBeVisible();
    await expect(customerPage.getByText("Paneer Tikka")).toBeVisible();
    const orderUrl = customerPage.url();

    // --- Refresh: the order is still visible (persisted, not client state) ---
    await customerPage.reload();
    await expect(
      customerPage.getByRole("heading", { name: /Order #\d+/ }),
    ).toBeVisible();
    await expect(customerPage.getByText("Paneer Tikka")).toBeVisible();

    // --- No duplicate order was created. A double-tap on "Place order"
    // itself is covered precisely (including the concurrent-request race)
    // by the submit_order() idempotency tests in
    // tests/integration/db/orders.test.ts — this checks the real,
    // end-to-end, persisted outcome: exactly one order exists for this
    // session, not two, via the session-scoped order history customerPage.
    await customerPage.goto(`/r/${slug}/orders`);
    await expect(customerPage.getByText(/Order #\d+/)).toHaveCount(1);

    // --- A different customer session (different anonymous identity, same
    // table) cannot open this order by URL — RLS-scoped, not just hidden
    // in the UI. Checked via rendered content, not response.status(): this
    // page streams (OrderStatusSync + async data), and per this project's
    // own Next.js version's documented behavior (node_modules/next/dist/docs/
    // .../not-found.md — "Next.js will return a 200 HTTP status code for
    // streamed responses, and 404 for non-streamed responses"), a
    // notFound() thrown deep in a streamed response legitimately keeps the
    // initial 200 status even though the correct not-found UI renders —
    // confirmed directly against this exact route before writing this
    // assertion. Checking status() would fail this test even when RLS is
    // working correctly, testing an HTTP-status implementation detail
    // instead of the actual security property (no order data ever reaches
    // the second session).
    const otherContext = await context.browser()!.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(customerUrl); // starts a brand-new anonymous session
    await otherPage.waitForURL(new RegExp(`/r/${slug}/menu`));
    await otherPage.goto(orderUrl);
    await expect(otherPage.getByText(/page not found/i)).toBeVisible();
    await expect(otherPage.getByText("Paneer Tikka")).not.toBeVisible();
    await otherContext.close();
  });
});
