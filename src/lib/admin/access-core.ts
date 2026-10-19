/**
 * Who may open /admin: the platform owner(s), listed by email in the
 * PLATFORM_ADMIN_EMAILS Vercel variable. No `server-only` and no I/O, so
 * the rule is unit-tested directly; src/lib/admin/access.ts applies it.
 */

/** "A@x.com, b@y.com ,," → ["a@x.com", "b@y.com"]. */
export function parseAdminEmails(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@")),
    ),
  ];
}

export function isPlatformAdminEmail(
  email: string | null | undefined,
  allowed: readonly string[],
): boolean {
  if (!email) return false;
  return allowed.includes(email.trim().toLowerCase());
}
