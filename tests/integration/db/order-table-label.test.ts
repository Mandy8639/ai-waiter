// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCustomerSession,
  createRestaurant,
  fullOrderFixture,
} from "./helpers";

/**
 * get_order_table() exists because a diner's order page showed "—" where
 * the table belongs: getOrderById() read `tables` directly, and that
 * table's only SELECT policy is members-only.
 *
 * It runs SECURITY DEFINER, so RLS doesn't protect it. These tests check
 * that it repeats orders_select_own_or_staff exactly, answering only the
 * diner whose session placed the order or the restaurant's staff, and
 * that adding it didn't open `tables` itself to diners.
 */

type TableRow = { table_number: string; display_name: string | null };

describe("get_order_table()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  const callAs = (userId: string, orderId: string) =>
    db.asUser(userId, (c) =>
      c.query<TableRow>("select * from public.get_order_table($1);", [orderId]),
    );

  async function tableNumberOf(tableId: string): Promise<string> {
    const { rows } = await db.admin.query<{ table_number: string }>(
      "select table_number from public.tables where id = $1;",
      [tableId],
    );
    return rows[0].table_number;
  }

  it("returns the table to the diner who placed the order", async () => {
    const f = await fullOrderFixture(db);

    const { rows } = await callAs(f.customerUserId, f.orderId);

    expect(rows).toHaveLength(1);
    expect(rows[0].table_number).toBe(await tableNumberOf(f.tableId));
    expect(rows[0].display_name).toBeNull();
  });

  it("returns the display name when the table has one", async () => {
    const f = await fullOrderFixture(db);
    await db.admin.query(
      "update public.tables set display_name = 'Patio 2' where id = $1;",
      [f.tableId],
    );

    const { rows } = await callAs(f.customerUserId, f.orderId);

    expect(rows[0].display_name).toBe("Patio 2");
  });

  it("returns the table to the restaurant's staff", async () => {
    const f = await fullOrderFixture(db, "staff");

    const { rows } = await callAs(f.staffUserId, f.orderId);

    expect(rows).toHaveLength(1);
  });

  it("returns nothing to a different diner at the same restaurant", async () => {
    const f = await fullOrderFixture(db);
    const { userId: otherDiner } = await createCustomerSession(
      db,
      f.restaurantId,
      f.tableId,
    );

    const { rows } = await callAs(otherDiner, f.orderId);

    expect(rows).toHaveLength(0);
  });

  it("returns nothing to staff of a different restaurant", async () => {
    const f = await fullOrderFixture(db);
    const otherRestaurant = await createRestaurant(db);
    const otherOwner = await db.createAuthUser();
    await addMember(db, otherRestaurant, otherOwner, "owner");

    const { rows } = await callAs(otherOwner, f.orderId);

    expect(rows).toHaveLength(0);
  });

  it("can't be called without signing in", async () => {
    const f = await fullOrderFixture(db);

    await expect(
      db.asAnon((c) =>
        c.query("select * from public.get_order_table($1);", [f.orderId]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("does not let a diner read the tables table directly", async () => {
    const f = await fullOrderFixture(db);

    const { rows } = await db.asUser(f.customerUserId, (c) =>
      c.query("select * from public.tables where id = $1;", [f.tableId]),
    );

    expect(rows).toHaveLength(0);
  });
});
