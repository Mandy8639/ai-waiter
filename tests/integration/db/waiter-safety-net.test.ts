// @vitest-environment node
//
// The safety net's store (20261025090000, per job since 20261026090000):
// server-only, like
// platform_settings, and free models only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant } from "./helpers";

describe("waiter safety net store", () => {
  let db: TestDb;
  let ownerId: string;

  beforeAll(async () => {
    db = await createTestDb();
    ownerId = await db.createAuthUser();
    await addMember(db, await createRestaurant(db), ownerId, "owner");
  });

  afterAll(async () => {
    await db.close();
  });

  it("holds free models only, with a known status", async () => {
    await db.admin.query(
      "insert into public.free_model_checks (job, model, status, last_passed_at, pass_ms) values ('waiter', 'a/b:free', 'passed', now(), 3000);",
    );
    await expect(
      db.admin.query(
        "insert into public.free_model_checks (job, model, status) values ('waiter', 'a/paid', 'passed');",
      ),
    ).rejects.toThrow(/free_only/);
    await expect(
      db.admin.query(
        "insert into public.free_model_checks (job, model, status) values ('waiter', 'c/d:free', 'great');",
      ),
    ).rejects.toThrow(/status_valid/);
  });

  it("keeps each job's result for the same model apart", async () => {
    await db.admin.query(
      "insert into public.free_model_checks (job, model, status) values ('staff_assistant', 'a/b:free', 'failed');",
    );
    const { rows } = await db.admin.query<{ job: string; status: string }>(
      "select job, status from public.free_model_checks where model = 'a/b:free' order by job;",
    );
    expect(rows).toEqual([
      { job: "staff_assistant", status: "failed" },
      { job: "waiter", status: "passed" },
    ]);
    await expect(
      db.admin.query(
        "insert into public.free_model_checks (job, model, status) values ('vision', 'x:free', 'passed');",
      ),
    ).rejects.toThrow(/job_valid/);
  });

  it("takes only known switches", async () => {
    await db.admin.query(
      "insert into public.platform_switches (name, enabled) values ('staff_assistant_safety_net', true);",
    );
    await db.admin.query(
      "insert into public.platform_switches (name, enabled) values ('waiter_safety_net', false);",
    );
    await expect(
      db.admin.query(
        "insert into public.platform_switches (name, enabled) values ('billing', true);",
      ),
    ).rejects.toThrow(/name_valid/);
  });

  it("is invisible and unwritable to a restaurant owner and a visitor", async () => {
    for (const table of ["free_model_checks", "platform_switches"]) {
      const asOwner = await db
        .asUser(ownerId, (c) => c.query(`select * from public.${table};`))
        .catch(() => ({ rows: [] }));
      expect(asOwner.rows).toEqual([]);
      const asAnon = await db
        .asAnon((c) => c.query(`select * from public.${table};`))
        .catch(() => ({ rows: [] }));
      expect(asAnon.rows).toEqual([]);
    }
    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "insert into public.free_model_checks (job, model, status, last_passed_at) values ('waiter', 'evil:free', 'passed', now());",
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/);
    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "update public.platform_switches set enabled = true where name = 'waiter_safety_net' returning name;",
        ),
      ),
    ).resolves.toMatchObject({ rows: [] });
  });
});
