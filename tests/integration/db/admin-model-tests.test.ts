// @vitest-environment node
//
// save_platform_models() (20261024090000): a model list is saved from
// /admin only after a passing Test of that exact list, for that job, by
// the same person, in the last 15 minutes. Every save is recorded.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant } from "./helpers";

describe("saving a model list from /admin", () => {
  let db: TestDb;
  let adminId: string;
  let otherId: string;

  beforeAll(async () => {
    db = await createTestDb();
    adminId = await db.createAuthUser();
    otherId = await db.createAuthUser();
    await addMember(db, await createRestaurant(db), otherId, "owner");
  });

  afterAll(async () => {
    await db.close();
  });

  async function recordTest(input: {
    job: string;
    models: string[];
    passed?: boolean;
    by?: string;
    minutesAgo?: number;
  }): Promise<string> {
    const { rows } = await db.admin.query<{ id: string }>(
      `insert into public.platform_model_tests
         (job, models, passed, result, tested_by, tested_at)
       values ($1, $2, $3, $4, $5, now() - make_interval(mins => $6))
       returning id;`,
      [
        input.job,
        input.models,
        input.passed ?? true,
        JSON.stringify({ costUsd: 0.008, ms: 3100 }),
        input.by ?? adminId,
        input.minutesAgo ?? 1,
      ],
    );
    return rows[0].id;
  }

  function save(job: string, models: string[], testId: string, by = adminId) {
    return db.asServiceRole((c) =>
      c.query("select public.save_platform_models($1, $2, $3, $4);", [
        job,
        models,
        testId,
        by,
      ]),
    );
  }

  it("saves after a passing test and records the change", async () => {
    const testId = await recordTest({
      job: "waiter",
      models: ["a/paid", "b:free"],
    });
    await save("waiter", ["a/paid", "b:free"], testId);

    const { rows } = await db.admin.query<{
      models: string[];
      updated_by: string;
    }>(
      "select models, updated_by from public.platform_settings where job = 'waiter';",
    );
    expect(rows[0]).toEqual({
      models: ["a/paid", "b:free"],
      updated_by: adminId,
    });

    const history = await db.admin.query<{
      action: string;
      old_models: string[] | null;
      new_models: string[];
      test_result: { costUsd: number };
      changed_by: string;
    }>(
      "select action, old_models, new_models, test_result, changed_by from public.platform_settings_history where job = 'waiter' order by changed_at desc limit 1;",
    );
    expect(history.rows[0]).toMatchObject({
      action: "save",
      old_models: null,
      new_models: ["a/paid", "b:free"],
      test_result: { costUsd: 0.008 },
      changed_by: adminId,
    });
  });

  it("records the list it replaced", async () => {
    const testId = await recordTest({ job: "waiter", models: ["c/paid"] });
    await save("waiter", ["c/paid"], testId);
    const { rows } = await db.admin.query<{ old_models: string[] }>(
      "select old_models from public.platform_settings_history where job = 'waiter' order by changed_at desc, id limit 1;",
    );
    expect(rows[0].old_models).toEqual(["a/paid", "b:free"]);
  });

  it("refuses a failed test", async () => {
    const testId = await recordTest({
      job: "vision",
      models: ["v:free"],
      passed: false,
    });
    await expect(save("vision", ["v:free"], testId)).rejects.toThrow(
      /MODEL_TEST_REQUIRED/,
    );
  });

  it("refuses a test of a different list, order or job", async () => {
    const testId = await recordTest({
      job: "vision",
      models: ["v:free", "w:free"],
    });
    await expect(save("vision", ["w:free", "v:free"], testId)).rejects.toThrow(
      /MODEL_TEST_REQUIRED/,
    );
    await expect(save("vision", ["v:free"], testId)).rejects.toThrow(
      /MODEL_TEST_REQUIRED/,
    );
    await expect(
      save("staff_assistant", ["v:free", "w:free"], testId),
    ).rejects.toThrow(/MODEL_TEST_REQUIRED/);
  });

  it("refuses someone else's test", async () => {
    const testId = await recordTest({
      job: "vision",
      models: ["v:free"],
      by: otherId,
    });
    await expect(save("vision", ["v:free"], testId)).rejects.toThrow(
      /MODEL_TEST_REQUIRED/,
    );
  });

  it("refuses a test more than 15 minutes old", async () => {
    const testId = await recordTest({
      job: "vision",
      models: ["v:free"],
      minutesAgo: 16,
    });
    await expect(save("vision", ["v:free"], testId)).rejects.toThrow(
      /MODEL_TEST_STALE/,
    );
  });

  it("refuses a paid model for a free-only job", async () => {
    const testId = await recordTest({ job: "drafts", models: ["a/paid"] });
    await expect(save("drafts", ["a/paid"], testId)).rejects.toThrow(
      /MODEL_NOT_FREE/,
    );
  });

  it("refuses an unknown test id", async () => {
    await expect(
      save("vision", ["v:free"], "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow(/MODEL_TEST_REQUIRED/);
  });

  it("can't be called by a signed-in restaurant owner, even with a real test", async () => {
    const testId = await recordTest({
      job: "vision",
      models: ["v:free"],
      by: otherId,
    });
    await expect(
      db.asUser(otherId, (c) =>
        c.query("select public.save_platform_models($1, $2, $3, $4);", [
          "vision",
          ["v:free"],
          testId,
          otherId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps the tests themselves out of a restaurant owner's reach", async () => {
    const read = await db
      .asUser(otherId, (c) =>
        c.query("select * from public.platform_model_tests;"),
      )
      .catch(() => ({ rows: [] }));
    expect(read.rows).toEqual([]);
    await expect(
      db.asUser(otherId, (c) =>
        c.query(
          "insert into public.platform_model_tests (job, models, passed, result, tested_by) values ('vision', array['v:free'], true, '{}', $1);",
          [otherId],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/);
  });
});
