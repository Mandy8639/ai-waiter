import { test, expect } from "@playwright/test";

/**
 * Batch 6's kitchen workflow, end to end (spec section 32): a customer
 * places an order, it appears on the kitchen display live (Realtime, no
 * manual reload), staff walks it through
 * confirmed -> preparing -> ready -> served, and the customer's own order
 * page reflects each change live too. Also covers: no status-change
 * controls are ever offered to the customer, a served order has no further
 * action on the board, a second restaurant's staff never sees this order
 * on their own kitchen display, and a reload of the kitchen board still
 * shows the authoritative current state.
 *
 * Needs a real (test-only) Supabase project for the same reason
 * order-flow.spec.ts does — Realtime, Auth (password + anonymous), and
 * Postgres round trips aren't something a placeholder URL can fake.
 * Skipped automatically otherwise. Anonymous sign-ins must be enabled on
 * the project's Auth settings.
 *
 * Never use production credentials — use a disposable Supabase test project.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const hasRealSupabaseProject =
  supabaseUrl.length > 0 && !supabaseUrl.includes("placeholder");

test.describe("kitchen display: order lifecycle", () => {
  test.skip(
    !hasRealSupabaseProject,
    "Requires a real Supabase test project (NEXT_PUBLIC_SUPABASE_URL unset or placeholder).",
  );

  test("customer order -> KDS receives it live -> staff walks it through confirm/preparing/ready/served -> customer sees each update live", async ({
    page,
    context,
  }) => {
    const testId = Date.now();
    const email = `e2e-kitchen-flow-${testId}@example.com`;
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

    const slug = `e2e-kitchen-flow-${testId}`;
    await page
      .getByLabel("Restaurant name")
      .fill("Kitchen Flow Test Restaurant");
    await page.getByLabel("Slug").fill(slug);
    await page.getByRole("button", { name: "Create restaurant" }).click();
    await page.waitForURL("/dashboard");

    // --- Staff: category, menu item, table ---
    await page.goto("/dashboard/categories/new");
    await page.getByLabel("Name").fill("Mains");
    await page.getByRole("button", { name: "Create category" }).click();
    await page.waitForURL("/dashboard/categories");

    await page.goto("/dashboard/menu/new");
    await page.getByLabel("Name").fill("Chana Masala");
    await page.getByLabel("Slug").fill("chana-masala");
    await page.getByLabel("Category").selectOption({ label: "Mains" });
    await page.getByLabel("Price ($)").fill("10.00");
    await page.getByRole("button", { name: "Create menu item" }).click();
    await page.waitForURL("/dashboard/menu");

    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("9");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");

    await page
      .getByRole("row", { name: /Table 9/ })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();

    // --- Staff opens the kitchen display and stays there watching ---
    await page.goto("/dashboard/kitchen");
    await expect(page.getByText("Kitchen")).toBeVisible();

    // --- Customer (separate browser context/identity): scan QR, order ---
    const customerContext = await context.browser()!.newContext();
    const customerPage = await customerContext.newPage();
    await customerPage.goto(customerUrl);
    await customerPage.waitForURL(new RegExp(`/r/${slug}/menu`));

    await customerPage.getByText("Chana Masala").click();
    await customerPage.waitForURL(/\/item\//);
    await customerPage.getByRole("button", { name: /Add to cart/ }).click();
    await expect(customerPage.getByText("Added to cart.")).toBeVisible();

    await customerPage.getByRole("link", { name: "View cart" }).click();
    await customerPage.waitForURL(/\/cart/);
    await customerPage.getByRole("button", { name: "Place order" }).click();
    await customerPage.waitForURL(/\/order\/.+/);
    await expect(customerPage.getByText(/Order #\d+/)).toBeVisible();

    // --- The customer page never offers any status-change control ---
    for (const label of [
      "Confirm",
      "Start preparing",
      "Mark ready",
      "Mark served",
    ]) {
      await expect(
        customerPage.getByRole("button", { name: label }),
      ).toHaveCount(0);
    }

    // --- KDS receives the new order live, no manual reload ---
    const card = page.locator('[data-order-number="1"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("New")).toBeVisible();
    await expect(card.getByText("Chana Masala")).toBeVisible();

    // --- Staff confirms; customer sees it live ---
    await card.getByRole("button", { name: "Confirm" }).click();
    await expect(customerPage.getByText("Confirmed")).toBeVisible({
      timeout: 15_000,
    });

    // --- Staff starts preparing; customer sees it live ---
    await card.getByRole("button", { name: "Start preparing" }).click();
    await expect(customerPage.getByText("Preparing")).toBeVisible({
      timeout: 15_000,
    });

    // --- Staff marks ready; customer sees it live ---
    await card.getByRole("button", { name: "Mark ready" }).click();
    await expect(customerPage.getByText("Ready", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // --- Staff marks served (owner has full operational access); customer sees it live ---
    await card.getByRole("button", { name: "Mark served" }).click();
    await expect(customerPage.getByText("Served")).toBeVisible({
      timeout: 15_000,
    });

    // --- A served order has no further action button on the board ---
    await expect(card.getByRole("button", { name: "Mark served" })).toHaveCount(
      0,
    );
    await expect(card.getByRole("button", { name: "Cancel" })).toHaveCount(0);

    // --- Reloading the kitchen board still shows current, authoritative
    // state — served orders stay visible briefly (recent-served window),
    // still with no action button. ---
    await page.reload();
    await expect(page.locator('[data-order-number="1"]')).toBeVisible();
    await expect(
      page
        .locator('[data-order-number="1"]')
        .getByRole("button", { name: "Mark served" }),
    ).toHaveCount(0);

    await customerContext.close();
  });

  test("a second restaurant's staff never sees another restaurant's order on their own kitchen display", async ({
    page,
    context,
  }) => {
    const testId = Date.now();

    async function signUpAndCreateRestaurant(p: typeof page, suffix: string) {
      const email = `e2e-kitchen-tenant-${testId}-${suffix}@example.com`;
      const password = "TestPassword123!";
      await p.goto("/signup");
      await p.getByLabel("Email").fill(email);
      await p.getByLabel("Password").fill(password);
      await p.getByRole("button", { name: "Create account" }).click();
      await p.waitForURL(/\/(onboarding|signup)/);
      if (p.url().includes("/signup")) {
        test.skip(true, "Project requires email confirmation.");
      }
      const slug = `e2e-kitchen-tenant-${testId}-${suffix}`;
      await p.getByLabel("Restaurant name").fill(`Tenant ${suffix} Restaurant`);
      await p.getByLabel("Slug").fill(slug);
      await p.getByRole("button", { name: "Create restaurant" }).click();
      await p.waitForURL("/dashboard");
      return slug;
    }

    // Restaurant A: full setup + one submitted order.
    const slugA = await signUpAndCreateRestaurant(page, "a");
    await page.goto("/dashboard/categories/new");
    await page.getByLabel("Name").fill("Mains");
    await page.getByRole("button", { name: "Create category" }).click();
    await page.waitForURL("/dashboard/categories");
    await page.goto("/dashboard/menu/new");
    await page.getByLabel("Name").fill("Aloo Paratha");
    await page.getByLabel("Slug").fill("aloo-paratha");
    await page.getByLabel("Category").selectOption({ label: "Mains" });
    await page.getByLabel("Price ($)").fill("7.00");
    await page.getByRole("button", { name: "Create menu item" }).click();
    await page.waitForURL("/dashboard/menu");
    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("2");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");
    await page
      .getByRole("row", { name: /Table 2/ })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrlA = await page.locator("p.break-all").innerText();

    const customerContext = await context.browser()!.newContext();
    const customerPage = await customerContext.newPage();
    await customerPage.goto(customerUrlA);
    await customerPage.waitForURL(new RegExp(`/r/${slugA}/menu`));
    await customerPage.getByText("Aloo Paratha").click();
    await customerPage.waitForURL(/\/item\//);
    await customerPage.getByRole("button", { name: /Add to cart/ }).click();
    await customerPage.getByRole("link", { name: "View cart" }).click();
    await customerPage.waitForURL(/\/cart/);
    await customerPage.getByRole("button", { name: "Place order" }).click();
    await customerPage.waitForURL(/\/order\/.+/);
    await customerContext.close();

    // Restaurant B: separate staff account, own (empty) kitchen display.
    const bContext = await context.browser()!.newContext();
    const bPage = await bContext.newPage();
    await signUpAndCreateRestaurant(bPage, "b");
    await bPage.goto("/dashboard/kitchen");

    await expect(bPage.getByText("Aloo Paratha")).toHaveCount(0);
    await expect(bPage.locator('[data-order-number="1"]')).toHaveCount(0);

    await bContext.close();
  });
});
