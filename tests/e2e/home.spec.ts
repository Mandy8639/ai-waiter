import { test, expect } from "@playwright/test";

test("home page loads and identifies Tableside", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/Tableside/);
  await expect(page.getByRole("heading", { name: "Tableside" })).toBeVisible();
  await expect(page.getByText("An AI waiter for restaurants.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Get started free" }).first(),
  ).toHaveAttribute("href", "/signup");
});

for (const [path, heading] of [
  ["/features", /Everything Tableside does/],
  ["/pricing", /Free to use/],
  ["/demo", /Be the guest/],
] as const) {
  test(`${path} renders its marketing page`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveTitle(/Tableside/);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Main" }).first(),
    ).toBeAttached();
  });
}

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
