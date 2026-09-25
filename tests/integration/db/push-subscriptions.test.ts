// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCustomerSession,
  createRestaurant,
  createTable,
  type Role,
} from "./helpers";

/**
 * Phase F: which devices get kitchen alerts, and who can see them.
 *
 * A subscription's endpoint and keys are enough to put a notification on
 * that device, so the tests here are mostly about who must NOT be able to
 * read or change one — above all the diner, whose order is what triggers
 * a push.
 */

describe("push subscriptions", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  let n = 0;
  function device() {
    n += 1;
    return {
      endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}-${Date.now()}`,
      p256dh: "B".repeat(87),
      auth: "a".repeat(22),
    };
  }

  async function member(role: Role = "kitchen") {
    const restaurantId = await createRestaurant(db);
    const userId = await db.createAuthUser();
    await addMember(db, restaurantId, userId, role);
    return { restaurantId, userId };
  }

  async function save(
    userId: string,
    restaurantId: string,
    d = device(),
    userAgent: string | null = "Test tablet",
  ) {
    await db.asUser(userId, (c) =>
      c.query("select public.save_push_subscription($1, $2, $3, $4, $5);", [
        restaurantId,
        d.endpoint,
        d.p256dh,
        d.auth,
        userAgent,
      ]),
    );
    return d;
  }

  async function own(userId: string) {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ endpoint: string; restaurant_id: string }>(
        "select endpoint, restaurant_id from public.push_subscriptions;",
      ),
    );
    return rows;
  }

  describe("turning alerts on", () => {
    it.each(["owner", "manager", "kitchen", "staff"] as Role[])(
      "lets a %s turn alerts on for their device",
      async (role) => {
        const { restaurantId, userId } = await member(role);
        const d = await save(userId, restaurantId);
        expect(await own(userId)).toEqual([
          { endpoint: d.endpoint, restaurant_id: restaurantId },
        ]);
      },
    );

    it("refuses a diner — an anonymous table session is a member of nothing", async () => {
      const restaurantId = await createRestaurant(db);
      const tableId = await createTable(db, restaurantId);
      const { userId } = await createCustomerSession(db, restaurantId, tableId);
      await expect(save(userId, restaurantId)).rejects.toThrow(
        /PUSH_NOT_A_MEMBER/,
      );
    });

    it("refuses a staff member of a different restaurant", async () => {
      const a = await member();
      const b = await member();
      await expect(save(b.userId, a.restaurantId)).rejects.toThrow(
        /PUSH_NOT_A_MEMBER/,
      );
    });

    it("refuses anything that is not an https push endpoint", async () => {
      const { restaurantId, userId } = await member();
      await expect(
        save(userId, restaurantId, {
          ...device(),
          endpoint: "http://attacker.example/collect",
        }),
      ).rejects.toThrow(/push_subscriptions_endpoint_https/);
    });

    it("lets the same device re-subscribe without a duplicate row", async () => {
      const { restaurantId, userId } = await member();
      const d = await save(userId, restaurantId);
      await save(userId, restaurantId, d);
      expect(await own(userId)).toHaveLength(1);
    });

    it("hands a shared tablet to whoever turned alerts on last", async () => {
      // The kitchen tablet, used by two cooks on different shifts: the
      // device receives the alerts, whoever it is registered to.
      const { restaurantId, userId: first } = await member();
      const second = await db.createAuthUser();
      await addMember(db, restaurantId, second, "kitchen");

      const d = await save(first, restaurantId);
      await save(second, restaurantId, d);

      expect(await own(first)).toEqual([]);
      expect(await own(second)).toHaveLength(1);
    });

    it("allows one device to take alerts for two restaurants", async () => {
      const owner = await db.createAuthUser();
      const a = await createRestaurant(db);
      const b = await createRestaurant(db);
      await addMember(db, a, owner, "owner");
      await addMember(db, b, owner, "owner");
      const d = await save(owner, a);
      await save(owner, b, d);
      expect(await own(owner)).toHaveLength(2);
    });
  });

  describe("who can see a subscription", () => {
    it("shows a member only their own devices, not a colleague's", async () => {
      const { restaurantId, userId: cook } = await member("kitchen");
      const boss = await db.createAuthUser();
      await addMember(db, restaurantId, boss, "owner");
      await save(cook, restaurantId);

      // Even the owner does not read a cook's device credentials.
      expect(await own(boss)).toEqual([]);
    });

    it("shows a diner nothing, even at the restaurant they are ordering from", async () => {
      const { restaurantId, userId } = await member();
      await save(userId, restaurantId);
      const tableId = await createTable(db, restaurantId);
      const diner = await createCustomerSession(db, restaurantId, tableId);
      expect(await own(diner.userId)).toEqual([]);
    });

    it("refuses a direct insert, even by a member", async () => {
      const { restaurantId, userId } = await member();
      const d = device();
      await expect(
        db.asUser(userId, (c) =>
          c.query(
            "insert into public.push_subscriptions (restaurant_id, user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4, $5);",
            [restaurantId, userId, d.endpoint, d.p256dh, d.auth],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("is not callable at all by a signed-out visitor", async () => {
      await expect(
        db.asAnon((c) =>
          c.query(
            "select public.save_push_subscription($1, 'https://x', 'k', 'a');",
            [crypto.randomUUID()],
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("turning alerts off", () => {
    it("removes the caller's own device", async () => {
      const { restaurantId, userId } = await member();
      const d = await save(userId, restaurantId);
      await db.asUser(userId, (c) =>
        c.query("select public.delete_push_subscription($1);", [d.endpoint]),
      );
      expect(await own(userId)).toEqual([]);
    });

    it("cannot remove someone else's device, even knowing its endpoint", async () => {
      const { restaurantId, userId: cook } = await member();
      const other = await db.createAuthUser();
      await addMember(db, restaurantId, other, "kitchen");
      const d = await save(cook, restaurantId);

      await db.asUser(other, (c) =>
        c.query("select public.delete_push_subscription($1);", [d.endpoint]),
      );
      expect(await own(cook)).toHaveLength(1);
    });

    it("drops every device of a member who is removed from the restaurant", async () => {
      const { restaurantId, userId } = await member();
      await save(userId, restaurantId);
      await db.admin.query(
        "delete from public.restaurant_users where restaurant_id = $1 and user_id = $2;",
        [restaurantId, userId],
      );
      const { rows } = await db.admin.query(
        "select 1 from public.push_subscriptions where user_id = $1;",
        [userId],
      );
      expect(rows).toEqual([]);
    });
  });

  describe("the once-only record", () => {
    it("lets an order be claimed exactly once", async () => {
      const restaurantId = await createRestaurant(db);
      const orderId = crypto.randomUUID();
      const claim = () =>
        db.asServiceRole((c) =>
          c.query<{ id: string }>(
            `insert into public.push_dispatches (restaurant_id, kind, source_id)
             values ($1, 'order', $2)
             on conflict (kind, source_id) do nothing
             returning id;`,
            [restaurantId, orderId],
          ),
        );
      expect((await claim()).rows).toHaveLength(1);
      expect((await claim()).rows).toHaveLength(0);
    });

    it("is invisible to everyone but the service role", async () => {
      const { restaurantId, userId } = await member("owner");
      await db.admin.query(
        "insert into public.push_dispatches (restaurant_id, kind, source_id) values ($1, 'order', $2);",
        [restaurantId, crypto.randomUUID()],
      );
      const { rows } = await db.asUser(userId, (c) =>
        c.query("select * from public.push_dispatches;"),
      );
      expect(rows).toEqual([]);
    });
  });
});
