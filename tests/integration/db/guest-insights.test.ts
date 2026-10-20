// @vitest-environment node
//
// get_guest_insights() (20261029090000): visits, AI waiter use, busy
// hours, ratings, bookings and regulars for one restaurant over a period.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCustomerSession,
  createRestaurant,
  createTable,
} from "./helpers";

interface Insights {
  visits: {
    visits: number;
    orderingVisits: number;
    spend: number;
    orders: number;
  };
  ai: {
    chatVisits: number;
    chatOrderingVisits: number;
    chatSpend: number;
    otherOrderingVisits: number;
    otherSpend: number;
    questions: number;
  };
  busy: { dow: number; hour: number; orders: number }[];
  feedback: { count: number; average: number | null; byRating: number[] };
  bookings: {
    bookings: number;
    kept: number;
    covers: number;
    noShows: number;
    cancelled: number;
    guests: number;
    returningGuests: number;
  };
  regulars: { name: string; visits: number; lastVisit: string }[];
}

const FROM = "2026-10-12T00:00:00Z";
const TO = "2026-10-19T00:00:00Z";

describe("guest insights", () => {
  let db: TestDb;
  let restaurantId: string;
  let otherRestaurantId: string;
  let tableId: string;
  let ownerId: string;
  let staffId: string;
  let orderNumber = 0;

  async function visit(
    opts: { at: string; totals?: number[]; chat?: boolean; cancelled?: number },
    restaurant = restaurantId,
    table = tableId,
  ) {
    const { sessionId } = await createCustomerSession(db, restaurant, table);
    await db.admin.query(
      "update public.customer_sessions set started_at = $2 where id = $1;",
      [sessionId, opts.at],
    );
    const ids: string[] = [];
    for (const total of opts.totals ?? []) {
      const { rows } = await db.admin.query<{ id: string }>(
        `insert into public.orders (restaurant_id, table_id, customer_session_id, order_number,
           status, total, currency, idempotency_key, created_at)
         values ($1, $2, $3, $4, 'served', $5, 'USD', gen_random_uuid()::text, $6)
         returning id;`,
        [restaurant, table, sessionId, ++orderNumber, total, opts.at],
      );
      ids.push(rows[0].id);
    }
    if (opts.cancelled !== undefined) {
      await db.admin.query(
        `insert into public.orders (restaurant_id, table_id, customer_session_id, order_number,
           status, total, currency, idempotency_key, created_at)
         values ($1, $2, $3, $4, 'cancelled', $5, 'USD', gen_random_uuid()::text, $6);`,
        [restaurant, table, sessionId, ++orderNumber, opts.cancelled, opts.at],
      );
    }
    if (opts.chat) {
      await db.admin.query(
        `insert into public.ai_conversation_messages (restaurant_id, customer_session_id, role, content, created_at)
         values ($1, $2, 'user', 'What do you recommend?', $3),
                ($1, $2, 'assistant', 'The curry.', $3);`,
        [restaurant, sessionId, opts.at],
      );
    }
    return ids;
  }

  async function booking(
    name: string,
    phone: string,
    at: string,
    status = "seated",
    partySize = 2,
  ) {
    await db.admin.query(
      `insert into public.reservations (restaurant_id, table_id, customer_name, customer_phone,
         party_size, reservation_time, status)
       values ($1, $2, $3, $4, $5, $6, $7);`,
      [restaurantId, tableId, name, phone, partySize, at, status],
    );
  }

  beforeAll(async () => {
    db = await createTestDb();
    restaurantId = await createRestaurant(db);
    otherRestaurantId = await createRestaurant(db);
    await db.admin.query(
      "update public.restaurants set timezone = 'Europe/London' where id = $1;",
      [restaurantId],
    );
    tableId = await createTable(db, restaurantId);
    const otherTable = await createTable(db, otherRestaurantId);
    ownerId = await db.createAuthUser();
    staffId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    await addMember(db, restaurantId, staffId, "staff");

    // Wednesday 14 Oct, 19:30 in London (BST, UTC+1).
    const [rated] = await visit({
      at: "2026-10-14T18:30:00Z",
      totals: [30, 10],
      chat: true,
    });
    await visit({ at: "2026-10-14T18:45:00Z", totals: [20], cancelled: 99 });
    await visit({ at: "2026-10-15T12:00:00Z" }); // looked, didn't order
    await visit({ at: "2026-10-01T12:00:00Z", totals: [500] }); // before
    await visit(
      { at: "2026-10-14T18:30:00Z", totals: [77] },
      otherRestaurantId,
      otherTable,
    );

    await db.admin.query(
      `insert into public.order_feedback (order_id, restaurant_id, table_id, rating, created_at)
       values ($1, $2, $3, 4, '2026-10-14T20:00:00Z');`,
      [rated, restaurantId, tableId],
    );

    // Sam has been before; Alex is new; Jo didn't come.
    await booking("Sam", "+44 7700 900001", "2026-09-20T19:00:00Z");
    await booking("Sam B", "07700-900001", "2026-10-13T19:00:00Z", "seated", 4);
    await booking(
      "Sam",
      "+447700900001",
      "2026-10-16T19:00:00Z",
      "completed",
      3,
    );
    await booking("Alex", "07700 900002", "2026-10-15T19:00:00Z");
    await booking("Jo", "07700 900003", "2026-10-17T19:00:00Z", "no_show");
    await booking("Kim", "07700 900004", "2026-10-17T20:00:00Z", "cancelled");
  });

  afterAll(async () => {
    await db.close();
  });

  async function insights(userId = ownerId): Promise<Insights> {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ i: Insights }>(
        "select public.get_guest_insights($1, $2, $3) as i;",
        [restaurantId, FROM, TO],
      ),
    );
    return rows[0].i;
  }

  it("counts this restaurant's visits and spend in the period, cancelled orders aside", async () => {
    const { visits } = await insights();
    expect(visits).toEqual({
      visits: 3,
      orderingVisits: 2,
      spend: 60,
      orders: 3,
    });
  });

  it("splits ordering visits by whether the guest asked the AI waiter", async () => {
    const { ai } = await insights();
    expect(ai).toEqual({
      chatVisits: 1,
      chatOrderingVisits: 1,
      chatSpend: 40,
      otherOrderingVisits: 1,
      otherSpend: 20,
      questions: 1,
    });
  });

  it("files orders under the restaurant's own weekday and hour", async () => {
    const { busy } = await insights();
    expect(busy).toEqual([{ dow: 3, hour: 19, orders: 3 }]);
  });

  it("averages ratings", async () => {
    const { feedback } = await insights();
    expect(feedback.count).toBe(1);
    expect(Number(feedback.average)).toBe(4);
    expect(feedback.byRating).toEqual([0, 0, 0, 1, 0]);
  });

  it("matches returning guests by their phone, however it was typed", async () => {
    const { bookings, regulars } = await insights();
    expect(bookings).toEqual({
      bookings: 5,
      kept: 3,
      covers: 9,
      noShows: 1,
      cancelled: 1,
      guests: 2,
      returningGuests: 1,
    });
    // Compared as a moment, not as text: Postgres writes the timestamp in
    // the session's timezone, which is UTC in CI but not on a laptop.
    expect(
      (
        regulars as Array<{ name: string; visits: number; lastVisit: string }>
      ).map((r) => ({ ...r, lastVisit: new Date(r.lastVisit).toISOString() })),
    ).toEqual([
      { name: "Sam", visits: 3, lastVisit: "2026-10-16T19:00:00.000Z" },
    ]);
  });

  it("never returns a phone number", async () => {
    expect(JSON.stringify(await insights())).not.toMatch(/7700/);
  });

  it("is for owners and managers only", async () => {
    await expect(insights(staffId)).rejects.toThrow(/REPORT_FORBIDDEN/);
    const stranger = await db.createAuthUser();
    await expect(insights(stranger)).rejects.toThrow(/REPORT_FORBIDDEN/);
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(
      db.asUser(ownerId, (c) =>
        c.query("select public.get_guest_insights($1, $2, $3);", [
          restaurantId,
          TO,
          FROM,
        ]),
      ),
    ).rejects.toThrow(/REPORT_INVALID_RANGE/);
  });
});
