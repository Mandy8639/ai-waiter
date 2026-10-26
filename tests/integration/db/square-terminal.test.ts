// @vitest-environment node
//
// Square, phase 3 (20261111090000): Terminal payments, device-added tips,
// cash copied to Square, and paired Terminals.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createCustomerSession, fullOrderFixture } from "./helpers";

type Fixture = Awaited<ReturnType<typeof fullOrderFixture>>;

interface StartRow {
  payment_id: string;
  amount: string;
  total_amount: string;
  currency: string;
  tipping_enabled: boolean;
}

describe("Square Terminal and cash", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function squareRestaurant(f: Fixture) {
    await db.admin.query(
      `update public.restaurant_settings
       set accept_card = true, accept_cash = true, tipping_enabled = true
       where restaurant_id = $1;`,
      [f.restaurantId],
    );
    await db.admin.query(
      `insert into public.restaurant_pos_integrations
         (restaurant_id, provider, external_location_id, is_enabled, payments_enabled)
       values ($1, 'square', 'LOC1', true, true);`,
      [f.restaurantId],
    );
    await db.admin.query(
      `insert into public.pos_credentials (restaurant_id, provider, merchant_id, access_token_enc)
       values ($1, 'square', 'M1', 'v1.a.b.c');`,
      [f.restaurantId],
    );
  }

  const start = (userId: string, orderIds: string[]) =>
    db.asUser(userId, (c) =>
      c.query<StartRow>(
        "select * from public.start_square_terminal_payment($1);",
        [orderIds],
      ),
    );

  const orderTotalMinor = async (orderId: string) =>
    Math.round(
      Number(
        (
          await db.admin.query<{ total: string }>(
            "select total from public.orders where id = $1;",
            [orderId],
          )
        ).rows[0].total,
      ) * 100,
    );

  const settle = (
    squareOrderId: string,
    total: number,
    tip: number,
    currency = "USD",
  ) =>
    db.admin
      .query<{ r: string }>(
        "select public.settle_square_payment($1, $2, $3, $4, $5) as r;",
        [squareOrderId, `PAY_${squareOrderId}`, total, tip, currency],
      )
      .then((r) => r.rows[0].r);

  async function sentToTerminal(role: "staff" | "owner" = "staff") {
    const f = await fullOrderFixture(db, role);
    await squareRestaurant(f);
    const { rows } = await start(f.staffUserId, [f.orderId]);
    const squareOrderId = `SQ_${crypto.randomUUID()}`;
    await db.asUser(f.staffUserId, (c) =>
      c.query("select public.attach_square_terminal_checkout($1, $2, $3);", [
        rows[0].payment_id,
        squareOrderId,
        `TC_${squareOrderId}`,
      ]),
    );
    return { f, payment: rows[0], squareOrderId };
  }

  it("lets staff start a Terminal payment priced from the orders, with no tip yet", async () => {
    const f = await fullOrderFixture(db, "staff");
    await squareRestaurant(f);
    const { rows } = await start(f.staffUserId, [f.orderId]);
    expect(Number(rows[0].amount)).toBe(
      (await orderTotalMinor(f.orderId)) / 100,
    );
    expect(Number(rows[0].total_amount)).toBe(Number(rows[0].amount));
    const { rows: p } = await db.admin.query<{
      tip_on_device: boolean;
      card_present: boolean;
      recorded_by: string;
    }>(
      "select tip_on_device, card_present, recorded_by from public.order_payments where id = $1;",
      [rows[0].payment_id],
    );
    expect(p[0]).toEqual({
      tip_on_device: true,
      card_present: true,
      recorded_by: f.staffUserId,
    });
  });

  it("refuses a restaurant that doesn't take cards through Square, and an outsider", async () => {
    const f = await fullOrderFixture(db, "staff");
    await db.admin.query(
      "update public.restaurant_settings set accept_card = true where restaurant_id = $1;",
      [f.restaurantId],
    );
    await expect(start(f.staffUserId, [f.orderId])).rejects.toThrow(
      /PAYMENT_NOT_SQUARE/,
    );
    await squareRestaurant(f);
    const outsider = await db.createAuthUser();
    await expect(start(outsider, [f.orderId])).rejects.toThrow(
      /PAYMENT_FORBIDDEN/,
    );
  });

  it("settles with the tip the diner added on the device", async () => {
    const { payment, squareOrderId } = await sentToTerminal();
    const base = Math.round(Number(payment.amount) * 100);
    expect(await settle(squareOrderId, base + 200, 200)).toBe("settled");
    const { rows } = await db.admin.query<{
      status: string;
      tip_amount: string;
      total_amount: string;
    }>(
      "select status, tip_amount, total_amount from public.order_payments where id = $1;",
      [payment.payment_id],
    );
    expect(rows[0].status).toBe("succeeded");
    expect(Number(rows[0].tip_amount)).toBe(2);
    expect(Number(rows[0].total_amount)).toBe(Number(payment.amount) + 2);
    expect(await settle(squareOrderId, base + 200, 200)).toBe("already");
  });

  it("refuses a Terminal payment whose amount without the tip isn't the bill", async () => {
    const { payment, squareOrderId } = await sentToTerminal();
    const base = Math.round(Number(payment.amount) * 100);
    expect(await settle(squareOrderId, base + 200, 100)).toBe("mismatch");
    expect(await settle(squareOrderId, base, 0, "CAD")).toBe("mismatch");
  });

  it("won't settle a payment staff already cancelled", async () => {
    const { f, payment, squareOrderId } = await sentToTerminal();
    await db.asUser(f.staffUserId, (c) =>
      c.query("select public.cancel_square_terminal_payment($1);", [
        payment.payment_id,
      ]),
    );
    const base = Math.round(Number(payment.amount) * 100);
    expect(await settle(squareOrderId, base, 0)).toBe("mismatch");
  });

  it("keeps phase 2's online settlement working through the old entry point", async () => {
    const f = await fullOrderFixture(db);
    await squareRestaurant(f);
    const { rows: tab } = await db.asUser(f.customerUserId, (c) =>
      c.query<{ payment_id: string; total_amount: string }>(
        "select * from public.start_tab_payment(1);",
      ),
    );
    const sq = `SQ_${crypto.randomUUID()}`;
    await db.asUser(f.customerUserId, (c) =>
      c.query("select public.attach_square_checkout($1, $2, 'https://x');", [
        tab[0].payment_id,
        sq,
      ]),
    );
    const { rows } = await db.admin.query<{ r: string }>(
      "select public.mark_square_payment_succeeded($1, 'P', $2, 'USD') as r;",
      [sq, Math.round(Number(tab[0].total_amount) * 100)],
    );
    expect(rows[0].r).toBe("settled");
  });

  it("lets staff read the bill lines, and still keeps other diners out", async () => {
    const { f, payment } = await sentToTerminal();
    const { rows } = await db.asUser(f.staffUserId, (c) =>
      c.query("select * from public.payment_bill_lines($1);", [
        payment.payment_id,
      ]),
    );
    expect(rows.length).toBe(1);
    const stranger = await createCustomerSession(db, f.restaurantId, f.tableId);
    await expect(
      db.asUser(stranger.userId, (c) =>
        c.query("select * from public.payment_bill_lines($1);", [
          payment.payment_id,
        ]),
      ),
    ).rejects.toThrow(/PAYMENT_NOT_YOUR_ORDER/);
  });

  it("records where a cash payment was copied in Square, once", async () => {
    const f = await fullOrderFixture(db, "staff");
    await squareRestaurant(f);
    const { rows } = await db.asUser(f.staffUserId, (c) =>
      c.query<{ id: string }>(
        "select public.record_in_person_payment($1, 'cash', 0) as id;",
        [[f.orderId]],
      ),
    );
    const paymentId = rows[0].id;
    const attach = (sqPayment: string) =>
      db.asUser(f.staffUserId, (c) =>
        c.query("select public.attach_square_cash_sale($1, 'SQO', $2);", [
          paymentId,
          sqPayment,
        ]),
      );
    await attach("SQP1");
    await attach("SQP2"); // already sent: ignored, not overwritten
    const { rows: p } = await db.admin.query<{ square_payment_id: string }>(
      "select square_payment_id from public.order_payments where id = $1;",
      [paymentId],
    );
    expect(p[0].square_payment_id).toBe("SQP1");
  });

  it("can't be settled by a signed-in user", async () => {
    const { f, squareOrderId } = await sentToTerminal("owner");
    await expect(
      db.asUser(f.staffUserId, (c) =>
        c.query("select public.settle_square_payment($1, 'P', 1, 0, 'USD');", [
          squareOrderId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  describe("Terminals", () => {
    it("are visible to staff, and only owners and managers can add them", async () => {
      const f = await fullOrderFixture(db, "owner");
      const staff = await db.createAuthUser();
      await addMember(db, f.restaurantId, staff, "staff");
      await db.asUser(f.staffUserId, (c) =>
        c.query(
          `insert into public.pos_devices (restaurant_id, name, device_id, status)
           values ($1, 'Front Terminal', 'DEV1', 'paired');`,
          [f.restaurantId],
        ),
      );
      const { rows } = await db.asUser(staff, (c) =>
        c.query<{ name: string }>(
          "select name from public.pos_devices where restaurant_id = $1;",
          [f.restaurantId],
        ),
      );
      expect(rows.map((r) => r.name)).toEqual(["Front Terminal"]);
      await expect(
        db.asUser(staff, (c) =>
          c.query(
            "insert into public.pos_devices (restaurant_id, name) values ($1, 'Sneaky');",
            [f.restaurantId],
          ),
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
    });

    it("must have a device id once paired", async () => {
      const f = await fullOrderFixture(db);
      await expect(
        db.admin.query(
          "insert into public.pos_devices (restaurant_id, name, status) values ($1, 'T', 'paired');",
          [f.restaurantId],
        ),
      ).rejects.toThrow(/paired_has_device/);
    });
  });
});
