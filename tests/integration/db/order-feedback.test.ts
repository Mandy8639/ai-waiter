// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture, type Role } from "./helpers";

/**
 * Phase N: diner feedback. Only the diner who placed a served order can
 * leave it, once, within two days, voting only on dishes on that order —
 * and only owners and managers can read it.
 */

describe("order feedback", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function servedOrder() {
    const f = await fullOrderFixture(db);
    // One step at a time: the status trigger refuses skipping ahead.
    for (const status of ["confirmed", "preparing", "ready", "served"]) {
      await db.admin.query(
        "update public.orders set status = $2 where id = $1;",
        [f.orderId, status],
      );
    }
    const { rows } = await db.admin.query<{ id: string }>(
      "select id from public.order_items where order_id = $1;",
      [f.orderId],
    );
    return { ...f, orderItemId: rows[0].id };
  }

  async function submit(
    userId: string,
    orderId: string,
    rating = 4,
    comment: string | null = "Lovely dosa",
    votes: Record<string, unknown> | null = null,
  ) {
    await db.asUser(userId, (c) =>
      c.query("select public.submit_order_feedback($1, $2, $3, $4);", [
        orderId,
        rating,
        comment,
        votes === null ? null : JSON.stringify(votes),
      ]),
    );
  }

  async function state(userId: string, orderId: string) {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ feedback_state: string; feedback_rating: number | null }>(
        "select * from public.get_my_order_feedback_state($1);",
        [orderId],
      ),
    );
    return rows[0];
  }

  describe("who can leave it, and when", () => {
    it("opens once the diner's order is served, and takes rating, comment and dish votes", async () => {
      const f = await fullOrderFixture(db);
      expect(await state(f.customerUserId, f.orderId)).toEqual({
        feedback_state: "not_yet",
        feedback_rating: null,
      });
      await expect(submit(f.customerUserId, f.orderId)).rejects.toThrow(
        /FEEDBACK_NOT_SERVED/,
      );

      const o = await servedOrder();
      expect((await state(o.customerUserId, o.orderId)).feedback_state).toBe(
        "open",
      );
      await submit(o.customerUserId, o.orderId, 2, "  Cold when it came  ", {
        [o.orderItemId]: false,
      });
      expect(await state(o.customerUserId, o.orderId)).toEqual({
        feedback_state: "given",
        feedback_rating: 2,
      });

      const { rows } = await db.admin.query(
        `select f.rating, f.comment, f.table_id = $2 as right_table,
                i.liked, i.menu_item_id = $3 as right_dish
         from public.order_feedback f
         join public.order_item_feedback i on i.order_id = f.order_id
         where f.order_id = $1;`,
        [o.orderId, o.tableId, o.menuItemId],
      );
      expect(rows).toEqual([
        {
          rating: 2,
          comment: "Cold when it came",
          right_table: true,
          liked: false,
          right_dish: true,
        },
      ]);
    });

    it("refuses anyone but the diner who ordered — staff and other diners included", async () => {
      const o = await servedOrder();
      const other = await servedOrder();
      expect(
        (await state(other.customerUserId, o.orderId)).feedback_state,
      ).toBe("not_yours");
      await expect(submit(other.customerUserId, o.orderId)).rejects.toThrow(
        /FEEDBACK_NOT_YOUR_ORDER/,
      );
      await expect(submit(o.staffUserId, o.orderId)).rejects.toThrow(
        /FEEDBACK_NOT_YOUR_ORDER/,
      );
      await expect(
        db.asAnon((c) =>
          c.query("select public.submit_order_feedback($1, 5, null, null);", [
            o.orderId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("takes one per order, and closes two days after the order", async () => {
      const o = await servedOrder();
      await submit(o.customerUserId, o.orderId);
      await expect(submit(o.customerUserId, o.orderId, 1)).rejects.toThrow(
        /FEEDBACK_ALREADY_GIVEN/,
      );

      const late = await servedOrder();
      await db.admin.query(
        "update public.orders set created_at = now() - interval '3 days' where id = $1;",
        [late.orderId],
      );
      expect(
        (await state(late.customerUserId, late.orderId)).feedback_state,
      ).toBe("closed");
      await expect(submit(late.customerUserId, late.orderId)).rejects.toThrow(
        /FEEDBACK_CLOSED/,
      );
    });
  });

  describe("what it accepts", () => {
    it("refuses a rating outside 1–5 and an over-long comment", async () => {
      const o = await servedOrder();
      await expect(submit(o.customerUserId, o.orderId, 0)).rejects.toThrow(
        /order_feedback_rating_range/,
      );
      await expect(submit(o.customerUserId, o.orderId, 6)).rejects.toThrow(
        /order_feedback_rating_range/,
      );
      await expect(
        submit(o.customerUserId, o.orderId, 5, "x".repeat(1001)),
      ).rejects.toThrow(/order_feedback_comment_length/);
      // A blank comment is no comment.
      await submit(o.customerUserId, o.orderId, 5, "   ");
      const { rows } = await db.admin.query(
        "select comment from public.order_feedback where order_id = $1;",
        [o.orderId],
      );
      expect(rows).toEqual([{ comment: null }]);
    });

    it("refuses a vote for a dish on someone else's order, and saves nothing", async () => {
      const o = await servedOrder();
      const other = await servedOrder();
      await expect(
        submit(o.customerUserId, o.orderId, 5, null, {
          [other.orderItemId]: true,
        }),
      ).rejects.toThrow(/FEEDBACK_INVALID_VOTES/);
      await expect(
        submit(o.customerUserId, o.orderId, 5, null, {
          [o.orderItemId]: "yes",
        }),
      ).rejects.toThrow(/FEEDBACK_INVALID_VOTES/);
      // The failed calls rolled back whole: feedback can still be given.
      expect((await state(o.customerUserId, o.orderId)).feedback_state).toBe(
        "open",
      );
    });
  });

  describe("who can read it", () => {
    it("shows it to owners and managers only — not kitchen, staff, the diner or anyone else", async () => {
      const o = await servedOrder();
      await submit(o.customerUserId, o.orderId, 3, "Fine", {
        [o.orderItemId]: true,
      });

      async function sees(userId: string) {
        const { rows } = await db.asUser(userId, (c) =>
          c.query(
            `select (select count(*)::int from public.order_feedback where order_id = $1) as visits,
                    (select count(*)::int from public.order_item_feedback where order_id = $1) as dishes;`,
            [o.orderId],
          ),
        );
        return rows[0];
      }

      expect(await sees(o.staffUserId)).toEqual({ visits: 1, dishes: 1 });
      const manager = await db.createAuthUser();
      await addMember(db, o.restaurantId, manager, "manager");
      expect(await sees(manager)).toEqual({ visits: 1, dishes: 1 });

      for (const role of ["kitchen", "staff"] as Role[]) {
        const u = await db.createAuthUser();
        await addMember(db, o.restaurantId, u, role);
        expect(await sees(u)).toEqual({ visits: 0, dishes: 0 });
      }
      expect(await sees(o.customerUserId)).toEqual({ visits: 0, dishes: 0 });
      const stranger = await servedOrder();
      expect(await sees(stranger.staffUserId)).toEqual({
        visits: 0,
        dishes: 0,
      });
    });

    it("can't be written directly", async () => {
      const o = await servedOrder();
      await expect(
        db.asUser(o.customerUserId, (c) =>
          c.query(
            "insert into public.order_feedback (order_id, restaurant_id, table_id, rating) values ($1, $2, $3, 5);",
            [o.orderId, o.restaurantId, o.tableId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });
});
