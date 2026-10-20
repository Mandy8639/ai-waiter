// @vitest-environment node
//
// Admin Phase 7 (20261031090000_waiter_model_per_restaurant.sql): a waiter
// list for one restaurant or one plan is saved only after a passing Test of
// exactly that list, by the same person, in the last 15 minutes; for a
// restaurant, on that restaurant's own menu. Server-only, recorded, and
// cleared back to the next level.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant } from "./helpers";

describe("waiter model per restaurant or plan", () => {
  let db: TestDb;
  let admin: string;

  beforeAll(async () => {
    db = await createTestDb();
    admin = await db.createAuthUser();
  });

  afterAll(async () => {
    await db.close();
  });

  async function test(
    models: string[],
    {
      passed = true,
      restaurantId = null,
      by = admin,
      ageMinutes = 0,
    }: {
      passed?: boolean;
      restaurantId?: string | null;
      by?: string;
      ageMinutes?: number;
    } = {},
  ) {
    const { rows } = await db.admin.query<{ id: string }>(
      `insert into public.platform_model_tests
         (job, models, passed, result, tested_by, restaurant_id, tested_at)
       values ('waiter', $1, $2, '{"ms": 1}'::jsonb, $3, $4, now() - make_interval(mins => $5))
       returning id;`,
      [models, passed, by, restaurantId, ageMinutes],
    );
    return rows[0].id;
  }

  const save = (
    target: { restaurantId?: string; planId?: string },
    models: string[] | null,
    testId: string | null,
    user = admin,
  ) =>
    db.admin.query(
      "select public.save_waiter_model_override($1, $2, $3, $4, $5);",
      [
        target.restaurantId ?? null,
        target.planId ?? null,
        models,
        testId,
        user,
      ],
    );

  const overrides = async () =>
    (
      await db.admin.query<{
        restaurant_id: string | null;
        plan_id: string | null;
        models: string[];
      }>(
        "select restaurant_id, plan_id, models from public.waiter_model_overrides;",
      )
    ).rows;

  it("saves a restaurant's list tested on its own menu, and clears it back", async () => {
    const restaurantId = await createRestaurant(db);
    const testId = await test(["paid/smart"], { restaurantId });
    await save({ restaurantId }, ["paid/smart"], testId);
    expect(
      (await overrides()).find((o) => o.restaurant_id === restaurantId)?.models,
    ).toEqual(["paid/smart"]);

    await save({ restaurantId }, null, null);
    expect(
      (await overrides()).some((o) => o.restaurant_id === restaurantId),
    ).toBe(false);

    const { rows } = await db.admin.query<{ action: string }>(
      "select action from public.waiter_model_override_history where restaurant_id = $1 order by changed_at;",
      [restaurantId],
    );
    expect(rows.map((r) => r.action)).toEqual(["save", "clear"]);
  });

  it("refuses a Test from the sample menu, or another restaurant's menu", async () => {
    const restaurantId = await createRestaurant(db);
    const other = await createRestaurant(db);
    for (const testId of [
      await test(["paid/smart"]),
      await test(["paid/smart"], { restaurantId: other }),
    ]) {
      await expect(
        save({ restaurantId }, ["paid/smart"], testId),
      ).rejects.toThrow(/MODEL_TEST_REQUIRED/);
    }
  });

  it("saves a plan's list tested on the sample menu", async () => {
    const { rows } = await db.admin.query<{ id: string }>(
      "select id from public.platform_plans where slug = 'pro';",
    );
    const planId = rows[0].id;
    const testId = await test(["paid/pro-waiter"]);
    await save({ planId }, ["paid/pro-waiter"], testId);
    expect(
      (await overrides()).find((o) => o.plan_id === planId)?.models,
    ).toEqual(["paid/pro-waiter"]);
  });

  it("refuses a failed, stale, different or someone else's Test", async () => {
    const restaurantId = await createRestaurant(db);
    const someoneElse = await db.createAuthUser();
    const cases: Array<[string, RegExp]> = [
      [
        await test(["m/a"], { restaurantId, passed: false }),
        /MODEL_TEST_REQUIRED/,
      ],
      [
        await test(["m/a"], { restaurantId, ageMinutes: 20 }),
        /MODEL_TEST_STALE/,
      ],
      [await test(["m/b"], { restaurantId }), /MODEL_TEST_REQUIRED/],
      [
        await test(["m/a"], { restaurantId, by: someoneElse }),
        /MODEL_TEST_REQUIRED/,
      ],
    ];
    for (const [testId, error] of cases) {
      await expect(save({ restaurantId }, ["m/a"], testId)).rejects.toThrow(
        error,
      );
    }
  });

  it("needs exactly one target", async () => {
    const restaurantId = await createRestaurant(db);
    await expect(save({}, null, null)).rejects.toThrow(
      /OVERRIDE_TARGET_INVALID/,
    );
    const { rows } = await db.admin.query<{ id: string }>(
      "select id from public.platform_plans limit 1;",
    );
    await expect(
      save({ restaurantId, planId: rows[0].id }, null, null),
    ).rejects.toThrow(/OVERRIDE_TARGET_INVALID/);
  });

  it("is invisible to a signed-in restaurant owner", async () => {
    const restaurantId = await createRestaurant(db);
    const owner = await db.createAuthUser();
    await addMember(db, restaurantId, owner, "owner");
    const testId = await test(["paid/smart"], { restaurantId });
    await save({ restaurantId }, ["paid/smart"], testId);
    for (const table of [
      "waiter_model_overrides",
      "waiter_model_override_history",
    ]) {
      const read = await db
        .asUser(owner, (c) => c.query(`select * from public.${table};`))
        .catch(() => ({ rows: [] }));
      expect(read.rows, table).toEqual([]);
    }
    await expect(
      db.asUser(owner, (c) =>
        c.query(
          "select public.save_waiter_model_override($1, null, array['x'], null, null);",
          [restaurantId],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
