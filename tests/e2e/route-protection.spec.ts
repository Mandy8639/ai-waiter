import { test, expect } from "@playwright/test";

/**
 * These don't need a real Supabase project — they verify the middleware
 * (src/proxy.ts) redirect behavior itself, which works from the absence of
 * a valid session regardless of backend connectivity.
 */
test.describe("route protection", () => {
  test("unauthenticated access to /dashboard redirects to /login", async ({
    page,
  }) => {
    const response = await page.goto("/dashboard");
    expect(response?.request().url()).toContain("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("unauthenticated access to /onboarding redirects to /login", async ({
    page,
  }) => {
    const response = await page.goto("/onboarding");
    expect(response?.request().url()).toContain("/login");
  });

  test("unauthenticated access to /dashboard/kitchen (the KDS) redirects to /login", async ({
    page,
  }) => {
    const response = await page.goto("/dashboard/kitchen");
    expect(response?.request().url()).toContain("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("login page has accessible email/password fields and a signup link", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
  });

  test("signup page has accessible email/password fields and a login link", async ({
    page,
  }) => {
    await page.goto("/signup");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  test("submitting the login form empty shows validation errors, not a crash", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Email is required.")).toBeVisible();
    await expect(page.getByText("Password is required.")).toBeVisible();
  });
});
