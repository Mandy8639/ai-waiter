import "server-only";
import { z } from "zod";

/**
 * Server-side environment configuration — the PUBLIC vars only.
 *
 * Importing "server-only" makes this module a build error if anything ever
 * tries to pull it into a browser bundle (client code should read
 * `NEXT_PUBLIC_*` vars directly instead — see `src/lib/supabase/client.ts`).
 *
 * PUBLIC (safe in the browser, prefixed NEXT_PUBLIC_):
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 *
 * Deliberately does NOT include `SUPABASE_SECRET_KEY` or any other secret.
 * This module is imported by `src/lib/supabase/server.ts`, which nearly
 * every server component/action pulls in — bundling a secret's validation
 * in here would mean any page that merely reads the database (never
 * touching the admin client) fails to build/start without that secret
 * configured, which it doesn't need. Secrets validate themselves lazily, at
 * the one call site that actually needs them — see
 * `src/lib/supabase/admin.ts`.
 *
 * Parsing happens once at module load. If a required variable is missing or
 * malformed, this throws immediately — at build/startup time, not deep into
 * a request — with a message naming exactly which variable is wrong.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .string({
      error: "NEXT_PUBLIC_SUPABASE_URL is required (see .env.example)",
    })
    .url("NEXT_PUBLIC_SUPABASE_URL must be a valid URL"),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string({
      error:
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required (see .env.example)",
    })
    .min(1, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY cannot be empty"),
});

function loadPublicEnv() {
  const parsed = publicEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid or missing environment variables:\n${issues}\n\nCopy .env.example to .env.local and fill in real values.`,
    );
  }

  return parsed.data;
}

export const env = loadPublicEnv();
