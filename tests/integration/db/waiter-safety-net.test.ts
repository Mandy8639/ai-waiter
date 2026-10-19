// @vitest-environment node
//
// The safety net's store (20261025090000): server-only, like
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
      "insert into public.free_model_checks (model, status, last_passed_at, pass_ms) values ('a/b:free', 'passed', now(), 3000);",
    );
    await expect(
      db.admin.query(
        "insert into public.free_model_checks (model, status) values ('a/paid', 'passed');",
      ),
    ).rejects.toThrow(/free_only/);
    await expect(
      db.admin.query(
        "insert into public.free_model_checks (model, status) values ('c/d:free', 'great');",
      ),
    ).rejects.toThrow(/status_valid/);
  });

  it("takes only known switches", async () => {
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
          "insert into public.free_model_checks (model, status, last_passed_at) values ('evil:free', 'passed', now());",
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
