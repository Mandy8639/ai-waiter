import { test, expect } from "@playwright/test";
import { createConfirmedTestUser } from "./test-auth-helpers";

/**
 * Live concurrency verification for submit_order()'s cart row lock (see
 * supabase/migrations/20260826100000_submit_order_cart_lock.sql). The
 * deterministic PGlite suite (tests/integration/db/orders.test.ts) proves
 * the post-lock decision logic and rollback behavior, but PGlite is a
 * single connection — it cannot reproduce two genuinely overlapping
 * Postgres transactions. This test can, against the real Supabase test
 * project: two pages in the SAME browser context (sharing the customer
 * session's cookies) each mount their own PlaceOrderForm — and therefore
 * generate their own distinct client-side idempotency key
 * (src/components/customer/place-order-form.tsx) — then both click
 * "Place order" via Promise.all() for genuine near-simultaneous dispatch.
 *
 * Success criterion: exactly one order results, no matter which of the
 * two requests the database happens to let win.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const hasRealSupabaseProject =
  supabaseUrl.length > 0 && !supabaseUrl.includes("placeholder");

test.describe("submit_order() concurrent-race protection (live)", () => {
  test.skip(
    !hasRealSupabaseProject,
    "Requires a real Supabase test project (NEXT_PUBLIC_SUPABASE_URL unset or placeholder).",
  );

  test("two near-simultaneous 'Place order' submissions for the same cart, with different idempotency keys, produce exactly one order", async ({
    page,
    context,
  }) => {
    // A second browser context means a second cold page load on top of the
    // dashboard setup this test already does, which pushes it past the 30s
    // default. Raised here rather than globally so every other spec keeps
    // the tighter budget.
    test.setTimeout(60_000);

    const testId = Date.now();
    const email = `e2e-order-race-${testId}@example.com`;
    const password = "TestPassword123!";

    // --- Staff: create a pre-confirmed account and a minimal menu ---
    await createConfirmedTestUser(email, password);
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("/dashboard");
    await page.getByRole("link", { name: "Create your restaurant" }).click();
    await page.waitForURL("/onboarding");

    const slug = `e2e-order-race-${testId}`;
    await page.getByLabel("Restaurant name").fill("Order Race Test Restaurant");
    await page.getByLabel("Slug").fill(slug);
    await page.getByRole("button", { name: "Create restaurant" }).click();
    await page.waitForURL("/dashboard");

    await page.goto("/dashboard/categories/new");
    await page.getByLabel("Name").fill("Mains");
    await page.getByRole("button", { name: "Create category" }).click();
    await page.waitForURL("/dashboard/categories");

    await page.goto("/dashboard/menu/new");
    await page.getByLabel("Name").fill("Race Test Dish");
    await page.getByLabel("Slug").fill("race-test-dish");
    await page.getByLabel("Category").selectOption({ label: "Mains" });
    await page.getByLabel("Price ($)").fill("10.00");
    await page.getByRole("button", { name: "Create menu item" }).click();
    await page.waitForURL("/dashboard/menu");

    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("1");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");
    // /dashboard/tables renders a card grid (data-slot="card"), not a
    // <table>, so getByRole("row", ...) never matches — filter cards by text.
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Table 1" })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();

    // --- Customer: scan the QR, establishing the session on `page` ---
    // baseURL is NOT inherited by a context created this way, and several
    // diner steps navigate with a relative path. Without it those gotos
    // resolve against about:blank and the page never arrives.
    const customerContext = await context.browser()!.newContext({
      baseURL: "http://localhost:3000",
    });
    const customerPage = await customerContext.newPage();
    await customerPage.goto(customerUrl);
    await customerPage.waitForURL(new RegExp(`/r/${slug}/menu`));
    await customerPage.getByText("Race Test Dish").click();
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

    await customerPage.goto(`/r/${slug}/cart`);
    await expect(
      customerPage.getByRole("button", { name: "Place order" }),
    ).toBeVisible();

    // A second page in the SAME context shares the customer session's
    // cookies — a genuinely separate PlaceOrderForm mount, so a genuinely
    // separate client-generated idempotency key, exactly matching two
    // browser tabs open to the same cart.
    // Same context as the diner: this test is two simultaneous submissions
    // of ONE cart, which only holds if both pages share that session.
    const page2 = await customerContext.newPage();
    await page2.goto(`/r/${slug}/cart`);
    await expect(
      page2.getByRole("button", { name: "Place order" }),
    ).toBeVisible();

    const [result1, result2] = await Promise.allSettled([
      customerPage.getByRole("button", { name: "Place order" }).click(),
      page2.getByRole("button", { name: "Place order" }).click(),
    ]);
    expect(result1.status).toBe("fulfilled");
    expect(result2.status).toBe("fulfilled");

    // One of the two either navigates to the order confirmation page or
    // shows the cart-empty error — wait for BOTH pages to settle into one
    // of those two end states before inspecting anything.
    await Promise.all([
      Promise.race([
        customerPage.waitForURL(/\/order\//, { timeout: 30_000 }),
        customerPage
          .getByText("Your cart is empty — add something before ordering.")
          .waitFor({ timeout: 30_000 }),
      ]),
      Promise.race([
        page2.waitForURL(/\/order\//, { timeout: 30_000 }),
        page2
          .getByText("Your cart is empty — add something before ordering.")
          .waitFor({ timeout: 30_000 }),
      ]),
    ]);

    const page1Won = /\/order\//.test(customerPage.url());
    const page2Won = /\/order\//.test(page2.url());

    // Exactly one of the two won — never both, never neither.
    expect(page1Won !== page2Won).toBe(true);

    // Both candidates are the DINER's pages — page1Won is derived from
    // customerPage, so pairing it with the staff page would search the
    // dashboard for a menu item and always find none.
    const winner = page1Won ? customerPage : page2;
    const loser = page1Won ? page2 : customerPage;

    // The loser sees the expected, safe cart-empty message — not a
    // duplicate order, not a generic/opaque error.
    await expect(
      loser.getByText("Your cart is empty — add something before ordering."),
    ).toBeVisible();

    // The winner is already on the order confirmation page
    // (PlaceOrderForm's router.push on success) — this is where the item
    // name/line actually renders (order/[orderId]/page.tsx), unlike the
    // orders LIST page, which shows only order number/date/total/status.
    // The winning order actually contains the item (one line, correct
    // item) — not zero, not a duplicate line from a lost-then-recovered
    // race.
    await expect(winner.getByText("Race Test Dish")).toHaveCount(1);

    // --- Verify actual database state independently of what the UI claims ---
    await winner.goto(`/r/${slug}/orders`);
    await expect(winner.getByText(/Order #\d+/)).toBeVisible({
      timeout: 15_000,
    });
    const orderCount = await winner.getByText(/Order #\d+/).count();
    expect(orderCount).toBe(1);

    // Cart is empty afterward, matching the winner's own submission.
    await winner.goto(`/r/${slug}/cart`);
    await expect(winner.getByText("Your order is empty")).toBeVisible();
  });
});
