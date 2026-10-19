// @vitest-environment node
//
// ai_usage and ai_cost_summary() (20261028090000): AI cost per
// restaurant, server-only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant } from "./helpers";

describe("AI usage and cost per restaurant", () => {
  let db: TestDb;
  let ownerId: string;
  let r1: string;
  let r2: string;

  beforeAll(async () => {
    db = await createTestDb();
    ownerId = await db.createAuthUser();
    r1 = await createRestaurant(db);
    r2 = await createRestaurant(db);
    await addMember(db, r1, ownerId, "owner");

    const insert = (
      restaurant: string | null,
      job: string,
      source: string,
      cost: number | null,
      at = "2026-10-14T12:00:00Z",
    ) =>
      db.admin.query(
        `insert into public.ai_usage (restaurant_id, job, source, model, cost_usd, created_at)
         values ($1, $2, $3, 'm/x', $4, $5);`,
        [restaurant, job, source, cost, at],
      );
    await insert(r1, "waiter", "app", 0.004);
    await insert(r1, "waiter", "app", 0.006);
    await insert(r1, "drafts", "app", 0);
    await insert(r2, "waiter", "app", null);
    await insert(null, "waiter", "admin_test", 0.01);
    // Outside the week.
    await insert(r1, "waiter", "app", 5, "2026-10-20T00:00:00Z");
  });

  afterAll(async () => {
    await db.close();
  });

  async function summary() {
    const { rows } = await db.asServiceRole((c) =>
      c.query<{
        restaurant_id: string | null;
        waiter_chats: string;
        uses: string;
        cost_usd: string;
        unpriced: string;
      }>(
        "select * from public.ai_cost_summary('2026-10-12T00:00:00Z', '2026-10-19T00:00:00Z');",
      ),
    );
    return rows;
  }

  it("adds up each restaurant's week, counting only diners' waiter turns as chats", async () => {
    const rows = await summary();
    const one = rows.find((r) => r.restaurant_id === r1)!;
    expect(Number(one.waiter_chats)).toBe(2);
    expect(Number(one.uses)).toBe(3);
    expect(Number(one.cost_usd)).toBeCloseTo(0.01);

    const platform = rows.find((r) => r.restaurant_id === null)!;
    expect(Number(platform.waiter_chats)).toBe(0);
    expect(Number(platform.cost_usd)).toBeCloseTo(0.01);
  });

  it("counts an unknown cost as unknown, not as zero", async () => {
    const two = (await summary()).find((r) => r.restaurant_id === r2)!;
    expect(Number(two.unpriced)).toBe(1);
    expect(Number(two.cost_usd)).toBe(0);
  });

  it("refuses an unknown job or source, and a negative cost", async () => {
    await expect(
      db.admin.query(
        "insert into public.ai_usage (job, source) values ('billing', 'app');",
      ),
    ).rejects.toThrow(/job_valid/);
    await expect(
      db.admin.query(
        "insert into public.ai_usage (job, source) values ('waiter', 'guess');",
      ),
    ).rejects.toThrow(/source_valid/);
    await expect(
      db.admin.query(
        "insert into public.ai_usage (job, cost_usd) values ('waiter', -1);",
      ),
    ).rejects.toThrow(/cost_not_negative/);
  });

  it("is out of a restaurant owner's reach, even for their own restaurant", async () => {
    const read = await db
      .asUser(ownerId, (c) => c.query("select * from public.ai_usage;"))
      .catch(() => ({ rows: [] }));
    expect(read.rows).toEqual([]);
    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "select * from public.ai_cost_summary(now() - interval '30 days', now());",
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("sends each admin one weekly email per week", async () => {
    await db.admin.query(
      "insert into public.platform_email_dispatches (kind, dedupe_key, recipient) values ('weekly_ai_cost', '2026-10-12', 'a@x.test');",
    );
    await expect(
      db.admin.query(
        "insert into public.platform_email_dispatches (kind, dedupe_key, recipient) values ('weekly_ai_cost', '2026-10-12', 'a@x.test');",
      ),
    ).rejects.toThrow(/platform_email_dispatches_once/);
    await expect(
      db.admin.query(
        "insert into public.platform_email_dispatches (kind, dedupe_key, recipient) values ('spam', '2026-10-12', 'a@x.test');",
      ),
    ).rejects.toThrow(/kind_valid/);
  });
});
