/**
 * Works out which tables exist and what order they can safely be inserted
 * in, from the schema the migrations actually produce rather than from a
 * hand-maintained list that silently rots when a table is added.
 *
 * Pure apart from the queries it is handed, so it is unit-testable without
 * a database — same split as src/lib/payments/stripe-mode.ts.
 */

export interface ForeignKeyEdge {
  /** The table holding the foreign key. */
  child: string;
  /** The table it points at. */
  parent: string;
  /**
   * The key's columns can be NULL. A cycle that runs through such a key can
   * still be restored: rows go in with it empty, which is how they were
   * first written (e.g. restaurants.active_hero_video_id, set only after
   * the hero video row exists).
   */
  optional?: boolean;
  /** The key's columns that can be NULL (what a restore leaves empty). */
  nullableColumns?: string[];
}

/** Columns a restore inserts empty and fills in once every table is in. */
export interface DeferredColumns {
  table: string;
  columns: string[];
}

/**
 * Topological order: a table always appears after every table it
 * references, so a restore can insert straight through without deferring
 * constraints.
 *
 * Self-references (a table with an FK to itself, e.g. a parent_id) are
 * ignored for ordering — they can't be resolved by table order at all, and
 * are handled by inserting that table's rows in their own recorded order.
 *
 * A cycle between two different tables cannot be satisfied by table order
 * alone. When the walk gets stuck it first ignores optional (nullable) keys,
 * which breaks a cycle like restaurants <-> restaurant_hero_videos. If it is
 * still stuck, the rest are appended in name order and reported in
 * `unresolved`.
 *
 * Every table ALWAYS appears in `order`. The backup exports exactly
 * `order`, and before 2026-10-17 a cycle (restaurants <->
 * restaurant_hero_videos, 20260923090000) left everything that depends on
 * restaurants out of it: the backup held 3 tables of 60 and only warned.
 */
export function orderTablesForRestore(
  tables: string[],
  edges: ForeignKeyEdge[],
): { order: string[]; unresolved: string[]; deferred: DeferredColumns[] } {
  const remaining = new Set(tables);
  const realEdges = edges.filter(
    (e) =>
      e.child !== e.parent &&
      tables.includes(e.child) &&
      tables.includes(e.parent),
  );

  const readyUnder = (edgesInForce: ForeignKeyEdge[]) =>
    [...remaining]
      .filter((table) =>
        edgesInForce.every(
          (e) => e.child !== table || !remaining.has(e.parent),
        ),
      )
      .sort();

  const order: string[] = [];
  while (remaining.size > 0) {
    let ready = readyUnder(realEdges);
    if (ready.length === 0) {
      // Stuck on a cycle: a nullable key can be left empty on the way in.
      ready = readyUnder(realEdges.filter((e) => !e.optional));
    }
    if (ready.length === 0) break; // a cycle of required keys
    for (const table of ready) {
      order.push(table);
      remaining.delete(table);
    }
  }

  const unresolved = [...remaining].sort();
  const finalOrder = [...order, ...unresolved];

  // The optional keys the order broke: their parent is restored after the
  // child, so the child's rows go in with those columns empty.
  const position = new Map(finalOrder.map((t, i) => [t, i]));
  const deferredByTable = new Map<string, Set<string>>();
  for (const e of realEdges) {
    if (!e.optional || !e.nullableColumns?.length) continue;
    if (position.get(e.parent)! < position.get(e.child)!) continue;
    const set = deferredByTable.get(e.child) ?? new Set<string>();
    for (const column of e.nullableColumns) set.add(column);
    deferredByTable.set(e.child, set);
  }
  const deferred: DeferredColumns[] = [...deferredByTable.entries()]
    .map(([table, columns]) => ({ table, columns: [...columns].sort() }))
    .sort((a, b) => a.table.localeCompare(b.table));

  return { order: finalOrder, unresolved, deferred };
}
