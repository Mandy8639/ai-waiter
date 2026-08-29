// @vitest-environment node
//
// Kitchen order splitting/merging (see
// supabase/migrations/20260829100000_order_ticket_groups.sql):
// split_order_into_tickets(), merge_orders_into_ticket(),
// transition_ticket_group_status(), and the order-status derivation
// (recompute_order_status_from_groups()) it drives. Pricing/totals/order
// numbers are never touched by any of this — deliberately not re-tested
// here, since order-submission tests already cover them and nothing in
// this migration writes to those columns at all.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCart,
  createCategory,
  createCustomerSession,
  createMenuItem,
  createRestaurant,
  createTable,
  addCartItem,
  submitOrder,
  transitionOrderStatus,
  type Role,
} from "./helpers";

/** An order with exactly two items (needed for a valid 2-group split), plus one staff member of the given role. */
async function twoItemOrderFixture(db: TestDb, staffRole: Role = "owner") {
  const restaurantId = await createRestaurant(db);
  const staffUserId = await db.createAuthUser();
  await addMember(db, restaurantId, staffUserId, staffRole);
  const tableId = await createTable(db, restaurantId);
  const categoryId = await createCategory(db, restaurantId);
  const appetizerId = await createMenuItem(db, restaurantId, categoryId, {
    name: "Samosa",
  });
  const mainId = await createMenuItem(db, restaurantId, categoryId, {
    name: "Paneer Tikka",
  });
  const { userId: customerUserId, sessionId } = await createCustomerSession(
    db,
    restaurantId,
    tableId,
  );
  const cartId = await createCart(db, restaurantId, sessionId);
  await addCartItem(db, customerUserId, cartId, restaurantId, appetizerId);
  await addCartItem(db, customerUserId, cartId, restaurantId, mainId);
  const order = await submitOrder(db, customerUserId, `order-${sessionId}`);

  const { rows: items } = await db.admin.query<{
    id: string;
    item_name: string;
  }>(
    "select id, item_name from public.order_items where order_id = $1 order by created_at asc;",
    [order.id],
  );

  return {
    restaurantId,
    staffUserId,
    tableId,
    customerUserId,
    orderId: order.id,
    appetizerItemId: items.find((i) => i.item_name === "Samosa")!.id,
    mainItemId: items.find((i) => i.item_name === "Paneer Tikka")!.id,
  };
}

async function getOrderStatus(db: TestDb, orderId: string): Promise<string> {
  const { rows } = await db.admin.query<{ status: string }>(
    "select status from public.orders where id = $1;",
    [orderId],
  );
  return rows[0].status;
}

describe("split_order_into_tickets()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("splits an order's two items into two labeled groups", async () => {
    const fx = await twoItemOrderFixture(db, "owner");

    const { rows: groups } = await db.asUser(fx.staffUserId, (c) =>
      c.query<{ id: string; label: string; status: string }>(
        "select * from public.split_order_into_tickets($1, $2::jsonb);",
        [
          fx.orderId,
          JSON.stringify([
            { label: "Appetizers", item_ids: [fx.appetizerItemId] },
            { label: "Mains", item_ids: [fx.mainItemId] },
          ]),
        ],
      ),
    );

    expect(groups.length).toBe(2);
    const labels = groups.map((g) => g.label).sort();
    expect(labels).toEqual(["Appetizers", "Mains"]);
    expect(groups.every((g) => g.status === "pending")).toBe(true);

    const { rows: items } = await db.admin.query<{
      id: string;
      ticket_group_id: string;
    }>(
      "select id, ticket_group_id from public.order_items where order_id = $1;",
      [fx.orderId],
    );
    expect(items.every((i) => i.ticket_group_id !== null)).toBe(true);
  });

  it("rejects a split that doesn't cover every item", async () => {
    const fx = await twoItemOrderFixture(db, "owner");

    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query(
          "select * from public.split_order_into_tickets($1, $2::jsonb);",
          [
            fx.orderId,
            JSON.stringify([
              { label: "Appetizers", item_ids: [fx.appetizerItemId] },
              { label: "Mains", item_ids: [] },
            ]),
          ],
        ),
      ),
    ).rejects.toThrow(/TICKET_SPLIT_INCOMPLETE_COVERAGE/);
  });

  it("rejects a split naming an item from a different order", async () => {
    const fx = await twoItemOrderFixture(db, "owner");
    const other = await twoItemOrderFixture(db, "owner");

    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query(
          "select * from public.split_order_into_tickets($1, $2::jsonb);",
          [
            fx.orderId,
            JSON.stringify([
              { label: "A", item_ids: [fx.appetizerItemId] },
              { label: "B", item_ids: [other.appetizerItemId] },
            ]),
          ],
        ),
      ),
    ).rejects.toThrow(/TICKET_SPLIT_ITEM_NOT_IN_ORDER/);
  });

  it("rejects fewer than two groups", async () => {
    const fx = await twoItemOrderFixture(db, "owner");

    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query(
          "select * from public.split_order_into_tickets($1, $2::jsonb);",
          [
            fx.orderId,
            JSON.stringify([
              {
                label: "Everything",
                item_ids: [fx.appetizerItemId, fx.mainItemId],
              },
            ]),
          ],
        ),
      ),
    ).rejects.toThrow(/TICKET_SPLIT_NEEDS_TWO_GROUPS/);
  });

  it("rejects splitting an already-served order", async () => {
    const fx = await twoItemOrderFixture(db, "owner");
    for (const status of ["confirmed", "preparing", "ready", "served"]) {
      await transitionOrderStatus(db, fx.staffUserId, fx.orderId, status);
    }

    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query(
          "select * from public.split_order_into_tickets($1, $2::jsonb);",
          [
            fx.orderId,
            JSON.stringify([
              { label: "A", item_ids: [fx.appetizerItemId] },
              { label: "B", item_ids: [fx.mainItemId] },
            ]),
          ],
        ),
      ),
    ).rejects.toThrow(/TICKET_SPLIT_ORDER_FINALIZED/);
  });

  it("rejects a caller with no membership, or a customer session", async () => {
    const fx = await twoItemOrderFixture(db, "owner");
    const outsiderId = await db.createAuthUser();

    await expect(
      db.asUser(outsiderId, (c) =>
        c.query(
          "select * from public.split_order_into_tickets($1, $2::jsonb);",
          [
            fx.orderId,
            JSON.stringify([
              { label: "A", item_ids: [fx.appetizerItemId] },
              { label: "B", item_ids: [fx.mainItemId] },
            ]),
          ],
        ),
      ),
    ).rejects.toThrow(/TICKET_SPLIT_FORBIDDEN/);

    await expect(
      db.asUser(fx.customerUserId, (c) =>
        c.query(
          "select * from public.split_order_into_tickets($1, $2::jsonb);",
          [
            fx.orderId,
            JSON.stringify([
              { label: "A", item_ids: [fx.appetizerItemId] },
              { label: "B", item_ids: [fx.mainItemId] },
            ]),
          ],
        ),
      ),
    ).rejects.toThrow(/TICKET_SPLIT_FORBIDDEN/);
  });

  it("re-splitting replaces the previous grouping rather than layering on top", async () => {
    const fx = await twoItemOrderFixture(db, "owner");
    await db.asUser(fx.staffUserId, (c) =>
      c.query("select * from public.split_order_into_tickets($1, $2::jsonb);", [
        fx.orderId,
        JSON.stringify([
          { label: "A", item_ids: [fx.appetizerItemId] },
          { label: "B", item_ids: [fx.mainItemId] },
        ]),
      ]),
    );

    const { rows: resplit } = await db.asUser(fx.staffUserId, (c) =>
      c.query<{ id: string; label: string }>(
        "select * from public.split_order_into_tickets($1, $2::jsonb);",
        [
          fx.orderId,
          JSON.stringify([
            {
              label: "Everything",
              item_ids: [fx.appetizerItemId, fx.mainItemId],
            },
            { label: "Empty placeholder", item_ids: [] },
          ]),
        ],
      ),
    );

    // The old "A"/"B" groups must be gone (orphaned, cleaned up), not just
    // superseded — only the new split's groups should exist for this order.
    const { rows: allGroupsForOrder } = await db.admin.query<{
      label: string;
    }>(
      `select distinct otg.label from public.order_ticket_groups otg
       join public.order_items oi on oi.ticket_group_id = otg.id
       where oi.order_id = $1;`,
      [fx.orderId],
    );
    expect(allGroupsForOrder.map((g) => g.label)).toEqual(["Everything"]);
    expect(resplit.some((g) => g.label === "A")).toBe(false);
  });
});

describe("merge_orders_into_ticket()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("merges two same-restaurant, same-status orders into one shared group", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const tableA = await createTable(db, restaurantId);
    const tableB = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);

    const sessionA = await createCustomerSession(db, restaurantId, tableA);
    const cartA = await createCart(db, restaurantId, sessionA.sessionId);
    await addCartItem(db, sessionA.userId, cartA, restaurantId, menuItemId);
    const orderA = await submitOrder(db, sessionA.userId, "merge-a");

    const sessionB = await createCustomerSession(db, restaurantId, tableB);
    const cartB = await createCart(db, restaurantId, sessionB.sessionId);
    await addCartItem(db, sessionB.userId, cartB, restaurantId, menuItemId);
    const orderB = await submitOrder(db, sessionB.userId, "merge-b");

    const { rows } = await db.asUser(ownerId, (c) =>
      c.query<{ id: string; label: string; status: string }>(
        "select * from public.merge_orders_into_ticket($1, $2);",
        [[orderA.id, orderB.id], "Tables A+B"],
      ),
    );
    expect(rows[0].label).toBe("Tables A+B");
    expect(rows[0].status).toBe("pending");

    const { rows: items } = await db.admin.query<{ ticket_group_id: string }>(
      "select ticket_group_id from public.order_items where order_id in ($1, $2);",
      [orderA.id, orderB.id],
    );
    expect(new Set(items.map((i) => i.ticket_group_id)).size).toBe(1);
  });

  it("rejects merging orders in different statuses", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const tableA = await createTable(db, restaurantId);
    const tableB = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);

    const sessionA = await createCustomerSession(db, restaurantId, tableA);
    const cartA = await createCart(db, restaurantId, sessionA.sessionId);
    await addCartItem(db, sessionA.userId, cartA, restaurantId, menuItemId);
    const orderA = await submitOrder(db, sessionA.userId, "status-a");
    await transitionOrderStatus(db, ownerId, orderA.id, "confirmed");

    const sessionB = await createCustomerSession(db, restaurantId, tableB);
    const cartB = await createCart(db, restaurantId, sessionB.sessionId);
    await addCartItem(db, sessionB.userId, cartB, restaurantId, menuItemId);
    const orderB = await submitOrder(db, sessionB.userId, "status-b");
    // orderB stays 'pending' — mismatched with orderA's 'confirmed'.

    await expect(
      db.asUser(ownerId, (c) =>
        c.query("select * from public.merge_orders_into_ticket($1, $2);", [
          [orderA.id, orderB.id],
          null,
        ]),
      ),
    ).rejects.toThrow(/TICKET_MERGE_STATUS_MISMATCH/);
  });

  it("rejects merging an order that has already been split", async () => {
    const fx = await twoItemOrderFixture(db, "owner");
    await db.asUser(fx.staffUserId, (c) =>
      c.query("select * from public.split_order_into_tickets($1, $2::jsonb);", [
        fx.orderId,
        JSON.stringify([
          { label: "A", item_ids: [fx.appetizerItemId] },
          { label: "B", item_ids: [fx.mainItemId] },
        ]),
      ]),
    );

    // A second, unsplit 'pending' order in the SAME restaurant — merging
    // across two different restaurants would trip TICKET_MERGE_CROSS_RESTAURANT
    // first, which isn't what this test is checking.
    const tableC = await createTable(db, fx.restaurantId);
    const categoryId = await createCategory(db, fx.restaurantId);
    const menuItemId = await createMenuItem(db, fx.restaurantId, categoryId);
    const sessionC = await createCustomerSession(db, fx.restaurantId, tableC);
    const cartC = await createCart(db, fx.restaurantId, sessionC.sessionId);
    await addCartItem(db, sessionC.userId, cartC, fx.restaurantId, menuItemId);
    const otherOrder = await submitOrder(
      db,
      sessionC.userId,
      "already-split-c",
    );

    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query("select * from public.merge_orders_into_ticket($1, $2);", [
          [fx.orderId, otherOrder.id],
          null,
        ]),
      ),
    ).rejects.toThrow(/TICKET_MERGE_ALREADY_SPLIT/);
  });

  it("rejects merging orders across two different restaurants", async () => {
    const fxA = await twoItemOrderFixture(db, "owner");
    const fxB = await twoItemOrderFixture(db, "owner");

    await expect(
      db.asUser(fxA.staffUserId, (c) =>
        c.query("select * from public.merge_orders_into_ticket($1, $2);", [
          [fxA.orderId, fxB.orderId],
          null,
        ]),
      ),
    ).rejects.toThrow(/TICKET_MERGE_CROSS_RESTAURANT|TICKET_MERGE_FORBIDDEN/);
  });

  it("rejects a caller with no membership", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const outsiderId = await db.createAuthUser();
    const tableA = await createTable(db, restaurantId);
    const tableB = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);

    const sessionA = await createCustomerSession(db, restaurantId, tableA);
    const cartA = await createCart(db, restaurantId, sessionA.sessionId);
    await addCartItem(db, sessionA.userId, cartA, restaurantId, menuItemId);
    const orderA = await submitOrder(db, sessionA.userId, "outsider-a");

    const sessionB = await createCustomerSession(db, restaurantId, tableB);
    const cartB = await createCart(db, restaurantId, sessionB.sessionId);
    await addCartItem(db, sessionB.userId, cartB, restaurantId, menuItemId);
    const orderB = await submitOrder(db, sessionB.userId, "outsider-b");

    await expect(
      db.asUser(outsiderId, (c) =>
        c.query("select * from public.merge_orders_into_ticket($1, $2);", [
          [orderA.id, orderB.id],
          null,
        ]),
      ),
    ).rejects.toThrow(/TICKET_MERGE_FORBIDDEN/);
  });
});

describe("transition_ticket_group_status() and order-status derivation", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("the order's own status is the least-advanced group covering it", async () => {
    const fx = await twoItemOrderFixture(db, "owner");
    const { rows: groups } = await db.asUser(fx.staffUserId, (c) =>
      c.query<{ id: string; label: string }>(
        "select * from public.split_order_into_tickets($1, $2::jsonb);",
        [
          fx.orderId,
          JSON.stringify([
            { label: "Appetizers", item_ids: [fx.appetizerItemId] },
            { label: "Mains", item_ids: [fx.mainItemId] },
          ]),
        ],
      ),
    );
    const appetizerGroup = groups.find((g) => g.label === "Appetizers")!;
    const mainsGroup = groups.find((g) => g.label === "Mains")!;

    // Advance only the appetizer ticket — the order must NOT jump ahead,
    // since mains are still pending.
    await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "select public.transition_ticket_group_status($1, 'confirmed');",
        [appetizerGroup.id],
      ),
    );
    expect(await getOrderStatus(db, fx.orderId)).toBe("pending");

    // Advance mains to match — now both are at least 'confirmed', so the
    // order (the customer-facing status) catches up.
    await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "select public.transition_ticket_group_status($1, 'confirmed');",
        [mainsGroup.id],
      ),
    );
    expect(await getOrderStatus(db, fx.orderId)).toBe("confirmed");

    // Race the appetizer ticket all the way to 'served' while mains lag —
    // the order must still read the mains ticket's lesser progress.
    await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "select public.transition_ticket_group_status($1, 'preparing');",
        [appetizerGroup.id],
      ),
    );
    await db.asUser(fx.staffUserId, (c) =>
      c.query("select public.transition_ticket_group_status($1, 'ready');", [
        appetizerGroup.id,
      ]),
    );
    await db.asUser(fx.staffUserId, (c) =>
      c.query("select public.transition_ticket_group_status($1, 'served');", [
        appetizerGroup.id,
      ]),
    );
    expect(await getOrderStatus(db, fx.orderId)).toBe("confirmed");

    // Bring mains all the way to 'served' too — only now does the whole
    // order become 'served'.
    await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "select public.transition_ticket_group_status($1, 'preparing');",
        [mainsGroup.id],
      ),
    );
    await db.asUser(fx.staffUserId, (c) =>
      c.query("select public.transition_ticket_group_status($1, 'ready');", [
        mainsGroup.id,
      ]),
    );
    await db.asUser(fx.staffUserId, (c) =>
      c.query("select public.transition_ticket_group_status($1, 'served');", [
        mainsGroup.id,
      ]),
    );
    expect(await getOrderStatus(db, fx.orderId)).toBe("served");
  });

  it("a merged group's progress drives both underlying orders in lockstep", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const tableA = await createTable(db, restaurantId);
    const tableB = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);

    const sessionA = await createCustomerSession(db, restaurantId, tableA);
    const cartA = await createCart(db, restaurantId, sessionA.sessionId);
    await addCartItem(db, sessionA.userId, cartA, restaurantId, menuItemId);
    const orderA = await submitOrder(db, sessionA.userId, "lockstep-a");

    const sessionB = await createCustomerSession(db, restaurantId, tableB);
    const cartB = await createCart(db, restaurantId, sessionB.sessionId);
    await addCartItem(db, sessionB.userId, cartB, restaurantId, menuItemId);
    const orderB = await submitOrder(db, sessionB.userId, "lockstep-b");

    const { rows: merged } = await db.asUser(ownerId, (c) =>
      c.query<{ id: string }>(
        "select * from public.merge_orders_into_ticket($1, $2);",
        [[orderA.id, orderB.id], "Combined"],
      ),
    );

    await db.asUser(ownerId, (c) =>
      c.query(
        "select public.transition_ticket_group_status($1, 'confirmed');",
        [merged[0].id],
      ),
    );

    expect(await getOrderStatus(db, orderA.id)).toBe("confirmed");
    expect(await getOrderStatus(db, orderB.id)).toBe("confirmed");
  });

  it("rejects an invalid transition (skipping a step)", async () => {
    const fx = await twoItemOrderFixture(db, "owner");
    const { rows: groups } = await db.asUser(fx.staffUserId, (c) =>
      c.query<{ id: string }>(
        "select * from public.split_order_into_tickets($1, $2::jsonb);",
        [
          fx.orderId,
          JSON.stringify([
            { label: "A", item_ids: [fx.appetizerItemId] },
            { label: "B", item_ids: [fx.mainItemId] },
          ]),
        ],
      ),
    );

    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query(
          "select public.transition_ticket_group_status($1, 'preparing');",
          [groups[0].id],
        ),
      ),
    ).rejects.toThrow(/TICKET_GROUP_INVALID_TRANSITION/);
  });

  it("rejects a transition the role isn't allowed to perform (staff cannot confirm)", async () => {
    // Owner performs the split (staff cannot — see role_can_transition_order's
    // matrix, unchanged); the test is about the *transition* denial, not the split.
    const fx = await twoItemOrderFixture(db, "owner");
    const staffUserId = await db.createAuthUser();
    await addMember(db, fx.restaurantId, staffUserId, "staff");

    const { rows: groups } = await db.asUser(fx.staffUserId, (c) =>
      c.query<{ id: string }>(
        "select * from public.split_order_into_tickets($1, $2::jsonb);",
        [
          fx.orderId,
          JSON.stringify([
            { label: "A", item_ids: [fx.appetizerItemId] },
            { label: "B", item_ids: [fx.mainItemId] },
          ]),
        ],
      ),
    );

    await expect(
      db.asUser(staffUserId, (c) =>
        c.query(
          "select public.transition_ticket_group_status($1, 'confirmed');",
          [groups[0].id],
        ),
      ),
    ).rejects.toThrow(/TICKET_GROUP_FORBIDDEN/);
  });

  it("staff (kitchen role) splitting is allowed — split isn't restricted to owner/manager", async () => {
    const fx = await twoItemOrderFixture(db, "kitchen");

    const { rows: groups } = await db.asUser(fx.staffUserId, (c) =>
      c.query<{ id: string }>(
        "select * from public.split_order_into_tickets($1, $2::jsonb);",
        [
          fx.orderId,
          JSON.stringify([
            { label: "A", item_ids: [fx.appetizerItemId] },
            { label: "B", item_ids: [fx.mainItemId] },
          ]),
        ],
      ),
    );
    expect(groups.length).toBe(2);
  });
});
