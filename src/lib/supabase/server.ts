import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { env } from "@/lib/env";
import type { Database } from "./database.types";

/**
 * Server-side Supabase client, scoped to the current request.
 *
 * SERVER COMPONENTS, SERVER ACTIONS, AND ROUTE HANDLERS ONLY. Reads/writes
 * auth cookies for the signed-in user (or anonymous customer session), so
 * every query still runs through Row Level Security as that user — this is
 * NOT a privileged client. For work that must bypass RLS (e.g. system-level
 * writes), use `src/lib/supabase/admin.ts` instead, and only from trusted
 * server code.
 *
 * Never import this file from a Client Component.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database, "public">(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component render, where cookies are
            // read-only. Safe to ignore as long as middleware refreshes the
            // session — see docs/security.md.
          }
        },
      },
    },
  );
}
