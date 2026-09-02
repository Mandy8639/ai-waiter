// @vitest-environment node
//
// Reservations (see supabase/migrations/20260829110000_reservations.sql):
// create_reservation(), update_reservation_details(),
// transition_reservation_status(), and the double-booking guard.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant, createTable, type Role } from "./helpers";

interface Reservation {
  id: string;
  restaurant_id: string;
  table_id: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  party_size: number;
  reservation_time: string;
  status: string;
  notes: string | null;
}

/** A restaurant with one table and one staff member of the given role. */
async function reservationFixture(db: TestDb, staffRole: Role = "owner") {
  const restaurantId = await createRestaurant(db);
  const staffUserId = await db.createAuthUser();
  await addMember(db, restaurantId, staffUserId, staffRole);
  const tableId = await createTable(db, restaurantId);
  return { restaurantId, staffUserId, tableId };
}

async function createReservation(
  db: TestDb,
  userId: string,
  args: {
    restaurantId: string;
    tableId: string;
    reservationTime: Date;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string | null;
    partySize?: number;
    notes?: string | null;
  },
): Promise<Reservation> {
  const { rows } = await db.asUser(userId, (c) =>
    c.query<Reservation>(
      "select * from public.create_reservation($1, $2, $3, $4, $5, $6, $7, $8);",
      [
        args.restaurantId,
        args.tableId,
        args.customerName ?? "Priya Shah",
        args.customerPhone ?? "555-0100",
        args.customerEmail ?? null,
        args.partySize ?? 2,
        args.reservationTime.toISOString(),
        args.notes ?? null,
      ],
    ),
  );
  return rows[0];
}

describe("create_reservation()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("books a table as confirmed", async () => {
    const fx = await reservationFixture(db, "owner");
    const time = new Date("2027-01-15T19:00:00Z");

    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: time,
      customerName: "Priya Shah",
      customerPhone: "555-0100",
      partySize: 4,
    });

    expect(reservation.status).toBe("confirmed");
    expect(reservation.party_size).toBe(4);
    expect(reservation.customer_name).toBe("Priya Shah");
    expect(new Date(reservation.reservation_time).toISOString()).toBe(
      time.toISOString(),
    );
  });

  it("allows staff and manager, not just owner", async () => {
    for (const role of ["manager", "staff"] as const) {
      const fx = await reservationFixture(db, role);
      const reservation = await createReservation(db, fx.staffUserId, {
        restaurantId: fx.restaurantId,
        tableId: fx.tableId,
        reservationTime: new Date("2027-01-16T19:00:00Z"),
      });
      expect(reservation.status).toBe("confirmed");
    }
  });

  it("rejects kitchen role", async () => {
    const fx = await reservationFixture(db, "kitchen");
    await expect(
      createReservation(db, fx.staffUserId, {
        restaurantId: fx.restaurantId,
        tableId: fx.tableId,
        reservationTime: new Date("2027-01-17T19:00:00Z"),
      }),
    ).rejects.toThrow(/RESERVATION_FORBIDDEN/);
  });

  it("rejects a non-member", async () => {
    const fx = await reservationFixture(db, "owner");
    const outsiderId = await db.createAuthUser();
    await expect(
      createReservation(db, outsiderId, {
        restaurantId: fx.restaurantId,
        tableId: fx.tableId,
        reservationTime: new Date("2027-01-18T19:00:00Z"),
      }),
    ).rejects.toThrow(/RESERVATION_FORBIDDEN/);
  });

  it("rejects a table that doesn't belong to the restaurant", async () => {
    const fx = await reservationFixture(db, "owner");
    const otherRestaurantId = await createRestaurant(db);
    const otherTableId = await createTable(db, otherRestaurantId);

    await expect(
      createReservation(db, fx.staffUserId, {
        restaurantId: fx.restaurantId,
        tableId: otherTableId,
        reservationTime: new Date("2027-01-19T19:00:00Z"),
      }),
    ).rejects.toThrow(/RESERVATION_TABLE_NOT_FOUND/);
  });

  it("rejects a blank customer name", async () => {
    const fx = await reservationFixture(db, "owner");
    await expect(
      createReservation(db, fx.staffUserId, {
        restaurantId: fx.restaurantId,
        tableId: fx.tableId,
        reservationTime: new Date("2027-01-20T19:00:00Z"),
        customerName: "   ",
      }),
    ).rejects.toThrow(/RESERVATION_INVALID_NAME/);
  });

  it("rejects a non-positive party size", async () => {
    const fx = await reservationFixture(db, "owner");
    await expect(
      createReservation(db, fx.staffUserId, {
        restaurantId: fx.restaurantId,
        tableId: fx.tableId,
        reservationTime: new Date("2027-01-21T19:00:00Z"),
        partySize: 0,
      }),
    ).rejects.toThrow(/RESERVATION_INVALID_PARTY_SIZE/);
  });

  it("rejects double-booking the same table within 90 minutes", async () => {
    const fx = await reservationFixture(db, "owner");
    const time = new Date("2027-01-22T19:00:00Z");
    await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: time,
    });

    const overlapping = new Date(time.getTime() + 60 * 60 * 1000); // 60 min later
    await expect(
      createReservation(db, fx.staffUserId, {
        restaurantId: fx.restaurantId,
        tableId: fx.tableId,
        reservationTime: overlapping,
      }),
    ).rejects.toThrow(/RESERVATION_TABLE_CONFLICT/);
  });

  it("allows a second booking on the same table at least 90 minutes apart", async () => {
    const fx = await reservationFixture(db, "owner");
    const time = new Date("2027-01-23T19:00:00Z");
    await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: time,
    });

    const farEnough = new Date(time.getTime() + 90 * 60 * 1000); // exactly 90 min later
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: farEnough,
    });
    expect(reservation.status).toBe("confirmed");
  });

  it("allows overlapping times on different tables", async () => {
    const fx = await reservationFixture(db, "owner");
    const otherTableId = await createTable(db, fx.restaurantId);
    const time = new Date("2027-01-24T19:00:00Z");

    await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: time,
    });
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: otherTableId,
      reservationTime: time,
    });
    expect(reservation.status).toBe("confirmed");
  });

  it("frees the table once the earlier reservation is cancelled", async () => {
    const fx = await reservationFixture(db, "owner");
    const time = new Date("2027-01-25T19:00:00Z");
    const first = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: time,
    });

    await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "select * from public.transition_reservation_status($1, 'cancelled');",
        [first.id],
      ),
    );

    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date(time.getTime() + 30 * 60 * 1000), // 30 min later, would have conflicted
    });
    expect(reservation.status).toBe("confirmed");
  });
});

describe("update_reservation_details()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("updates customer/party-size/notes fields", async () => {
    const fx = await reservationFixture(db, "owner");
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-01T19:00:00Z"),
    });

    const { rows } = await db.asUser(fx.staffUserId, (c) =>
      c.query<Reservation>(
        "select * from public.update_reservation_details($1, $2, $3, $4, $5, $6);",
        [
          reservation.id,
          "Priya Patel",
          "555-0199",
          "priya@example.com",
          6,
          "Birthday — window seat please",
        ],
      ),
    );

    expect(rows[0].customer_name).toBe("Priya Patel");
    expect(rows[0].customer_phone).toBe("555-0199");
    expect(rows[0].customer_email).toBe("priya@example.com");
    expect(rows[0].party_size).toBe(6);
    expect(rows[0].notes).toBe("Birthday — window seat please");
    // Immutable fields untouched.
    expect(rows[0].table_id).toBe(fx.tableId);
  });

  it("rejects a non-member editing details", async () => {
    const fx = await reservationFixture(db, "owner");
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-02T19:00:00Z"),
    });
    const outsiderId = await db.createAuthUser();

    await expect(
      db.asUser(outsiderId, (c) =>
        c.query(
          "select * from public.update_reservation_details($1, $2, $3, $4, $5, $6);",
          [reservation.id, "Someone Else", "555-0000", null, 2, null],
        ),
      ),
    ).rejects.toThrow(/RESERVATION_FORBIDDEN/);
  });
});

describe("transition_reservation_status()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function statusOf(reservationId: string): Promise<string> {
    const { rows } = await db.admin.query<{ status: string }>(
      "select status from public.reservations where id = $1;",
      [reservationId],
    );
    return rows[0].status;
  }

  it("walks the full confirmed -> seated -> completed path", async () => {
    const fx = await reservationFixture(db, "staff");
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-03T19:00:00Z"),
    });

    await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "select * from public.transition_reservation_status($1, 'seated');",
        [reservation.id],
      ),
    );
    expect(await statusOf(reservation.id)).toBe("seated");

    await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "select * from public.transition_reservation_status($1, 'completed');",
        [reservation.id],
      ),
    );
    expect(await statusOf(reservation.id)).toBe("completed");
  });

  it("allows confirmed -> no_show directly", async () => {
    const fx = await reservationFixture(db, "owner");
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-04T19:00:00Z"),
    });

    await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "select * from public.transition_reservation_status($1, 'no_show');",
        [reservation.id],
      ),
    );
    expect(await statusOf(reservation.id)).toBe("no_show");
  });

  it("rejects skipping seated to go straight to completed", async () => {
    const fx = await reservationFixture(db, "owner");
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-05T19:00:00Z"),
    });

    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query(
          "select * from public.transition_reservation_status($1, 'completed');",
          [reservation.id],
        ),
      ),
    ).rejects.toThrow(/RESERVATION_INVALID_TRANSITION/);
  });

  it("rejects any transition out of a terminal state", async () => {
    const fx = await reservationFixture(db, "owner");
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-06T19:00:00Z"),
    });

    await db.asUser(fx.staffUserId, (c) =>
      c.query(
        "select * from public.transition_reservation_status($1, 'cancelled');",
        [reservation.id],
      ),
    );

    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query(
          "select * from public.transition_reservation_status($1, 'seated');",
          [reservation.id],
        ),
      ),
    ).rejects.toThrow(/RESERVATION_INVALID_TRANSITION/);
  });

  it("rejects kitchen role transitioning a reservation", async () => {
    const fx = await reservationFixture(db, "owner");
    const kitchenUserId = await db.createAuthUser();
    await addMember(db, fx.restaurantId, kitchenUserId, "kitchen");
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-07T19:00:00Z"),
    });

    await expect(
      db.asUser(kitchenUserId, (c) =>
        c.query(
          "select * from public.transition_reservation_status($1, 'seated');",
          [reservation.id],
        ),
      ),
    ).rejects.toThrow(/RESERVATION_FORBIDDEN/);
  });

  it("rejects a raw UPDATE that skips the state machine (structural trigger)", async () => {
    const fx = await reservationFixture(db, "owner");
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-08T19:00:00Z"),
    });

    await expect(
      db.admin.query(
        "update public.reservations set status = 'completed' where id = $1;",
        [reservation.id],
      ),
    ).rejects.toThrow(/invalid reservation status transition/);
  });

  it("rejects changing table_id or reservation_time after creation (immutable-fields trigger)", async () => {
    // Two separate branches since
    // 20260902190000_customer_reservation_requests.sql split them: a table
    // may be filled in once (a pending request has none) but never moved,
    // while restaurant and time are immutable outright. The wording
    // differs per branch, so both are asserted rather than only the one
    // this test used to reach.
    const fx = await reservationFixture(db, "owner");
    const otherTableId = await createTable(db, fx.restaurantId);
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-09T19:00:00Z"),
    });

    await expect(
      db.admin.query(
        "update public.reservations set table_id = $2 where id = $1;",
        [reservation.id, otherTableId],
      ),
    ).rejects.toThrow(/table is immutable once assigned/);

    await expect(
      db.admin.query(
        "update public.reservations set reservation_time = $2 where id = $1;",
        [reservation.id, new Date("2027-02-10T19:00:00Z").toISOString()],
      ),
    ).rejects.toThrow(/immutable after creation/);
  });
});

describe("reservations RLS", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("scopes SELECT to restaurant members with a front-of-house role", async () => {
    const fx = await reservationFixture(db, "owner");
    const reservation = await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-10T19:00:00Z"),
    });

    const { rows: ownRows } = await db.asUser(fx.staffUserId, (c) =>
      c.query<{ id: string }>("select id from public.reservations;"),
    );
    expect(ownRows.map((r) => r.id)).toContain(reservation.id);

    const outsiderId = await db.createAuthUser();
    const { rows: outsiderRows } = await db.asUser(outsiderId, (c) =>
      c.query<{ id: string }>("select id from public.reservations;"),
    );
    expect(outsiderRows).toHaveLength(0);
  });

  it("excludes kitchen role from viewing reservations", async () => {
    const fx = await reservationFixture(db, "owner");
    const kitchenUserId = await db.createAuthUser();
    await addMember(db, fx.restaurantId, kitchenUserId, "kitchen");
    await createReservation(db, fx.staffUserId, {
      restaurantId: fx.restaurantId,
      tableId: fx.tableId,
      reservationTime: new Date("2027-02-11T19:00:00Z"),
    });

    const { rows } = await db.asUser(kitchenUserId, (c) =>
      c.query<{ id: string }>("select id from public.reservations;"),
    );
    expect(rows).toHaveLength(0);
  });
});
