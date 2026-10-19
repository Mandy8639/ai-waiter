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

describe("Undo and Emergency reset (20261027090000)", () => {
  let db: TestDb;
  let adminId: string;
  let ownerId: string;

  beforeAll(async () => {
    db = await createTestDb();
    adminId = await db.createAuthUser();
    ownerId = await db.createAuthUser();
    await addMember(db, await createRestaurant(db), ownerId, "owner");
  });

  afterAll(async () => {
    await db.close();
  });

  async function passingTest(job: string, models: string[]) {
    const { rows } = await db.admin.query<{ id: string }>(
      `insert into public.platform_model_tests (job, models, passed, result, tested_by)
       values ($1, $2, true, '{"ms": 1000, "costUsd": 0}', $3) returning id;`,
      [job, models, adminId],
    );
    return rows[0].id;
  }

  function lastHistory() {
    return db.admin
      .query<{
        job: string;
        action: string;
        old_models: string[] | null;
        new_models: string[] | null;
        test_result: { cleared?: Record<string, string[]> } | null;
        changed_by: string;
      }>(
        "select job, action, old_models, new_models, test_result, changed_by from public.platform_settings_history order by changed_at desc, id desc limit 1;",
      )
      .then((r) => r.rows[0]);
  }

  it("records a restore by Undo as an undo, still needing a passing test", async () => {
    const first = await passingTest("vision", ["a:free"]);
    await db.asServiceRole((c) =>
      c.query("select public.save_platform_models($1, $2, $3, $4);", [
        "vision",
        ["a:free"],
        first,
        adminId,
      ]),
    );
    const again = await passingTest("vision", ["b:free"]);
    await db.asServiceRole((c) =>
      c.query("select public.save_platform_models($1, $2, $3, $4, 'undo');", [
        "vision",
        ["b:free"],
        again,
        adminId,
      ]),
    );
    expect(await lastHistory()).toMatchObject({
      action: "undo",
      old_models: ["a:free"],
      new_models: ["b:free"],
    });
    await expect(
      db.asServiceRole((c) =>
        c.query(
          "select public.save_platform_models($1, $2, $3, $4, 'delete');",
          ["vision", ["b:free"], again, adminId],
        ),
      ),
    ).rejects.toThrow(/MODEL_ACTION_INVALID/);
  });

  it("clears one job back to its default, recorded as an undo", async () => {
    await expect(
      db.asServiceRole((c) =>
        c.query("select public.clear_platform_models('vision', $1) as n;", [
          adminId,
        ]),
      ),
    ).resolves.toMatchObject({ rows: [{ n: 1 }] });
    const { rows } = await db.admin.query(
      "select 1 from public.platform_settings where job = 'vision';",
    );
    expect(rows).toEqual([]);
    expect(await lastHistory()).toMatchObject({
      job: "vision",
      action: "undo",
      old_models: ["b:free"],
      new_models: null,
    });
  });

  it("does nothing, and records nothing, when the job had nothing saved", async () => {
    const before = await lastHistory();
    await expect(
      db.asServiceRole((c) =>
        c.query("select public.clear_platform_models('vision', $1) as n;", [
          adminId,
        ]),
      ),
    ).resolves.toMatchObject({ rows: [{ n: 0 }] });
    expect(await lastHistory()).toEqual(before);
  });

  it("resets every job at once, and records what it cleared and who", async () => {
    for (const [job, models] of [
      ["waiter", ["w/paid"]],
      ["drafts", ["d:free"]],
    ] as const) {
      const id = await passingTest(job, [...models]);
      await db.asServiceRole((c) =>
        c.query("select public.save_platform_models($1, $2, $3, $4);", [
          job,
          [...models],
          id,
          adminId,
        ]),
      );
    }
    await expect(
      db.asServiceRole((c) =>
        c.query("select public.clear_platform_models(null, $1) as n;", [
          adminId,
        ]),
      ),
    ).resolves.toMatchObject({ rows: [{ n: 2 }] });
    const { rows } = await db.admin.query(
      "select 1 from public.platform_settings;",
    );
    expect(rows).toEqual([]);
    expect(await lastHistory()).toMatchObject({
      job: "all",
      action: "reset",
      changed_by: adminId,
      test_result: { cleared: { waiter: ["w/paid"], drafts: ["d:free"] } },
    });
  });

  it("refuses an unknown job", async () => {
    await expect(
      db.asServiceRole((c) =>
        c.query("select public.clear_platform_models('billing', $1);", [
          adminId,
        ]),
      ),
    ).rejects.toThrow(/MODEL_JOB_INVALID/);
  });

  it("can't be called by a signed-in restaurant owner", async () => {
    await expect(
      db.asUser(ownerId, (c) =>
        c.query("select public.clear_platform_models(null, $1);", [ownerId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
