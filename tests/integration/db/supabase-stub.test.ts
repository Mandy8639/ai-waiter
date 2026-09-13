// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_PLATFORM_STUB_SQL } from "@/lib/backup/supabase-stub";

/**
 * Every migration must apply on top of the shared Supabase stub alone.
 *
 * This guards `npm run db:backup` and `npm run db:verify-backup`, which
 * both replay the migrations into PGlite to learn the schema. Nothing else
 * covered them: the integration suite builds its own database through the
 * harness, so when a migration started needing `storage.buckets` the
 * harness was updated and the two scripts were not. The backup script threw
 * `relation "storage.buckets" does not exist` and stayed broken for nine
 * days — silently, because a backup is only run when it is already needed.
 *
 * If a future migration needs another Supabase platform object, this fails
 * here rather than the next time someone reaches for a backup.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");

describe("the shared Supabase stub", () => {
  let db: PGlite;
  let migrationCount = 0;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SUPABASE_PLATFORM_STUB_SQL);
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    migrationCount = files.length;
    for (const file of files) {
      // Named in the failure so a breaking migration identifies itself.
      try {
        await db.exec(await readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
      } catch (cause) {
        throw new Error(`migration ${file} failed against the stub: ${cause}`, {
          cause,
        });
      }
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it("carries every migration in the repository", () => {
    expect(migrationCount).toBeGreaterThan(0);
  });

  it("leaves the public tables the backup script enumerates", async () => {
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE';`,
    );
    // The backup writes one entry per public table; an empty schema here
    // would mean a backup that "succeeds" while saving nothing.
    expect(rows[0].count).toBeGreaterThan(20);
  });

  it.each([
    ["auth", "users"],
    ["storage", "buckets"],
    ["storage", "objects"],
  ])("provides %s.%s, which migrations reference", async (schema, table) => {
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count
         from information_schema.tables
        where table_schema = $1 and table_name = $2;`,
      [schema, table],
    );
    expect(rows[0].count).toBe(1);
  });

  it("models auth.users.is_anonymous, which create_restaurant() reads", async () => {
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count
         from information_schema.columns
        where table_schema = 'auth'
          and table_name = 'users'
          and column_name = 'is_anonymous';`,
    );
    expect(rows[0].count).toBe(1);
  });
});
