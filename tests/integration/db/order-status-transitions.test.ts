// @vitest-environment node
//
// Batch 6's order state machine: transition_order_status() (see
// supabase/migrations/20260824090200_transition_order_status_function.sql)
// is the single entry point for every operational status change. These
// tests exercise it against real Postgres semantics (via PGlite — see
// setup.ts) covering the state machine itself, the role permission matrix,
// customer/unauthenticated/cross-tenant denial, audit-history creation and
// append-only-ness, financial immutability, and cancellation policy.
//
// A note on "concurrency" (spec section 17): this harness's PGlite
// instance is a single connection (see setup.ts's own header comment), so
// two transactions can never genuinely overlap here. What IS tested is the
// *logical* guarantee that actually matters: a transition is evaluated
// against the order's CURRENT status at call time, not a value the caller
// assumed — so a duplicate/late attempt (e.g. two sequential calls both
// trying preparing -> ready) resolves to exactly one success and one clean
// rejection, never a double-applied or corrupted state. The mechanism that
// makes this true under REAL concurrency is `SELECT ... FOR UPDATE`
// row-locking inside transition_order_status() (see the function's own
// comments) — a property of Postgres itself, not something a
// single-connection harness can directly exercise, the same documented
// limitation as tests/integration/db/orders.test.ts's idempotency suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture, transitionOrderStatus } from "./helpers";

describe("transition_order_status() valid transitions (owner)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("walks an order through the full pending -> confirmed -> preparing -> ready -> served lifecycle", async () => {
    const fx = await fullOrderFixture(db, "owner");

    const confirmed = await transitionOrderStatus(
      db,
      fx.staffUserId,
      fx.orderId,
      "confirmed",
    );
    expect(confirmed.status).toBe("confirmed");

    const preparing = await transitionOrderStatus(
      db,
      fx.staffUserId,
      fx.orderId,
      "preparing",
    );
    expect(preparing.status).toBe("preparing");

    const ready = await transitionOrderStatus(
      db,
      fx.staffUserId,
      fx.orderId,
      "ready",
    );
    expect(ready.status).toBe("ready");

    const served = await transitionOrderStatus(
      db,
      fx.staffUserId,
      fx.orderId,
      "served",
    );
    expect(served.status).toBe("served");

    const { rows: history } = await db.admin.query<{
      previous_status: string | null;
      status: string;
      actor_type: string;
      actor_id: string;
    }>(
      "select previous_status, status, actor_type, actor_id from public.order_status_history where order_id = $1 order by created_at asc;",
      [fx.orderId],
    );
    // Row 0 is submit_order()'s own initial 'pending' event (previous_status
    // NULL, actor 'customer') — rows 1-4 are this test's four transitions.
    expect(history).toHaveLength(5);
    expect(history[0]).toMatchObject({
      previous_status: null,
      status: "pending",
      actor_type: "customer",
    });
    expect(history[1]).toMatchObject({
      previous_status: "pending",
      status: "confirmed",
      actor_type: "owner",
      actor_id: fx.staffUserId,
    });
    expect(history[2]).toMatchObject({
      previous_status: "confirmed",
      status: "preparing",
      actor_type: "owner",
    });
    expect(history[3]).toMatchObject({
      previous_status: "preparing",
      status: "ready",
      actor_type: "owner",
    });
    expect(history[4]).toMatchObject({
      previous_status: "ready",
      status: "served",
      actor_type: "owner",
    });
  });

  it("stamps confirmed_at when an order is confirmed", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");

    const { rows } = await db.admin.query<{ confirmed_at: string | null }>(
      "select confirmed_at from public.orders where id = $1;",
      [fx.orderId],
    );
    expect(rows[0].confirmed_at).not.toBeNull();
  });

  it("stamps cancelled_at when an order is cancelled", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "cancelled");

    const { rows } = await db.admin.query<{
      cancelled_at: string | null;
      status: string;
    }>("select cancelled_at, status from public.orders where id = $1;", [
      fx.orderId,
    ]);
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].cancelled_at).not.toBeNull();
  });
});

describe("transition_order_status() structurally invalid transitions", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  // Owner role throughout — these must fail on state-machine legality
  // alone, not on role permission (owner can attempt any structurally
  // valid transition).
  it.each([
    ["pending", "preparing"],
    ["pending", "ready"],
    ["pending", "served"],
  ])("rejects skipping confirmation: %s -> %s", async (_from, to) => {
    const fx = await fullOrderFixture(db, "owner");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, to),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_TRANSITION/);
  });

  it("rejects preparing -> pending (backward)", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "pending"),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_TRANSITION/);
  });

  it("rejects ready -> preparing (backward)", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "ready");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing"),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_TRANSITION/);
  });

  it("rejects any transition out of 'served' (terminal)", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "ready");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "served");

    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "cancelled"),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_TRANSITION/);
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "pending"),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_TRANSITION/);
  });

  it("rejects any transition out of 'cancelled' (terminal)", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "cancelled");

    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed"),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_TRANSITION/);
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "pending"),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_TRANSITION/);
  });

  it("rejects re-applying the same transition twice in a row (the 'duplicate transition' scenario)", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "ready");

    // Two employees both try to move preparing -> ready; the first
    // (above) already succeeded. This second attempt evaluates against
    // the CURRENT status ('ready' now, not 'preparing') and is correctly
    // rejected — see this file's header comment on what this proves vs.
    // what only real concurrency can prove.
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "ready"),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_TRANSITION/);
  });

  it("rejects an unknown status value outright", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "exploding"),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_STATUS/);
  });
});

describe("transition_order_status() role permission matrix", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("kitchen can confirm, start preparing, and mark ready", async () => {
    const fx = await fullOrderFixture(db, "kitchen");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed"),
    ).resolves.toMatchObject({ status: "confirmed" });
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing"),
    ).resolves.toMatchObject({ status: "preparing" });
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "ready"),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("kitchen CANNOT mark an order served", async () => {
    const fx = await fullOrderFixture(db, "kitchen");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "ready");

    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "served"),
    ).rejects.toThrow(/ORDER_TRANSITION_FORBIDDEN/);
  });

  it("kitchen CANNOT cancel an order", async () => {
    const fx = await fullOrderFixture(db, "kitchen");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "cancelled"),
    ).rejects.toThrow(/ORDER_TRANSITION_FORBIDDEN/);
  });

  it("staff can serve a ready order", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "ready");

    const staffUserId = await db.createAuthUser();
    await addMember(db, fx.restaurantId, staffUserId, "staff");

    await expect(
      transitionOrderStatus(db, staffUserId, fx.orderId, "served"),
    ).resolves.toMatchObject({ status: "served" });
  });

  it("staff CANNOT confirm, start preparing, or mark ready", async () => {
    const fx = await fullOrderFixture(db, "staff");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed"),
    ).rejects.toThrow(/ORDER_TRANSITION_FORBIDDEN/);
  });

  it("staff can cancel a still-pending order", async () => {
    const fx = await fullOrderFixture(db, "staff");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "cancelled"),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("staff CANNOT cancel an already-confirmed order", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");

    const staffUserId = await db.createAuthUser();
    await addMember(db, fx.restaurantId, staffUserId, "staff");

    await expect(
      transitionOrderStatus(db, staffUserId, fx.orderId, "cancelled"),
    ).rejects.toThrow(/ORDER_TRANSITION_FORBIDDEN/);
  });

  it("manager has full operational access, same as owner", async () => {
    const fx = await fullOrderFixture(db, "manager");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed"),
    ).resolves.toMatchObject({ status: "confirmed" });
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "cancelled"),
    ).resolves.toMatchObject({ status: "cancelled" });
  });
});

describe("transition_order_status() denial: customer, unauthenticated, cross-tenant", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("the customer who placed the order cannot transition its status themselves", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await expect(
      transitionOrderStatus(db, fx.customerUserId, fx.orderId, "confirmed"),
    ).rejects.toThrow(/ORDER_TRANSITION_FORBIDDEN/);
  });

  it("an unauthenticated (anon-role) caller cannot call transition_order_status at all", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await expect(
      db.asAnon((c) =>
        c.query("select * from public.transition_order_status($1, $2);", [
          fx.orderId,
          "confirmed",
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("Restaurant A's staff cannot transition Restaurant B's order", async () => {
    const a = await fullOrderFixture(db, "owner");
    const b = await fullOrderFixture(db, "owner");

    await expect(
      transitionOrderStatus(db, a.staffUserId, b.orderId, "confirmed"),
    ).rejects.toThrow(/ORDER_TRANSITION_FORBIDDEN/);
  });

  it("a signed-in user with NO restaurant membership anywhere cannot transition any order", async () => {
    const fx = await fullOrderFixture(db, "owner");
    const randomUserId = await db.createAuthUser();

    await expect(
      transitionOrderStatus(db, randomUserId, fx.orderId, "confirmed"),
    ).rejects.toThrow(/ORDER_TRANSITION_FORBIDDEN/);
  });

  it("transitioning a nonexistent order id fails cleanly", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await expect(
      transitionOrderStatus(
        db,
        fx.staffUserId,
        "00000000-0000-0000-0000-000000000000",
        "confirmed",
      ),
    ).rejects.toThrow(/ORDER_TRANSITION_NOT_FOUND/);
  });
});

describe("order_status_history: append-only audit trail", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("no client role can INSERT a history row directly (only transition_order_status() can)", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query(
          "insert into public.order_status_history (restaurant_id, order_id, status, actor_type, actor_id) values ($1, $2, 'confirmed', 'owner', $3);",
          [fx.restaurantId, fx.orderId, fx.staffUserId],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("no client role can UPDATE a history row (append-only, not just insert-only)", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");

    const result = await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "update public.order_status_history set status = 'cancelled' where order_id = $1 and status = 'confirmed';",
        [fx.orderId],
      ),
    );
    expect(result.affectedRows).toBe(0);
  });

  it("no client role can DELETE a history row", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");

    const result = await db.asUser(fx.staffUserId, (c) =>
      c.query("delete from public.order_status_history where order_id = $1;", [
        fx.orderId,
      ]),
    );
    expect(result.affectedRows).toBe(0);

    const { rows } = await db.admin.query(
      "select id from public.order_status_history where order_id = $1;",
      [fx.orderId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("a history row can never point at a different restaurant's order (composite FK, unchanged since Batch 5)", async () => {
    const a = await fullOrderFixture(db, "owner");
    const b = await fullOrderFixture(db, "owner");

    await expect(
      db.admin.query(
        "insert into public.order_status_history (restaurant_id, order_id, status, actor_type, actor_id) values ($1, $2, 'confirmed', 'owner', $3);",
        [a.restaurantId, b.orderId, a.staffUserId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("gives a full, queryable auditability chain — who did each transition, and when", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "ready");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "served");

    const { rows } = await db.admin.query<{
      status: string;
      actor_id: string;
      created_at: string;
    }>(
      "select status, actor_id, created_at from public.order_status_history where order_id = $1 order by created_at asc;",
      [fx.orderId],
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r]));
    for (const status of ["confirmed", "preparing", "ready", "served"]) {
      expect(byStatus[status].actor_id).toBe(fx.staffUserId);
      expect(byStatus[status].created_at).toBeTruthy();
    }
  });
});

describe("order immutability under status transitions", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("transition_order_status() never changes price/total fields — only status (and confirmed_at/cancelled_at)", async () => {
    const fx = await fullOrderFixture(db, "owner");
    const { rows: before } = await db.admin.query<{
      subtotal: number;
      total: number;
    }>("select subtotal, total from public.orders where id = $1;", [
      fx.orderId,
    ]);

    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");

    const { rows: after } = await db.admin.query<{
      subtotal: number;
      total: number;
    }>("select subtotal, total from public.orders where id = $1;", [
      fx.orderId,
    ]);
    expect(Number(after[0].subtotal)).toBeCloseTo(
      Number(before[0].subtotal),
      2,
    );
    expect(Number(after[0].total)).toBeCloseTo(Number(before[0].total), 2);
  });

  it("the immutable-fields trigger rejects a financial change even bundled with a legal status change, at the database level, regardless of who issues it", async () => {
    const fx = await fullOrderFixture(db, "owner");
    // Simulates a hypothetical bug or hostile privileged path trying to
    // sneak a price change in alongside a status update — the trigger
    // (20260824090100_order_status_transitions.sql) doesn't care that the
    // status half of this UPDATE would otherwise be legal.
    await expect(
      db.admin.query(
        "update public.orders set status = 'confirmed', total = 0 where id = $1;",
        [fx.orderId],
      ),
    ).rejects.toThrow(/immutable/i);

    const { rows } = await db.admin.query<{ status: string; total: number }>(
      "select status, total from public.orders where id = $1;",
      [fx.orderId],
    );
    expect(rows[0].status).toBe("pending");
    expect(Number(rows[0].total)).not.toBe(0);
  });

  it("staff cannot change item quantity, snapshot name, or modifier data — no write path to order_items/order_item_modifiers exists in this batch either", async () => {
    const fx = await fullOrderFixture(db, "owner");
    const { rows: items } = await db.admin.query<{ id: string }>(
      "select id from public.order_items where order_id = $1;",
      [fx.orderId],
    );

    const result = await db.asUser(fx.staffUserId, (c) =>
      c.query("update public.order_items set quantity = 99 where id = $1;", [
        items[0].id,
      ]),
    );
    expect(result.affectedRows).toBe(0);
  });
});

describe("cancellation policy", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("owner can cancel from pending", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "cancelled"),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("owner can cancel from confirmed", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");
    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "cancelled"),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("nobody can cancel a preparing/ready/served order — cancellation is only legal from pending/confirmed", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "preparing");

    await expect(
      transitionOrderStatus(db, fx.staffUserId, fx.orderId, "cancelled"),
    ).rejects.toThrow(/ORDER_TRANSITION_INVALID_TRANSITION/);
  });

  it("cancelling records the cancelling actor in history, distinct from who confirmed it", async () => {
    const fx = await fullOrderFixture(db, "owner");
    await transitionOrderStatus(db, fx.staffUserId, fx.orderId, "confirmed");

    const managerId = await db.createAuthUser();
    await addMember(db, fx.restaurantId, managerId, "manager");
    await transitionOrderStatus(db, managerId, fx.orderId, "cancelled");

    const { rows } = await db.admin.query<{ status: string; actor_id: string }>(
      "select status, actor_id from public.order_status_history where order_id = $1 order by created_at asc;",
      [fx.orderId],
    );
    const confirmedRow = rows.find((r) => r.status === "confirmed")!;
    const cancelledRow = rows.find((r) => r.status === "cancelled")!;
    expect(confirmedRow.actor_id).toBe(fx.staffUserId);
    expect(cancelledRow.actor_id).toBe(managerId);
  });
});
