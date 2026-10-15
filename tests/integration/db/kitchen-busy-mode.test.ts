// @vitest-environment node
//
// Kitchen busy mode (supabase/migrations/20261015090000_kitchen_busy_mode.sql):
// a pause really stops new orders, lifts by itself, and is the kitchen's
// and managers' to set — and diners can read only the two facts they need.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  addMember,
  fullCustomerFixture,
  submitOrder,
  type Role,
} from "./helpers";

describe("kitchen busy mode", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function fixture() {
    const f = await fullCustomerFixture(db);
    const member = async (role: Role) => {
      const userId = await db.createAuthUser();
      await addMember(db, f.restaurantId, userId, role);
      return userId;
    };
    const fillCart = () =>
      addCartItem(db, f.userId, f.cartId, f.restaurantId, f.menuItemId);
    return { ...f, member, fillCart };
  }

  const pause = (
    userId: string,
    restaurantId: string,
    minutes: number | null,
  ) =>
    db.asUser(userId, (c) =>
      c.query("select public.pause_new_orders($1, $2);", [
        restaurantId,
        minutes,
      ]),
    );

  async function status(restaurantId: string) {
    const { rows } = await db.asAnon((c) =>
      c.query<{
        orders_paused_until: string | null;
        busy_extra_minutes: number;
      }>("select * from public.get_kitchen_status($1);", [restaurantId]),
    );
    return rows[0];
  }

  it("refuses new orders while the kitchen has paused them", async () => {
    const f = await fixture();
    const cook = await f.member("kitchen");
    await f.fillCart();

    await pause(cook, f.restaurantId, 30);

    await expect(
      submitOrder(db, f.userId, `paused-${crypto.randomUUID()}`),
    ).rejects.toThrow(/ORDER_PAUSED/);
  });

  it("takes orders again once resumed", async () => {
    const f = await fixture();
    const cook = await f.member("kitchen");
    await f.fillCart();
    await pause(cook, f.restaurantId, null);

    await db.asUser(cook, (c) =>
      c.query("select public.resume_new_orders($1);", [f.restaurantId]),
    );

    await expect(
      submitOrder(db, f.userId, `resumed-${crypto.randomUUID()}`),
    ).resolves.toBeDefined();
  });

  it("lifts a timed pause by itself when the time has passed", async () => {
    const f = await fixture();
    await f.fillCart();
    await db.admin.query(
      `update public.restaurant_settings
       set orders_paused_until = now() - interval '1 minute'
       where restaurant_id = $1;`,
      [f.restaurantId],
    );

    await expect(
      submitOrder(db, f.userId, `expired-${crypto.randomUUID()}`),
    ).resolves.toBeDefined();
    expect((await status(f.restaurantId)).orders_paused_until).toBeNull();
  });

  it("still confirms an order that went through just before the pause", async () => {
    // A diner's retry of the same submission returns their existing order
    // rather than being told the kitchen is paused.
    const f = await fixture();
    const cook = await f.member("kitchen");
    await f.fillCart();
    const key = `replay-${crypto.randomUUID()}`;
    const first = await submitOrder(db, f.userId, key);

    await pause(cook, f.restaurantId, 30);

    const again = await submitOrder(db, f.userId, key);
    expect(again.id).toBe(first.id);
  });

  it("is the kitchen's and managers' call, not front of house's", async () => {
    const f = await fixture();
    const waiter = await f.member("staff");
    const manager = await f.member("manager");

    await expect(pause(waiter, f.restaurantId, 30)).rejects.toThrow(
      /BUSY_FORBIDDEN/,
    );
    await expect(
      db.asUser(waiter, (c) =>
        c.query("select public.set_kitchen_busy($1, 20);", [f.restaurantId]),
      ),
    ).rejects.toThrow(/BUSY_FORBIDDEN/);
    await expect(pause(manager, f.restaurantId, 30)).resolves.toBeDefined();
  });

  it("refuses another restaurant's kitchen", async () => {
    const f = await fixture();
    const other = await fixture();
    const outsider = await other.member("kitchen");

    await expect(pause(outsider, f.restaurantId, 30)).rejects.toThrow(
      /BUSY_FORBIDDEN/,
    );
  });

  it("refuses nonsense lengths", async () => {
    const f = await fixture();
    const cook = await f.member("kitchen");

    await expect(pause(cook, f.restaurantId, 1)).rejects.toThrow(
      /BUSY_INVALID/,
    );
    await expect(
      db.asUser(cook, (c) =>
        c.query("select public.set_kitchen_busy($1, 500);", [f.restaurantId]),
      ),
    ).rejects.toThrow(/BUSY_INVALID/);
  });

  it("tells anyone how much longer food is taking, until it runs out", async () => {
    const f = await fixture();
    const cook = await f.member("kitchen");

    await db.asUser(cook, (c) =>
      c.query("select public.set_kitchen_busy($1, 20, 60);", [f.restaurantId]),
    );
    expect((await status(f.restaurantId)).busy_extra_minutes).toBe(20);

    // Orders still flow while running behind.
    await f.fillCart();
    await expect(
      submitOrder(db, f.userId, `behind-${crypto.randomUUID()}`),
    ).resolves.toBeDefined();

    await db.admin.query(
      `update public.restaurant_settings set busy_until = now() - interval '1 minute'
       where restaurant_id = $1;`,
      [f.restaurantId],
    );
    expect((await status(f.restaurantId)).busy_extra_minutes).toBe(0);
  });

  it("clears 'running behind' with 0", async () => {
    const f = await fixture();
    const cook = await f.member("kitchen");
    await db.asUser(cook, (c) =>
      c.query("select public.set_kitchen_busy($1, 20);", [f.restaurantId]),
    );
    await db.asUser(cook, (c) =>
      c.query("select public.set_kitchen_busy($1, 0);", [f.restaurantId]),
    );
    expect((await status(f.restaurantId)).busy_extra_minutes).toBe(0);
  });
});
