import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Reads the current user from Supabase Auth, revalidated against the Auth
 * server (`getUser()`, not `getSession()`) rather than trusted from the
 * session cookie as-is — the cookie is opaque to us and could in principle
 * be stale; `getUser()` is the call Supabase documents as safe to treat as
 * authoritative identity in server code.
 */
export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Same as getCurrentUser(), but redirects to /login instead of returning
 * null. Use at the top of any Server Component or Server Action that
 * requires an authenticated user — this is the server-side enforcement
 * src/proxy.ts also performs (defense in depth, not a replacement for it).
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
