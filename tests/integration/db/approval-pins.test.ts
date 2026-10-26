// @vitest-environment node
//
// Manager PINs (20261117090000): a waiter's void, comp or discount, approved
// by a manager typing their PIN; wrong PINs counted and locked out; tokens
// single-use and the waiter's own.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture } from "./helpers";

describe("approval PINs", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function fixture() {
    const f = await fullOrderFixture(db, "manager");
    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");
    const { rows } = await db.admin.query<{ id: string }>(
      "select id from public.order_items where order_id = $1;",
      [f.orderId],
    );
    return { ...f, managerId: f.staffUserId, waiter, itemId: rows[0].id };
  }

  const setPin = (userId: string, restaurantId: string, pin: string) =>
    db.asUser(userId, (c) =>
      c.query("select public.set_approval_pin($1, $2);", [restaurantId, pin]),
    );

  const verify = (userId: string, restaurantId: string, pin: string) =>
    db
      .asUser(userId, (c) =>
        c.query<{ outcome: string; token: string | null }>(
          "select * from public.verify_approval_pin($1, $2);",
          [restaurantId, pin],
        ),
      )
      .then((r) => r.rows[0]);

  const discount = (userId: string, orderId: string, token: string | null) =>
    db
      .asUser(userId, (c) =>
        c.query<{ id: string }>(
          "select public.adjust_order($1, 'discount', 'Regular guest', null, null, 10, null, $2) as id;",
          [orderId, token],
        ),
      )
      .then((r) => r.rows[0].id);

  it("lets a waiter adjust a bill once a manager's PIN approves it, recording who approved", async () => {
    const f = await fixture();
    await setPin(f.managerId, f.restaurantId, "4821");

    await expect(discount(f.waiter, f.orderId, null)).rejects.toThrow(
      /ADJUST_FORBIDDEN/,
    );
    expect((await verify(f.waiter, f.restaurantId, "1111")).outcome).toBe(
      "wrong",
    );
    const ok = await verify(f.waiter, f.restaurantId, "4821");
    expect(ok.outcome).toBe("ok");

    const id = await discount(f.waiter, f.orderId, ok.token);
    const { rows } = await db.admin.query<{
      created_by: string;
      approved_by: string;
    }>(
      "select created_by, approved_by from public.order_adjustments where id = $1;",
      [id],
    );
    expect(rows[0]).toEqual({ created_by: f.waiter, approved_by: f.managerId });

    // A token approves one change only.
    await expect(discount(f.waiter, f.orderId, ok.token)).rejects.toThrow(
      /ADJUST_FORBIDDEN/,
    );

    // Undoing needs approval too.
    const again = await verify(f.waiter, f.restaurantId, "4821");
    await db.asUser(f.waiter, (c) =>
      c.query("select public.remove_order_adjustment($1, $2);", [
        id,
        again.token,
      ]),
    );
  });

  it("locks a waiter out after five wrong PINs, even if the sixth is right", async () => {
    const f = await fixture();
    await setPin(f.managerId, f.restaurantId, "4821");
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++)
      outcomes.push((await verify(f.waiter, f.restaurantId, "0000")).outcome);
    expect(outcomes).toEqual(["wrong", "wrong", "wrong", "wrong", "locked"]);
    expect((await verify(f.waiter, f.restaurantId, "4821")).outcome).toBe(
      "locked",
    );
  });

  it("keeps a token to the waiter it was given to", async () => {
    const f = await fixture();
    await setPin(f.managerId, f.restaurantId, "4821");
    const other = await db.createAuthUser();
    await addMember(db, f.restaurantId, other, "staff");
    const ok = await verify(f.waiter, f.restaurantId, "4821");
    await expect(discount(other, f.orderId, ok.token)).rejects.toThrow(
      /ADJUST_FORBIDDEN/,
    );
  });

  it("lets only owners and managers set a PIN, never the same as another's, and never readable", async () => {
    const f = await fixture();
    await expect(setPin(f.waiter, f.restaurantId, "1234")).rejects.toThrow(
      /PIN_FORBIDDEN/,
    );
    await expect(setPin(f.managerId, f.restaurantId, "12a4")).rejects.toThrow(
      /PIN_INVALID/,
    );
    await setPin(f.managerId, f.restaurantId, "4821");
    const second = await db.createAuthUser();
    await addMember(db, f.restaurantId, second, "manager");
    await expect(setPin(second, f.restaurantId, "4821")).rejects.toThrow(
      /PIN_TAKEN/,
    );

    const { rows } = await db.asUser(f.managerId, (c) =>
      c.query("select * from public.approval_pins;"),
    );
    expect(rows).toEqual([]);
    const set = await db.asUser(f.managerId, (c) =>
      c.query<{ s: boolean }>("select public.my_approval_pin_set($1) as s;", [
        f.restaurantId,
      ]),
    );
    expect(set.rows[0].s).toBe(true);
  });
});
