import type { PGlite } from "@electric-sql/pglite";
import {
  orderTablesForRestore,
  type DeferredColumns,
  type ForeignKeyEdge,
} from "./schema-order";

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
  deferred: DeferredColumns[];
}> {
  const { rows: tableRows } = await db.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
      order by table_name;`,
  );
  const tables = tableRows.map((r) => r.table_name);

  // One row per foreign key. Optional when it can be left unenforced by an
  // empty column: under the default MATCH SIMPLE a multi-column key is not
  // checked if ANY of its columns is NULL (menu_items' (active_image_id, id)
  // key on menu_item_images); under MATCH FULL every column must be.
  const { rows: fkRows } = await db.query<{
    child: string;
    parent: string;
    optional: boolean;
    nullable_columns: string[] | null;
  }>(
    `select cl.relname as child,
            pcl.relname as parent,
            case when con.confmatchtype = 'f'
                 then bool_and(not att.attnotnull)
                 else bool_or(not att.attnotnull) end as optional,
            array_agg(att.attname::text order by att.attname)
              filter (where not att.attnotnull) as nullable_columns
       from pg_constraint con
       join pg_class cl on cl.oid = con.conrelid
       join pg_namespace ns on ns.oid = cl.relnamespace
       join pg_class pcl on pcl.oid = con.confrelid
       join pg_namespace pns on pns.oid = pcl.relnamespace
       join pg_attribute att
         on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
      where con.contype = 'f'
        and ns.nspname = 'public'
        and pns.nspname = 'public'
      group by con.oid, con.confmatchtype, cl.relname, pcl.relname;`,
  );

  const edges: ForeignKeyEdge[] = fkRows.map((r) => ({
    child: r.child,
    parent: r.parent,
    optional: r.optional,
    nullableColumns: r.nullable_columns ?? [],
  }));

  const result = orderTablesForRestore(tables, edges);
  return { ...result, deferred: await withCheckPartners(db, result.deferred) };
}

/**
 * A deferred column can be tied to others by a CHECK (menu_items:
 * `(active_image_id is null) = (image_source is null)`; restaurants: the
 * same for hero_video). Emptying it alone would break that check, so its
 * nullable partners are deferred with it and filled in by the same UPDATE.
 */
async function withCheckPartners(
  db: PGlite,
  deferred: DeferredColumns[],
): Promise<DeferredColumns[]> {
  const out: DeferredColumns[] = [];
  for (const { table, columns } of deferred) {
    const { rows } = await db.query<{ columns: string[] }>(
      `select array_agg(att.attname::text) as columns
         from pg_constraint con
         join pg_class cl on cl.oid = con.conrelid
         join pg_namespace ns on ns.oid = cl.relnamespace
         join pg_attribute att
           on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
        where con.contype = 'c'
          and ns.nspname = 'public'
          and cl.relname = $1
          and not att.attnotnull
        group by con.oid;`,
      [table],
    );
    const all = new Set(columns);
    for (const check of rows) {
      if (check.columns.some((c) => all.has(c))) {
        for (const c of check.columns) all.add(c);
      }
    }
    out.push({ table, columns: [...all].sort() });
  }
  return out;
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
