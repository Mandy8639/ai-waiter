// @vitest-environment node
//
// Admin Phase 8 (20261101090000_plan_prices_admin.sql): plan prices, card
// fees and the free month change only through the server's functions,
// are recorded, and a new free month applies to new restaurants only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant } from "./helpers";

describe("plan prices and the free month", () => {
  let db: TestDb;
  let admin: string;

  beforeAll(async () => {
    db = await createTestDb();
    admin = await db.createAuthUser();
  });

  afterAll(async () => {
    await db.close();
  });

  const plan = async (slug: string) =>
    (
      await db.admin.query<{
        id: string;
        monthly_price_cents: number;
        fee_bps: number;
        stripe_price_id: string | null;
      }>(
        "select id, monthly_price_cents, fee_bps, stripe_price_id from public.platform_plans where slug = $1;",
        [slug],
      )
    ).rows[0];

  const update = (
    id: string,
    cents: number | null,
    priceId: string | null,
    bps: number | null,
  ) =>
    db.admin.query("select public.admin_update_plan($1, $2, $3, $4, $5);", [
      id,
      cents,
      priceId,
      bps,
      admin,
    ]);

  it("changes a price with its new Stripe price, and records both", async () => {
    const before = await plan("standard");
    await update(before.id, 5900, "price_new_standard", null);
    const after = await plan("standard");
    expect(after).toMatchObject({
      monthly_price_cents: 5900,
      stripe_price_id: "price_new_standard",
      fee_bps: before.fee_bps,
    });
    const { rows } = await db.admin.query(
      `select change, old_value, new_value, old_stripe_price_id, new_stripe_price_id
       from public.platform_plan_history where plan_id = $1 order by changed_at desc limit 1;`,
      [before.id],
    );
    expect(rows[0]).toEqual({
      change: "monthly_price",
      old_value: String(before.monthly_price_cents),
      new_value: "5900",
      old_stripe_price_id: before.stripe_price_id,
      new_stripe_price_id: "price_new_standard",
    });
  });

  it("refuses a paid price without a Stripe price; a free one drops it", async () => {
    const pro = await plan("pro");
    await expect(update(pro.id, 20000, null, null)).rejects.toThrow(
      /PLAN_PRICE_NEEDS_STRIPE_PRICE/,
    );
    await update(pro.id, 0, "price_ignored", null);
    expect(await plan("pro")).toMatchObject({
      monthly_price_cents: 0,
      stripe_price_id: null,
    });
  });

  it("changes a fee alone, within the plan's limits", async () => {
    const starter = await plan("starter");
    await update(starter.id, null, null, 150);
    expect((await plan("starter")).fee_bps).toBe(150);
    await expect(update(starter.id, null, null, 5000)).rejects.toThrow(
      /check constraint/i,
    );
    await expect(
      update("00000000-0000-4000-8000-000000000000", null, null, 10),
    ).rejects.toThrow(/PLAN_NOT_FOUND/);
  });

  it("gives new restaurants the free month as set, and leaves existing ones alone", async () => {
    const existing = await createRestaurant(db);
    const days = async (id: string) =>
      Number(
        (
          await db.admin.query<{ d: number }>(
            "select round(extract(epoch from trial_ends_at - now()) / 86400) as d from public.restaurants where id = $1;",
            [id],
          )
        ).rows[0].d,
      );
    expect(await days(existing)).toBe(30);

    await db.admin.query("select public.admin_set_free_month(14, $1);", [
      admin,
    ]);
    const fresh = await createRestaurant(db);
    expect(await days(fresh)).toBe(14);
    expect(await days(existing)).toBe(30);

    await expect(
      db.admin.query("select public.admin_set_free_month(91, $1);", [admin]),
    ).rejects.toThrow(/check constraint/i);
    const { rows } = await db.admin.query<{
      old_value: string;
      new_value: string;
    }>(
      "select old_value, new_value from public.platform_plan_history where change = 'free_month';",
    );
    expect(rows).toEqual([{ old_value: "30", new_value: "14" }]);
    await db.admin.query("select public.admin_set_free_month(30, $1);", [
      admin,
    ]);
  });

  it("can't be read or changed by a restaurant owner", async () => {
    const restaurantId = await createRestaurant(db);
    const owner = await db.createAuthUser();
    await addMember(db, restaurantId, owner, "owner");
    for (const table of [
      "platform_billing_settings",
      "platform_plan_history",
    ]) {
      const read = await db
        .asUser(owner, (c) => c.query(`select * from public.${table};`))
        .catch(() => ({ rows: [] }));
      expect(read.rows, table).toEqual([]);
    }
    const starter = await plan("starter");
    for (const sql of [
      "select public.admin_update_plan($1, 0, null, 0, null);",
      "select public.admin_set_free_month(90, null);",
    ]) {
      await expect(
        db.asUser(owner, (c) =>
          c.query(sql, sql.includes("$1") ? [starter.id] : []),
        ),
      ).rejects.toThrow(/permission denied/i);
    }
  });
});
