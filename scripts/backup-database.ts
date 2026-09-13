/**
 * Exports every row of every public table to a single timestamped JSON
 * file. Read-only against production; writes nothing but the local file.
 *
 * This exists because the production Supabase project is on the Free plan,
 * which includes NO scheduled backups and no point-in-time recovery (both
 * are Pro features — see docs/backup-and-restore.md). Without this, a
 * dropped table or a bad migration is unrecoverable: the schema is
 * reproducible from supabase/migrations/, but the data is not reproducible
 * from anything.
 *
 * The table list is not hand-maintained. It is read from the schema the
 * migrations actually produce, via a throwaway in-memory PGlite instance,
 * so a table added in a future migration is included automatically instead
 * of being silently missed by a backup that still looks like it worked.
 *
 *   npm run db:backup
 */
import { createClient } from "@supabase/supabase-js";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { introspectPublicTables } from "../src/lib/backup/introspect";
import { SUPABASE_PLATFORM_STUB_SQL } from "../src/lib/backup/supabase-stub";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");
const OUT_DIR = path.resolve(process.cwd(), "backups");

async function schemaFromMigrations(): Promise<PGlite> {
  const db = new PGlite();
  // The platform pieces PGlite has no equivalent of, shared with the
  // verifier and the test harness. It used to be copy-pasted here, fell
  // behind the migrations, and broke this script — see the module.
  await db.exec(SUPABASE_PLATFORM_STUB_SQL);
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await db.exec(await readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.error("Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.");
    process.exitCode = 1;
    return;
  }

  console.log("Reading the schema from supabase/migrations/ ...");
  const schema = await schemaFromMigrations();
  const { order, unresolved } = await introspectPublicTables(schema);
  await schema.close();

  if (unresolved.length > 0) {
    // Said out loud rather than swallowed: these can't be ordered for a
    // straight-through restore, so a restore may need them handled by hand.
    console.warn(
      `WARNING: circular foreign keys, restore order not guaranteed for: ${unresolved.join(", ")}`,
    );
  }
  console.log(`${order.length} tables to export.\n`);

  const db = createClient(url, key);
  const data: Record<string, unknown[]> = {};
  let total = 0;
  let failed = 0;

  for (const table of order) {
    // Paged: a plain select caps out at PostgREST's row limit, and a
    // backup that silently stops at 1000 rows is worse than no backup.
    const rows: unknown[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data: page, error } = await db
        .from(table)
        .select("*")
        .range(from, from + pageSize - 1);
      if (error) {
        console.log(`  !! ${table}: ${error.message}`);
        failed += 1;
        break;
      }
      rows.push(...(page ?? []));
      if (!page || page.length < pageSize) break;
    }
    data[table] = rows;
    total += rows.length;
    if (rows.length > 0) console.log(`  ${table}: ${rows.length}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(OUT_DIR, `backup-${stamp}.json`);
  await writeFile(
    file,
    JSON.stringify(
      { takenAt: new Date().toISOString(), tableOrder: order, data },
      null,
      2,
    ),
  );

  console.log(`\n${total} rows across ${order.length} tables -> ${file}`);
  if (failed > 0) {
    console.error(
      `${failed} table(s) could not be read — this backup is INCOMPLETE.`,
    );
    process.exitCode = 1;
  }
}

main();
