import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The nav badge is driven by Realtime, and Realtime only delivers changes
 * for tables in the `supabase_realtime` publication. `orders` needed an
 * explicit migration to join it; `reservations` did too.
 *
 * This is a static check because the integration suite structurally cannot
 * catch it: PGlite has no Realtime layer and no such publication, so the
 * migration is a deliberate no-op there and every test would pass against
 * a database where the badge never updates. The same blind spot that hid
 * the unqualified DELETE in start_tab_payment().
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function migrationsMentioning(table: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) =>
      readFileSync(join(MIGRATIONS, f), "utf8").includes(
        `alter publication supabase_realtime add table public.${table}`,
      ),
    );
}

describe("realtime publication", () => {
  it("adds reservations, or the pending-request badge never updates", () => {
    expect(migrationsMentioning("reservations")).toHaveLength(1);
  });

  it("still adds orders, so the kitchen board keeps working", () => {
    expect(migrationsMentioning("orders")).toHaveLength(1);
  });

  it("sets replica identity full on reservations", () => {
    // Without it, an UPDATE's replication record carries only the primary
    // key for the old row — not enough for Realtime to re-evaluate RLS.
    const sql = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    expect(sql).toContain(
      "alter table public.reservations replica identity full",
    );
  });

  it("guards the publication change, or the whole integration suite fails", () => {
    // PGlite has no supabase_realtime publication at all.
    const file = migrationsMentioning("reservations")[0];
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    expect(sql).toContain("pg_publication");
    expect(sql).toContain("pubname = 'supabase_realtime'");
  });
});
