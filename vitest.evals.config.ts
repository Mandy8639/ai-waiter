import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * The AI waiter's live evaluation suite (evals/), kept out of `npm test`:
 * it calls a real model through OpenRouter, costs money and is not
 * deterministic. Run with `npm run eval:waiter`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
    // The tool modules read these at import. The suite never talks to
    // Supabase: every tool runs against an in-memory restaurant
    // (evals/waiter/world.ts), so placeholders are enough.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "placeholder",
      // The suite calls OpenRouter, so the waiter's default model list is
      // OpenRouter's (free) one, never the Anthropic default, which
      // OpenRouter would happily serve and bill.
      AI_PROVIDER: "openrouter",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
