// @vitest-environment node
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { fullCustomerFixture, addCartItem, submitOrder } from "./helpers";

/**
 * The seam a POS connector plugs into. What has to be true:
 *
 *   - an order and its outbound event are written together, or not at all
 *   - a restaurant with no integration writes nothing
 *   - one restaurant's events never reach another's
 *   - the same order can never be queued twice
 */
describe("POS integration seam", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function enablePos(restaurantId: string) {
    await db.admin.query(
      `insert into public.restaurant_pos_integrations
         (restaurant_id, provider, external_location_id, credentials_ref, is_enabled)
       values ($1, 'square', 'LOC-123', 'square/acme', true);`,
      [restaurantId],
    );
  }

  it("writes nothing for a restaurant with no POS integration", async () => {
    // Every restaurant on the platform inserts orders. Only the ones that
    // asked for an integration should pay for an outbox row.
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    await submitOrder(db, fx.userId, "pos-none-1");

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*) from public.pos_outbox where restaurant_id = $1;",
      [fx.restaurantId],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("writes nothing while the integration is configured but switched off", async () => {
    const fx = await fullCustomerFixture(db);
    await db.admin.query(
      `insert into public.restaurant_pos_integrations
         (restaurant_id, provider, external_location_id, is_enabled)
       values ($1, 'toast', 'GUID-9', false);`,
      [fx.restaurantId],
    );
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    await submitOrder(db, fx.userId, "pos-off-1");

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*) from public.pos_outbox where restaurant_id = $1;",
      [fx.restaurantId],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("queues exactly one event, in the order's own transaction", async () => {
    const fx = await fullCustomerFixture(db);
    await enablePos(fx.restaurantId);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "pos-on-1");

    const { rows } = await db.admin.query<{
      order_id: string;
      event_type: string;
      status: string;
      attempts: number;
    }>(
      "select order_id, event_type, status, attempts from public.pos_outbox where restaurant_id = $1;",
      [fx.restaurantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).toBe(order.id);
    expect(rows[0].event_type).toBe("order.created");
    expect(rows[0].status).toBe("pending");
    expect(Number(rows[0].attempts)).toBe(0);
  });

  it("cannot queue the same order twice", async () => {
    // The idempotency key. A retry storm, a double-fired trigger or a
    // worker that delivers then crashes before marking must not push the
    // same sale to the till twice.
    const fx = await fullCustomerFixture(db);
    await enablePos(fx.restaurantId);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "pos-dupe-1");

    await expect(
      db.admin.query(
        "insert into public.pos_outbox (restaurant_id, order_id, event_type) values ($1, $2, 'order.created');",
        [fx.restaurantId, order.id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("never queues one restaurant's order against another", async () => {
    const a = await fullCustomerFixture(db);
    const b = await fullCustomerFixture(db);
    await enablePos(a.restaurantId);
    await addCartItem(db, a.userId, a.cartId, a.restaurantId, a.menuItemId);
    await submitOrder(db, a.userId, "pos-tenant-1");

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*) from public.pos_outbox where restaurant_id = $1;",
      [b.restaurantId],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("refuses to enable an integration with nowhere to push to", async () => {
    // A half-configured integration that starts queueing work it can
    // never deliver is worse than one that does nothing.
    const fx = await fullCustomerFixture(db);
    await expect(
      db.admin.query(
        `insert into public.restaurant_pos_integrations
           (restaurant_id, provider, is_enabled) values ($1, 'clover', true);`,
        [fx.restaurantId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("keeps external ids unique per restaurant, not globally", async () => {
    // Two restaurants on the same POS vendor will collide on ids
    // otherwise — the single most likely way a naive mapping corrupts a
    // menu.
    const a = await fullCustomerFixture(db);
    const b = await fullCustomerFixture(db);

    await db.admin.query(
      "update public.menu_items set external_id = 'SQ-ITEM-1' where id = $1;",
      [a.menuItemId],
    );
    await db.admin.query(
      "update public.menu_items set external_id = 'SQ-ITEM-1' where id = $1;",
      [b.menuItemId],
    );

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*) from public.menu_items where external_id = 'SQ-ITEM-1';",
      [],
    );
    expect(Number(rows[0].count)).toBe(2);

    // ...but the same restaurant cannot use one id twice.
    const { rows: another } = await db.admin.query<{ id: string }>(
      `insert into public.menu_items (restaurant_id, category_id, name, slug, price)
       values ($1, $2, 'Second', 'second-dish', 5.00) returning id;`,
      [a.restaurantId, a.categoryId],
    );
    await expect(
      db.admin.query(
        "update public.menu_items set external_id = 'SQ-ITEM-1' where id = $1;",
        [another[0].id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
