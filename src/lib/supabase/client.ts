"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

/**
 * Browser-side Supabase client.
 *
 * SAFE FOR CLIENT COMPONENTS. Only ever reads `NEXT_PUBLIC_*` variables,
 * which Next.js inlines into the browser bundle — nothing here can leak a
 * secret. This client is subject to Row Level Security; it can only do what
 * RLS policies allow for the current (possibly anonymous) session.
 *
 * Do not add any non-`NEXT_PUBLIC_*` variable to this file.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local and fill in real values.",
    );
  }

  return createBrowserClient<Database>(supabaseUrl, supabasePublishableKey);
}
