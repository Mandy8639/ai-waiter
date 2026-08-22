/**
 * Creates the four dev-only login users for the seeded "Nashta (Demo)"
 * restaurant (owner/manager/kitchen/staff) and links them via
 * restaurant_users.
 *
 * Why this is a separate script and not part of supabase/seed.sql:
 * creating a real login requires either a password or the Supabase Admin
 * API, and per project policy no password — fake or otherwise — belongs in
 * source-controlled SQL (see supabase/seed.sql's header comment). This
 * script uses the Admin API instead, generates a random password per user
 * at RUNTIME, prints it once to your terminal, and never writes it to disk
 * or git. If you don't capture it, just re-run the script for that role —
 * see the "already exists" handling below.
 *
 * Requires supabase/seed.sql to have already been applied (the restaurant
 * must exist) and SUPABASE_SECRET_KEY set in your environment — this uses
 * the admin client, which bypasses RLS, and must only ever run from a
 * trusted local/CI shell, never from application code.
 *
 * Usage:
 *   npm run db:seed:users
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const RESTAURANT_SLUG = "nashta-demo";
const EMAIL_DOMAIN = "nashta-demo.aiwaiter.test";

const ROLES = ["owner", "manager", "kitchen", "staff"] as const;

async function findUserIdByEmail(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
): Promise<string | null> {
  // The Admin API has no direct "get user by email" call, so we page
  // through listUsers(). Fine for a handful of dev accounts; not something
  // you'd want at production scale.
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const found = data.users.find((u) => u.email === email);
    if (found) return found.id;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

async function main() {
  const admin = createAdminClient();

  const { data: restaurant, error: restaurantError } = await admin
    .from("restaurants")
    .select("id")
    .eq("slug", RESTAURANT_SLUG)
    .single();

  if (restaurantError || !restaurant) {
    throw new Error(
      `Could not find seeded restaurant "${RESTAURANT_SLUG}". Run \`supabase db reset\` (which applies supabase/seed.sql) first.`,
    );
  }

  for (const role of ROLES) {
    const email = `${role}@${EMAIL_DOMAIN}`;

    let userId = await findUserIdByEmail(admin, email);

    if (userId) {
      console.log(
        `[${role}] already exists (${email}) — leaving password as-is.`,
      );
    } else {
      const password = crypto.randomUUID();
      const { data: created, error: createError } =
        await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
      if (createError || !created.user) {
        throw new Error(
          `Failed to create ${role} user: ${createError?.message}`,
        );
      }
      userId = created.user.id;
      console.log(`[${role}] created ${email}`);
      console.log(`         password (shown once, not stored): ${password}`);
    }

    const { error: membershipError } = await admin
      .from("restaurant_users")
      .upsert(
        { restaurant_id: restaurant.id, user_id: userId, role },
        { onConflict: "user_id,restaurant_id" },
      );

    if (membershipError) {
      throw new Error(
        `Failed to link ${role} to ${RESTAURANT_SLUG}: ${membershipError.message}`,
      );
    }
  }

  console.log(
    "\nDone. These are local/dev credentials only — never reuse them anywhere real.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
