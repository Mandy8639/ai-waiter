import "server-only";
import { z } from "zod";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { Database } from "./database.types";

/**
 * Privileged Supabase client, authenticated with the SECRET key.
 *
 * DANGER: this client BYPASSES Row Level Security entirely. It can read and
 * write across every restaurant's data. Never import it into a Client
 * Component (the `server-only` import above already makes that a build
 * error), never return it from an API route, and never use it to serve a
 * request on a tenant's behalf without first re-checking that tenant's
 * authorization in application code.
 *
 * Reserve this for trusted, server-only system operations — e.g. a webhook
 * handler or a scheduled job — that legitimately need to act across tenants.
 * Ordinary requests should use `src/lib/supabase/server.ts`, which respects
 * the signed-in user's RLS-scoped access.
 *
 * SUPABASE_SECRET_KEY validates lazily, right here, rather than through
 * `src/lib/env.ts` — that module is imported by `server.ts`, which nearly
 * every page pulls in, so bundling this secret's validation there would
 * make every page require it, even ones that never call this function.
 */
const secretKeySchema = z
  .string({ error: "SUPABASE_SECRET_KEY is required (see .env.example)" })
  .min(1, "SUPABASE_SECRET_KEY cannot be empty");

export function createAdminClient() {
  const parsed = secretKeySchema.safeParse(process.env.SUPABASE_SECRET_KEY);

  if (!parsed.success) {
    throw new Error(
      `Invalid or missing SUPABASE_SECRET_KEY:\n  - ${parsed.error.issues[0].message}\n\nCopy .env.example to .env.local and fill in real values.`,
    );
  }

  return createSupabaseClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    parsed.data,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
