// @vitest-environment node
//
// "Keep ringing until accepted" (20261012090000_order_ring.sql): which
// orders claim_order_rings() picks for a repeat alert, and when they stop.
// Time is moved by back-dating rows instead of waiting.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { fullOrderFixture, transitionOrderStatus } from "./helpers";

describe("order ring", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  /** An order that was pushed about `secondsAgo` seconds ago and is still pending. */
  async function alertedOrder(secondsAgo: number) {
    const fixture = await fullOrderFixture(db);
    await db.admin.query(
      `update public.orders set created_at = now() - make_interval(secs => $2) where id = $1;`,
      [fixture.orderId, secondsAgo],
    );
    await db.admin.query(
      `insert into public.push_dispatches (restaurant_id, kind, source_id, created_at)
       values ($1, 'order', $2, now() - make_interval(secs => $3));`,
      [fixture.restaurantId, fixture.orderId, secondsAgo],
    );
    return fixture;
  }

  async function claim() {
    const { rows } = await db.asServiceRole((c) =>
      c.query<{ order_id: string; ring_count: number }>(
        "select * from public.claim_order_rings(30, 10);",
      ),
    );
    return rows;
  }

  async function due() {
    const { rows } = await db.asServiceRole((c) =>
      c.query<{ due: boolean }>(
        "select public.order_rings_due(30, 10) as due;",
      ),
    );
    return rows[0].due;
  }

  async function lastRingSecondsAgo(orderId: string, seconds: number) {
    await db.admin.query(
      `update public.push_dispatches set last_ring_at = now() - make_interval(secs => $2)
       where kind = 'order' and source_id = $1;`,
      [orderId, seconds],
    );
  }

  it("rings an order still waiting 30 seconds after its alert, once per round", async () => {
    const { orderId } = await alertedOrder(40);
    expect(await due()).toBe(true);

    const first = await claim();
    expect(first).toContainEqual({ order_id: orderId, ring_count: 1 });

    // Claimed and stamped: an overlapping call in the same round gets nothing.
    expect((await claim()).map((r) => r.order_id)).not.toContain(orderId);

    // Thirty seconds later it rings again.
    await lastRingSecondsAgo(orderId, 31);
    expect(await claim()).toContainEqual({ order_id: orderId, ring_count: 2 });
  });

  it("waits the interval after the first alert", async () => {
    const { orderId } = await alertedOrder(10);
    expect((await claim()).map((r) => r.order_id)).not.toContain(orderId);
  });

  it("stops the moment the kitchen confirms or cancels", async () => {
    for (const target of ["confirmed", "cancelled"]) {
      const { orderId, staffUserId } = await alertedOrder(40);
      await transitionOrderStatus(db, staffUserId, orderId, target);
      expect(
        (await claim()).map((r) => r.order_id),
        target,
      ).not.toContain(orderId);
    }
  });

  it("gives up after ten minutes, leaving the board to show it", async () => {
    const { orderId } = await alertedOrder(11 * 60);
    expect((await claim()).map((r) => r.order_id)).not.toContain(orderId);
  });

  it("never rings an order that was never alerted (no push set up)", async () => {
    const { orderId } = await fullOrderFixture(db);
    await db.admin.query(
      `update public.orders set created_at = now() - interval '40 seconds' where id = $1;`,
      [orderId],
    );
    expect((await claim()).map((r) => r.order_id)).not.toContain(orderId);
  });

  it("reports nothing due when every waiting order has just rung", async () => {
    // Drain anything earlier tests left due (rings and stops), then check
    // the quiet state.
    await claim();
    await claimHandled();
    expect(await due()).toBe(false);
  });

  async function claimHandled() {
    const { rows } = await db.asServiceRole((c) =>
      c.query<{ order_id: string; restaurant_id: string }>(
        "select * from public.claim_orders_handled(60);",
      ),
    );
    return rows;
  }

  it("tells the phones to stop once an alerted order stops waiting, once", async () => {
    const { orderId, restaurantId, staffUserId } = await alertedOrder(40);
    // Still waiting: nothing to stop.
    expect((await claimHandled()).map((r) => r.order_id)).not.toContain(
      orderId,
    );

    await transitionOrderStatus(db, staffUserId, orderId, "confirmed");
    expect(await due()).toBe(true); // the scheduler wakes for the stop
    expect(await claimHandled()).toContainEqual({
      order_id: orderId,
      restaurant_id: restaurantId,
    });
    // Stamped: never sent twice.
    expect((await claimHandled()).map((r) => r.order_id)).not.toContain(
      orderId,
    );
  });

  it("can be called only by the service role", async () => {
    const user = await db.createAuthUser();
    for (const sql of [
      "select * from public.claim_order_rings(30, 10);",
      "select public.order_rings_due(30, 10);",
      "select * from public.claim_orders_handled(60);",
    ]) {
      await expect(
        db.asAnon((c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.asUser(user, (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });
});
