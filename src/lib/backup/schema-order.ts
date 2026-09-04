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
 * A cycle between two different tables cannot be ordered either. Rather
 * than silently producing an order that will fail halfway through a
 * restore, the remaining tables are appended and reported, so the caller
 * can say so out loud.
 */
export function orderTablesForRestore(
  tables: string[],
  edges: ForeignKeyEdge[],
): { order: string[]; unresolved: string[] } {
  const remaining = new Set(tables);
  const realEdges = edges.filter(
    (e) =>
      e.child !== e.parent &&
      tables.includes(e.child) &&
      tables.includes(e.parent),
  );

  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((table) =>
        realEdges.every((e) => e.child !== table || !remaining.has(e.parent)),
      )
      .sort();

    if (ready.length === 0) break; // cycle — see the doc comment
    for (const table of ready) {
      order.push(table);
      remaining.delete(table);
    }
  }

  return { order, unresolved: [...remaining].sort() };
}
