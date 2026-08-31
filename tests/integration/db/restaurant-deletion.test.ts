// @vitest-environment node
//
// Deleting a restaurant (see
// supabase/migrations/20260831120000_audit_log_allow_restaurant_delete.sql).
//
// Nothing covered restaurant deletion until this file, and that gap hid a
// real defect for three days: 20260828090000_admin_audit_log.sql gave
// audit_log.restaurant_id a foreign key to restaurants while also firing an
// audit INSERT on every cascaded child DELETE. The cascade removes the
// parent first, so the audit insert referenced a restaurant that no longer
// existed and Postgres rejected the whole delete with 23503. Every
// restaurant in the database was undeletable — which broke offboarding and
// any data-deletion request, not just the clearing of test fixtures.
//
// The first test here is the regression test: before the fix it fails with
// "violates foreign key constraint audit_log_restaurant_id_fkey". The rest
// guard the two ways a naive fix could go wrong — silently disabling
// auditing for ordinary writes, or leaving another tenant's rows behind.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createModifier,
  createModifierOption,
  createTable,
  fullRestaurantFixture,
} from "./helpers";

describe("restaurant deletion", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("deletes a fully populated restaurant without tripping the audit log", async () => {
    const { restaurantId, menuItemId } = await fullRestaurantFixture(db);
    // Populate every audited table, so the cascade fires record_audit_log()
    // from as many directions as possible — including modifier_options,
    // which resolves its restaurant_id one hop away through its owning
    // modifier group rather than from a column of its own.
    const modifierId = await createModifier(db, restaurantId, menuItemId);
    await createModifierOption(db, modifierId);
    await createTable(db, restaurantId);
    const extraMember = await db.createAuthUser();
    await addMember(db, restaurantId, extraMember, "manager");

    await expect(
      db.admin.query("delete from public.restaurants where id = $1;", [
        restaurantId,
      ]),
    ).resolves.toBeDefined();

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.restaurants where id = $1;",
      [restaurantId],
    );
    expect(rows[0].count).toBe("0");
  });

  it("removes the deleted restaurant's audit rows with it", async () => {
    const { restaurantId } = await fullRestaurantFixture(db);
    await createTable(db, restaurantId);

    const before = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.audit_log where restaurant_id = $1;",
      [restaurantId],
    );
    // Guards against the skip being so eager that nothing is ever audited:
    // the fixture's own writes must have produced audit rows.
    expect(Number(before.rows[0].count)).toBeGreaterThan(0);

    await db.admin.query("delete from public.restaurants where id = $1;", [
      restaurantId,
    ]);

    const after = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.audit_log where restaurant_id = $1;",
      [restaurantId],
    );
    expect(after.rows[0].count).toBe("0");
  });

  it("still audits ordinary writes on a restaurant that exists", async () => {
    // The fix skips the audit write only when the restaurant is gone. A
    // guard that was too broad — or checked the wrong id — would quietly
    // stop auditing everything, which is worse than the bug it replaced.
    const { restaurantId, categoryId } = await fullRestaurantFixture(db);

    await db.admin.query(
      "update public.categories set name = $2 where id = $1;",
      [categoryId, "Renamed"],
    );

    const { rows } = await db.admin.query<{ operation: string }>(
      `select operation from public.audit_log
       where restaurant_id = $1 and table_name = 'categories' and row_id = $2
       order by seq desc limit 1;`,
      [restaurantId, categoryId],
    );
    expect(rows[0]?.operation).toBe("UPDATE");
  });

  it("still refuses to remove the last owner while the restaurant exists", async () => {
    // The other half of the fix relaxes enforce_at_least_one_owner() so a
    // restaurant's cascade can remove its final owner. That relaxation must
    // not leak into the case the guard exists for: while the restaurant is
    // still there, stranding it without an owner leaves it permanently
    // unmanageable and must still be refused.
    const { restaurantId, userId } = await fullRestaurantFixture(db);

    await expect(
      db.admin.query(
        "delete from public.restaurant_users where restaurant_id = $1 and user_id = $2;",
        [restaurantId, userId],
      ),
    ).rejects.toThrow(/last owner/i);

    await expect(
      db.admin.query(
        "update public.restaurant_users set role = 'manager' where restaurant_id = $1 and user_id = $2;",
        [restaurantId, userId],
      ),
    ).rejects.toThrow(/last owner/i);
  });

  it("leaves another restaurant's data untouched", async () => {
    const doomed = await fullRestaurantFixture(db);
    const survivor = await fullRestaurantFixture(db);
    await createTable(db, survivor.restaurantId);

    await db.admin.query("delete from public.restaurants where id = $1;", [
      doomed.restaurantId,
    ]);

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.menu_items where restaurant_id = $1;",
      [survivor.restaurantId],
    );
    expect(Number(rows[0].count)).toBeGreaterThan(0);

    const audit = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.audit_log where restaurant_id = $1;",
      [survivor.restaurantId],
    );
    expect(Number(audit.rows[0].count)).toBeGreaterThan(0);
  });
});
