// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  compareGrants,
  expectedGrantsFromMigrations,
  findOverloads,
  type LiveFunctionGrant,
} from "@/lib/db-audit/function-grants-core";

/**
 * Keeps `npm run db:check-grants` honest.
 *
 * That script compares the live database's EXECUTE grants against what the
 * migrations ask for. It can only be run by a human with production
 * credentials, so nothing in CI exercises it — and a drift report that
 * cries wolf is worse than no report, because it gets ignored and then the
 * one real finding is lost in the noise.
 *
 * This runs the script's exact catalog query and its exact comparison
 * against a database built *from* the migrations, where the correct answer
 * is necessarily "no drift". Any drift reported here is a false positive in
 * the comparator: a revoke it failed to parse, a role it mishandled, or the
 * permissive Supabase default modelled wrongly.
 *
 * It does not test that real drift is detected — the unit tests in
 * tests/unit/db-audit-function-grants.test.ts pin both of the 2026-09-19
 * incidents for that.
 */

/** Identical to LIVE_GRANTS_SQL in scripts/check-function-grants.ts. */
const LIVE_GRANTS_SQL = `
  select p.proname                                               as name,
         p.oid::regprocedure::text                               as signature,
         has_function_privilege('anon', p.oid, 'execute')          as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
         has_function_privilege('service_role', p.oid, 'execute')  as service_role,
         has_function_privilege('public', p.oid, 'execute')        as pub
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prorettype <> 'trigger'::regtype
  order by p.proname;
`;

describe("function grant drift comparator", () => {
  let db: TestDb;
  let live: LiveFunctionGrant[];
  let migrationSql: string[];

  beforeAll(async () => {
    db = await createTestDb();
    const { rows } = await db.admin.query<LiveFunctionGrant>(LIVE_GRANTS_SQL);
    live = rows;

    const { readdir, readFile } = await import("node:fs/promises");
    const path = (await import("node:path")).default;
    const dir = path.resolve(process.cwd(), "supabase/migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    migrationSql = await Promise.all(
      files.map((f) => readFile(path.join(dir, f), "utf8")),
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it("reads the grants of every public function", () => {
    // Guards against the query silently matching nothing, which would make
    // every assertion below pass for the wrong reason.
    expect(live.length).toBeGreaterThan(50);
  });

  it("finds no overloaded names, which the name-keyed comparison requires", () => {
    expect(findOverloads(live)).toEqual([]);
  });

  it("parses the grant statements of the real migrations", () => {
    const expected = expectedGrantsFromMigrations(migrationSql);
    expect(expected.size).toBeGreaterThan(40);
    // A spot-check that intent survives revoke-then-grant ordering.
    expect(expected.get("get_restaurant_staff")).toMatchObject({
      pub: false,
      anon: false,
      authenticated: true,
    });
    expect(expected.get("mark_order_payment_succeeded")).toMatchObject({
      pub: false,
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });

  it("reports no drift against a database built from those same migrations", () => {
    const drifts = compareGrants(
      expectedGrantsFromMigrations(migrationSql),
      live,
    );
    // Printed in full on failure: the signature and grantee say immediately
    // which statement the parser mishandled.
    expect(
      drifts.map(
        (d) => `${d.signature} ${d.grantee} want=${d.expected} got=${d.actual}`,
      ),
    ).toEqual([]);
  });
});
