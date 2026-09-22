/**
 * Compares EXECUTE grants on the live database against what the migrations
 * in supabase/migrations/ ask for, and fails if the live database is more
 * permissive.
 *
 * Read-only: it runs catalog queries and writes nothing.
 *
 * The test suite cannot do this job. It builds its database *from* the
 * migrations, so the grants and the repository agree there by definition.
 * Every real exposure found on 2026-09-19 was a disagreement between the
 * repository and the live project:
 *
 *   - four Stripe webhook functions callable by anyone holding the anon
 *     key, because their migrations revoked PUBLIC but not anon, and
 *     Supabase's default privileges grant anon EXECUTE on every new
 *     function;
 *   - two functions hand-recreated in the SQL editor, which reset their
 *     ACL to Postgres's default of PUBLIC-has-EXECUTE;
 *   - thirteen functions whose revokes were added to a migration *after*
 *     that migration had already been applied, so they could never run.
 *
 *   npm run db:check-grants
 *
 * Needs SUPABASE_DB_URL (Project Settings → Database → Connection string).
 * See scripts/check-migration-drift.ts for the companion check that spots
 * an applied migration whose file has since been edited.
 */
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  compareGrants,
  expectedGrantsFromMigrations,
  findOverloads,
  type LiveFunctionGrant,
} from "../src/lib/db-audit/function-grants-core";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");

/**
 * Trigger functions are excluded: they return `trigger`, cannot be called
 * through PostgREST, and their grants carry no meaning.
 */
const LIVE_GRANTS_SQL = `
  select p.proname                                             as name,
         p.oid::regprocedure::text                             as signature,
         has_function_privilege('anon', p.oid, 'execute')         as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
         has_function_privilege('service_role', p.oid, 'execute')  as service_role,
         has_function_privilege('public', p.oid, 'execute')        as pub
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prorettype <> 'trigger'::regtype
  order by p.proname;
`;

async function readMigrationsInOrder(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return Promise.all(
    files.map((f) => readFile(path.join(MIGRATIONS_DIR, f), "utf8")),
  );
}

async function main(): Promise<void> {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error(
      "Needs SUPABASE_DB_URL. Supabase dashboard → Project Settings → Database → Connection string → URI.",
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  let live: LiveFunctionGrant[];
  try {
    await client.connect();
    const { rows } = await client.query<LiveFunctionGrant>(LIVE_GRANTS_SQL);
    live = rows;
  } finally {
    await client.end();
  }

  const expected = expectedGrantsFromMigrations(await readMigrationsInOrder());

  // Keyed by name, so an overload would make the answer ambiguous. This
  // schema has none; if that ever changes, say so rather than mislead.
  const overloads = findOverloads(live);
  if (overloads.length > 0) {
    console.error(
      `Overloaded function names, which this check cannot resolve: ${overloads.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const drifts = compareGrants(expected, live);
  console.log(
    `Checked ${live.length} functions against ${expected.size} named in migrations.`,
  );

  if (drifts.length === 0) {
    console.log("No grant drift: the live database matches the migrations.");
    return;
  }

  const permissive = drifts.filter((d) => d.morePermissive);
  const restrictive = drifts.filter((d) => !d.morePermissive);

  if (permissive.length > 0) {
    console.error(
      `\n${permissive.length} grant(s) MORE permissive than intended:`,
    );
    for (const d of permissive) {
      console.error(
        `  ${d.signature}: ${d.grantee} can execute, migrations revoke it`,
      );
    }
    console.error(
      "\nFix with `revoke execute on function public.<signature> from public, <role>;`" +
        "\nRevoking from a role alone is not enough while PUBLIC still holds EXECUTE.",
    );
  }

  if (restrictive.length > 0) {
    console.warn(
      `\n${restrictive.length} grant(s) MORE restrictive than intended:`,
    );
    for (const d of restrictive) {
      console.warn(
        `  ${d.signature}: ${d.grantee} cannot execute, migrations grant it`,
      );
    }
    console.warn("\nThese do not expose anything, but a caller may be broken.");
  }

  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
