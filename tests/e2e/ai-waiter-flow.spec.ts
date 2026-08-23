import { test, expect } from "@playwright/test";
import { resolveAiProviderGate } from "./ai-provider-gate";

/**
 * Batch 7's conversational AI waiter, end to end (spec section 45):
 * customer scans a QR code, opens the AI waiter, asks a menu question,
 * adds an item to the cart conversationally (answering a required
 * modifier question along the way), asks what's in the cart, confirms an
 * order, then asks for its status once the kitchen has moved it along.
 *
 * Needs BOTH a real (test-only) Supabase project AND a real credential for
 * whichever AI provider is configured (AI_PROVIDER — see
 * src/lib/ai/config.ts) — this is the one flow in this codebase that can't
 * run without a live model, since it depends on the model actually
 * understanding natural language and choosing the right tools. Assertions
 * below are intentionally robust to exact wording (the model's phrasing
 * isn't scripted) and instead check for structural evidence of success:
 * message bubbles appearing, and the underlying cart/order state actually
 * changing (verified independently via the ordinary, non-AI cart/order
 * pages this codebase already trusts).
 *
 * Never use production credentials — use disposable test accounts.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const hasRealSupabaseProject =
  supabaseUrl.length > 0 && !supabaseUrl.includes("placeholder");

// Which credential is required depends on AI_PROVIDER, not a hardcoded
// provider — mirrors src/lib/ai/config.ts's own provider selection, so this
// suite runs under whichever provider local/CI is actually configured for
// (Batch 9 added `openrouter` as a cost-free alternative to `anthropic`).
// See ./ai-provider-gate.ts for the gating logic itself and
// tests/unit/ai-e2e-provider-gate.test.ts for its unit coverage.
const { hasRealAiProvider, skipReason: aiProviderSkipReason } =
  resolveAiProviderGate({
    AI_PROVIDER: process.env.AI_PROVIDER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  });

test.describe("AI waiter: full conversational order flow", () => {
  test.skip(
    !hasRealSupabaseProject || !hasRealAiProvider,
    aiProviderSkipReason,
  );

  test("QR scan -> ask about vegetarian dishes -> add an item with a required modifier -> review cart -> place order -> check status", async ({
    page,
  }) => {
    const testId = Date.now();
    const email = `e2e-ai-waiter-${testId}@example.com`;
    const password = "TestPassword123!";

    // --- Staff: sign up, create a restaurant with AI enabled (the default) ---
    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    await page.waitForURL(/\/(onboarding|signup)/);
    if (page.url().includes("/signup")) {
      test.skip(true, "Project requires email confirmation.");
    }

    const slug = `e2e-ai-waiter-${testId}`;
    await page.getByLabel("Restaurant name").fill("AI Waiter Test Restaurant");
    await page.getByLabel("Slug").fill(slug);
    await page.getByRole("button", { name: "Create restaurant" }).click();
    await page.waitForURL("/dashboard");

    // --- Staff: a vegetarian item with a required modifier group ---
    await page.goto("/dashboard/categories/new");
    await page.getByLabel("Name").fill("Mains");
    await page.getByRole("button", { name: "Create category" }).click();
    await page.waitForURL("/dashboard/categories");

    await page.goto("/dashboard/menu/new");
    await page.getByLabel("Name").fill("Paneer Dosa");
    await page.getByLabel("Slug").fill("paneer-dosa");
    await page.getByLabel("Category").selectOption({ label: "Mains" });
    await page.getByLabel("Price ($)").fill("9.50");
    await page.getByLabel("Vegetarian").check();
    await page.getByRole("button", { name: "Create menu item" }).click();
    await page.waitForURL("/dashboard/menu");

    await page.goto("/dashboard/modifiers/new");
    await page.getByLabel("Menu item").selectOption({ label: "Paneer Dosa" });
    await page.getByLabel("Group name").fill("Spice level");
    await page.getByLabel("Required").check();
    await page.getByRole("button", { name: "Create group" }).click();
    await page.waitForURL(/\/dashboard\/modifiers\/.+/);
    await page.getByLabel("Option name").fill("Medium");
    await page.getByRole("button", { name: "Add option" }).click();
    await expect(page.getByText("Medium")).toBeVisible();

    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("5");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");
    await page
      .getByRole("row", { name: /Table 5/ })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();

    // --- Customer: scan the QR, open the AI waiter ---
    await page.goto(customerUrl);
    await page.waitForURL(new RegExp(`/r/${slug}/menu`));

    await page.getByRole("button", { name: "Open AI waiter chat" }).click();
    await expect(
      page.getByRole("heading", { name: "AI Waiter" }),
    ).toBeVisible();

    const chatInput = page.getByLabel("Message the AI waiter");

    // --- "What vegetarian dishes do you have?" -> AI searches the real menu ---
    await chatInput.fill("What vegetarian dishes do you have?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Paneer Dosa")).toBeVisible({
      timeout: 30_000,
    });

    // --- Ask for it; the item has a required modifier, so the AI must ask ---
    await chatInput.fill("I'll have the Paneer Dosa");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/spice|medium/i).last()).toBeVisible({
      timeout: 30_000,
    });

    // --- Answer the required modifier ---
    await chatInput.fill("Medium please");
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForTimeout(1000);

    // --- Verify the AI actually used the real cart tool, not just talk —
    // check the ordinary, non-AI cart page independently. ---
    await page.goto(`/r/${slug}/cart`);
    await expect(page.getByText("Paneer Dosa")).toBeVisible();
    await expect(page.getByText("Medium")).toBeVisible();

    // --- Back to the AI waiter: ask what's in the cart, then place the order ---
    await page.getByRole("button", { name: "Open AI waiter chat" }).click();
    await chatInput.fill("What's in my cart?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/paneer dosa/i).last()).toBeVisible({
      timeout: 30_000,
    });

    await chatInput.fill("Please place the order");
    await page.getByRole("button", { name: "Send" }).click();
    // The AI should either ask for confirmation or, if it already has
    // enough context, submit — either way, give it a moment and confirm
    // if asked.
    await page.waitForTimeout(2000);
    const confirmPrompt = page.getByText(/confirm|yes/i).last();
    if (await confirmPrompt.isVisible().catch(() => false)) {
      await chatInput.fill("Yes, place it");
      await page.getByRole("button", { name: "Send" }).click();
    }

    // --- Verify a real order actually exists — independently of the AI's own claim ---
    await page.waitForTimeout(2000);
    await page.goto(`/r/${slug}/orders`);
    await expect(page.getByText(/Order #\d+/)).toBeVisible({ timeout: 15_000 });

    // --- Ask the AI for status; it must reflect the real order ---
    await page.getByRole("button", { name: "Open AI waiter chat" }).click();
    await chatInput.fill("Where is my order?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/received|confirmed|preparing|ready/i).last(),
    ).toBeVisible({
      timeout: 30_000,
    });
  });
});

test.describe("AI waiter: never blocks normal ordering", () => {
  test.skip(!hasRealSupabaseProject, "Requires a real Supabase test project.");

  test("the full menu -> cart -> order flow works whether or not the AI waiter is configured/available", async ({
    page,
  }) => {
    const testId = Date.now();
    const email = `e2e-ai-fallback-${testId}@example.com`;
    const password = "TestPassword123!";

    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/(onboarding|signup)/);
    if (page.url().includes("/signup")) {
      test.skip(true, "Project requires email confirmation.");
    }

    const slug = `e2e-ai-fallback-${testId}`;
    await page
      .getByLabel("Restaurant name")
      .fill("AI Fallback Test Restaurant");
    await page.getByLabel("Slug").fill(slug);
    await page.getByRole("button", { name: "Create restaurant" }).click();
    await page.waitForURL("/dashboard");

    await page.goto("/dashboard/categories/new");
    await page.getByLabel("Name").fill("Mains");
    await page.getByRole("button", { name: "Create category" }).click();
    await page.waitForURL("/dashboard/categories");
    await page.goto("/dashboard/menu/new");
    await page.getByLabel("Name").fill("Veg Thali");
    await page.getByLabel("Slug").fill("veg-thali");
    await page.getByLabel("Category").selectOption({ label: "Mains" });
    await page.getByLabel("Price ($)").fill("12.00");
    await page.getByRole("button", { name: "Create menu item" }).click();
    await page.waitForURL("/dashboard/menu");
    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("6");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");
    await page
      .getByRole("row", { name: /Table 6/ })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();

    // --- Ordering works end to end regardless of whether the AI waiter
    // button happens to be offered in this environment (it's an
    // independent enhancement, never a dependency of ordering — spec
    // section 32/46). ---
    await page.goto(customerUrl);
    await page.waitForURL(new RegExp(`/r/${slug}/menu`));
    await page.getByText("Veg Thali").click();
    await page.waitForURL(/\/item\//);
    await page.getByRole("button", { name: /Add to cart/ }).click();
    await page.getByRole("link", { name: "View cart" }).click();
    await page.waitForURL(/\/cart/);
    await page.getByRole("button", { name: "Place order" }).click();
    await page.waitForURL(/\/order\/.+/);
    await expect(page.getByText(/Order #\d+/)).toBeVisible();
  });
});
