import { test, expect } from "@playwright/test";
import { resolveAiProviderGate } from "./ai-provider-gate";
import { createConfirmedTestUser } from "./test-auth-helpers";

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
    context,
  }) => {
    // Localized to this test only (not playwright.config.ts's global
    // timeout, not any other spec). The full flow chains several
    // real openrouter/free model turns; live evidence (Phase 2A dispatch
    // diagnostic) showed a single turn legitimately taking ~31.6s against
    // the default 30s Playwright test timeout — this budget accommodates
    // several such turns in sequence without masking a genuine hang.
    test.setTimeout(240_000);

    const testId = Date.now();
    const email = `e2e-ai-waiter-${testId}@example.com`;
    const password = "TestPassword123!";

    // --- Staff: create a pre-confirmed account (Admin API — this test only
    // needs a working login, not the signup/email-confirmation flow itself;
    // see dashboard-flow.spec.ts for that), create a restaurant with AI
    // enabled (the default) ---
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
    // getByLabel("Vegetarian") is ambiguous: Base UI's Checkbox.Root renders
    // a visible role="checkbox" element plus a hidden (aria-hidden) native
    // <input> for form compatibility, both sharing the label. The role
    // locator correctly excludes the aria-hidden one.
    await page.getByRole("checkbox", { name: "Vegetarian" }).check();
    await page.getByRole("button", { name: "Create menu item" }).click();
    await page.waitForURL("/dashboard/menu");

    await page.goto("/dashboard/modifiers/new");
    await page.getByLabel("Menu item").selectOption({ label: "Paneer Dosa" });
    await page.getByLabel("Group name").fill("Spice level");
    // getByLabel("Required") is ambiguous for the same reason as the
    // "Vegetarian" checkbox above: Base UI's Checkbox.Root renders a
    // visible role="checkbox" element plus a hidden aria-hidden native
    // <input>, both sharing the label ("Required (customer must choose an
    // option)" — see modifier-group-form.tsx). The role locator correctly
    // excludes the aria-hidden one.
    await page.getByRole("checkbox", { name: "Required" }).check();
    await page.getByRole("button", { name: "Create group" }).click();
    await page.waitForURL(/\/dashboard\/modifiers\/.+/);
    await page.getByLabel("Option name").fill("Medium");
    await page.getByRole("button", { name: "Add option" }).click();
    await expect(page.getByText("Medium")).toBeVisible();

    await page.goto("/dashboard/tables/new");
    await page.getByLabel("Table number").fill("5");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForURL("/dashboard/tables");
    // /dashboard/tables renders a card grid (data-slot="card"), not a
    // <table>, so getByRole("row", ...) never matches — filter cards by text.
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Table 5" })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();

    // --- Customer: scan the QR, open the AI waiter ---
    // baseURL is NOT inherited by a context created this way, and several
    // diner steps navigate with a relative path. Without it those gotos
    // resolve against about:blank and the page never arrives.
    const customerContext = await context.browser()!.newContext({
      baseURL: "http://localhost:3000",
    });
    const customerPage = await customerContext.newPage();
    await customerPage.goto(customerUrl);
    await customerPage.waitForURL(new RegExp(`/r/${slug}/menu`));

    await customerPage
      .getByRole("button", { name: "Open AI waiter chat" })
      .click();
    // Scoped to the AI chat dialog (Base UI Dialog.Popup, role="dialog",
    // named via Dialog.Title — see ai-waiter-panel.tsx) — reused below so
    // Turn-1's own assertion can't be satisfied by the customer menu page
    // rendered behind it, which also lists "Paneer Dosa" as a menu item.
    const aiDialog = customerPage.getByRole("dialog", { name: "AI Waiter" });
    await expect(
      aiDialog.getByRole("heading", { name: "AI Waiter" }),
    ).toBeVisible();

    const chatInput = customerPage.getByLabel("Message the AI waiter");

    // --- "What vegetarian dishes do you have?" -> AI searches the real menu ---
    await chatInput.fill("What vegetarian dishes do you have?");
    await customerPage.getByRole("button", { name: "Send" }).click();
    // Scoped to the dialog (not a bare page-wide getByText) — the
    // customer's own menu page, rendered behind this dialog, also shows
    // "Paneer Dosa" as a menu item, so an unscoped text match can be
    // satisfied without the AI ever actually replying (confirmed live:
    // ai_conversation_messages showed only the user's own message, no
    // assistant/tool row, while this assertion still passed).
    await expect(aiDialog.getByText("Paneer Dosa")).toBeVisible({
      timeout: 60_000,
    });

    // Deterministic, content-independent completion signal instead of a
    // fixed sleep or pinned wording: the app's own "AI waiter is typing"
    // status (role="status", tied 1:1 to useTransition's isPending — see
    // ai-waiter-panel.tsx) is visible only while a Server Action call is in
    // flight and disappears the instant it settles. A live free-tier model
    // doesn't phrase the modifier question identically every run (observed
    // directly: one run asked in wording that didn't match /spice|medium/,
    // another run's exact reply text varied) — waiting for this indicator
    // to appear then disappear proves each turn actually finished without
    // asserting on the model's exact reply, and avoids navigating away
    // (which appeared to abort the in-flight call in an earlier run) before
    // the server-side work is done.
    const typingIndicator = aiDialog.getByRole("status", {
      name: "AI waiter is typing",
    });

    // --- Ask for it; the item has a required modifier, so the AI must ask ---
    await chatInput.fill("I'll have the Paneer Dosa");
    await customerPage.getByRole("button", { name: "Send" }).click();
    await expect(typingIndicator).toBeVisible({ timeout: 5_000 });
    await expect(typingIndicator).toBeHidden({ timeout: 60_000 });

    // --- Answer the required modifier ---
    await chatInput.fill("Medium please");
    await customerPage.getByRole("button", { name: "Send" }).click();
    await expect(typingIndicator).toBeVisible({ timeout: 5_000 });
    await expect(typingIndicator).toBeHidden({ timeout: 60_000 });

    // --- Verify the AI actually used the real cart tool, not just talk —
    // check the ordinary, non-AI cart page independently. Checks "at least
    // one", not an exact match: observed directly that a live free-tier
    // model isn't guaranteed to reach this state via exactly one
    // add_item_to_cart call every run — what this test cares about is that
    // the item genuinely reached the cart with the right modifier, not the
    // model's exact call sequence (a real duplicate-add efficiency concern
    // is a prompt/model-choice question, not something this e2e flow test
    // should gate on). ---
    await customerPage.goto(`/r/${slug}/cart`);
    await expect(customerPage.getByText("Paneer Dosa").first()).toBeVisible();
    await expect(customerPage.getByText("Medium").first()).toBeVisible();

    // --- Back to the AI waiter: ask what's in the cart, then place the order ---
    await customerPage
      .getByRole("button", { name: "Open AI waiter chat" })
      .click();
    await chatInput.fill("What's in my cart?");
    await customerPage.getByRole("button", { name: "Send" }).click();
    await expect(customerPage.getByText(/paneer dosa/i).last()).toBeVisible({
      timeout: 60_000,
    });

    await chatInput.fill("Please place the order");
    await customerPage.getByRole("button", { name: "Send" }).click();
    // Wait for the turn to actually finish (not a fixed sleep — a fixed
    // 2s wait here was observed to check for a confirmation prompt and
    // then navigate away before the model's real turn had finished, since
    // a live turn can legitimately take far longer than 2s; see the
    // typingIndicator comment above for the full reasoning) before
    // deciding whether the model asked for confirmation.
    await expect(typingIndicator).toBeVisible({ timeout: 5_000 });
    await expect(typingIndicator).toBeHidden({ timeout: 60_000 });
    // Confirming is NOT optional, so this is not conditional. The gate in
    // tools/order-confirmation.ts requires the request_order_confirmation
    // call to be strictly earlier than the user message that triggers
    // submit_order — "a confirmation call and a submit_order call both
    // happening within the same turn must never count". A separate
    // customer message is therefore structurally required, every run,
    // and no wording the model chooses can change that.
    //
    // This used to be gated on `getByText(/confirm|yes/i)` being visible,
    // which made a mandatory step conditional on a loose regex matching a
    // live free model's run-to-run phrasing. When it didn't match, the
    // confirmation was silently skipped, no order was ever placed, and
    // the failure surfaced 20 lines later as "Order #… not found" —
    // pointing at the assertion rather than at the turn that never
    // happened.
    await chatInput.fill("Yes, place it");
    await customerPage.getByRole("button", { name: "Send" }).click();
    await expect(typingIndicator).toBeVisible({ timeout: 5_000 });
    await expect(typingIndicator).toBeHidden({ timeout: 60_000 });

    // --- Verify a real order actually exists — independently of the AI's own claim ---
    //
    // Bounded nudges rather than a single shot: a live free model may
    // answer the first "place the order" with a clarifying question
    // instead of the summary, which legitimately pushes the confirmable
    // summary one turn later. This tolerates that the same way the
    // add-to-cart assertion above tolerates a variable call sequence —
    // what's being tested is that the AI can drive a real order to
    // completion, not that it does so in a fixed number of turns. It is
    // bounded so a model that never gets there still fails.
    const orderNumber = customerPage.getByText(/Order #\d+/);
    for (let attempt = 0; attempt < 2; attempt++) {
      await customerPage.goto(`/r/${slug}/orders`);
      if (await orderNumber.isVisible({ timeout: 15_000 }).catch(() => false)) {
        break;
      }
      await customerPage
        .getByRole("button", { name: "Open AI waiter chat" })
        .click();
      await chatInput.fill("Yes — please place the order now.");
      await customerPage.getByRole("button", { name: "Send" }).click();
      await expect(typingIndicator).toBeVisible({ timeout: 5_000 });
      await expect(typingIndicator).toBeHidden({ timeout: 60_000 });
    }

    await customerPage.goto(`/r/${slug}/orders`);
    await expect(orderNumber).toBeVisible({ timeout: 15_000 });

    // --- Ask the AI for status; it must reflect the real order ---
    await customerPage
      .getByRole("button", { name: "Open AI waiter chat" })
      .click();
    await chatInput.fill("Where is my order?");
    await customerPage.getByRole("button", { name: "Send" }).click();
    await expect(
      customerPage.getByText(/received|confirmed|preparing|ready/i).last(),
    ).toBeVisible({
      timeout: 60_000,
    });
  });
});

test.describe("AI waiter: never blocks normal ordering", () => {
  test.skip(!hasRealSupabaseProject, "Requires a real Supabase test project.");

  test("the full menu -> cart -> order flow works whether or not the AI waiter is configured/available", async ({
    page,
    context,
  }) => {
    const testId = Date.now();
    const email = `e2e-ai-fallback-${testId}@example.com`;
    const password = "TestPassword123!";

    // Admin API pre-confirmed account (see the header comment on the first
    // test in this file) + sign in — not the signup UI itself.
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
    // /dashboard/tables renders a card grid (data-slot="card"), not a
    // <table>, so getByRole("row", ...) never matches — filter cards by text.
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Table 6" })
      .getByRole("link", { name: "QR code" })
      .click();
    await page.waitForURL(/\/dashboard\/tables\/.+\/qr/);
    const customerUrl = await page.locator("p.break-all").innerText();

    // --- Ordering works end to end regardless of whether the AI waiter
    // button happens to be offered in this environment (it's an
    // independent enhancement, never a dependency of ordering — spec
    // section 32/46). ---
    // baseURL is NOT inherited by a context created this way, and several
    // diner steps navigate with a relative path. Without it those gotos
    // resolve against about:blank and the page never arrives.
    const customerContext = await context.browser()!.newContext({
      baseURL: "http://localhost:3000",
    });
    const customerPage = await customerContext.newPage();
    await customerPage.goto(customerUrl);
    await customerPage.waitForURL(new RegExp(`/r/${slug}/menu`));
    await customerPage.getByText("Veg Thali").click();
    await customerPage.waitForURL(/\/item\//);
    await customerPage.getByRole("button", { name: /Add to cart/ }).click();
    await customerPage.getByRole("link", { name: "View cart" }).click();
    await customerPage.waitForURL(/\/cart/);
    await customerPage.getByRole("button", { name: "Place order" }).click();
    await customerPage.waitForURL(/\/order\/.+/);
    // Scoped to the heading, not plain getByText: this page's <title> is
    // also "Order #N" (see generateMetadata in order/[orderId]/page.tsx),
    // which makes an unscoped text match ambiguous once fully rendered.
    await expect(
      customerPage.getByRole("heading", { name: /Order #\d+/ }),
    ).toBeVisible();
  });
});
