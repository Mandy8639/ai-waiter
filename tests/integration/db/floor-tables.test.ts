// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCustomerSession,
  createRestaurant,
  createTable,
  fullOrderFixture,
  transitionOrderStatus,
} from "./helpers";

/**
 * floor_tables() and clear_floor_table(), against the real migration.
 *
 * What matters: staff see each table's facts (including guests they could
 * not otherwise see), nobody outside the restaurant sees anything, and
 * clearing a table hides its past without touching any order.
 */
describe("floor view", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  interface FloorRow {
    table_id: string;
    seated_since: string | null;
    open_requests: { id: string; kind: string }[];
    active_orders: number;
    active_status: string | null;
    ready_orders: number;
    served_orders: number;
    unpaid_orders: number;
    unpaid_total: string;
  }

  async function floor(userId: string, restaurantId: string) {
    return db.asUser(userId, async (c) => {
      const { rows } = await c.query<FloorRow>(
        "select * from public.floor_tables($1);",
        [restaurantId],
      );
      return rows;
    });
  }

  it("shows a submitted order as active, then ready, then served", async () => {
    const f = await fullOrderFixture(db, "owner");

    let row = (await floor(f.staffUserId, f.restaurantId)).find(
      (r) => r.table_id === f.tableId,
    )!;
    expect(row.active_orders).toBe(1);
    expect(row.active_status).toBe("pending");
    expect(row.unpaid_orders).toBe(1);

    await transitionOrderStatus(db, f.staffUserId, f.orderId, "confirmed");
    await transitionOrderStatus(db, f.staffUserId, f.orderId, "preparing");
    await transitionOrderStatus(db, f.staffUserId, f.orderId, "ready");
    row = (await floor(f.staffUserId, f.restaurantId)).find(
      (r) => r.table_id === f.tableId,
    )!;
    expect(row.active_orders).toBe(0);
    expect(row.ready_orders).toBe(1);

    await transitionOrderStatus(db, f.staffUserId, f.orderId, "served");
    row = (await floor(f.staffUserId, f.restaurantId)).find(
      (r) => r.table_id === f.tableId,
    )!;
    expect(row.ready_orders).toBe(0);
    expect(row.served_orders).toBe(1);
  });

  it("lets staff see a seated guest they cannot read directly", async () => {
    const restaurantId = await createRestaurant(db);
    const staff = await db.createAuthUser();
    await addMember(db, restaurantId, staff, "staff");
    const tableId = await createTable(db, restaurantId);
    await createCustomerSession(db, restaurantId, tableId);

    const direct = await db.asUser(staff, async (c) => {
      const { rows } = await c.query(
        "select id from public.customer_sessions where table_id = $1;",
        [tableId],
      );
      return rows;
    });
    expect(direct).toHaveLength(0);

    const row = (await floor(staff, restaurantId)).find(
      (r) => r.table_id === tableId,
    )!;
    expect(row.seated_since).not.toBeNull();
    expect(row.active_orders).toBe(0);
  });

  it("includes open requests and leaves out counters and inactive tables", async () => {
    const restaurantId = await createRestaurant(db);
    const staff = await db.createAuthUser();
    await addMember(db, restaurantId, staff, "staff");
    const tableId = await createTable(db, restaurantId);
    const inactive = await createTable(db, restaurantId);
    await db.admin.query(
      "update public.tables set is_active = false where id = $1;",
      [inactive],
    );
    const { userId } = await createCustomerSession(db, restaurantId, tableId);
    await db.asUser(userId, (c) =>
      c.query("select public.create_table_request('bill', null);"),
    );

    const rows = await floor(staff, restaurantId);
    expect(rows.map((r) => r.table_id)).toEqual([tableId]);
    expect(rows[0].open_requests.map((r) => r.kind)).toEqual(["bill"]);
  });

  it("returns nothing to people outside the restaurant", async () => {
    const f = await fullOrderFixture(db, "owner");
    const stranger = await db.createAuthUser();

    expect(await floor(stranger, f.restaurantId)).toHaveLength(0);
    await expect(
      db.asAnon((c) =>
        c.query("select * from public.floor_tables($1);", [f.restaurantId]),
      ),
    ).rejects.toThrow();
  });

  it("clearing a table hides its earlier visit and changes no order", async () => {
    const f = await fullOrderFixture(db, "staff");

    await db.asUser(f.staffUserId, (c) =>
      c.query("select public.clear_floor_table($1);", [f.tableId]),
    );

    const row = (await floor(f.staffUserId, f.restaurantId)).find(
      (r) => r.table_id === f.tableId,
    )!;
    expect(row.active_orders).toBe(0);
    expect(row.unpaid_orders).toBe(0);
    expect(row.seated_since).toBeNull();

    const { rows } = await db.admin.query<{ status: string }>(
      "select status from public.orders where id = $1;",
      [f.orderId],
    );
    expect(rows[0].status).toBe("pending");
  });

  it("refuses to clear another restaurant's table", async () => {
    const f = await fullOrderFixture(db, "owner");
    const other = await createRestaurant(db);
    const outsider = await db.createAuthUser();
    await addMember(db, other, outsider, "owner");

    await expect(
      db.asUser(outsider, (c) =>
        c.query("select public.clear_floor_table($1);", [f.tableId]),
      ),
    ).rejects.toThrow(/FLOOR_TABLE_FORBIDDEN/);
  });
});
