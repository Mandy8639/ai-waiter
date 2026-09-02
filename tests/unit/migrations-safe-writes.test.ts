import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every DELETE and UPDATE in a migration must carry a WHERE clause.
 *
 * Supabase loads pg_safeupdate on the roles PostgREST connects as, which
 * rejects an unqualified DELETE or UPDATE with `21000: DELETE requires a
 * WHERE clause`. The integration suite cannot catch this: it runs on
 * PGlite, which does not load that extension, so the statement is legal
 * there and the test passes against a database that does not enforce the
 * rule the real one does.
 *
 * That is exactly how `start_tab_payment()` shipped with a bare
 * `delete from tab_orders_tmp;` and failed for every diner who tried to
 * pay a tab, with 13 integration tests passing over it. A static check is
 * the only kind that can see this, so it lives here.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/**
 * The one statement that shipped before this check existed.
 *
 * It is left in place rather than edited out: the migration has already
 * been applied to production, and rewriting an applied migration risks a
 * mismatch on the next `supabase db push`. It is superseded instead — the
 * migration named here replaces the whole function with a version that
 * uses no temporary table at all — so a fresh replay creates the broken
 * form and then immediately replaces it, and an existing database is
 * repaired by the same migration.
 */
const SUPERSEDED = [
  {
    file: "20260902090000_tab_payments.sql",
    statement: "delete from tab_orders_tmp;",
    supersededBy: "20260902170000_fix_tab_payment_temp_table.sql",
  },
] as const;

/** Strips `--` comments and string literals so prose and quoted SQL cannot trip the scan. */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, (body) => body.replace(/'[^']*'/g, "''"))
    .replace(/'[^']*'/g, "''");
}

interface Offence {
  file: string;
  statement: string;
}

function unqualifiedWrites(): Offence[] {
  const offences: Offence[] = [];

  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith(".sql")) continue;
    const sql = stripNoise(readFileSync(join(MIGRATIONS, file), "utf8"));

    // Statement-terminated: everything from the keyword to the next
    // semicolon, so a WHERE on a later line still counts as qualified.
    for (const match of sql.matchAll(/\b(delete\s+from|update)\s+[^;]*?;/gi)) {
      const statement = match[0].replace(/\s+/g, " ").trim();
      // `update` also appears in DDL ("for update", "on update", grants,
      // trigger definitions) — only row-writing statements matter.
      if (
        /^update\s+(only\s+)?[\w".]+\s+set\b/i.test(statement) === false &&
        /^delete\s+from\b/i.test(statement) === false
      ) {
        continue;
      }
      if (/\bwhere\b/i.test(statement)) continue;

      const known = SUPERSEDED.some(
        (s) => s.file === file && s.statement === statement,
      );
      if (!known) {
        offences.push({ file, statement: statement.slice(0, 120) });
      }
    }
  }

  return offences;
}

describe("migrations", () => {
  it("scans a realistic number of files", () => {
    // Guards the guard: a broken path would make the assertion below pass
    // over nothing at all.
    expect(
      readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).length,
    ).toBeGreaterThan(20);
  });

  it("never writes rows without a WHERE clause", () => {
    expect(unqualifiedWrites()).toEqual([]);
  });

  it.each(SUPERSEDED)(
    "still ships the migration superseding $file",
    ({ supersededBy }) => {
      // Without this, deleting the fix would leave the allowlist silently
      // excusing a statement that is broken again.
      expect(readdirSync(MIGRATIONS)).toContain(supersededBy);
    },
  );
});
