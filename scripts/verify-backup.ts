/**
 * Restores a backup file into a throwaway in-memory Postgres with this
 * project's real migrations applied, then checks every table came back
 * with the row count it went in with.
 *
 * The point is that an unverified backup is not a backup. This runs the
 * actual restore path — real migration SQL, real constraints, real
 * triggers — and fails loudly if a table cannot be restored, without
 * touching any real database. PGlite is already a dependency (the
 * integration suite runs the same migrations in it), so this costs no new
 * infrastructure and can be run as often as the backup itself.
 *
 *   npm run db:verify-backup                  # newest file in backups/
 *   npm run db:verify-backup -- <path.json>
 */
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  generatedColumns,
  columnsReferencingAuthUsers,
} from "../src/lib/backup/introspect";
import { SUPABASE_PLATFORM_STUB_SQL } from "../src/lib/backup/supabase-stub";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");
const BACKUP_DIR = path.resolve(process.cwd(), "backups");

interface BackupFile {
  takenAt: string;
  tableOrder: string[];
  data: Record<string, Record<string, unknown>[]>;
}

async function newestBackup(): Promise<string> {
  const files = (await readdir(BACKUP_DIR))
    .filter((f) => f.startsWith("backup-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`No backups in ${BACKUP_DIR}`);
  return path.join(BACKUP_DIR, files[files.length - 1]);
}

async function migratedDb(): Promise<PGlite> {
  const db = new PGlite();
  // Shared with the backup script and the test harness: a stale private
  // copy of this is what broke `npm run db:backup`.
  await db.exec(SUPABASE_PLATFORM_STUB_SQL);
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await db.exec(await readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

/**
 * The backup covers the `public` schema only. Supabase's `auth` schema —
 * the actual user accounts — is not reachable through PostgREST and is not
 * in the file, yet several public tables hold foreign keys into it.
 *
 * Which columns those are is discovered from the schema, not hardcoded:
 * the first version of this seeded only restaurant_users.user_id and the
 * restore then failed on customer_sessions.user_id (anonymous diners) and
 * reservations.created_by.
 *
 * They are seeded so the rest of the restore can be verified, and the gap
 * is reported at the end rather than hidden — an operator restoring for
 * real needs the Supabase auth export too, or every login is gone even
 * though the restaurant data came back.
 */
async function seedReferencedAuthUsers(
  db: PGlite,
  backup: BackupFile,
): Promise<{
  seeded: number;
  columns: Array<{ table: string; column: string }>;
}> {
  const columns = await columnsReferencingAuthUsers(db);
  const ids = new Set<string>();
  for (const { table, column } of columns) {
    for (const row of backup.data[table] ?? []) {
      const id = row[column];
      if (typeof id === "string") ids.add(id);
    }
  }
  for (const id of ids) {
    await db.query("insert into auth.users (id) values ($1);", [id]);
  }
  return { seeded: ids.size, columns };
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? (await newestBackup());
  const backup = JSON.parse(await readFile(file, "utf8")) as BackupFile;

  console.log(`Backup:  ${path.basename(file)}`);
  console.log(`Taken:   ${backup.takenAt}\n`);

  const db = await migratedDb();
  const { seeded, columns: authColumns } = await seedReferencedAuthUsers(
    db,
    backup,
  );
  const generated = await generatedColumns(db);

  // Some migrations seed reference data (platform_plans is the one that
  // bit: restoring its rows collided with the seeded ones on the slug
  // unique constraint). Clearing in reverse dependency order first makes
  // the restore authoritative rather than additive — the backup is the
  // source of truth for what should be there.
  for (const table of [...backup.tableOrder].reverse()) {
    await db.query(`delete from public."${table}" where true;`);
  }

  // User triggers off for the load, exactly as pg_restore does it.
  // Without this the audit triggers fire on every restored row and write
  // NEW audit_log entries on top of the restored ones — the first run came
  // back with 801 rows where the backup held 348. A restore has to
  // reproduce the audit trail, not append its own activity to it.
  //
  // `disable trigger user` deliberately leaves system triggers alone, so
  // foreign keys stay enforced throughout: that the restore satisfies
  // every FK is the most valuable thing this check proves, and turning it
  // off (via session_replication_role) would make a passing run mean much
  // less.
  for (const table of backup.tableOrder) {
    await db.query(`alter table public."${table}" disable trigger user;`);
  }

  const failures: string[] = [];
  let restored = 0;

  for (const table of backup.tableOrder) {
    const rows = backup.data[table] ?? [];
    if (rows.length === 0) continue;

    const skip = generated.get(table) ?? new Set<string>();
    const columns = Object.keys(rows[0]).filter((c) => !skip.has(c));
    const quoted = columns.map((c) => `"${c}"`).join(", ");
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

    for (const row of rows) {
      try {
        await db.query(
          `insert into public."${table}" (${quoted}) values (${placeholders});`,
          columns.map((c) => row[c] ?? null),
        );
        restored += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${table}: ${message}`);
        break; // one message per table is enough to diagnose
      }
    }
  }

  for (const table of backup.tableOrder) {
    await db.query(`alter table public."${table}" enable trigger user;`);
  }

  console.log("Row counts after restore:\n");
  let mismatched = 0;
  for (const table of backup.tableOrder) {
    const expected = (backup.data[table] ?? []).length;
    if (expected === 0) continue;
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public."${table}";`,
    );
    const actual = Number(rows[0].count);
    const ok = actual === expected;
    if (!ok) mismatched += 1;
    console.log(
      `  ${ok ? "OK  " : "DIFF"}  ${table.padEnd(32)} expected ${expected}, got ${actual}`,
    );
  }

  await db.close();

  console.log(`\n${restored} rows restored.`);
  console.log(
    `Seeded ${seeded} auth.users row(s) for ${authColumns.length} public column(s) referencing auth.users:`,
  );
  for (const { table, column } of authColumns) {
    console.log(`  ${table}.${column}`);
  }
  console.log(
    "\nGAP: this backup covers the `public` schema only. Supabase's `auth`\n" +
      "schema (the actual user accounts and their credentials) is not in it,\n" +
      "so restoring this alone brings back every restaurant and order but no\n" +
      "logins. See docs/backup-and-restore.md.",
  );

  if (failures.length > 0 || mismatched > 0) {
    console.error(
      `\nFAILED: ${failures.length} table(s) errored, ${mismatched} count mismatch(es).`,
    );
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "\nRestore verified: every table came back with the row count it went in with.",
  );
}

main();
