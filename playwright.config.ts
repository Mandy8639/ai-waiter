import { defineConfig, devices } from "@playwright/test";
import { loadEnvConfig } from "@next/env";

// Batch 8 fix (docs/production-audit.md): the Playwright test *process*
// never automatically reads .env.local — only the Next.js app it builds/
// starts (via `webServer` below) does that internally. Without this, every
// e2e spec's `hasRealSupabaseProject`/`hasRealAiProvider` check (evaluated
// at test-collection time, in THIS process) would read `undefined` even
// when a developer filled in real credentials in .env.local exactly as
// docs/development.md instructs — silently skipping the real-credential
// suites forever, never actually running them. `@next/env` is the same
// loader Next.js itself uses internally (bundled with `next`, not a new
// dependency), so this follows identical precedence rules
// (.env.local > .env.<NODE_ENV> > .env), not a reimplementation of them.
loadEnvConfig(process.cwd());

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
