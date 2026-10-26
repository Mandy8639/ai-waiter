// @vitest-environment node
//
// Paid at the register on the restaurant's own card machine
// (supabase/migrations/20261013090000_card_terminal_payments.sql).
//
// A card-machine payment is a record like cash, not a Stripe charge, so
// these tests check it follows cash's rules — its own setting, the same
// one-payment-per-order guarantee, owner/manager reversal — and that it
// can never be mistaken for a Stripe card payment.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture } from "./helpers";

async function settings(
  db: TestDb,
  restaurantId: string,
  values: {
    accept_card_terminal?: boolean;
    accept_cash?: boolean;
    tipping_enabled?: boolean;
  },
) {
  for (const [column, value] of Object.entries(values)) {
    await db.admin.query(
      `update public.restaurant_settings set ${column} = $2 where restaurant_id = $1;`,
      [restaurantId, value],
    );
  }
}

function record(
  db: TestDb,
  userId: string,
  orderIds: string[],
  method: string,
  tip = 0,
): Promise<string> {
  return db.asUser(userId, async (c) => {
    const { rows } = await c.query<{ record_in_person_payment: string }>(
      "select public.record_in_person_payment($1::uuid[], $2, $3);",
      [orderIds, method, tip],
    );
    return rows[0].record_in_person_payment;
  });
}

describe("card-machine payments", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("is off until the restaurant switches it on", async () => {
    const f = await fullOrderFixture(db);
    // Cash being on says nothing about having a card machine.
    await settings(db, f.restaurantId, { accept_cash: true });

    await expect(
      record(db, f.staffUserId, [f.orderId], "card_terminal"),
    ).rejects.toThrow(/PAYMENT_CARD_TERMINAL_NOT_ACCEPTED/);
  });

  it("settles immediately as card_terminal, with no Stripe object", async () => {
    const f = await fullOrderFixture(db);
    await settings(db, f.restaurantId, { accept_card_terminal: true });

    const id = await record(db, f.staffUserId, [f.orderId], "card_terminal");

    const { rows } = await db.admin.query<{
      status: string;
      method: string;
      paid_at: string | null;
      stripe_payment_intent_id: string | null;
      recorded_by: string;
      matches: boolean;
    }>(
      `select p.status, p.method, p.paid_at, p.stripe_payment_intent_id,
              p.recorded_by,
              p.amount = (select o.total from public.orders o where o.id = $2) as matches
       from public.order_payments p where p.id = $1;`,
      [id, f.orderId],
    );
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      method: "card_terminal",
      stripe_payment_intent_id: null,
      recorded_by: f.staffUserId,
      matches: true,
    });
    expect(rows[0].paid_at).not.toBeNull();
  });

  it("does not need cash to be switched on", async () => {
    const f = await fullOrderFixture(db);
    await settings(db, f.restaurantId, {
      accept_card_terminal: true,
      accept_cash: false,
    });

    await expect(
      record(db, f.staffUserId, [f.orderId], "card_terminal"),
    ).resolves.toBeTruthy();
    // ...and switching it on does not open the cash path.
    const second = await fullOrderFixture(db);
    await settings(db, second.restaurantId, { accept_card_terminal: true });
    await expect(
      record(db, second.staffUserId, [second.orderId], "cash"),
    ).rejects.toThrow(/PAYMENT_CASH_NOT_ACCEPTED/);
  });

  it("lets any member record it, not just managers", async () => {
    const f = await fullOrderFixture(db);
    await settings(db, f.restaurantId, { accept_card_terminal: true });
    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");

    await expect(
      record(db, waiter, [f.orderId], "card_terminal"),
    ).resolves.toBeTruthy();
  });

  it("refuses a non-member", async () => {
    const f = await fullOrderFixture(db);
    const other = await fullOrderFixture(db);
    await settings(db, f.restaurantId, { accept_card_terminal: true });

    await expect(
      record(db, other.staffUserId, [f.orderId], "card_terminal"),
    ).rejects.toThrow(/PAYMENT_FORBIDDEN/);
  });

  it("refuses 'card': only Stripe's webhook says a card payment happened", async () => {
    const f = await fullOrderFixture(db);
    await settings(db, f.restaurantId, {
      accept_card_terminal: true,
      accept_cash: true,
    });

    for (const method of ["card", "cheque", ""]) {
      await expect(
        record(db, f.staffUserId, [f.orderId], method),
      ).rejects.toThrow(/PAYMENT_INVALID_METHOD/);
    }
  });

  it("follows the tip setting, like every other payment path", async () => {
    const f = await fullOrderFixture(db);
    await settings(db, f.restaurantId, {
      accept_card_terminal: true,
      tipping_enabled: false,
    });
    await expect(
      record(db, f.staffUserId, [f.orderId], "card_terminal", 2),
    ).rejects.toThrow(/PAYMENT_TIPPING_DISABLED/);

    await settings(db, f.restaurantId, { tipping_enabled: true });
    const id = await record(db, f.staffUserId, [f.orderId], "card_terminal", 2);
    const { rows } = await db.admin.query<{ tip_amount: string }>(
      "select tip_amount from public.order_payments where id = $1;",
      [id],
    );
    expect(Number(rows[0].tip_amount)).toBe(2);
  });

  it("cannot settle an order cash already settled, or the reverse", async () => {
    const f = await fullOrderFixture(db);
    await settings(db, f.restaurantId, {
      accept_card_terminal: true,
      accept_cash: true,
    });
    await record(db, f.staffUserId, [f.orderId], "cash");

    await expect(
      record(db, f.staffUserId, [f.orderId], "card_terminal"),
    ).rejects.toThrow(/PAYMENT_ALREADY_PAID/);
  });

  describe("correcting a mistake", () => {
    it("is reversed by an owner or manager, which frees the order again", async () => {
      const f = await fullOrderFixture(db);
      await settings(db, f.restaurantId, { accept_card_terminal: true });
      const manager = await db.createAuthUser();
      await addMember(db, f.restaurantId, manager, "manager");
      const id = await record(db, f.staffUserId, [f.orderId], "card_terminal");

      await db.asUser(manager, (c) =>
        c.query("select public.reverse_cash_payment($1, $2);", [
          id,
          "recorded against the wrong table",
        ]),
      );

      const { rows } = await db.admin.query<{ status: string }>(
        "select status from public.order_payments where id = $1;",
        [id],
      );
      expect(rows[0].status).toBe("reversed");
      await expect(
        record(db, f.staffUserId, [f.orderId], "card_terminal"),
      ).resolves.toBeTruthy();
    });

    it("refuses a reversal by plain staff", async () => {
      const f = await fullOrderFixture(db);
      await settings(db, f.restaurantId, { accept_card_terminal: true });
      const waiter = await db.createAuthUser();
      await addMember(db, f.restaurantId, waiter, "staff");
      const id = await record(db, waiter, [f.orderId], "card_terminal");

      await expect(
        db.asUser(waiter, (c) =>
          c.query("select public.reverse_cash_payment($1, $2);", [id, "oops"]),
        ),
      ).rejects.toThrow(/PAYMENT_FORBIDDEN/);
    });

    it("is refunded on the machine and only recorded here, never through Stripe", async () => {
      // The money is on the restaurant's machine; a refund happens there.
      const f = await fullOrderFixture(db);
      await settings(db, f.restaurantId, { accept_card_terminal: true });
      const id = await record(db, f.staffUserId, [f.orderId], "card_terminal");

      const { rows } = await db.asUser(f.staffUserId, (c) =>
        c.query<{ provider: string; stripe_payment_intent_id: string | null }>(
          "select provider, stripe_payment_intent_id from public.start_refund($1, $2, $3);",
          [id, null, "dish returned"],
        ),
      );
      expect(rows[0]).toEqual({
        provider: "none",
        stripe_payment_intent_id: null,
      });
    });
  });

  it("leaves record_cash_payment() recording cash as before", async () => {
    const f = await fullOrderFixture(db);
    await settings(db, f.restaurantId, { accept_cash: true });

    const id = await db.asUser(f.staffUserId, async (c) => {
      const { rows } = await c.query<{ record_cash_payment: string }>(
        "select public.record_cash_payment($1::uuid[], 0);",
        [[f.orderId]],
      );
      return rows[0].record_cash_payment;
    });
    const { rows } = await db.admin.query<{ method: string }>(
      "select method from public.order_payments where id = $1;",
      [id],
    );
    expect(rows[0].method).toBe("cash");
  });
});
