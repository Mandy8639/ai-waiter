// @vitest-environment node
//
// Customer-facing reservations
// (supabase/migrations/20260902190000_customer_reservation_requests.sql).
//
// request_reservation() is the only reservation write a person with no
// relationship to the restaurant may perform, so most of what follows is
// about what it refuses.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createTable, fullRestaurantFixture } from "./helpers";

interface ReservationRow {
  id: string;
  status: string;
  table_id: string | null;
  party_size: number;
  customer_name: string;
  created_by: string;
}

function request(
  db: TestDb,
  userId: string,
  restaurantId: string,
  overrides: {
    name?: string;
    phone?: string;
    email?: string | null;
    partySize?: number;
    when?: string;
    notes?: string | null;
  } = {},
): Promise<ReservationRow> {
  return db.asUser(userId, async (c) => {
    const { rows } = await c.query<ReservationRow>(
      `select * from public.request_reservation($1, $2, $3, $4, $5, $6::timestamptz, $7);`,
      [
        restaurantId,
        overrides.name ?? "Ada",
        overrides.phone ?? "555-0100",
        overrides.email ?? "ada@example.test",
        overrides.partySize ?? 2,
        overrides.when ?? new Date(Date.now() + 86_400_000).toISOString(),
        overrides.notes ?? null,
      ],
    );
    return rows[0];
  });
}

function confirm(
  db: TestDb,
  userId: string,
  reservationId: string,
  tableId: string,
): Promise<ReservationRow> {
  return db.asUser(userId, async (c) => {
    const { rows } = await c.query<ReservationRow>(
      "select * from public.confirm_reservation_request($1, $2);",
      [reservationId, tableId],
    );
    return rows[0];
  });
}

describe("a diner requesting a table", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("creates a pending request with no table assigned", async () => {
    // The whole point: nothing here knows how many people a table seats,
    // so no table is chosen until a person chooses it.
    const f = await fullRestaurantFixture(db);
    const diner = await db.createAuthUser();

    const reservation = await request(db, diner, f.restaurantId);

    expect(reservation.status).toBe("pending");
    expect(reservation.table_id).toBeNull();
    expect(reservation.created_by).toBe(diner);
  });

  it("accepts a diner with no staff role at all", async () => {
    const f = await fullRestaurantFixture(db);
    const stranger = await db.createAuthUser();

    const reservation = await request(db, stranger, f.restaurantId);
    expect(reservation.status).toBe("pending");
  });

  it("refuses an anonymous caller with no identity", async () => {
    // created_by is what later lets the diner read their own booking, so
    // a request with nobody attached to it is refused.
    const f = await fullRestaurantFixture(db);

    await expect(
      db.asAnon((c) =>
        c.query(
          `select public.request_reservation($1, 'Ada', '555', null, 2, now() + interval '1 day', null);`,
          [f.restaurantId],
        ),
      ),
    ).rejects.toThrow();
  });

  describe("what it refuses", () => {
    it("a time in the past", async () => {
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAuthUser();

      await expect(
        request(db, diner, f.restaurantId, {
          when: new Date(Date.now() - 86_400_000).toISOString(),
        }),
      ).rejects.toThrow(/RESERVATION_TIME_IN_PAST/);
    });

    it("a time more than a year out", async () => {
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAuthUser();

      await expect(
        request(db, diner, f.restaurantId, {
          when: new Date(Date.now() + 400 * 86_400_000).toISOString(),
        }),
      ).rejects.toThrow(/RESERVATION_TIME_TOO_FAR/);
    });

    it("a party of nobody", async () => {
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAuthUser();

      await expect(
        request(db, diner, f.restaurantId, { partySize: 0 }),
      ).rejects.toThrow(/RESERVATION_INVALID_PARTY_SIZE/);
    });

    it("a party too large to be a booking", async () => {
      // Without a ceiling the field is a way to make the dashboard
      // unreadable.
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAuthUser();

      await expect(
        request(db, diner, f.restaurantId, { partySize: 400 }),
      ).rejects.toThrow(/RESERVATION_PARTY_TOO_LARGE/);
    });

    it("a blank name or phone", async () => {
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAuthUser();

      await expect(
        request(db, diner, f.restaurantId, { name: "   " }),
      ).rejects.toThrow(/RESERVATION_INVALID_NAME/);
      await expect(
        request(db, diner, f.restaurantId, { phone: "" }),
      ).rejects.toThrow(/RESERVATION_INVALID_PHONE/);
    });

    it("a restaurant that does not exist", async () => {
      const diner = await db.createAuthUser();

      await expect(
        request(db, diner, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow(/RESERVATION_RESTAURANT_NOT_FOUND/);
    });

    it("a sixth request within the hour", async () => {
      // Enforced in the function rather than the server action: this path
      // is reachable directly, so a check that lives only in the app is a
      // check that can be skipped.
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAuthUser();

      for (let i = 0; i < 5; i++) {
        await request(db, diner, f.restaurantId);
      }

      await expect(request(db, diner, f.restaurantId)).rejects.toThrow(
        /RESERVATION_TOO_MANY_REQUESTS/,
      );
    });

    it("counts the limit per caller, not per restaurant", async () => {
      // One busy diner must not stop everyone else booking.
      const f = await fullRestaurantFixture(db);
      const busy = await db.createAuthUser();
      const other = await db.createAuthUser();

      for (let i = 0; i < 5; i++) {
        await request(db, busy, f.restaurantId);
      }

      const reservation = await request(db, other, f.restaurantId);
      expect(reservation.status).toBe("pending");
    });
  });

  describe("who can see it", () => {
    it("lets the diner read back their own request", async () => {
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAuthUser();
      const reservation = await request(db, diner, f.restaurantId);

      const rows = await db.asUser(diner, async (c) => {
        const result = await c.query(
          "select id from public.reservations where id = $1;",
          [reservation.id],
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
    });

    it("hides it from a different diner", async () => {
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAuthUser();
      const stranger = await db.createAuthUser();
      const reservation = await request(db, diner, f.restaurantId);

      const rows = await db.asUser(stranger, async (c) => {
        const result = await c.query(
          "select id from public.reservations where id = $1;",
          [reservation.id],
        );
        return result.rows;
      });

      expect(rows).toHaveLength(0);
    });

    it("shows it to staff at that restaurant", async () => {
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAuthUser();
      const reservation = await request(db, diner, f.restaurantId);

      const rows = await db.asUser(f.userId, async (c) => {
        const result = await c.query(
          "select id from public.reservations where id = $1;",
          [reservation.id],
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
    });
  });
});

describe("staff accepting a request", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("assigns the table and confirms it", async () => {
    const f = await fullRestaurantFixture(db);
    const tableId = await createTable(db, f.restaurantId);
    const diner = await db.createAuthUser();
    const reservation = await request(db, diner, f.restaurantId);

    const confirmed = await confirm(db, f.userId, reservation.id, tableId);

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.table_id).toBe(tableId);
  });

  it("refuses a diner trying to confirm their own request", async () => {
    const f = await fullRestaurantFixture(db);
    const tableId = await createTable(db, f.restaurantId);
    const diner = await db.createAuthUser();
    const reservation = await request(db, diner, f.restaurantId);

    await expect(confirm(db, diner, reservation.id, tableId)).rejects.toThrow(
      /RESERVATION_FORBIDDEN/,
    );
  });

  it("allows a plain staff member, not only a manager", async () => {
    const f = await fullRestaurantFixture(db);
    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");
    const tableId = await createTable(db, f.restaurantId);
    const diner = await db.createAuthUser();
    const reservation = await request(db, diner, f.restaurantId);

    const confirmed = await confirm(db, waiter, reservation.id, tableId);
    expect(confirmed.status).toBe("confirmed");
  });

  it("refuses a table belonging to another restaurant", async () => {
    const f = await fullRestaurantFixture(db);
    const other = await fullRestaurantFixture(db);
    const foreignTable = await createTable(db, other.restaurantId);
    const diner = await db.createAuthUser();
    const reservation = await request(db, diner, f.restaurantId);

    await expect(
      confirm(db, f.userId, reservation.id, foreignTable),
    ).rejects.toThrow(/RESERVATION_TABLE_NOT_FOUND/);
  });

  it("refuses a table already booked within 90 minutes", async () => {
    const f = await fullRestaurantFixture(db);
    const tableId = await createTable(db, f.restaurantId);
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const first = await request(db, await db.createAuthUser(), f.restaurantId, {
      when,
    });
    await confirm(db, f.userId, first.id, tableId);

    const second = await request(
      db,
      await db.createAuthUser(),
      f.restaurantId,
      {
        when: new Date(Date.parse(when) + 30 * 60_000).toISOString(),
      },
    );

    await expect(confirm(db, f.userId, second.id, tableId)).rejects.toThrow(
      /RESERVATION_TABLE_CONFLICT/,
    );
  });

  it("refuses to accept the same request twice", async () => {
    const f = await fullRestaurantFixture(db);
    const tableId = await createTable(db, f.restaurantId);
    const secondTable = await createTable(db, f.restaurantId);
    const diner = await db.createAuthUser();
    const reservation = await request(db, diner, f.restaurantId);
    await confirm(db, f.userId, reservation.id, tableId);

    await expect(
      confirm(db, f.userId, reservation.id, secondTable),
    ).rejects.toThrow(/RESERVATION_NOT_PENDING/);
  });

  it("keeps the table immutable once assigned", async () => {
    // Stated explicitly in the trigger now, rather than resting on the
    // NULL comparison that used to permit it by accident.
    const f = await fullRestaurantFixture(db);
    const tableId = await createTable(db, f.restaurantId);
    const otherTable = await createTable(db, f.restaurantId);
    const diner = await db.createAuthUser();
    const reservation = await request(db, diner, f.restaurantId);
    await confirm(db, f.userId, reservation.id, tableId);

    await expect(
      db.admin.query(
        "update public.reservations set table_id = $2 where id = $1;",
        [reservation.id, otherTable],
      ),
    ).rejects.toThrow(/immutable once assigned/);
  });

  it("will not let a pending request be seated directly", async () => {
    // Seating someone requires a table, and a pending row has none.
    const { rows } = await db.admin.query<{ ok: boolean }>(
      "select public.is_valid_reservation_status_transition('pending', 'seated') as ok;",
    );
    expect(rows[0].ok).toBe(false);
  });

  it("allows a pending request to be turned down", async () => {
    const { rows } = await db.admin.query<{ ok: boolean }>(
      "select public.is_valid_reservation_status_transition('pending', 'cancelled') as ok;",
    );
    expect(rows[0].ok).toBe(true);
  });
});
