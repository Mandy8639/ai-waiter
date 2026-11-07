// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  addMember,
  createCart,
  createCategory,
  createCustomerSession,
  createMenuItem,
  createRestaurant,
  createTable,
} from "./helpers";

/**
 * Ordering together (20261129090000), against the real migration.
 *
 * The claims worth testing are the ones that would leak or double up:
 * only guests at the same table can join; nobody edits another member's
 * lines; sending makes exactly one order, even when two phones tap at
 * once; submit_order()'s own rules still apply; and the group's members,
 * and nobody else, can see the order.
 */
describe("table groups", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function table() {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);
    return { restaurantId, tableId, menuItemId };
  }

  async function guest(t: { restaurantId: string; tableId: string }) {
    const { userId, sessionId } = await createCustomerSession(
      db,
      t.restaurantId,
      t.tableId,
    );
    const cartId = await createCart(db, t.restaurantId, sessionId);
    return { userId, sessionId, cartId };
  }

  const call = <T>(userId: string, sql: string, params: unknown[] = []) =>
    db.asUser(userId, async (c) => (await c.query<T>(sql, params)).rows);

  async function start(userId: string, name: string | null = null) {
    const rows = await call<{ id: string }>(
      userId,
      "select public.start_table_group($1) as id;",
      [name],
    );
    return rows[0].id;
  }

  async function join(
    userId: string,
    groupId: string,
    name: string | null = null,
  ) {
    return call<{ id: string }>(
      userId,
      "select public.join_table_group($1, $2) as id;",
      [groupId, name],
    );
  }

  async function state(userId: string) {
    const rows = await call<{
      s: {
        kind: string;
        group_id?: string;
        members?: { name: string | null; is_me: boolean }[];
      };
    }>(userId, "select public.table_group_state() as s;");
    return rows[0].s;
  }

  async function groupCart(userId: string) {
    return call<{
      cart_item_id: string;
      is_mine: boolean;
      member_position: number;
    }>(userId, "select * from public.table_group_cart();");
  }

  async function send(userId: string, key: string) {
    const rows = await call<{
      id: string;
      table_group_id: string;
      subtotal: string;
    }>(userId, "select * from public.submit_table_group_order($1, null);", [
      key,
    ]);
    return rows[0];
  }

  it("offers the group to someone at the same table, and they join", async () => {
    const t = await table();
    const sam = await guest(t);
    const priya = await guest(t);

    expect((await state(priya.userId)).kind).toBe("none");
    const groupId = await start(sam.userId, "  Sam  ");

    const offered = await state(priya.userId);
    expect(offered.kind).toBe("can_join");
    expect(offered.group_id).toBe(groupId);
    expect(offered.members?.map((m) => m.name)).toEqual(["Sam"]);

    await join(priya.userId, groupId, "Priya");
    const joined = await state(priya.userId);
    expect(joined.kind).toBe("member");
    expect(joined.members?.map((m) => [m.name, m.is_me])).toEqual([
      ["Sam", false],
      ["Priya", true],
    ]);
  });

  it("won't let a guest at another table join or even see the group", async () => {
    const t = await table();
    const sam = await guest(t);
    const groupId = await start(sam.userId);

    const otherTable = await createTable(db, t.restaurantId);
    const stranger = await guest({
      restaurantId: t.restaurantId,
      tableId: otherTable,
    });

    expect((await state(stranger.userId)).kind).toBe("none");
    await expect(join(stranger.userId, groupId)).rejects.toThrow(
      /TABLE_GROUP_NOT_FOUND/,
    );
  });

  it("refuses a second group at a table that already has one", async () => {
    const t = await table();
    const sam = await guest(t);
    const priya = await guest(t);
    await start(sam.userId);
    await expect(start(priya.userId)).rejects.toThrow(/TABLE_GROUP_EXISTS/);
  });

  it("shows members everyone's lines but lets each edit only their own", async () => {
    const t = await table();
    const sam = await guest(t);
    const priya = await guest(t);
    const groupId = await start(sam.userId);
    await join(priya.userId, groupId);

    const samLine = await addCartItem(
      db,
      sam.userId,
      sam.cartId,
      t.restaurantId,
      t.menuItemId,
    );
    await addCartItem(
      db,
      priya.userId,
      priya.cartId,
      t.restaurantId,
      t.menuItemId,
      { quantity: 2 },
    );

    const seenByPriya = await groupCart(priya.userId);
    expect(seenByPriya).toHaveLength(2);
    expect(seenByPriya.find((l) => l.cart_item_id === samLine)?.is_mine).toBe(
      false,
    );

    // Priya can't change or delete Sam's line: RLS hides it from her.
    await call(
      priya.userId,
      "update public.cart_items set quantity = 9 where id = $1;",
      [samLine],
    );
    await call(priya.userId, "delete from public.cart_items where id = $1;", [
      samLine,
    ]);
    const { rows } = await db.admin.query<{ quantity: number }>(
      "select quantity from public.cart_items where id = $1;",
      [samLine],
    );
    expect(rows[0].quantity).toBe(1);

    // A guest outside the group sees nothing.
    const outsider = await guest(t);
    expect(await groupCart(outsider.userId)).toHaveLength(0);
  });

  it("sends everyone's lines as one order that every member can see", async () => {
    const t = await table();
    const sam = await guest(t);
    const priya = await guest(t);
    const groupId = await start(sam.userId);
    await join(priya.userId, groupId);
    await addCartItem(db, sam.userId, sam.cartId, t.restaurantId, t.menuItemId);
    await addCartItem(
      db,
      priya.userId,
      priya.cartId,
      t.restaurantId,
      t.menuItemId,
      { quantity: 2 },
    );

    const order = await send(priya.userId, "group-send-1");
    expect(order.table_group_id).toBe(groupId);
    expect(Number(order.subtotal)).toBeCloseTo(9.99 * 3, 2);

    const items = await db.admin.query<{ quantity: number }>(
      "select quantity from public.order_items where order_id = $1 order by quantity;",
      [order.id],
    );
    expect(items.rows.map((r) => r.quantity)).toEqual([1, 2]);

    // Both carts are empty now.
    const left = await db.admin.query(
      "select 1 from public.cart_items where cart_id in ($1, $2);",
      [sam.cartId, priya.cartId],
    );
    expect(left.rows).toHaveLength(0);

    // Sam didn't send it but sees it, its lines, and its table.
    const samSees = await call<{ id: string }>(
      sam.userId,
      "select id from public.orders where id = $1;",
      [order.id],
    );
    expect(samSees).toHaveLength(1);
    const samItems = await call(
      sam.userId,
      "select id from public.order_items where order_id = $1;",
      [order.id],
    );
    expect(samItems).toHaveLength(2);
    const label = await call(
      sam.userId,
      "select * from public.get_order_table($1);",
      [order.id],
    );
    expect(label).toHaveLength(1);

    // Someone else at the table who never joined does not.
    const outsider = await guest(t);
    expect(
      await call(
        outsider.userId,
        "select id from public.orders where id = $1;",
        [order.id],
      ),
    ).toHaveLength(0);
    expect(
      await call(outsider.userId, "select * from public.get_order_table($1);", [
        order.id,
      ]),
    ).toHaveLength(0);
  });

  it("returns the same order on a retry and to a second phone sending just after", async () => {
    const t = await table();
    const sam = await guest(t);
    const priya = await guest(t);
    const groupId = await start(sam.userId);
    await join(priya.userId, groupId);
    await addCartItem(db, sam.userId, sam.cartId, t.restaurantId, t.menuItemId);

    const first = await send(sam.userId, "same-key");
    const retry = await send(sam.userId, "same-key");
    expect(retry.id).toBe(first.id);

    const secondPhone = await send(priya.userId, "priyas-own-key");
    expect(secondPhone.id).toBe(first.id);

    const { rows } = await db.admin.query(
      "select id from public.orders where table_group_id = $1;",
      [groupId],
    );
    expect(rows).toHaveLength(1);
  });

  it("keeps submit_order's rules: a sold-out dish stops the send and nothing moves", async () => {
    const t = await table();
    const sam = await guest(t);
    const priya = await guest(t);
    const groupId = await start(sam.userId);
    await join(priya.userId, groupId);
    const categoryId = await createCategory(db, t.restaurantId);
    const soldOut = await createMenuItem(db, t.restaurantId, categoryId);
    await addCartItem(db, sam.userId, sam.cartId, t.restaurantId, t.menuItemId);
    const priyaLine = await addCartItem(
      db,
      priya.userId,
      priya.cartId,
      t.restaurantId,
      soldOut,
    );
    await db.admin.query(
      "update public.menu_items set is_available = false where id = $1;",
      [soldOut],
    );

    await expect(send(sam.userId, "blocked")).rejects.toThrow(/ORDER_/);

    const { rows } = await db.admin.query<{ cart_id: string }>(
      "select cart_id from public.cart_items where id = $1;",
      [priyaLine],
    );
    expect(rows[0].cart_id).toBe(priya.cartId);
  });

  it("ends the group when the table is cleared on the Floor view", async () => {
    const t = await table();
    const staff = await db.createAuthUser();
    await addMember(db, t.restaurantId, staff, "staff");
    const sam = await guest(t);
    const priya = await guest(t);
    await start(sam.userId);

    await call(staff, "select public.clear_floor_table($1);", [t.tableId]);

    expect((await state(priya.userId)).kind).toBe("none");
    expect((await state(sam.userId)).kind).toBe("none");
    // And the next party can start their own.
    await start(priya.userId);
  });

  it("lets a member leave, keeping their own cart", async () => {
    const t = await table();
    const sam = await guest(t);
    const priya = await guest(t);
    const groupId = await start(sam.userId);
    await join(priya.userId, groupId);
    const line = await addCartItem(
      db,
      priya.userId,
      priya.cartId,
      t.restaurantId,
      t.menuItemId,
    );

    await call(priya.userId, "select public.leave_table_group();");

    expect((await state(priya.userId)).kind).toBe("can_join");
    expect(await groupCart(sam.userId)).toHaveLength(0);
    const { rows } = await db.admin.query(
      "select 1 from public.cart_items where id = $1;",
      [line],
    );
    expect(rows).toHaveLength(1);
  });

  it("isn't available at a pickup counter, and anon can't call it", async () => {
    const restaurantId = await createRestaurant(db);
    const { rows } = await db.admin.query<{ id: string }>(
      "insert into public.tables (restaurant_id, table_number, kind) values ($1, 'P1', 'counter') returning id;",
      [restaurantId],
    );
    const counterGuest = await guest({ restaurantId, tableId: rows[0].id });
    expect((await state(counterGuest.userId)).kind).toBe("not_a_table");
    await expect(start(counterGuest.userId)).rejects.toThrow(
      /TABLE_GROUP_NOT_AT_TABLE/,
    );

    await expect(
      db.asAnon((c) => c.query("select public.table_group_state();")),
    ).rejects.toThrow();
  });
});
