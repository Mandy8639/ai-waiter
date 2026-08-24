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
    await page.goto(customerUrl);
    await page.waitForURL(new RegExp(`/r/${slug}/menu`));
    await page.getByText("Race Test Dish").click();
    await page.waitForURL(/\/item\//);
    await page.getByRole("button", { name: /Add to cart/ }).click();
    await expect(page.getByText("Added to cart.")).toBeVisible();

    await page.goto(`/r/${slug}/cart`);
    await expect(
      page.getByRole("button", { name: "Place order" }),
    ).toBeVisible();

    // A second page in the SAME context shares the customer session's
    // cookies — a genuinely separate PlaceOrderForm mount, so a genuinely
    // separate client-generated idempotency key, exactly matching two
    // browser tabs open to the same cart.
    const page2 = await context.newPage();
    await page2.goto(`/r/${slug}/cart`);
    await expect(
      page2.getByRole("button", { name: "Place order" }),
    ).toBeVisible();

    const [result1, result2] = await Promise.allSettled([
      page.getByRole("button", { name: "Place order" }).click(),
      page2.getByRole("button", { name: "Place order" }).click(),
    ]);
    expect(result1.status).toBe("fulfilled");
    expect(result2.status).toBe("fulfilled");

    // One of the two either navigates to the order confirmation page or
    // shows the cart-empty error — wait for BOTH pages to settle into one
    // of those two end states before inspecting anything.
    await Promise.all([
      Promise.race([
        page.waitForURL(/\/order\//, { timeout: 30_000 }),
        page
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

    const page1Won = /\/order\//.test(page.url());
    const page2Won = /\/order\//.test(page2.url());

    // Exactly one of the two won — never both, never neither.
    expect(page1Won !== page2Won).toBe(true);

    const winner = page1Won ? page : page2;
    const loser = page1Won ? page2 : page;

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
    await expect(winner.getByText("Your cart is empty.")).toBeVisible();
  });
});
