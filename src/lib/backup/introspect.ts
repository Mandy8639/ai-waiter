import type { PGlite } from "@electric-sql/pglite";
import { orderTablesForRestore, type ForeignKeyEdge } from "./schema-order";

/**
 * Reads the real table list and foreign-key graph out of a database that
 * has this project's migrations applied. Used against a throwaway PGlite
 * instance rather than production: the schema is defined by
 * supabase/migrations/, so PGlite is an authoritative and completely
 * side-effect-free place to ask what that schema contains.
 */
export async function introspectPublicTables(db: PGlite): Promise<{
  order: string[];
  unresolved: string[];
}> {
  const { rows: tableRows } = await db.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
      order by table_name;`,
  );
  const tables = tableRows.map((r) => r.table_name);

  const { rows: fkRows } = await db.query<{ child: string; parent: string }>(
    `select tc.table_name as child, ccu.table_name as parent
       from information_schema.table_constraints tc
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name
        and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY'
        and tc.table_schema = 'public';`,
  );

  const edges: ForeignKeyEdge[] = fkRows.map((r) => ({
    child: r.child,
    parent: r.parent,
  }));

  return orderTablesForRestore(tables, edges);
}

/**
 * Columns Postgres computes itself — GENERATED ALWAYS AS, and identity
 * columns declared GENERATED ALWAYS AS IDENTITY. An INSERT that supplies a
 * value for one of these is rejected outright, so a restore has to leave
 * them out and let the database recompute them.
 *
 * Found the hard way: the first restore attempt failed on audit_log.seq
 * and order_payments.total_amount.
 */
export async function generatedColumns(
  db: PGlite,
): Promise<Map<string, Set<string>>> {
  const { rows } = await db.query<{
    table_name: string;
    column_name: string;
  }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and (is_generated = 'ALWAYS' or identity_generation = 'ALWAYS');`,
  );
  const byTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byTable.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    byTable.set(row.table_name, set);
  }
  return byTable;
}

/**
 * Every public column that points at auth.users. Needed because the backup
 * covers `public` only: each of these columns holds an id that must exist
 * in a schema the backup does not contain.
 *
 * Deliberately discovered rather than hardcoded — the first version seeded
 * only restaurant_users.user_id and the restore then failed on
 * customer_sessions.user_id (anonymous diners) and reservations.created_by.
 */
export async function columnsReferencingAuthUsers(
  db: PGlite,
): Promise<Array<{ table: string; column: string }>> {
  const { rows } = await db.query<{ table_name: string; column_name: string }>(
    `select tc.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.table_schema = tc.table_schema
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
        and tc.table_schema = 'public'
        and ccu.table_schema = 'auth'
        and ccu.table_name = 'users';`,
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}
