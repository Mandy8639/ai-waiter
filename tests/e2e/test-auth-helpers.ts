import { createClient } from "@supabase/supabase-js";

/**
 * Test-only Supabase Admin API helper — creates a REAL, pre-confirmed
 * staff user for E2E specs that only need a working login to reach the
 * dashboard, not to exercise the signup/email-confirmation flow itself
 * (that remains dashboard-flow.spec.ts's job, using the real, unmodified
 * /signup UI — never swap that one to this helper).
 *
 * Deliberately does NOT import src/lib/supabase/admin.ts: that file has
 * `import "server-only"`, which throws unconditionally outside Next.js's
 * RSC bundler, and Playwright runs spec files as plain Node, not through
 * Next's bundler (the same constraint scripts/seed-dev-users.ts hits,
 * documented there). This constructs its own client directly instead,
 * mirroring admin.ts's exact configuration — a deliberate, small
 * duplication that keeps test authentication code separate from
 * production authentication code, per the task that introduced this file.
 *
 * SUPABASE_SECRET_KEY is loaded into the Playwright test process by
 * playwright.config.ts's existing loadEnvConfig() call — never exposed
 * via NEXT_PUBLIC_*, never imported by any src/ (application) file, never
 * logged. This does NOT disable or weaken email confirmation for real
 * production signups — it only lets the ADMIN API mark a specific,
 * test-created account confirmed, which is Supabase's own intended
 * mechanism for exactly this purpose.
 */
export async function createConfirmedTestUser(
  email: string,
  password: string,
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secretKey) {
    throw new Error(
      "createConfirmedTestUser requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY " +
        "in the Playwright test process (see .env.example) — these real-credential E2E " +
        "specs cannot run without them.",
    );
  }

  const admin = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    throw new Error(
      `createConfirmedTestUser failed for ${email}: ${error.message}`,
    );
  }
}
