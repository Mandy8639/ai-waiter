// @vitest-environment node
//
// staff_place_order() (20261107090000): the POS screen. Staff ring up an
// order for a table, or for a pickup counter under a name, priced from the
// current menu like submit_order().
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCategory,
  createMenuItem,
  createModifier,
  createModifierOption,
  createRestaurant,
  createTable,
  fullOrderFixture,
  type Role,
} from "./helpers";

interface PlacedOrder {
  id: string;
  order_number: number;
  status: string;
  source: string;
  placed_by: string | null;
  customer_session_id: string | null;
  subtotal: string;
  tax: string;
  total: string;
  fulfillment: string;
  pickup_name: string | null;
}

describe("staff_place_order()", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function setup(role: Role = "staff") {
    const restaurantId = await createRestaurant(db);
    await db.admin.query(
      "update public.restaurants set tax_rate = 0.1 where id = $1;",
      [restaurantId],
    );
    const userId = await db.createAuthUser();
    await addMember(db, restaurantId, userId, role);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const itemId = await createMenuItem(db, restaurantId, categoryId, {
      price: 10,
    });
    return { restaurantId, userId, tableId, categoryId, itemId };
  }

  function place(
    userId: string,
    args: {
      restaurantId: string;
      tableId: string;
      lines: unknown;
      key?: string;
      note?: string | null;
      pickupName?: string | null;
    },
  ) {
    return db.asUser(userId, (c) =>
      c.query<PlacedOrder>(
        "select * from public.staff_place_order($1, $2, $3::jsonb, $4, $5, $6);",
        [
          args.restaurantId,
          args.tableId,
          JSON.stringify(args.lines),
          args.key ?? crypto.randomUUID(),
          args.note ?? null,
          args.pickupName ?? null,
        ],
      ),
    );
  }

  it("rings up a table order, priced from the menu, recorded as staff", async () => {
    const f = await setup();
    const { rows } = await place(f.userId, {
      restaurantId: f.restaurantId,
      tableId: f.tableId,
      lines: [{ menu_item_id: f.itemId, quantity: 2, notes: "no onions" }],
      note: "birthday",
    });
    const order = rows[0];
    expect(order).toMatchObject({
      status: "pending",
      source: "staff",
      placed_by: f.userId,
      customer_session_id: null,
      fulfillment: "dine_in",
    });
    expect(Number(order.subtotal)).toBe(20);
    expect(Number(order.tax)).toBe(2);
    expect(Number(order.total)).toBe(22);

    const { rows: lines } = await db.admin.query<{
      quantity: number;
      line_total: string;
      notes: string;
    }>(
      "select quantity, line_total, notes from public.order_items where order_id = $1;",
      [order.id],
    );
    expect(lines).toEqual([
      { quantity: 2, line_total: "20.00", notes: "no onions" },
    ]);

    const { rows: history } = await db.admin.query<{
      actor_type: string;
      actor_id: string;
    }>(
      "select actor_type, actor_id from public.order_status_history where order_id = $1;",
      [order.id],
    );
    expect(history).toEqual([{ actor_type: "staff", actor_id: f.userId }]);
  });

  it("prices add-ons and enforces a required group", async () => {
    const f = await setup("manager");
    const group = await createModifier(db, f.restaurantId, f.itemId, "Size");
    await db.admin.query(
      "update public.menu_item_modifiers set is_required = true where id = $1;",
      [group],
    );
    const large = await createModifierOption(db, group, {
      name: "Large",
      priceAdjustment: 2.5,
    });

    await expect(
      place(f.userId, {
        restaurantId: f.restaurantId,
        tableId: f.tableId,
        lines: [{ menu_item_id: f.itemId, quantity: 1 }],
      }),
    ).rejects.toThrow(/ORDER_MODIFIER_INVALID/);

    const { rows } = await place(f.userId, {
      restaurantId: f.restaurantId,
      tableId: f.tableId,
      lines: [
        { menu_item_id: f.itemId, quantity: 2, modifier_option_ids: [large] },
      ],
    });
    expect(Number(rows[0].subtotal)).toBe(25);

    const { rows: mods } = await db.admin.query<{
      modifier_group_name: string;
      modifier_option_name: string;
    }>(
      `select m.modifier_group_name, m.modifier_option_name
       from public.order_item_modifiers m
       join public.order_items i on i.id = m.order_item_id
       where i.order_id = $1;`,
      [rows[0].id],
    );
    expect(mods).toEqual([
      { modifier_group_name: "Size", modifier_option_name: "Large" },
    ]);
  });

  it("refuses an add-on from another dish", async () => {
    const f = await setup();
    const other = await createMenuItem(db, f.restaurantId, f.categoryId);
    const group = await createModifier(db, f.restaurantId, other);
    const option = await createModifierOption(db, group);
    await expect(
      place(f.userId, {
        restaurantId: f.restaurantId,
        tableId: f.tableId,
        lines: [{ menu_item_id: f.itemId, modifier_option_ids: [option] }],
      }),
    ).rejects.toThrow(/ORDER_MODIFIER_INVALID/);
  });

  it("refuses a sold-out dish", async () => {
    const f = await setup();
    await db.admin.query(
      "update public.menu_items set is_available = false where id = $1;",
      [f.itemId],
    );
    await expect(
      place(f.userId, {
        restaurantId: f.restaurantId,
        tableId: f.tableId,
        lines: [{ menu_item_id: f.itemId }],
      }),
    ).rejects.toThrow(/ORDER_ITEM_UNAVAILABLE/);
  });

  it("returns the same order for a retry of the same send", async () => {
    const f = await setup();
    const key = crypto.randomUUID();
    const args = {
      restaurantId: f.restaurantId,
      tableId: f.tableId,
      lines: [{ menu_item_id: f.itemId }],
      key,
    };
    const first = await place(f.userId, args);
    const second = await place(f.userId, args);
    expect(second.rows[0].id).toBe(first.rows[0].id);
  });

  it("puts a counter order under the name to call out", async () => {
    const f = await setup();
    const { rows: counter } = await db.admin.query<{ id: string }>(
      "insert into public.tables (restaurant_id, table_number, kind) values ($1, 'Counter', 'counter') returning id;",
      [f.restaurantId],
    );
    const { rows } = await place(f.userId, {
      restaurantId: f.restaurantId,
      tableId: counter[0].id,
      lines: [{ menu_item_id: f.itemId }],
      pickupName: "  Priya ",
    });
    expect(rows[0]).toMatchObject({
      fulfillment: "pickup",
      pickup_name: "Priya",
    });
  });

  it("still takes staff orders while the kitchen has paused QR orders", async () => {
    const f = await setup();
    await db.admin.query(
      "update public.restaurant_settings set orders_paused_until = now() + interval '20 minutes' where restaurant_id = $1;",
      [f.restaurantId],
    );
    const { rows } = await place(f.userId, {
      restaurantId: f.restaurantId,
      tableId: f.tableId,
      lines: [{ menu_item_id: f.itemId }],
    });
    expect(rows[0].status).toBe("pending");
  });

  it("refuses the kitchen account and outsiders", async () => {
    const f = await setup("kitchen");
    await expect(
      place(f.userId, {
        restaurantId: f.restaurantId,
        tableId: f.tableId,
        lines: [{ menu_item_id: f.itemId }],
      }),
    ).rejects.toThrow(/ORDER_STAFF_FORBIDDEN/);

    const stranger = await db.createAuthUser();
    await expect(
      place(stranger, {
        restaurantId: f.restaurantId,
        tableId: f.tableId,
        lines: [{ menu_item_id: f.itemId }],
      }),
    ).rejects.toThrow(/ORDER_STAFF_FORBIDDEN/);
  });

  it("refuses another restaurant's table", async () => {
    const f = await setup("owner");
    const otherRestaurant = await createRestaurant(db);
    const otherTable = await createTable(db, otherRestaurant);
    await expect(
      place(f.userId, {
        restaurantId: f.restaurantId,
        tableId: otherTable,
        lines: [{ menu_item_id: f.itemId }],
      }),
    ).rejects.toThrow(/ORDER_TABLE_UNAVAILABLE/);
  });

  it("refuses empty or malformed lines", async () => {
    const f = await setup();
    const base = { restaurantId: f.restaurantId, tableId: f.tableId };
    await expect(place(f.userId, { ...base, lines: [] })).rejects.toThrow(
      /ORDER_INVALID_INPUT/,
    );
    await expect(
      place(f.userId, {
        ...base,
        lines: [{ menu_item_id: f.itemId, quantity: 0 }],
      }),
    ).rejects.toThrow(/ORDER_INVALID_INPUT/);
    await expect(
      place(f.userId, { ...base, lines: [{ menu_item_id: "nope" }] }),
    ).rejects.toThrow(/ORDER_INVALID_INPUT/);
  });

  it("leaves diner orders exactly as they were", async () => {
    const f = await fullOrderFixture(db);
    const { rows } = await db.admin.query<{
      source: string;
      customer_session_id: string;
    }>("select source, customer_session_id from public.orders where id = $1;", [
      f.orderId,
    ]);
    expect(rows[0]).toEqual({
      source: "diner",
      customer_session_id: f.sessionId,
    });
  });

  it("can't be rewritten after placing", async () => {
    const f = await setup();
    const { rows } = await place(f.userId, {
      restaurantId: f.restaurantId,
      tableId: f.tableId,
      lines: [{ menu_item_id: f.itemId }],
    });
    await expect(
      db.admin.query(
        "update public.orders set source = 'diner' where id = $1;",
        [rows[0].id],
      ),
    ).rejects.toThrow(/immutable|orders_source_matches_session/);
  });
});
