// @vitest-environment node
//
// menu_pairings() (20261122090000): the menu knowledge graph's "ordered
// together" edges. Counts of separate visits only, and only from 3 up.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  createCart,
  createCategory,
  createCustomerSession,
  createMenuItem,
  createRestaurant,
  createTable,
  submitOrder,
} from "./helpers";

describe("what guests order together", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function menu() {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const curry = await createMenuItem(db, restaurantId, categoryId);
    const naan = await createMenuItem(db, restaurantId, categoryId);
    const soda = await createMenuItem(db, restaurantId, categoryId);
    return { restaurantId, tableId, curry, naan, soda };
  }

  /** One diner's visit: each inner list is one order (a round). */
  async function visit(
    m: Awaited<ReturnType<typeof menu>>,
    rounds: string[][],
  ): Promise<string[]> {
    const { userId, sessionId } = await createCustomerSession(
      db,
      m.restaurantId,
      m.tableId,
    );
    const orderIds: string[] = [];
    for (const round of rounds) {
      const cartId = await createCart(db, m.restaurantId, sessionId);
      for (const item of round) {
        await addCartItem(db, userId, cartId, m.restaurantId, item);
      }
      orderIds.push((await submitOrder(db, userId, crypto.randomUUID())).id);
      await db.admin.query("delete from public.carts where id = $1;", [cartId]);
    }
    return orderIds;
  }

  const pairings = (restaurantId: string, asUser?: string) => {
    const run = (c: {
      query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }>;
    }) =>
      c.query<{
        menu_item_id: string;
        other_menu_item_id: string;
        visits: number;
      }>("select * from public.menu_pairings($1);", [restaurantId]);
    return (asUser ? db.asUser(asUser, run) : run(db.admin)).then(
      (r) => r.rows,
    );
  };

  it("counts separate visits, and only pairs seen in 3 or more", async () => {
    const m = await menu();
    for (let i = 0; i < 3; i++) await visit(m, [[m.curry, m.naan]]);
    for (let i = 0; i < 2; i++) await visit(m, [[m.curry, m.soda]]);

    const rows = await pairings(m.restaurantId);
    expect(rows).toEqual(
      expect.arrayContaining([
        { menu_item_id: m.curry, other_menu_item_id: m.naan, visits: 3 },
        { menu_item_id: m.naan, other_menu_item_id: m.curry, visits: 3 },
      ]),
    );
    expect(rows.some((r) => r.other_menu_item_id === m.soda)).toBe(false);
  });

  it("counts a visit once across its rounds, and ignores cancelled orders", async () => {
    const m = await menu();
    // Curry in one round, naan in the next: one visit, one pairing.
    for (let i = 0; i < 2; i++) await visit(m, [[m.curry], [m.naan]]);
    const [cancelled] = await visit(m, [[m.curry, m.naan]]);
    await db.admin.query(
      "update public.orders set status = 'cancelled' where id = $1;",
      [cancelled],
    );
    expect(await pairings(m.restaurantId)).toEqual([]);

    await visit(m, [[m.curry], [m.naan]]);
    expect(
      (await pairings(m.restaurantId)).find((r) => r.menu_item_id === m.curry),
    ).toEqual({ menu_item_id: m.curry, other_menu_item_id: m.naan, visits: 3 });
  });

  it("answers any signed-in diner with counts only, and nobody signed out", async () => {
    const m = await menu();
    for (let i = 0; i < 3; i++) await visit(m, [[m.curry, m.naan]]);
    const { userId } = await createCustomerSession(
      db,
      m.restaurantId,
      m.tableId,
    );

    const rows = await pairings(m.restaurantId, userId);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["menu_item_id", "other_menu_item_id", "visits"].sort(),
    );
    await expect(
      db.asAnon((c) =>
        c.query("select * from public.menu_pairings($1);", [m.restaurantId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
