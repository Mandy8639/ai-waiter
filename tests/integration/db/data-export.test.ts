// @vitest-environment node
//
// The data export's table list (src/lib/export/export-core.ts) against the
// real schema, read the way the export reads it: as the restaurant's owner.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { fullOrderFixture } from "./helpers";
import { EXPORT_TABLES } from "@/lib/export/export-core";

describe("data export tables", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it.each(EXPORT_TABLES.map((t) => [t.table, t]))(
    "%s exists, is per restaurant, sorts by its order columns and has a members' read policy",
    async (_name, spec) => {
      const { rows: cols } = await db.admin.query<{ c: string }>(
        "select column_name c from information_schema.columns where table_schema = 'public' and table_name = $1;",
        [spec.table],
      );
      const columns = cols.map((c) => c.c);
      expect(columns).toContain("restaurant_id");
      for (const c of [...spec.orderBy, ...(spec.omit ?? [])]) {
        expect(columns).toContain(c);
      }
      const { rows: policies } = await db.admin.query(
        "select 1 from pg_policies where schemaname = 'public' and tablename = $1 and cmd in ('SELECT', 'ALL') and 'authenticated' = any(roles);",
        [spec.table],
      );
      expect(policies.length).toBeGreaterThan(0);
    },
  );

  it("gives the owner their own orders and nobody else's", async () => {
    const mine = await fullOrderFixture(db);
    const theirs = await fullOrderFixture(db);
    const { rows } = await db.asUser(mine.staffUserId, (c) =>
      c.query<{ id: string }>(
        "select id from public.orders where restaurant_id = $1 order by id;",
        [mine.restaurantId],
      ),
    );
    expect(rows.map((r) => r.id)).toEqual([mine.orderId]);
    const { rows: none } = await db.asUser(mine.staffUserId, (c) =>
      c.query("select id from public.orders where restaurant_id = $1;", [
        theirs.restaurantId,
      ]),
    );
    expect(none).toEqual([]);
  });
});
