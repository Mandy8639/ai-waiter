// @vitest-environment node
//
// The staff assistant against the real database functions
// (20261020090000_staff_assistant.sql and the functions it calls): typed
// commands go parse → plan → the dashboard's own functions, as the
// signed-in person — and the command log is readable by managers only and
// writable by nobody signed in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  addMember,
  createMenuItem,
  fullCustomerFixture,
  submitOrder,
  type Role,
} from "./helpers";
import { parseStaffCommand } from "@/lib/staff-assistant/parse-core";
import {
  planIntent,
  type PlanContext,
  type StaffRole,
} from "@/lib/staff-assistant/plan-core";
import {
  executeAction,
  type AssistantDb,
} from "@/lib/staff-assistant/execute-core";
import type { Catalog } from "@/lib/staff-assistant/resolve-core";

/** Functions that return a time the assistant reports back. */
const RETURNS_TIME = new Set([
  "set_menu_item_sold_out_until_next_opening",
  "pause_new_orders",
]);

describe("staff assistant", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  /** The assistant's database, as this user — the same calls PostgREST would make. */
  function asUserDb(userId: string): AssistantDb {
    return {
      async rpc(fn, args) {
        const names = Object.keys(args);
        const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`;
        const sql = RETURNS_TIME.has(fn)
          ? `select to_json(${call}) #>> '{}' as v;`
          : `select ${call};`;
        try {
          const { rows } = await db.asUser(userId, (c) =>
            c.query<{ v?: string }>(sql, Object.values(args)),
          );
          return { data: rows[0]?.v ?? null, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      },
      async updateDishPrice(restaurantId, dishId, price) {
        try {
          const { rows } = await db.asUser(userId, (c) =>
            c.query<{ id: string }>(
              "update public.menu_items set price = $3 where id = $1 and restaurant_id = $2 returning id;",
              [dishId, restaurantId, price],
            ),
          );
          return { updatedIds: rows.map((r) => r.id), error: null };
        } catch (e) {
          return { updatedIds: [], error: { message: (e as Error).message } };
        }
      },
    };
  }

  async function catalogOf(restaurantId: string): Promise<Catalog> {
    const { rows } = await db.admin.query<{
      id: string;
      name: string;
      price: string;
      is_available: boolean;
      available_again_at: Date | null;
    }>(
      "select id, name, price, is_available, available_again_at from public.menu_items where restaurant_id = $1;",
      [restaurantId],
    );
    return {
      dishes: rows.map((r) => ({
        id: r.id,
        name: r.name,
        price: Number(r.price),
        available: r.is_available,
        backAt: r.available_again_at?.toISOString() ?? null,
      })),
      options: [],
    };
  }

  /** Types a command as this user and runs whatever it plans. */
  async function say(
    userId: string,
    role: StaffRole,
    restaurantId: string,
    text: string,
  ) {
    const ctx: PlanContext = {
      catalog: await catalogOf(restaurantId),
      role,
      state: { pausedUntil: null, busyExtraMinutes: 0 },
      source: "rules",
      timeZone: "UTC",
    };
    const plan = planIntent(parseStaffCommand(text), ctx);
    if (plan.type !== "run") return { plan, outcome: null };
    return {
      plan,
      outcome: await executeAction(asUserDb(userId), restaurantId, plan.action),
    };
  }

  async function fixture() {
    const f = await fullCustomerFixture(db);
    await db.admin.query(
      "update public.menu_items set name = 'Grilled Salmon' where id = $1;",
      [f.menuItemId],
    );
    const member = async (role: Role) => {
      const userId = await db.createAuthUser();
      await addMember(db, f.restaurantId, userId, role);
      return userId;
    };
    return { ...f, member };
  }

  const dish = async (id: string) =>
    (
      await db.admin.query<{
        is_available: boolean;
        available_again_at: Date | null;
        price: string;
      }>(
        "select is_available, available_again_at, price from public.menu_items where id = $1;",
        [id],
      )
    ).rows[0];

  it('"86 the salmon": unorderable now, orderable again at the next opening', async () => {
    const f = await fixture();
    await addCartItem(db, f.userId, f.cartId, f.restaurantId, f.menuItemId);
    const kitchen = await f.member("kitchen");

    const { outcome } = await say(
      kitchen,
      "kitchen",
      f.restaurantId,
      "86 the salmon",
    );
    expect(outcome).toMatchObject({ ok: true });
    const after = await dish(f.menuItemId);
    expect(after.is_available).toBe(false);
    expect(after.available_again_at!.getTime()).toBeGreaterThan(Date.now());
    await expect(
      submitOrder(db, f.userId, crypto.randomUUID()),
    ).rejects.toThrow();

    // The next opening arrives: the minute job puts it back.
    await db.admin.query(
      "update public.menu_items set available_again_at = now() - interval '1 minute' where id = $1;",
      [f.menuItemId],
    );
    await db.admin.query("select public.restore_menu_items_due();");
    expect((await dish(f.menuItemId)).is_available).toBe(true);
    await submitOrder(db, f.userId, crypto.randomUUID());
  });

  it('"pause ordering for an hour" refuses orders, and resuming takes them again', async () => {
    const f = await fixture();
    await addCartItem(db, f.userId, f.cartId, f.restaurantId, f.menuItemId);
    const manager = await f.member("manager");

    const paused = await say(
      manager,
      "manager",
      f.restaurantId,
      "pause ordering for an hour",
    );
    expect(paused.outcome).toMatchObject({ ok: true });
    if (paused.outcome?.ok) {
      const minutes =
        (new Date(paused.outcome.result.pausedUntil!).getTime() - Date.now()) /
        60_000;
      expect(minutes).toBeGreaterThan(58);
      expect(minutes).toBeLessThanOrEqual(60);
    }
    await expect(
      submitOrder(db, f.userId, crypto.randomUUID()),
    ).rejects.toThrow(/ORDER_RESTAURANT_UNAVAILABLE|paused/i);

    // Once the hour is up, orders are taken again by themselves.
    await db.admin.query(
      "update public.restaurant_settings set orders_paused_until = now() - interval '1 second' where restaurant_id = $1;",
      [f.restaurantId],
    );
    await submitOrder(db, f.userId, crypto.randomUUID());
  });

  it("a kitchen user can't change a price, even with a forged yes", async () => {
    const f = await fixture();
    const kitchen = await f.member("kitchen");
    const { plan } = await say(
      kitchen,
      "kitchen",
      f.restaurantId,
      "make the grilled salmon $25",
    );
    expect(plan.type).toBe("refused");

    // Straight to the database, past the plan: RLS still says no.
    const out = await executeAction(asUserDb(kitchen), f.restaurantId, {
      kind: "set_price",
      dishId: f.menuItemId,
      price: 25,
    });
    expect(out.ok).toBe(false);
    expect(Number((await dish(f.menuItemId)).price)).toBe(9.99);

    const owner = await f.member("owner");
    const ok = await executeAction(asUserDb(owner), f.restaurantId, {
      kind: "set_price",
      dishId: f.menuItemId,
      price: 25,
    });
    expect(ok.ok).toBe(true);
    expect(Number((await dish(f.menuItemId)).price)).toBe(25);
  });

  it("asks which one when a name matches several dishes, and changes nothing", async () => {
    const f = await fixture();
    await createMenuItem(db, f.restaurantId, f.categoryId, {
      name: "Salmon Tikka",
    });
    const kitchen = await f.member("kitchen");
    const { plan, outcome } = await say(
      kitchen,
      "kitchen",
      f.restaurantId,
      "86 the salmon",
    );
    expect(plan.type).toBe("choose");
    expect(outcome).toBeNull();
    expect((await dish(f.menuItemId)).is_available).toBe(true);
  });

  it("can't touch another restaurant's dish", async () => {
    const f = await fixture();
    const other = await fixture();
    const kitchen = await f.member("kitchen");
    const out = await executeAction(asUserDb(kitchen), f.restaurantId, {
      kind: "dish_sold_out",
      dishId: other.menuItemId,
      until: "manual",
    });
    expect(out.ok).toBe(false);
    expect((await dish(other.menuItemId)).is_available).toBe(true);
  });

  describe("the command log", () => {
    async function logRow(restaurantId: string, userId: string) {
      await db.admin.query(
        `insert into public.staff_assistant_commands
           (restaurant_id, user_id, role, command, interpreted_by, outcome, reply)
         values ($1, $2, 'kitchen', '86 the salmon', 'rules', 'applied', 'Done.');`,
        [restaurantId, userId],
      );
    }

    it("is read by owners and managers of that restaurant only", async () => {
      const f = await fixture();
      const kitchen = await f.member("kitchen");
      await logRow(f.restaurantId, kitchen);
      const count = async (userId: string) =>
        (
          await db.asUser(userId, (c) =>
            c.query("select id from public.staff_assistant_commands;"),
          )
        ).rows.length;

      expect(await count(await f.member("owner"))).toBe(1);
      expect(await count(await f.member("manager"))).toBe(1);
      expect(await count(kitchen)).toBe(0);
      expect(await count(await f.member("staff"))).toBe(0);
      const stranger = await (await fixture()).member("owner");
      expect(await count(stranger)).toBe(0);
    });

    it("can't be written, edited or deleted by anyone signed in", async () => {
      const f = await fixture();
      const owner = await f.member("owner");
      await logRow(f.restaurantId, owner);
      await expect(
        db.asUser(owner, (c) =>
          c.query(
            `insert into public.staff_assistant_commands
               (restaurant_id, user_id, role, command, interpreted_by, outcome, reply)
             values ($1, $2, 'owner', 'x', 'rules', 'applied', 'x');`,
            [f.restaurantId, owner],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);

      for (const sql of [
        "update public.staff_assistant_commands set reply = 'edited' where restaurant_id = $1;",
        "delete from public.staff_assistant_commands where restaurant_id = $1;",
      ]) {
        await db.asUser(owner, (c) => c.query(sql, [f.restaurantId]));
      }
      const { rows } = await db.admin.query<{ reply: string }>(
        "select reply from public.staff_assistant_commands where restaurant_id = $1;",
        [f.restaurantId],
      );
      expect(rows).toEqual([{ reply: "Done." }]);
    });

    it("keeps its shape", async () => {
      const f = await fixture();
      const owner = await f.member("owner");
      for (const [col, value] of [
        ["interpreted_by", "'magic'"],
        ["outcome", "'maybe'"],
        ["command", "''"],
        ["tool_calls", `'{"a":1}'::jsonb`],
      ]) {
        await expect(
          db.admin.query(
            `insert into public.staff_assistant_commands
               (restaurant_id, user_id, role, command, interpreted_by, outcome, reply, tool_calls)
             select $1, $2, 'owner',
               ${col === "command" ? value : "'x'"},
               ${col === "interpreted_by" ? value : "'rules'"},
               ${col === "outcome" ? value : "'applied'"},
               'x',
               ${col === "tool_calls" ? value : "'[]'::jsonb"};`,
            [f.restaurantId, owner],
          ),
        ).rejects.toThrow(/check constraint/i);
      }
    });
  });
});
