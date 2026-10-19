import "server-only";
import { notFound, redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import {
  hasVerifiedTwoFactor,
  TWO_FACTOR_PATH,
} from "@/lib/auth/two-factor-core";
import { isPlatformAdminEmail, parseAdminEmails } from "./access-core";

/** Whether this signed-in person is on the PLATFORM_ADMIN_EMAILS list. For showing the sidebar link; never access control on its own. */
export function isPlatformAdmin(user: Pick<User, "email"> | null): boolean {
  return isPlatformAdminEmail(
    user?.email,
    parseAdminEmails(process.env.PLATFORM_ADMIN_EMAILS),
  );
}

export type PlatformAdminAccess =
  | { ok: true; user: User }
  /** On the list, but two-step verification isn't set up yet. */
  | { ok: false; reason: "needs_two_factor"; user: User };

/**
 * The gate for every /admin page and action. Anyone not on the list gets
 * "page not found", the same as a page that doesn't exist, so the Admin
 * page isn't advertised to someone probing URLs. Someone on the list must
 * also have two-step verification on and have entered the code this
 * session (aal2): the page changes what every restaurant's diners get.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminAccess> {
  const user = await requireUser();
  if (!isPlatformAdmin(user)) notFound();

  if (!hasVerifiedTwoFactor(user.factors)) {
    return { ok: false, reason: "needs_two_factor", user };
  }

  const supabase = await createClient();
  const { data: aal } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") redirect(TWO_FACTOR_PATH);

  return { ok: true, user };
}
