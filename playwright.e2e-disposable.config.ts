import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

// Separate from playwright.config.ts on purpose: dashboard-flow.spec.ts
// tests the real /signup + email-confirmation flow, which the main live
// Supabase project (see docs/development.md) can't complete without a
// human clicking a confirmation email — it needs its own disposable
// project with "Confirm email" turned off, never the project real
// customer/restaurant data lives in. See docs/development.md#e2e-disposable
// for the one-time project setup this config assumes already exists.
//
// Loads .env.e2e-disposable.local directly (not @next/env's
// loadEnvConfig(), which follows Next's own NODE_ENV-derived file
// precedence — this project's AGENTS.md warns this Next.js version's
// conventions can't be assumed from training data, so this deliberately
// sidesteps that convention with an explicit, unambiguous path instead).
// override: true so a stray NEXT_PUBLIC_SUPABASE_URL already in the
// process environment (e.g. a shell that also sourced .env.local) can't
// silently win and point this run at the wrong project.
config({ path: ".env.e2e-disposable.local", override: true });

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "dashboard-flow.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3099",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // A distinct port from playwright.config.ts's 3000: this must never
    // reuse an already-running server built against the live project's
    // .env.local, which would silently defeat the entire point of this
    // separate project.
    command: "npm run build && npm run start -- --port 3099",
    url: "http://localhost:3099",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
