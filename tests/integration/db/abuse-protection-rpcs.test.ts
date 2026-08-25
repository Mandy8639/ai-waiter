// @vitest-environment node
//
// Batch 8's two count-only abuse-protection RPCs (see
// supabase/migrations/20260826090000_abuse_protection_rpcs.sql) —
// count_recent_sessions_for_table() backs
// src/lib/customer/rate-limit.ts (session-creation throttling) and
// count_recent_orders_for_session() backs src/lib/orders/rate-limit.ts
// (order-submission throttling). Both are SECURITY DEFINER, so these tests
// verify they return correct counts, are scoped to exactly the argument
// given (never leak another table's/session's activity into the count),
// and are callable by the roles the application code actually uses them
// as (anon for session creation — it runs before any session exists;
// authenticated for order submission — a session always exists by then).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  createRestaurant,
  createTable,
  createCustomerSession,
  createCategory,
  createMenuItem,
  createCart,
  addCartItem,
  submitOrder,
} from "./helpers";

describe("count_recent_sessions_for_table()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("counts sessions created for exactly this table within the window", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    await createCustomerSession(db, restaurantId, tableId);
    await createCustomerSession(db, restaurantId, tableId);
    await createCustomerSession(db, restaurantId, tableId);

    const { rows } = await db.asAnon((c) =>
      c.query<{ count_recent_sessions_for_table: string }>(
        "select public.count_recent_sessions_for_table($1, $2);",
        [tableId, 300],
      ),
    );
    expect(Number(rows[0].count_recent_sessions_for_table)).toBe(3);
  });

  it("does not count a different table's sessions", async () => {
    const restaurantId = await createRestaurant(db);
    const tableA = await createTable(db, restaurantId);
    const tableB = await createTable(db, restaurantId);
    await createCustomerSession(db, restaurantId, tableA);
    await createCustomerSession(db, restaurantId, tableA);

    const { rows } = await db.asAnon((c) =>
      c.query<{ count_recent_sessions_for_table: string }>(
        "select public.count_recent_sessions_for_table($1, $2);",
        [tableB, 300],
      ),
    );
    expect(Number(rows[0].count_recent_sessions_for_table)).toBe(0);
  });

  it("is callable by anon — the QR route handler runs this before any session/identity exists", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);

    await expect(
      db.asAnon((c) =>
        c.query("select public.count_recent_sessions_for_table($1, $2);", [
          tableId,
          300,
        ]),
      ),
    ).resolves.toBeDefined();
  });

  it("respects the window — a session outside it is not counted", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    // Backdate started_at explicitly rather than using a 0-second window:
    // PGlite's now()/clock_timestamp() only has millisecond resolution (real
    // Postgres has microsecond resolution plus real network latency between
    // statements), so two back-to-back statements can land in the exact same
    // millisecond, making a 0-second window's >= boundary a coin flip here
    // even though it's never ambiguous in production.
    await db.admin.query(
      "update public.customer_sessions set started_at = now() - interval '1 hour' where id = $1;",
      [sessionId],
    );

    const { rows } = await db.asAnon((c) =>
      c.query<{ count_recent_sessions_for_table: string }>(
        "select public.count_recent_sessions_for_table($1, $2);",
        [tableId, 300],
      ),
    );
    expect(Number(rows[0].count_recent_sessions_for_table)).toBe(0);
  });
});

describe("count_recent_orders_for_session()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("counts orders submitted by exactly this session within the window", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    const cartId = await createCart(db, restaurantId, sessionId);
    await addCartItem(db, userId, cartId, restaurantId, menuItemId);
    await submitOrder(db, userId, "order-key-1");

    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ count_recent_orders_for_session: string }>(
        "select public.count_recent_orders_for_session($1, $2);",
        [sessionId, 600],
      ),
    );
    expect(Number(rows[0].count_recent_orders_for_session)).toBe(1);
  });

  it("a repeated idempotency key does not inflate the count (retries never look like new orders)", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    const cartId = await createCart(db, restaurantId, sessionId);
    await addCartItem(db, userId, cartId, restaurantId, menuItemId);
    await submitOrder(db, userId, "same-key");
    await submitOrder(db, userId, "same-key");
    await submitOrder(db, userId, "same-key");

    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ count_recent_orders_for_session: string }>(
        "select public.count_recent_orders_for_session($1, $2);",
        [sessionId, 600],
      ),
    );
    expect(Number(rows[0].count_recent_orders_for_session)).toBe(1);
  });

  it("does not count a different session's orders", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);

    const sessionA = await createCustomerSession(db, restaurantId, tableId);
    const cartA = await createCart(db, restaurantId, sessionA.sessionId);
    await addCartItem(db, sessionA.userId, cartA, restaurantId, menuItemId);
    await submitOrder(db, sessionA.userId, "a-key");

    const sessionB = await createCustomerSession(db, restaurantId, tableId);

    const { rows } = await db.asUser(sessionB.userId, (c) =>
      c.query<{ count_recent_orders_for_session: string }>(
        "select public.count_recent_orders_for_session($1, $2);",
        [sessionB.sessionId, 600],
      ),
    );
    expect(Number(rows[0].count_recent_orders_for_session)).toBe(0);
  });

  it("is not callable by anon (no session exists yet for an anon caller to check)", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );

    await expect(
      db.asAnon((c) =>
        c.query("select public.count_recent_orders_for_session($1, $2);", [
          sessionId,
          600,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
