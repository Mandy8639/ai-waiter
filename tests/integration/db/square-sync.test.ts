// @vitest-environment node
//
// Square restaurants (20261118090000): card-machine sales copied like
// cash, refunds of copied sales linked, and what didn't reach Square
// listed for sending again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture } from "./helpers";

interface Unsynced {
  payments: { id: string; method: string }[];
  refunds: { id: string }[];
}

describe("Square sync", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function squareRestaurant() {
    const f = await fullOrderFixture(db, "manager");
    await db.admin.query(
      `update public.restaurant_settings
       set accept_card = true, accept_cash = true, accept_card_terminal = true
       where restaurant_id = $1;`,
      [f.restaurantId],
    );
    await db.admin.query(
      `insert into public.restaurant_pos_integrations
         (restaurant_id, provider, external_location_id, is_enabled, payments_enabled, connected_at)
       values ($1, 'square', 'LOC1', true, true, now() - interval '1 day');`,
      [f.restaurantId],
    );
    await db.admin.query(
      `insert into public.pos_credentials (restaurant_id, provider, merchant_id, access_token_enc)
       values ($1, 'square', 'M1', 'v1.a.b.c');`,
      [f.restaurantId],
    );
    return { ...f, managerId: f.staffUserId };
  }

  const record = async (
    userId: string,
    orderId: string,
    method: "cash" | "card_terminal",
  ) => {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ id: string }>(
        "select public.record_in_person_payment($1, $2, 0) as id;",
        [[orderId], method],
      ),
    );
    // Old enough that a copy should have happened by now.
    await db.admin.query(
      "update public.order_payments set paid_at = now() - interval '5 minutes' where id = $1;",
      [rows[0].id],
    );
    return rows[0].id;
  };

  const unsynced = (userId: string, restaurantId: string) =>
    db
      .asUser(userId, (c) =>
        c.query<{ u: Unsynced }>("select public.square_unsynced($1) as u;", [
          restaurantId,
        ]),
      )
      .then((r) => r.rows[0].u);

  it("lists a card-machine sale until it's copied, then not", async () => {
    const f = await squareRestaurant();
    const id = await record(f.managerId, f.orderId, "card_terminal");
    expect((await unsynced(f.managerId, f.restaurantId)).payments).toEqual([
      expect.objectContaining({ id, method: "card_terminal" }),
    ]);
    await db.asUser(f.managerId, (c) =>
      c.query("select public.attach_square_cash_sale($1, 'SQO1', 'SQP1');", [
        id,
      ]),
    );
    expect((await unsynced(f.managerId, f.restaurantId)).payments).toEqual([]);
  });

  it("lists a refund of a copied sale until it's linked to Square's", async () => {
    const f = await squareRestaurant();
    const id = await record(f.managerId, f.orderId, "cash");
    await db.asUser(f.managerId, (c) =>
      c.query("select public.attach_square_cash_sale($1, 'SQO2', 'SQP2');", [
        id,
      ]),
    );
    const { rows } = await db.asUser(f.managerId, (c) =>
      c.query<{ refund_id: string }>(
        "select refund_id from public.start_refund($1, 1, 'Short a naan');",
        [id],
      ),
    );
    await db.admin.query(
      "update public.payment_refunds set refunded_at = now() - interval '5 minutes' where id = $1;",
      [rows[0].refund_id],
    );
    expect((await unsynced(f.managerId, f.restaurantId)).refunds).toEqual([
      expect.objectContaining({ id: rows[0].refund_id }),
    ]);
    await db.asUser(f.managerId, (c) =>
      c.query("select public.attach_copied_refund($1, 'SQR1');", [
        rows[0].refund_id,
      ]),
    );
    expect((await unsynced(f.managerId, f.restaurantId)).refunds).toEqual([]);
  });

  it("is for owners and managers, and empty for a restaurant not on Square", async () => {
    const f = await squareRestaurant();
    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");
    await expect(unsynced(waiter, f.restaurantId)).rejects.toThrow(
      /PAYMENT_FORBIDDEN/,
    );

    const plain = await fullOrderFixture(db, "owner");
    expect(await unsynced(plain.staffUserId, plain.restaurantId)).toEqual({
      payments: [],
      refunds: [],
    });
  });
});
