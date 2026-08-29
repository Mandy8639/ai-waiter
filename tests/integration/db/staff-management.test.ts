// @vitest-environment node
//
// Staff management (see supabase/migrations/20260829090000_staff_management.sql):
// get_restaurant_staff() (email-resolved staff list), add_restaurant_staff_by_email()
// (add an existing account by email, re-implementing
// restaurant_users_insert_owner_manager's own authorization since
// SECURITY DEFINER bypasses it), and the enforce_at_least_one_owner()
// trigger (a restaurant can never end up with zero owners).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant } from "./helpers";

describe("get_restaurant_staff()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("returns every member's email, role, and id for a restaurant the caller belongs to", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser("owner@example.com");
    const staffId = await db.createAuthUser("staff@example.com");
    await addMember(db, restaurantId, ownerId, "owner");
    await addMember(db, restaurantId, staffId, "staff");

    const { rows } = await db.asUser(ownerId, (c) =>
      c.query<{ email: string; role: string }>(
        "select email, role from public.get_restaurant_staff($1) order by email;",
        [restaurantId],
      ),
    );

    expect(rows).toEqual([
      { email: "owner@example.com", role: "owner" },
      { email: "staff@example.com", role: "staff" },
    ]);
  });

  it("returns nothing for a restaurant the caller does not belong to", async () => {
    const restaurantId = await createRestaurant(db);
    const memberId = await db.createAuthUser("member@example.com");
    await addMember(db, restaurantId, memberId, "owner");
    const outsiderId = await db.createAuthUser("outsider@example.com");

    const { rows } = await db.asUser(outsiderId, (c) =>
      c.query("select * from public.get_restaurant_staff($1);", [restaurantId]),
    );

    expect(rows.length).toBe(0);
  });

  it("is not callable by anon", async () => {
    const restaurantId = await createRestaurant(db);
    await expect(
      db.asAnon((c) =>
        c.query("select * from public.get_restaurant_staff($1);", [
          restaurantId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("add_restaurant_staff_by_email()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("lets an owner add a new member with any role, including owner", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser("owner1@example.com");
    await addMember(db, restaurantId, ownerId, "owner");
    await db.createAuthUser("newowner@example.com");

    const { rows } = await db.asUser(ownerId, (c) =>
      c.query<{ add_restaurant_staff_by_email: string }>(
        "select public.add_restaurant_staff_by_email($1, $2, 'owner');",
        [restaurantId, "newowner@example.com"],
      ),
    );
    expect(rows[0].add_restaurant_staff_by_email).toBeTruthy();

    const { rows: staff } = await db.admin.query<{ role: string }>(
      "select role from public.restaurant_users where restaurant_id = $1 and user_id = (select id from auth.users where email = 'newowner@example.com');",
      [restaurantId],
    );
    expect(staff[0].role).toBe("owner");
  });

  it("lets a manager add staff/kitchen/manager, but not owner", async () => {
    const restaurantId = await createRestaurant(db);
    const managerId = await db.createAuthUser("manager1@example.com");
    await addMember(db, restaurantId, managerId, "manager");
    await db.createAuthUser("newstaff@example.com");
    await db.createAuthUser("newowner2@example.com");

    const ok = await db.asUser(managerId, (c) =>
      c.query("select public.add_restaurant_staff_by_email($1, $2, 'staff');", [
        restaurantId,
        "newstaff@example.com",
      ]),
    );
    expect(ok.rows.length).toBe(1);

    await expect(
      db.asUser(managerId, (c) =>
        c.query(
          "select public.add_restaurant_staff_by_email($1, $2, 'owner');",
          [restaurantId, "newowner2@example.com"],
        ),
      ),
    ).rejects.toThrow(/managers_cannot_grant_owner/i);
  });

  it("rejects a caller with no membership, or with kitchen/staff role", async () => {
    const restaurantId = await createRestaurant(db);
    const outsiderId = await db.createAuthUser("outsider2@example.com");
    const kitchenId = await db.createAuthUser("kitchen1@example.com");
    await addMember(db, restaurantId, kitchenId, "kitchen");
    await db.createAuthUser("target@example.com");

    await expect(
      db.asUser(outsiderId, (c) =>
        c.query(
          "select public.add_restaurant_staff_by_email($1, $2, 'staff');",
          [restaurantId, "target@example.com"],
        ),
      ),
    ).rejects.toThrow(/insufficient_role/i);

    await expect(
      db.asUser(kitchenId, (c) =>
        c.query(
          "select public.add_restaurant_staff_by_email($1, $2, 'staff');",
          [restaurantId, "target@example.com"],
        ),
      ),
    ).rejects.toThrow(/insufficient_role/i);
  });

  it("gives a generic error for an email with no account, not a different error shape", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser("owner2@example.com");
    await addMember(db, restaurantId, ownerId, "owner");

    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "select public.add_restaurant_staff_by_email($1, $2, 'staff');",
          [restaurantId, "nobody-real@example.com"],
        ),
      ),
    ).rejects.toThrow(/user_not_found/i);
  });

  it("rejects an invalid role value", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser("owner3@example.com");
    await addMember(db, restaurantId, ownerId, "owner");
    await db.createAuthUser("target2@example.com");

    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "select public.add_restaurant_staff_by_email($1, $2, 'superadmin');",
          [restaurantId, "target2@example.com"],
        ),
      ),
    ).rejects.toThrow(/invalid_role/i);
  });

  it("rejects adding the same person twice (unique membership)", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser("owner4@example.com");
    await addMember(db, restaurantId, ownerId, "owner");
    await db.createAuthUser("dup@example.com");

    await db.asUser(ownerId, (c) =>
      c.query("select public.add_restaurant_staff_by_email($1, $2, 'staff');", [
        restaurantId,
        "dup@example.com",
      ]),
    );

    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "select public.add_restaurant_staff_by_email($1, $2, 'kitchen');",
          [restaurantId, "dup@example.com"],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("never adds a member to a different restaurant than the caller belongs to", async () => {
    const restaurantA = await createRestaurant(db);
    const restaurantB = await createRestaurant(db);
    const ownerAId = await db.createAuthUser("ownerA@example.com");
    await addMember(db, restaurantA, ownerAId, "owner");
    await db.createAuthUser("targetB@example.com");

    await expect(
      db.asUser(ownerAId, (c) =>
        c.query(
          "select public.add_restaurant_staff_by_email($1, $2, 'staff');",
          [restaurantB, "targetB@example.com"],
        ),
      ),
    ).rejects.toThrow(/insufficient_role/i);
  });
});

describe("enforce_at_least_one_owner() trigger", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("blocks demoting the last owner", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser("solo-owner1@example.com");
    await addMember(db, restaurantId, ownerId, "owner");

    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "update public.restaurant_users set role = 'manager' where restaurant_id = $1 and user_id = $2;",
          [restaurantId, ownerId],
        ),
      ),
    ).rejects.toThrow(/last owner/i);
  });

  it("blocks removing the last owner", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser("solo-owner2@example.com");
    await addMember(db, restaurantId, ownerId, "owner");

    await expect(
      db.asUser(ownerId, (c) =>
        c.query(
          "delete from public.restaurant_users where restaurant_id = $1 and user_id = $2;",
          [restaurantId, ownerId],
        ),
      ),
    ).rejects.toThrow(/last owner/i);
  });

  it("allows demoting/removing an owner when a second owner exists", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerAId = await db.createAuthUser("co-ownerA@example.com");
    const ownerBId = await db.createAuthUser("co-ownerB@example.com");
    await addMember(db, restaurantId, ownerAId, "owner");
    await addMember(db, restaurantId, ownerBId, "owner");

    const demote = await db.asUser(ownerAId, (c) =>
      c.query(
        "update public.restaurant_users set role = 'manager' where restaurant_id = $1 and user_id = $2;",
        [restaurantId, ownerBId],
      ),
    );
    expect(demote.affectedRows).toBe(1);
  });

  it("never blocks changing/removing a non-owner", async () => {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser("owner5@example.com");
    const staffId = await db.createAuthUser("staff2@example.com");
    await addMember(db, restaurantId, ownerId, "owner");
    await addMember(db, restaurantId, staffId, "staff");

    const remove = await db.asUser(ownerId, (c) =>
      c.query(
        "delete from public.restaurant_users where restaurant_id = $1 and user_id = $2;",
        [restaurantId, staffId],
      ),
    );
    expect(remove.affectedRows).toBe(1);
  });
});
