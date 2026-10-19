// @vitest-environment node
//
// platform_settings (20261023090000): the store behind /admin. Only the
// server reads or writes it. A restaurant owner's session must not be able
// to see which models the platform uses, let alone change them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant } from "./helpers";

describe("platform settings store", () => {
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

  // Two layers stop them: the migration revokes the table privileges, and
  // RLS is on with no policy. This harness re-grants every table after the
  // migrations (setup.ts, standing in for Supabase's defaults), so what is
  // checked here is the layer that holds even if a grant comes back: no
  // rows are visible and no write is accepted.
  it("is invisible and unwritable to a signed-in restaurant owner", async () => {
    await db.admin.query(
      "insert into public.platform_settings (job, models) values ('vision', array['a/b:free']);",
    );
    const read = await db
      .asUser(ownerId, (c) =>
        c.query("select * from public.platform_settings;"),
      )
      .catch(() => ({ rows: [] }));
    expect(read.rows).toEqual([]);
    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "insert into public.platform_settings (job, models) values ('waiter', array['x']);",
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/);
    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "update public.platform_settings set models = array['evil'] where job = 'vision' returning job;",
        ),
      ),
    ).resolves.toMatchObject({ rows: [] });
    const history = await db
      .asUser(ownerId, (c) =>
        c.query("select * from public.platform_settings_history;"),
      )
      .catch(() => ({ rows: [] }));
    expect(history.rows).toEqual([]);

    const { rows } = await db.admin.query<{ models: string[] }>(
      "select models from public.platform_settings where job = 'vision';",
    );
    expect(rows[0].models).toEqual(["a/b:free"]);
  });

  it("is invisible to a signed-out visitor", async () => {
    const read = await db
      .asAnon((c) => c.query("select * from public.platform_settings;"))
      .catch(() => ({ rows: [] }));
    expect(read.rows).toEqual([]);
  });

  it("holds one to three models per job, and only known jobs", async () => {
    await expect(
      db.admin.query(
        "insert into public.platform_settings (job, models) values ('waiter', array[]::text[]);",
      ),
    ).rejects.toThrow(/models_count/);
    await expect(
      db.admin.query(
        "insert into public.platform_settings (job, models) values ('waiter', array['a','b','c','d']);",
      ),
    ).rejects.toThrow(/models_count/);
    await expect(
      db.admin.query(
        "insert into public.platform_settings (job, models) values ('waiter', array['a', '']);",
      ),
    ).rejects.toThrow(/no_blanks/);
    await expect(
      db.admin.query(
        "insert into public.platform_settings (job, models) values ('billing', array['a']);",
      ),
    ).rejects.toThrow(/job_valid/);
  });

  it("records history with a known action", async () => {
    await db.admin.query(
      `insert into public.platform_settings_history (job, action, old_models, new_models)
       values ('all', 'reset', null, null);`,
    );
    await expect(
      db.admin.query(
        "insert into public.platform_settings_history (job, action) values ('waiter', 'delete');",
      ),
    ).rejects.toThrow(/action_valid/);
  });
});
