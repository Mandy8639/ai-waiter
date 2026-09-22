/**
 * Works out who *should* be able to EXECUTE each public function, purely
 * from the migration SQL, so it can be compared against who actually can on
 * a live database.
 *
 * This exists because two real incidents on 2026-09-19 were both invisible
 * to the test suite, which only ever sees a database built from the
 * migrations — where the repo and the grants agree by construction:
 *
 *   - `get_restaurant_staff` and `add_restaurant_staff_by_email` were
 *     dropped and recreated by hand in the SQL editor while chasing a
 *     PostgREST cache bug. Recreating a function resets its ACL to the
 *     Postgres default (PUBLIC holds EXECUTE), and the migration's revoke
 *     never re-runs, so production quietly disagreed with the repo.
 *   - The menu-photos migration was edited after it had already been
 *     applied, so the corrected revokes could never reach production;
 *     `supabase db push` reported "up to date" while 13 functions stayed
 *     reachable by anon.
 *
 * Neither is a code defect, so neither could fail a build. They are
 * repo-versus-reality drift, and the only way to see them is to ask the
 * live database and compare.
 *
 * The starting point is deliberately pessimistic, because that is what a
 * real Supabase project does:
 *   - Postgres grants EXECUTE on every new function to PUBLIC.
 *   - Supabase's platform default privileges *additionally* grant EXECUTE
 *     to anon, authenticated and service_role.
 * So a migration that only says `revoke ... from public` leaves the
 * function callable by anyone holding the anon key — which is exactly how
 * the four Stripe webhook functions stayed exposed for weeks.
 */

/** The Supabase API roles whose EXECUTE we care about. */
export const API_ROLES = ["anon", "authenticated", "service_role"] as const;
export type ApiRole = (typeof API_ROLES)[number];

/** Whether each grantee holds EXECUTE. `pub` is PUBLIC, which everyone inherits. */
export interface GrantState {
  pub: boolean;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
}

/** One function as the live catalog reports it. */
export interface LiveFunctionGrant {
  /** Bare function name, e.g. `get_restaurant_staff`. */
  name: string;
  /** `oid::regprocedure` text, e.g. `get_restaurant_staff(uuid)` — for reporting only. */
  signature: string;
  /**
   * `has_function_privilege(role, oid, 'execute')`, which is already
   * PUBLIC-inclusive: it returns true when the role holds EXECUTE directly
   * *or* when PUBLIC does. That is precisely why a `revoke ... from anon`
   * can leave the answer `true`, and why `pub` is reported separately.
   */
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
  pub: boolean;
}

export interface GrantDrift {
  name: string;
  signature: string;
  grantee: "pub" | ApiRole;
  expected: boolean;
  actual: boolean;
  /** True when the live database is *more* permissive than the migrations ask for. */
  morePermissive: boolean;
}

/**
 * The default every function starts from on a real Supabase project: PUBLIC
 * from Postgres, the three API roles from Supabase's default privileges.
 */
function defaultGrantState(): GrantState {
  return { pub: true, anon: true, authenticated: true, service_role: true };
}

/**
 * Collapses whitespace so a statement broken across lines — like the
 * seven-argument `record_restaurant_subscription` revoke — parses the same
 * as a single-line one.
 */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ");
}

/**
 * Grantee lists are comma-separated and may name roles we do not track
 * (`postgres`, `dashboard_user`); those are ignored rather than guessed at.
 */
function parseGrantees(list: string): Array<"pub" | ApiRole> {
  const out: Array<"pub" | ApiRole> = [];
  for (const raw of list.split(",")) {
    const token = raw.trim().toLowerCase().replace(/"/g, "");
    if (token === "public") {
      out.push("pub");
    } else if ((API_ROLES as readonly string[]).includes(token)) {
      out.push(token as ApiRole);
    }
  }
  return out;
}

/**
 * Matches `revoke execute on function public.name(args) from a, b;` and the
 * `grant ... to ...` form. The argument list is skipped rather than parsed:
 * this schema has no overloaded functions, and matching argument types
 * across spellings (`timestamptz` in a migration versus `timestamp with
 * time zone` from `regprocedure`) would invent failures with no security
 * meaning. `findOverloads` below turns that assumption into a checked one.
 */
const GRANT_STATEMENT =
  /\b(revoke|grant)\s+execute\s+on\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\([^)]*\)\s*(?:from|to)\s+([^;]+);/gi;

/**
 * Replays every grant and revoke in migration order to get the state the
 * repository intends. Order matters: several migrations revoke from
 * `public, anon` and then grant back to `authenticated`.
 *
 * @param migrationSqlInOrder Migration file contents, already sorted by filename.
 */
export function expectedGrantsFromMigrations(
  migrationSqlInOrder: string[],
): Map<string, GrantState> {
  const expected = new Map<string, GrantState>();

  for (const sql of migrationSqlInOrder) {
    const normalized = normalizeSql(sql);
    for (const match of normalized.matchAll(GRANT_STATEMENT)) {
      const [, verb, name, granteeList] = match;
      const fn = name.toLowerCase();
      const state = expected.get(fn) ?? defaultGrantState();
      const granting = verb.toLowerCase() === "grant";
      for (const grantee of parseGrantees(granteeList)) {
        state[grantee] = granting;
      }
      expected.set(fn, state);
    }
  }

  return expected;
}

/**
 * Names carrying more than one signature. The comparison is keyed by name,
 * so an overload would make the result ambiguous — this reports that
 * honestly instead of silently picking one.
 */
export function findOverloads(live: LiveFunctionGrant[]): string[] {
  const seen = new Map<string, number>();
  for (const row of live) {
    seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
}

/**
 * Compares live grants against migration intent.
 *
 * A function the migrations never mention keeps the permissive default, so
 * it produces no drift — the ~23 helper functions that are deliberately
 * left callable stay quiet, and only genuine disagreements surface.
 *
 * The PUBLIC-inclusive nature of `has_function_privilege` is handled by
 * folding `pub` into each role's expectation: if the migrations leave
 * PUBLIC holding EXECUTE, then every role is expected to answer `true`,
 * which is the trap that made `get_restaurant_staff` look fixed when it
 * was not.
 */
export function compareGrants(
  expected: Map<string, GrantState>,
  live: LiveFunctionGrant[],
): GrantDrift[] {
  const drifts: GrantDrift[] = [];

  for (const row of live) {
    const want = expected.get(row.name.toLowerCase());
    if (!want) continue;

    const checks: Array<{
      grantee: "pub" | ApiRole;
      want: boolean;
      got: boolean;
    }> = [
      { grantee: "pub", want: want.pub, got: row.pub },
      ...API_ROLES.map((role) => ({
        grantee: role as ApiRole,
        // PUBLIC's grant reaches every role, so it is part of the expectation.
        want: want[role] || want.pub,
        got: row[role],
      })),
    ];

    for (const check of checks) {
      if (check.want === check.got) continue;
      drifts.push({
        name: row.name,
        signature: row.signature,
        grantee: check.grantee,
        expected: check.want,
        actual: check.got,
        morePermissive: check.got && !check.want,
      });
    }
  }

  return drifts.sort(
    (a, b) =>
      Number(b.morePermissive) - Number(a.morePermissive) ||
      a.name.localeCompare(b.name) ||
      a.grantee.localeCompare(b.grantee),
  );
}
