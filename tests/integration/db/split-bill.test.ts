// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCustomerSession,
  createRestaurant,
  createTable,
} from "./helpers";

/**
 * Phase J: splitting a tab. The phase's own definition of done is the
 * first describe block — the parts add up to exactly the bill, no cent
 * created or lost — and everything after it is what keeps that true once
 * real people start paying: nothing is marked paid early, nothing is paid
 * twice, and a part someone abandons goes back to the table.
 */

interface SplitView {
  split_id: string;
  status: string;
  mode: string;
  currency: string;
  total: number;
  paid_total: number;
  is_owner: boolean;
  order_numbers: number[];
  units: Array<{
    id: string;
    position: number;
    kind: string;
    label: string;
    amount: number;
    status: string;
  }>;
}

describe("split bill", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function payableRestaurant(currency = "USD") {
    const restaurantId = await createRestaurant(db);
    await db.admin.query(
      "update public.restaurants set currency = $2 where id = $1;",
      [restaurantId, currency],
    );
    await db.admin.query(
      "update public.restaurant_settings set accept_card = true, tipping_enabled = true where restaurant_id = $1;",
      [restaurantId],
    );
    await db.admin.query(
      `insert into public.restaurant_payment_accounts (restaurant_id, stripe_account_id, charges_enabled)
       values ($1, $2, true);`,
      [restaurantId, `acct_${restaurantId.replace(/-/g, "").slice(0, 16)}`],
    );
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const tableId = await createTable(db, restaurantId);
    const diner = await createCustomerSession(db, restaurantId, tableId);
    return { restaurantId, ownerId, tableId, currency, ...diner };
  }

  type Place = Awaited<ReturnType<typeof payableRestaurant>>;

  /** An order with exact line totals and extras (tax + service), inserted directly so every cent is chosen. */
  async function order(
    place: Place,
    lines: Array<{ name: string; total: string; quantity?: number }>,
    extras = "0",
    sessionId = place.sessionId,
  ) {
    const subtotal = lines.reduce(
      (sum, l) => sum + Math.round(Number(l.total) * 100),
      0,
    );
    const { rows: n } = await db.admin.query<{ n: number }>(
      "select coalesce(max(order_number), 0) + 1 as n from public.orders where restaurant_id = $1;",
      [place.restaurantId],
    );
    const { rows } = await db.admin.query<{ id: string }>(
      `insert into public.orders
         (restaurant_id, table_id, customer_session_id, order_number, status,
          subtotal, tax, service_charge, total, currency, idempotency_key)
       values ($1, $2, $3, $4, 'served', $5::numeric, $6::numeric, 0,
               $5::numeric + $6::numeric, $7, $8)
       returning id;`,
      [
        place.restaurantId,
        place.tableId,
        sessionId,
        n[0].n,
        (subtotal / 100).toFixed(2),
        extras,
        place.currency,
        crypto.randomUUID(),
      ],
    );
    // One statement for all lines, as submit_order() does: they share a
    // created_at, exactly like a real order's lines.
    await db.admin.query(
      `insert into public.order_items
         (restaurant_id, order_id, item_name, quantity, unit_price, line_total)
       select $1, $2, l.name, l.qty, round(l.total / l.qty, 2), l.total
       from jsonb_to_recordset($3::jsonb) as l(name text, qty int, total numeric);`,
      [
        place.restaurantId,
        rows[0].id,
        JSON.stringify(
          lines.map((l) => ({
            name: l.name,
            qty: l.quantity ?? 1,
            total: l.total,
          })),
        ),
      ],
    );
    return rows[0].id;
  }

  async function createSplit(
    place: Place,
    mode: "equal" | "by_dish",
    shares?: number,
  ) {
    const { rows } = await db.asUser(place.userId, (c) =>
      c.query<{ new_split_id: string; new_split_token: string }>(
        "select * from public.create_tab_split($1, $2);",
        [mode, shares ?? null],
      ),
    );
    return { id: rows[0].new_split_id, token: rows[0].new_split_token };
  }

  async function view(token: string, as?: string): Promise<SplitView> {
    const run = (c: { query: TestDb["admin"]["query"] }) =>
      c.query<{ get_tab_split: SplitView }>(
        "select public.get_tab_split($1);",
        [token],
      );
    const { rows } = as ? await db.asUser(as, run) : await db.asAnon(run);
    const v = rows[0].get_tab_split;
    return (
      v && {
        ...v,
        total: Number(v.total),
        paid_total: Number(v.paid_total),
        units: v.units.map((u) => ({ ...u, amount: Number(u.amount) })),
      }
    );
  }

  /** A guest on their own phone: not signed in at all. */
  async function startPayment(token: string, unitIds: string[], tip = 0) {
    const { rows } = await db.asAnon((c) =>
      c.query<{
        split_payment_id: string;
        split_amount: string;
        split_total: string;
        split_part_count: number;
        split_fee_minor_units: number;
      }>("select * from public.start_split_payment($1, $2::uuid[], $3);", [
        token,
        unitIds,
        tip,
      ]),
    );
    const paymentId = rows[0].split_payment_id;
    const session = `cs_test_${paymentId.replace(/-/g, "")}`;
    await db.asAnon((c) =>
      c.query("select public.attach_split_checkout_session($1, $2, $3);", [
        token,
        paymentId,
        session,
      ]),
    );
    return { paymentId, session, row: rows[0] };
  }

  /** What the Stripe webhook does, as the webhook's role. */
  async function webhookPaid(session: string) {
    await db.asServiceRole((c) =>
      c.query("select public.mark_order_payment_succeeded($1, $2);", [
        session,
        `pi_${session}`,
      ]),
    );
  }

  async function webhookExpired(session: string) {
    await db.asServiceRole((c) =>
      c.query("select public.mark_order_payment_failed($1, 'cancelled');", [
        session,
      ]),
    );
  }

  async function isPaid(orderId: string) {
    const { rows } = await db.admin.query<{ paid: boolean }>(
      `select exists (
         select 1 from public.payment_orders po
         join public.order_payments p on p.id = po.payment_id
         where po.order_id = $1 and p.status = 'succeeded') as paid;`,
      [orderId],
    );
    return rows[0].paid;
  }

  // ---------------------------------------------------------------------------

  describe("the parts add up to exactly the bill", () => {
    it("splits $100.00 three ways as 33.34 + 33.33 + 33.33", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "100.00" }]);
      const s = await createSplit(p, "equal", 3);
      const v = await view(s.token);
      expect(v.units.map((u) => u.amount)).toEqual([33.34, 33.33, 33.33]);
      expect(v.units.map((u) => u.label)).toEqual([
        "Share 1 of 3",
        "Share 2 of 3",
        "Share 3 of 3",
      ]);
    });

    it("never creates or loses a cent, for any total and any number of shares", async () => {
      // Every total from 0.02 to a few hundred dollars in awkward steps,
      // every share count from 2 to 20: the shares always sum to the total
      // and never differ by more than one cent.
      const { rows } = await db.admin.query<{
        bad_sum: number;
        bad_spread: number;
        cases: number;
      }>(
        `with cases as (
           select t, n, public.allocate_minor(t, array_fill(1::bigint, array[n])) as shares
           from generate_series(2, 40000, 137) as t, generate_series(2, 20) as n
           where t >= n
         )
         select
           count(*) filter (where (select sum(x) from unnest(shares) x) <> t)::int as bad_sum,
           count(*) filter (where (select max(x) - min(x) from unnest(shares) x) > 1)::int as bad_spread,
           count(*)::int as cases
         from cases;`,
      );
      expect(rows[0].cases).toBeGreaterThan(5000);
      expect(rows[0].bad_sum).toBe(0);
      expect(rows[0].bad_spread).toBe(0);
    });

    it("allocates proportional amounts exactly too, whatever the weights", async () => {
      const { rows } = await db.admin.query<{ bad: number; cases: number }>(
        `with cases as (
           select t, w, public.allocate_minor(t, w) as a
           from generate_series(0, 5000, 97) as t,
                (values (array[1,1,1]::bigint[]), (array[999,1]::bigint[]),
                        (array[0,0,5]::bigint[]), (array[0,0]::bigint[]),
                        (array[333,333,334,1,7]::bigint[])) as ws(w)
         )
         select count(*) filter (where (select sum(x) from unnest(a) x) <> t
                                   or (select min(x) from unnest(a) x) < 0)::int as bad,
                count(*)::int as cases
         from cases;`,
      );
      expect(rows[0].cases).toBeGreaterThan(200);
      expect(rows[0].bad).toBe(0);
    });

    it("splits yen in whole yen, since yen has no cents", async () => {
      const p = await payableRestaurant("JPY");
      await order(p, [{ name: "Ramen", total: "1000" }]);
      const s = await createSplit(p, "equal", 3);
      expect((await view(s.token)).units.map((u) => u.amount)).toEqual([
        334, 333, 333,
      ]);
    });

    it("gives each dish its exact slice of tax, so each order's dishes add up to its total", async () => {
      const p = await payableRestaurant();
      // Subtotal 17.99, tax 1.60 — no slice of 1.60 comes out even.
      await order(
        p,
        [
          { name: "Dosa", total: "10.00" },
          { name: "Chai", total: "5.00", quantity: 2 },
          { name: "Lassi", total: "2.99" },
        ],
        "1.60",
      );
      await order(p, [{ name: "Samosa", total: "4.50" }], "0.40");
      const s = await createSplit(p, "by_dish");
      const v = await view(s.token);

      // Lines of one order share a timestamp (submit_order inserts them
      // together), so within an order they are listed by name.
      expect(v.units.map((u) => u.label)).toEqual([
        "2× Chai",
        "Dosa",
        "Lassi",
        "Samosa",
      ]);
      const cents = Object.fromEntries(
        v.units.map((u) => [u.label, Math.round(u.amount * 100)]),
      );
      // Order 1: 17.99 + 1.60 tax. Order 2: 4.50 + 0.40.
      expect(cents["Dosa"] + cents["2× Chai"] + cents["Lassi"]).toBe(1959);
      expect(cents["Samosa"]).toBe(490);
      expect(Object.values(cents).reduce((a, b) => a + b, 0)).toBe(
        Math.round(v.total * 100),
      );
    });

    it("refuses to split a bill into more shares than it has cents", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Mint", total: "0.02" }]);
      await expect(createSplit(p, "equal", 3)).rejects.toThrow(
        /SPLIT_TOO_SMALL/,
      );
    });
  });

  describe("paying the parts", () => {
    it("marks nothing paid until the last share, then covers every order exactly", async () => {
      const p = await payableRestaurant();
      const o1 = await order(p, [{ name: "Thali", total: "60.00" }], "5.33");
      const o2 = await order(p, [{ name: "Biryani", total: "34.67" }]);
      const s = await createSplit(p, "equal", 4);
      const units = (await view(s.token)).units;

      const payments = [];
      for (const [i, unit] of units.entries()) {
        const pay = await startPayment(s.token, [unit.id], i === 0 ? 2 : 0);
        await webhookPaid(pay.session);
        payments.push(pay.paymentId);
        if (i < units.length - 1) {
          // Part-way through: still unpaid, and the split still open.
          expect(await isPaid(o1)).toBe(false);
          expect(await isPaid(o2)).toBe(false);
          expect((await view(s.token)).status).toBe("open");
        }
      }

      const v = await view(s.token);
      expect(v.status).toBe("paid");
      expect(v.paid_total).toBe(v.total);
      expect(await isPaid(o1)).toBe(true);
      expect(await isPaid(o2)).toBe(true);

      // Both margins exact: each order's coverage is its total, each
      // payment's coverage is what it charged (tip excluded).
      const { rows: byOrder } = await db.admin.query<{ ok: boolean }>(
        `select bool_and(o.total = (select sum(po.amount) from public.payment_orders po where po.order_id = o.id)) as ok
         from public.orders o where o.id = any($1::uuid[]);`,
        [[o1, o2]],
      );
      expect(byOrder[0].ok).toBe(true);
      const { rows: byPayment } = await db.admin.query<{ ok: boolean }>(
        `select bool_and(p.amount = (select sum(po.amount) from public.payment_orders po where po.payment_id = p.id)) as ok
         from public.order_payments p where p.id = any($1::uuid[]);`,
        [payments],
      );
      expect(byPayment[0].ok).toBe(true);

      // The tip went on the payer who chose it, and on no order.
      const { rows: tips } = await db.admin.query<{ sum: string }>(
        "select sum(tip_amount)::text as sum from public.order_payments where split_id = $1;",
        [s.id],
      );
      expect(tips[0].sum).toBe("2.00");
    });

    it("lets one person pay two shares, and dishes be paid by whoever had them", async () => {
      const p = await payableRestaurant();
      const o1 = await order(
        p,
        [
          { name: "Dosa", total: "10.00" },
          { name: "Idli", total: "7.00" },
        ],
        "1.53",
      );
      const s = await createSplit(p, "by_dish");
      const [dosa, idli] = (await view(s.token)).units;

      const a = await startPayment(s.token, [dosa.id]);
      const b = await startPayment(s.token, [idli.id]);
      await webhookPaid(b.session);
      expect(await isPaid(o1)).toBe(false);
      await webhookPaid(a.session);
      expect(await isPaid(o1)).toBe(true);

      const { rows } = await db.admin.query<{
        payment_id: string;
        amount: string;
      }>(
        "select po.payment_id, po.amount::text as amount from public.payment_orders po where po.order_id = $1 order by po.amount desc;",
        [o1],
      );
      expect(rows).toEqual([
        { payment_id: a.paymentId, amount: dosa.amount.toFixed(2) },
        { payment_id: b.paymentId, amount: idli.amount.toFixed(2) },
      ]);
    });

    it("never lets two people pay for the same part", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      const s = await createSplit(p, "equal", 2);
      const [first] = (await view(s.token)).units;
      await startPayment(s.token, [first.id]);
      await expect(startPayment(s.token, [first.id])).rejects.toThrow(
        /SPLIT_PART_TAKEN/,
      );
    });

    it("gives a part back when its Checkout expires or fails", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      const s = await createSplit(p, "equal", 2);
      const [first] = (await view(s.token)).units;

      const abandoned = await startPayment(s.token, [first.id]);
      expect((await view(s.token)).units[0].status).toBe("pending");
      await webhookExpired(abandoned.session);
      expect((await view(s.token)).units[0].status).toBe("open");

      // Someone else can now pay it, and it settles normally.
      const retry = await startPayment(s.token, [first.id]);
      await webhookPaid(retry.session);
      expect((await view(s.token)).units[0].status).toBe("paid");
    });

    it("charges the sum of the chosen parts, and computes the platform fee itself", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "30.00" }]);
      const s = await createSplit(p, "equal", 3);
      const units = (await view(s.token)).units;
      const pay = await startPayment(s.token, [units[0].id, units[1].id], 1.5);
      expect(pay.row.split_amount).toBe("20.00");
      expect(pay.row.split_total).toBe("21.50");
      expect(pay.row.split_part_count).toBe(2);
      expect(typeof pay.row.split_fee_minor_units).toBe("number");
    });

    it("rejects parts from another split, an unknown link, and tips the restaurant has turned off", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      const s = await createSplit(p, "equal", 2);
      const q = await payableRestaurant();
      await order(q, [{ name: "Thali", total: "20.00" }]);
      const other = await createSplit(q, "equal", 2);
      const theirs = (await view(other.token)).units[0];

      await expect(startPayment(s.token, [theirs.id])).rejects.toThrow(
        /SPLIT_UNKNOWN_PART/,
      );
      await expect(startPayment("not-a-token", [theirs.id])).rejects.toThrow(
        /SPLIT_NOT_FOUND/,
      );
      expect(await view("not-a-token")).toBeNull();

      await db.admin.query(
        "update public.restaurant_settings set tipping_enabled = false where restaurant_id = $1;",
        [p.restaurantId],
      );
      const mine = (await view(s.token)).units[0];
      await expect(startPayment(s.token, [mine.id], 1)).rejects.toThrow(
        /PAYMENT_TIPPING_DISABLED/,
      );
    });

    it("stops taking payments once the split is settled", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      const s = await createSplit(p, "equal", 2);
      const [a, b] = (await view(s.token)).units;
      await webhookPaid((await startPayment(s.token, [a.id, b.id])).session);
      await expect(startPayment(s.token, [a.id])).rejects.toThrow(
        /SPLIT_CLOSED/,
      );
    });
  });

  describe("nothing else can pay these orders while the split is open", () => {
    it("keeps them out of the whole-tab payment, but not orders placed after the split", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      await createSplit(p, "equal", 2);

      await expect(
        db.asUser(p.userId, (c) =>
          c.query("select * from public.start_tab_payment(0);"),
        ),
      ).rejects.toThrow(/PAYMENT_NOTHING_TO_PAY/);

      const later = await order(p, [{ name: "Kulfi", total: "4.00" }]);
      const { rows } = await db.asUser(p.userId, (c) =>
        c.query<{ order_count: number; amount: string }>(
          "select order_count, amount::text from public.start_tab_payment(0);",
        ),
      );
      expect(rows[0]).toEqual({ order_count: 1, amount: "4.00" });
      expect(later).toBeTruthy();
    });

    it("refuses a single-order card payment and staff cash for them", async () => {
      const p = await payableRestaurant();
      const o = await order(p, [{ name: "Thali", total: "20.00" }]);
      await createSplit(p, "equal", 2);

      await expect(
        db.asUser(p.userId, (c) =>
          c.query("select * from public.start_order_payment($1, 0);", [o]),
        ),
      ).rejects.toThrow(/PAYMENT_ORDER_IN_SPLIT/);

      await db.admin.query(
        "update public.restaurant_settings set accept_cash = true where restaurant_id = $1;",
        [p.restaurantId],
      );
      await expect(
        db.asUser(p.ownerId, (c) =>
          c.query("select public.record_cash_payment($1::uuid[], 0);", [[o]]),
        ),
      ).rejects.toThrow(/PAYMENT_ORDER_IN_SPLIT/);
    });

    it("won't let an order in an open split be cancelled", async () => {
      const p = await payableRestaurant();
      const o = await order(p, [{ name: "Thali", total: "20.00" }]);
      await createSplit(p, "equal", 2);
      await expect(
        db.admin.query(
          "update public.orders set status = 'cancelled' where id = $1;",
          [o],
        ),
      ).rejects.toThrow(/ORDER_IN_SPLIT/);
    });

    it("won't split while a Checkout for the tab is still open", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      const { rows } = await db.asUser(p.userId, (c) =>
        c.query<{ payment_id: string }>(
          "select payment_id from public.start_tab_payment(0);",
        ),
      );
      await db.admin.query(
        "update public.order_payments set stripe_checkout_session_id = 'cs_open' where id = $1;",
        [rows[0].payment_id],
      );
      await expect(createSplit(p, "equal", 2)).rejects.toThrow(
        /PAYMENT_IN_PROGRESS/,
      );

      // Once Stripe reports it expired, the split goes ahead.
      await webhookExpired("cs_open");
      await expect(createSplit(p, "equal", 2)).resolves.toBeTruthy();
    });
  });

  describe("the split itself", () => {
    it("is created only by the diner whose tab it is", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      await expect(
        db.asAnon((c) =>
          c.query("select * from public.create_tab_split('equal', 2);"),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.asUser(p.ownerId, (c) =>
          c.query("select * from public.create_tab_split('equal', 2);"),
        ),
      ).rejects.toThrow(/PAYMENT_NO_SESSION/);
    });

    it("tells its owner apart from a guest, and reveals no session or table", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      const s = await createSplit(p, "equal", 2);
      expect((await view(s.token, p.userId)).is_owner).toBe(true);
      const guest = await view(s.token);
      expect(guest.is_owner).toBe(false);
      expect(JSON.stringify(guest)).not.toContain(p.sessionId);
      expect(JSON.stringify(guest)).not.toContain(p.tableId);
    });

    it("can be cancelled before anyone pays, and then the tab pays normally", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      const s = await createSplit(p, "equal", 2);
      await db.asUser(p.userId, (c) =>
        c.query("select public.cancel_tab_split();"),
      );
      expect((await view(s.token)).status).toBe("cancelled");
      const { rows } = await db.asUser(p.userId, (c) =>
        c.query<{ amount: string }>(
          "select amount::text from public.start_tab_payment(0);",
        ),
      );
      expect(rows[0].amount).toBe("20.00");
    });

    it("can't be cancelled once someone is paying", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      const s = await createSplit(p, "equal", 2);
      await startPayment(s.token, [(await view(s.token)).units[0].id]);
      await expect(
        db.asUser(p.userId, (c) =>
          c.query("select public.cancel_tab_split();"),
        ),
      ).rejects.toThrow(/SPLIT_STARTED/);
    });

    it("gives its link back to the diner who made it, and to nobody else", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      const s = await createSplit(p, "equal", 2);
      const { rows } = await db.asUser(p.userId, (c) =>
        c.query<{ open_split_token: string }>(
          "select open_split_token from public.get_my_open_split();",
        ),
      );
      expect(rows[0].open_split_token).toBe(s.token);
      const { rows: stranger } = await db.asUser(p.ownerId, (c) =>
        c.query("select * from public.get_my_open_split();"),
      );
      expect(stranger).toEqual([]);
    });

    it("allows one open split per tab", async () => {
      const p = await payableRestaurant();
      await order(p, [{ name: "Thali", total: "20.00" }]);
      await createSplit(p, "equal", 2);
      await expect(createSplit(p, "equal", 3)).rejects.toThrow(
        /SPLIT_ALREADY_OPEN/,
      );
    });

    it("is readable and payable without signing in, and nothing more is", async () => {
      const { rows } = await db.admin.query<{ fn: string; anon: boolean }>(
        `select p.proname as fn, has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in (
           'get_tab_split', 'start_split_payment', 'attach_split_checkout_session',
           'get_split_payment_checkout', 'create_tab_split', 'cancel_tab_split',
           'get_my_open_split', 'get_my_tab_pending_checkouts', 'follow_split_payment',
           'enforce_split_order_payment', 'split_token_hash', 'allocate_minor')
         order by p.proname;`,
      );
      expect(Object.fromEntries(rows.map((r) => [r.fn, r.anon]))).toEqual({
        allocate_minor: false,
        attach_split_checkout_session: true,
        cancel_tab_split: false,
        create_tab_split: false,
        enforce_split_order_payment: false,
        follow_split_payment: false,
        get_my_open_split: false,
        get_my_tab_pending_checkouts: false,
        get_split_payment_checkout: true,
        get_tab_split: true,
        split_token_hash: false,
        start_split_payment: true,
      });
    });
  });
});
