// @vitest-environment node
//
// admin_audit_log (see supabase/migrations/20260828090000_admin_audit_log.sql) —
// closes the Item-6 audit's last open gap: order lifecycle has
// order_status_history and AI-driven mutations have ai_conversation_messages,
// but admin-side CRUD (menu/settings/staff tables) had no change history at
// all. These tests verify the generic record_audit_log() trigger actually
// fires with correct attribution for INSERT/UPDATE/DELETE across the tables
// it's attached to, the modifier_options special-case restaurant_id
// resolution (it has no restaurant_id column of its own), and that the
// audit trail itself is read-only to clients and scoped to managers/owners.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCategory,
  createModifier,
  createTable,
  fullRestaurantFixture,
} from "./helpers";

interface AuditRow {
  table_name: string;
  row_id: string;
  operation: string;
  actor_id: string | null;
  actor_role: string | null;
  restaurant_id: string;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
}

async function latestAuditRow(
  db: TestDb,
  tableName: string,
  rowId: string,
): Promise<AuditRow> {
  const { rows } = await db.admin.query<AuditRow>(
    `select table_name, row_id, operation, actor_id, actor_role, restaurant_id, old_data, new_data
     from public.audit_log
     where table_name = $1 and row_id = $2
     order by seq desc
     limit 1;`,
    [tableName, rowId],
  );
  expect(rows.length).toBe(1);
  return rows[0];
}

describe("admin_audit_log", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("records an INSERT with the actor's identity and role, and the new row's data", async () => {
    const fx = await fullRestaurantFixture(db, "manager");

    const { rows } = await db.asUser(fx.userId, (c) =>
      c.query<{ id: string }>(
        "insert into public.categories (restaurant_id, name) values ($1, 'Desserts') returning id;",
        [fx.restaurantId],
      ),
    );
    const categoryId = rows[0].id;

    const audit = await latestAuditRow(db, "categories", categoryId);
    expect(audit.operation).toBe("INSERT");
    expect(audit.restaurant_id).toBe(fx.restaurantId);
    expect(audit.actor_id).toBe(fx.userId);
    expect(audit.actor_role).toBe("manager");
    expect(audit.old_data).toBeNull();
    expect(audit.new_data).toMatchObject({ name: "Desserts" });
  });

  it("records an UPDATE with both the before and after data", async () => {
    const fx = await fullRestaurantFixture(db, "owner");

    await db.asUser(fx.userId, (c) =>
      c.query("update public.menu_items set price = 12.5 where id = $1;", [
        fx.menuItemId,
      ]),
    );

    const audit = await latestAuditRow(db, "menu_items", fx.menuItemId);
    expect(audit.operation).toBe("UPDATE");
    expect(audit.actor_role).toBe("owner");
    expect(Number(audit.old_data?.price)).toBe(9.99);
    expect(Number(audit.new_data?.price)).toBe(12.5);
  });

  it("records a DELETE with the row's last known data and no new_data", async () => {
    const fx = await fullRestaurantFixture(db, "manager");
    const tableId = await createTable(db, fx.restaurantId, "table-to-delete");

    await db.asUser(fx.userId, (c) =>
      c.query("delete from public.tables where id = $1;", [tableId]),
    );

    const audit = await latestAuditRow(db, "tables", tableId);
    expect(audit.operation).toBe("DELETE");
    expect(audit.old_data).toMatchObject({ table_number: "table-to-delete" });
    expect(audit.new_data).toBeNull();
  });

  it("resolves restaurant_id for modifier_options via its owning modifier group, which has no restaurant_id column of its own", async () => {
    const fx = await fullRestaurantFixture(db, "owner");
    const modifierId = await createModifier(db, fx.restaurantId, fx.menuItemId);

    const { rows } = await db.asUser(fx.userId, (c) =>
      c.query<{ id: string }>(
        "insert into public.modifier_options (modifier_id, name) values ($1, 'Extra cheese') returning id;",
        [modifierId],
      ),
    );
    const optionId = rows[0].id;

    const audit = await latestAuditRow(db, "modifier_options", optionId);
    expect(audit.restaurant_id).toBe(fx.restaurantId);
    expect(audit.actor_role).toBe("owner");
  });

  it("records restaurant_users membership changes (an owner adding a new staff member)", async () => {
    const fx = await fullRestaurantFixture(db, "owner");
    const newStaffUserId = await db.createAuthUser();

    const { rows } = await db.asUser(fx.userId, (c) =>
      c.query<{ id: string }>(
        "insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, 'staff') returning id;",
        [fx.restaurantId, newStaffUserId],
      ),
    );

    const audit = await latestAuditRow(db, "restaurant_users", rows[0].id);
    expect(audit.operation).toBe("INSERT");
    expect(audit.actor_id).toBe(fx.userId);
    expect(audit.actor_role).toBe("owner");
    expect(audit.new_data).toMatchObject({ role: "staff" });
  });

  it("is readable by an owner/manager but not by kitchen/staff", async () => {
    const fx = await fullRestaurantFixture(db, "owner");
    await createCategory(db, fx.restaurantId, "Read-scope test category");
    const kitchenUserId = await db.createAuthUser();
    await addMember(db, fx.restaurantId, kitchenUserId, "kitchen");

    const ownerRead = await db.asUser(fx.userId, (c) =>
      c.query("select 1 from public.audit_log where restaurant_id = $1;", [
        fx.restaurantId,
      ]),
    );
    expect(ownerRead.rows.length).toBeGreaterThan(0);

    const kitchenRead = await db.asUser(kitchenUserId, (c) =>
      c.query("select 1 from public.audit_log where restaurant_id = $1;", [
        fx.restaurantId,
      ]),
    );
    expect(kitchenRead.rows.length).toBe(0);
  });

  it("never lets a manager/owner read a different restaurant's audit trail", async () => {
    const fxA = await fullRestaurantFixture(db, "owner");
    await createCategory(db, fxA.restaurantId, "Restaurant A category");
    const fxB = await fullRestaurantFixture(db, "owner");

    const crossTenantRead = await db.asUser(fxB.userId, (c) =>
      c.query("select 1 from public.audit_log where restaurant_id = $1;", [
        fxA.restaurantId,
      ]),
    );
    expect(crossTenantRead.rows.length).toBe(0);
  });

  it("has no client-facing write path — not even an owner can insert, update, or delete audit_log rows directly", async () => {
    const fx = await fullRestaurantFixture(db, "owner");
    await createCategory(db, fx.restaurantId, "Write-path test category");

    // INSERT with no applicable policy throws outright (RLS's WITH CHECK
    // rejects the new row) — matches every other no-insert-policy table in
    // this schema (e.g. orders, order_status_history).
    await expect(
      db.asUser(fx.userId, (c) =>
        c.query(
          `insert into public.audit_log (restaurant_id, table_name, row_id, operation)
           values ($1, 'categories', gen_random_uuid(), 'INSERT');`,
          [fx.restaurantId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // UPDATE/DELETE with no applicable policy don't throw — RLS's USING
    // clause makes every row invisible to the statement, so it succeeds
    // having matched zero rows. Same pattern as rls-tenant-isolation.test.ts.
    const updateResult = await db.asUser(fx.userId, (c) =>
      c.query(
        "update public.audit_log set actor_role = 'owner' where restaurant_id = $1;",
        [fx.restaurantId],
      ),
    );
    expect(updateResult.affectedRows ?? 0).toBe(0);

    const deleteResult = await db.asUser(fx.userId, (c) =>
      c.query("delete from public.audit_log where restaurant_id = $1;", [
        fx.restaurantId,
      ]),
    );
    expect(deleteResult.affectedRows ?? 0).toBe(0);
  });

  it("anon has no read access at all", async () => {
    const fx = await fullRestaurantFixture(db, "owner");
    await createCategory(db, fx.restaurantId, "Anon-should-not-see-this");

    const anonRead = await db.asAnon((c) =>
      c.query("select 1 from public.audit_log where restaurant_id = $1;", [
        fx.restaurantId,
      ]),
    );
    expect(anonRead.rows.length).toBe(0);
  });
});
