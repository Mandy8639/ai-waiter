// @vitest-environment node
//
// The backup exports exactly the table order computed here. On 2026-10-17
// it was found exporting 3 tables of the whole schema: a cycle
// (restaurants <-> restaurant_hero_videos) dropped every table depending
// on restaurants, with only a warning. So: every table, every time, and
// every foreign key satisfied by the order except nullable ones.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { introspectPublicTables } from "@/lib/backup/introspect";
import { createTestDb, type TestDb } from "./setup";

describe("backup table order against the real schema", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("includes every public table, with no unresolved cycle", async () => {
    const { order, unresolved } = await introspectPublicTables(db.admin);
    const { rows } = await db.admin.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE';`,
    );
    expect([...order].sort()).toEqual(rows.map((r) => r.table_name).sort());
    expect(unresolved).toEqual([]);
    expect(order).toContain("restaurants");
    expect(order).toContain("orders");
  });

  it("puts every parent before its child, except along keys that can be left empty", async () => {
    const { order } = await introspectPublicTables(db.admin);
    const position = new Map(order.map((t, i) => [t, i]));
    const { rows } = await db.admin.query<{
      child: string;
      parent: string;
      optional: boolean;
    }>(
      `select cl.relname as child, pcl.relname as parent,
              case when con.confmatchtype = 'f'
                   then bool_and(not att.attnotnull)
                   else bool_or(not att.attnotnull) end as optional
         from pg_constraint con
         join pg_class cl on cl.oid = con.conrelid
         join pg_namespace ns on ns.oid = cl.relnamespace
         join pg_class pcl on pcl.oid = con.confrelid
         join pg_namespace pns on pns.oid = pcl.relnamespace
         join pg_attribute att
           on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
        where con.contype = 'f' and ns.nspname = 'public'
          and pns.nspname = 'public'
        group by con.oid, con.confmatchtype, cl.relname, pcl.relname;`,
    );
    const violations = rows
      .filter((e) => e.child !== e.parent && !e.optional)
      .filter((e) => position.get(e.parent)! > position.get(e.child)!)
      .map((e) => `${e.child} -> ${e.parent}`);
    expect(violations).toEqual([]);
  });
});
