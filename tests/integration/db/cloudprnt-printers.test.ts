// @vitest-environment node
//
// Network printers (20261112090000): printers, print_jobs, the triggers
// that queue kitchen tickets and receipts, and request_print().
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCustomerSession,
  createCart,
  addCartItem,
  submitOrder,
  fullOrderFixture,
  type Role,
} from "./helpers";

interface Job {
  kind: string;
  printer_id: string;
  order_id: string | null;
  payment_id: string | null;
  open_drawer: boolean;
  reprint: boolean;
  status: string;
  print_after: string;
}

describe("network printers", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function createPrinter(
    userId: string,
    restaurantId: string,
    role: "kitchen" | "receipt",
    opensDrawer = false,
  ) {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ printer_id: string; token: string }>(
        "select * from public.create_printer($1, $2, $3, null, $4);",
        [restaurantId, `${role} printer`, role, opensDrawer],
      ),
    );
    return rows[0];
  }

  async function jobs(restaurantId: string) {
    const { rows } = await db.admin.query<Job>(
      "select kind, printer_id, order_id, payment_id, open_drawer, reprint, status, print_after from public.print_jobs where restaurant_id = $1 order by created_at, kind;",
      [restaurantId],
    );
    return rows;
  }

  async function placeAnotherOrder(
    f: Awaited<ReturnType<typeof fullOrderFixture>>,
  ) {
    const { userId, sessionId } = await createCustomerSession(
      db,
      f.restaurantId,
      f.tableId,
    );
    const cartId = await createCart(db, f.restaurantId, sessionId);
    await addCartItem(db, userId, cartId, f.restaurantId, f.menuItemId);
    return submitOrder(db, userId, crypto.randomUUID());
  }

  it("stores only a hash of the printer's token, and shows the token once", async () => {
    const f = await fullOrderFixture(db);
    const printer = await createPrinter(
      f.staffUserId,
      f.restaurantId,
      "kitchen",
    );
    expect(printer.token).toMatch(/^[0-9a-f]{64}$/);

    const { rows } = await db.admin.query<{
      token_hash: string;
      hashed: string;
    }>(
      "select token_hash, encode(sha256(convert_to($2, 'UTF8')), 'hex') as hashed from public.printers where id = $1;",
      [printer.printer_id, printer.token],
    );
    expect(rows[0].token_hash).toBe(rows[0].hashed);
    expect(rows[0].token_hash).not.toBe(printer.token);
  });

  it("queues a kitchen ticket for each kitchen printer when an order comes in", async () => {
    const f = await fullOrderFixture(db);
    const kitchen = await createPrinter(
      f.staffUserId,
      f.restaurantId,
      "kitchen",
    );
    await createPrinter(f.staffUserId, f.restaurantId, "receipt");

    const order = await placeAnotherOrder(f);
    const queued = await jobs(f.restaurantId);
    expect(queued).toEqual([
      expect.objectContaining({
        kind: "kitchen_ticket",
        printer_id: kitchen.printer_id,
        order_id: order.id,
        status: "queued",
        reprint: false,
      }),
    ]);
  });

  it("queues nothing for a printer with auto-print off or switched off", async () => {
    const f = await fullOrderFixture(db);
    const kitchen = await createPrinter(
      f.staffUserId,
      f.restaurantId,
      "kitchen",
    );
    await db.asUser(f.staffUserId, (c) =>
      c.query(
        "select public.update_printer($1, 'Pass', null, false, false, true);",
        [kitchen.printer_id],
      ),
    );
    await placeAnotherOrder(f);
    expect(await jobs(f.restaurantId)).toEqual([]);
  });

  it("prints a receipt after a cash payment and opens the drawer", async () => {
    const f = await fullOrderFixture(db);
    await db.admin.query(
      "update public.restaurant_settings set accept_cash = true where restaurant_id = $1;",
      [f.restaurantId],
    );
    const receipt = await createPrinter(
      f.staffUserId,
      f.restaurantId,
      "receipt",
      true,
    );

    const { rows } = await db.asUser(f.staffUserId, (c) =>
      c.query<{ id: string }>(
        "select public.record_in_person_payment($1::uuid[], 'cash', 0) as id;",
        [[f.orderId]],
      ),
    );
    expect(await jobs(f.restaurantId)).toEqual([
      expect.objectContaining({
        kind: "receipt",
        printer_id: receipt.printer_id,
        payment_id: rows[0].id,
        open_drawer: true,
      }),
    ]);
  });

  it("doesn't open the drawer for a card-machine payment", async () => {
    const f = await fullOrderFixture(db);
    await db.admin.query(
      "update public.restaurant_settings set accept_card_terminal = true where restaurant_id = $1;",
      [f.restaurantId],
    );
    await createPrinter(f.staffUserId, f.restaurantId, "receipt", true);
    await db.asUser(f.staffUserId, (c) =>
      c.query(
        "select public.record_in_person_payment($1::uuid[], 'card_terminal', 0);",
        [[f.orderId]],
      ),
    );
    expect(await jobs(f.restaurantId)).toEqual([
      expect.objectContaining({ kind: "receipt", open_drawer: false }),
    ]);
  });

  it("only opens the drawer when receipts are off", async () => {
    const f = await fullOrderFixture(db);
    await db.admin.query(
      "update public.restaurant_settings set accept_cash = true where restaurant_id = $1;",
      [f.restaurantId],
    );
    const receipt = await createPrinter(
      f.staffUserId,
      f.restaurantId,
      "receipt",
      true,
    );
    await db.asUser(f.staffUserId, (c) =>
      c.query(
        "select public.update_printer($1, 'Till', null, false, true, true);",
        [receipt.printer_id],
      ),
    );
    await db.asUser(f.staffUserId, (c) =>
      c.query(
        "select public.record_in_person_payment($1::uuid[], 'cash', 0);",
        [[f.orderId]],
      ),
    );
    expect(await jobs(f.restaurantId)).toEqual([
      expect.objectContaining({
        kind: "drawer",
        payment_id: null,
        open_drawer: true,
      }),
    ]);
  });

  it("lets front of house print a bill and the kitchen reprint a ticket", async () => {
    const f = await fullOrderFixture(db);
    await createPrinter(f.staffUserId, f.restaurantId, "kitchen");
    await createPrinter(f.staffUserId, f.restaurantId, "receipt");

    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");
    const cook = await db.createAuthUser();
    await addMember(db, f.restaurantId, cook, "kitchen");

    const bill = await db.asUser(waiter, (c) =>
      c.query<{ n: number }>(
        "select public.request_print($1, 'bill', $2::uuid[]) as n;",
        [f.restaurantId, [f.orderId]],
      ),
    );
    expect(bill.rows[0].n).toBe(1);

    const reprint = await db.asUser(cook, (c) =>
      c.query<{ n: number }>(
        "select public.request_print($1, 'kitchen_ticket', $2::uuid[]) as n;",
        [f.restaurantId, [f.orderId]],
      ),
    );
    expect(reprint.rows[0].n).toBe(1);
    expect(
      (await jobs(f.restaurantId)).find((j) => j.kind === "kitchen_ticket"),
    ).toMatchObject({
      reprint: true,
    });

    await expect(
      db.asUser(cook, (c) =>
        c.query("select public.request_print($1, 'drawer');", [f.restaurantId]),
      ),
    ).rejects.toThrow(/PRINT_FORBIDDEN/);
  });

  it("refuses another restaurant's orders and outsiders", async () => {
    const f = await fullOrderFixture(db);
    const other = await fullOrderFixture(db);
    await createPrinter(f.staffUserId, f.restaurantId, "receipt");
    await expect(
      db.asUser(f.staffUserId, (c) =>
        c.query("select public.request_print($1, 'bill', $2::uuid[]);", [
          f.restaurantId,
          [other.orderId],
        ]),
      ),
    ).rejects.toThrow(/PRINT_INVALID/);

    const stranger = await db.createAuthUser();
    await expect(
      db.asUser(stranger, (c) =>
        c.query("select public.request_print($1, 'drawer');", [f.restaurantId]),
      ),
    ).rejects.toThrow(/PRINT_FORBIDDEN/);
  });

  it.each<Role>(["staff", "kitchen"])(
    "lets only owners and managers add printers (not %s)",
    async (role) => {
      const f = await fullOrderFixture(db);
      const member = await db.createAuthUser();
      await addMember(db, f.restaurantId, member, role);
      await expect(
        createPrinter(member, f.restaurantId, "kitchen"),
      ).rejects.toThrow(/PRINTER_FORBIDDEN/);
    },
  );

  it("shows printers to managers only, and rotating the token changes the hash", async () => {
    const f = await fullOrderFixture(db);
    const printer = await createPrinter(
      f.staffUserId,
      f.restaurantId,
      "kitchen",
    );
    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");

    const seen = await db.asUser(waiter, (c) =>
      c.query("select id from public.printers where restaurant_id = $1;", [
        f.restaurantId,
      ]),
    );
    expect(seen.rows).toEqual([]);

    const before = await db.admin.query<{ token_hash: string }>(
      "select token_hash from public.printers where id = $1;",
      [printer.printer_id],
    );
    const { rows } = await db.asUser(f.staffUserId, (c) =>
      c.query<{ token: string }>(
        "select public.rotate_printer_token($1) as token;",
        [printer.printer_id],
      ),
    );
    expect(rows[0].token).not.toBe(printer.token);
    const after = await db.admin.query<{ token_hash: string }>(
      "select token_hash from public.printers where id = $1;",
      [printer.printer_id],
    );
    expect(after.rows[0].token_hash).not.toBe(before.rows[0].token_hash);
  });

  it("tells any member which kinds of job have a printer, and outsiders nothing", async () => {
    const f = await fullOrderFixture(db);
    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");
    const caps = (userId: string) =>
      db
        .asUser(userId, (c) =>
          c.query<{ kitchen: boolean; receipt: boolean; drawer: boolean }>(
            "select * from public.restaurant_print_capabilities($1);",
            [f.restaurantId],
          ),
        )
        .then((r) => r.rows[0]);

    expect(await caps(waiter)).toEqual({
      kitchen: false,
      receipt: false,
      drawer: false,
    });
    await createPrinter(f.staffUserId, f.restaurantId, "kitchen");
    await createPrinter(f.staffUserId, f.restaurantId, "receipt", true);
    expect(await caps(waiter)).toEqual({
      kitchen: true,
      receipt: true,
      drawer: true,
    });
    const outsider = await db.createAuthUser();
    expect(await caps(outsider)).toEqual({
      kitchen: false,
      receipt: false,
      drawer: false,
    });
  });
});
