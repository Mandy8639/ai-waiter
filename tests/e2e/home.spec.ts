import { test, expect } from "@playwright/test";

test("home page loads and identifies AI Waiter", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/AI Waiter/);
  await expect(page.getByRole("heading", { name: "AI Waiter" })).toBeVisible();
  await expect(page.getByText("An AI waiter for restaurants.")).toBeVisible();
});

test("unknown route renders the not-found page", async ({ page }) => {
  const response = await page.goto("/this-route-does-not-exist");

  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
});

test("health endpoint reports readiness without leaking secrets (Batch 8)", async ({
  request,
}) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);

  const body = await response.json();
  expect(body.status).toBe("ok");
  expect(typeof body.supabaseConfigured).toBe("boolean");
  expect(typeof body.aiConfigured).toBe("boolean");

  const bodyText = JSON.stringify(body);
  expect(bodyText).not.toMatch(
    /service_role|SUPABASE_SECRET_KEY|sk-ant-|https?:\/\/.+\.supabase\.co/i,
  );
});
