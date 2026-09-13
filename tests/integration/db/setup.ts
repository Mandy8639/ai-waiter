/**
 * Test harness for the RLS/constraint integration tests in this directory.
 *
 * There is no Docker/Postgres available in this environment, so
 * `supabase start` (the normal local dev stack) isn't an option here. This
 * uses `@electric-sql/pglite` — real Postgres compiled to WASM — as a
 * dev-only test dependency instead: it runs the actual files in
 * supabase/migrations/, so what's under test is the real migration SQL,
 * not a re-description of it.
 *
 * The stub itself now lives in src/lib/backup/supabase-stub.ts, shared with
 * scripts/backup-database.ts and scripts/verify-backup.ts. It used to be a
 * private copy in each of the three; the other two fell behind the
 * migrations and broke, silently, until someone needed a backup.
 *
 * What's stubbed, and why it's a faithful stand-in:
 * - `auth.users` / `auth.uid()`: real Supabase provides these via GoTrue: a
 *   users table plus a function reading the request JWT. We recreate just
 *   the shape RLS policies actually touch — a users table or role checks
 *   this file makes, and `auth.uid()` backed by a Postgres session GUC we
 *   control from the test (`app.current_user_id`) instead of a real JWT.
 *   `is_anonymous` is modelled too: create_restaurant() reads it to refuse
 *   a diner's guest session, so tests need to be able to create one.
 *   Every policy in the schema is written purely in terms of `auth.uid()`,
 *   so this is a complete stand-in for RLS-testing purposes.
 * - `authenticated` / `anon` roles + default table grants: on a real
 *   Supabase project these come from platform-level default privileges
 *   applied to every new table automatically. We grant the same
 *   privileges by hand here since PGlite has no such platform layer.
 *
 * One PGlite instance is shared per test file (built once in `beforeAll`,
 * see individual test files) — building it takes ~500ms, so a fresh
 * instance per test would make the suite slow. Isolation between tests
 * instead comes from each test creating its own uniquely-named fixtures
 * (see helpers.ts), not from resetting the database between tests.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SUPABASE_PLATFORM_STUB_SQL } from "@/lib/backup/supabase-stub";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");

export interface TestDb {
  /** Raw connection. Runs as the default (table-owning) role, which bypasses RLS — for fixture setup only, never for asserting what a tenant user can see. */
  admin: PGlite;
  /** Runs `fn` as `authenticated`, with auth.uid() resolving to `userId`. */
  asUser: <T>(userId: string, fn: (client: PGlite) => Promise<T>) => Promise<T>;
  /** Runs `fn` as `anon` (unauthenticated) — auth.uid() is NULL. */
  asAnon: <T>(fn: (client: PGlite) => Promise<T>) => Promise<T>;
  /** Runs `fn` as `service_role` — what the Stripe webhook writes as. Bypasses RLS, as on a real project. */
  asServiceRole: <T>(fn: (client: PGlite) => Promise<T>) => Promise<T>;
  /** Inserts a row into the auth.users stub and returns its id. Give an explicit email to make that user findable via get_restaurant_staff()/add_restaurant_staff_by_email() — omitted, it gets a unique placeholder. */
  createAuthUser: (email?: string) => Promise<string>;
  /** Inserts an anonymous (diner) identity — what scanning a table's QR code creates. */
  createAnonymousAuthUser: () => Promise<string>;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const admin = new PGlite();

  // The Supabase platform pieces, shared with scripts/backup-database.ts
  // and scripts/verify-backup.ts. This used to be a private copy in each
  // of the three; the other two fell behind the migrations and broke.
  await admin.exec(SUPABASE_PLATFORM_STUB_SQL);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await admin.exec(sql);
  }

  // Stand-in for Supabase's platform-level default privileges (see header
  // comment) — RLS only narrows rows, it doesn't grant table access on its
  // own, so without this every query would fail on privilege, not policy.
  //
  // anon gets the same broad grants as authenticated, matching real
  // Supabase projects (which grant full CRUD to both roles by default and
  // rely on RLS policies — every one of which is scoped `to authenticated`
  // in this schema, never `to anon` — as the actual boundary). Narrowing
  // anon's grants here instead would make the "anon can't write" tests
  // pass for the wrong reason: a grant gap this test harness invented,
  // not the RLS policy scoping that's the real protection in production.
  await admin.exec(`
    grant usage on schema public to authenticated, anon, service_role;
    grant select, insert, update, delete on all tables in schema public to authenticated, anon, service_role;
  `);

  async function withRole<T>(
    role: "authenticated" | "anon" | "service_role",
    userId: string | null,
    fn: (client: PGlite) => Promise<T>,
  ): Promise<T> {
    await admin.exec(`set role ${role};`);
    await admin.query("select set_config('app.current_user_id', $1, false);", [
      userId ?? "",
    ]);
    try {
      return await fn(admin);
    } finally {
      await admin.query(
        "select set_config('app.current_user_id', $1, false);",
        [""],
      );
      await admin.exec("reset role;");
    }
  }

  return {
    admin,
    asUser: (userId, fn) => withRole("authenticated", userId, fn),
    asAnon: (fn) => withRole("anon", null, fn),
    asServiceRole: (fn) => withRole("service_role", null, fn),
    createAuthUser: async (email) => {
      const { rows } = await admin.query<{ id: string }>(
        "insert into auth.users (email) values ($1) returning id;",
        [email ?? `${crypto.randomUUID()}@example.com`],
      );
      return rows[0].id;
    },
    createAnonymousAuthUser: async () => {
      // No email, is_anonymous true — what Supabase Anonymous Auth creates
      // for a diner who scans a table's QR code.
      const { rows } = await admin.query<{ id: string }>(
        "insert into auth.users (email, is_anonymous) values (null, true) returning id;",
      );
      return rows[0].id;
    },
    close: () => admin.close(),
  };
}
