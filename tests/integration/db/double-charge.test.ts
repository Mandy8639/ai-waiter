// @vitest-environment node
//
// A phone payment that lands after the bill was settled another way
// (20261120090000): recorded for a refund instead of failing the webhook.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture } from "./helpers";

type Fixture = Awaited<ReturnType<typeof fullOrderFixture>>;

describe("a guest paying twice", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function orderTotal(orderId: string) {
    const { rows } = await db.admin.query<{ total: string; currency: string }>(
      "select total, currency from public.orders where id = $1;",
      [orderId],
    );
    return rows[0];
  }

  /** A phone payment the guest has started: pending, nothing settled yet. */
  async function phonePayment(
    f: Fixture,
    ref: { stripeSession?: string; squareOrder?: string },
  ) {
    const { total, currency } = await orderTotal(f.orderId);
    const { rows } = await db.admin.query<{ id: string }>(
      `insert into public.order_payments
         (restaurant_id, status, method, amount, currency,
          stripe_checkout_session_id, square_order_id)
       values ($1, 'pending', 'card', $2, $3, $4, $5)
       returning id;`,
      [
        f.restaurantId,
        total,
        currency,
        ref.stripeSession ?? null,
        ref.squareOrder ?? null,
      ],
    );
    await db.admin.query(
      `insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
       values ($1, $2, $3, $4);`,
      [rows[0].id, f.orderId, f.restaurantId, total],
    );
    return { paymentId: rows[0].id, total };
  }

  async function payCash(f: Fixture) {
    await db.admin.query(
      "update public.restaurant_settings set accept_cash = true where restaurant_id = $1;",
      [f.restaurantId],
    );
    await db.asUser(f.staffUserId, (c) =>
      c.query("select public.record_cash_payment($1::uuid[], 0);", [
        [f.orderId],
      ]),
    );
  }

  const settleStripe = (session: string, intent: string | null) =>
    db.admin
      .query<{ r: string }>(
        "select public.settle_stripe_checkout($1, $2) as r;",
        [session, intent],
      )
      .then((r) => r.rows[0].r);

  const settleSquare = (squareOrderId: string, totalMinor: number) =>
    db.admin
      .query<{ r: string }>(
        "select public.settle_square_payment($1, $2, $3, 0, 'USD') as r;",
        [squareOrderId, `PAY_${squareOrderId}`, totalMinor],
      )
      .then((r) => r.rows[0].r);

  const conflicts = (restaurantId: string) =>
    db.admin
      .query<{
        id: string;
        provider: string;
        provider_payment_id: string;
        amount: string;
        refund_status: string;
      }>(
        "select id, provider, provider_payment_id, amount, refund_status from public.payment_conflicts where restaurant_id = $1;",
        [restaurantId],
      )
      .then((r) => r.rows);

  const paymentStatus = (paymentId: string) =>
    db.admin
      .query<{ status: string }>(
        "select status from public.order_payments where id = $1;",
        [paymentId],
      )
      .then((r) => r.rows[0].status);

  it("settles a Stripe checkout as before when nothing else paid", async () => {
    const f = await fullOrderFixture(db);
    const session = `cs_${crypto.randomUUID()}`;
    const { paymentId } = await phonePayment(f, { stripeSession: session });

    expect(await settleStripe(session, "pi_ok")).toBe("settled");
    expect(await paymentStatus(paymentId)).toBe("succeeded");
    expect(await settleStripe(session, "pi_ok")).toBe("already");
    expect(await settleStripe("cs_nobody", "pi_x")).toBe("unknown");
    expect(await conflicts(f.restaurantId)).toEqual([]);
  });

  it("records a Stripe payment that lands after cash, once, for a refund", async () => {
    const f = await fullOrderFixture(db);
    const session = `cs_${crypto.randomUUID()}`;
    const { paymentId, total } = await phonePayment(f, {
      stripeSession: session,
    });
    await payCash(f);

    expect(await settleStripe(session, "pi_late")).toBe("double_paid");
    expect(await paymentStatus(paymentId)).toBe("cancelled");
    // Stripe retries; it is still the same one conflict.
    expect(await settleStripe(session, "pi_late")).toBe("double_paid");
    const rows = await conflicts(f.restaurantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "stripe",
      provider_payment_id: "pi_late",
      amount: total,
      refund_status: "pending",
    });
  });

  it("records a Square payment that lands after cash", async () => {
    const f = await fullOrderFixture(db);
    const squareOrder = `SQ_${crypto.randomUUID().slice(0, 8)}`;
    const { paymentId, total } = await phonePayment(f, { squareOrder });
    await payCash(f);
    const minor = Math.round(Number(total) * 100);

    expect(await settleSquare(squareOrder, minor)).toBe("double_paid");
    expect(await paymentStatus(paymentId)).toBe("cancelled");
    // A replay reads as the same double payment, not a mismatch.
    expect(await settleSquare(squareOrder, minor)).toBe("double_paid");
    expect(await conflicts(f.restaurantId)).toMatchObject([
      { provider: "square", provider_payment_id: `PAY_${squareOrder}` },
    ]);
  });

  it("records how the refund went, and keeps a refund once made", async () => {
    const f = await fullOrderFixture(db);
    const session = `cs_${crypto.randomUUID()}`;
    await phonePayment(f, { stripeSession: session });
    await payCash(f);
    await settleStripe(session, "pi_refund_me");
    const [conflict] = await conflicts(f.restaurantId);

    const record = (refundId: string | null, error: string | null) =>
      db.admin.query(
        "select public.record_payment_conflict_refund($1, $2, $3);",
        [conflict.id, refundId, error],
      );
    await record(null, "Stripe was unreachable");
    expect((await conflicts(f.restaurantId))[0].refund_status).toBe("failed");
    await record("re_123", null);
    expect((await conflicts(f.restaurantId))[0].refund_status).toBe("refunded");
    await record(null, "a late failure");
    expect((await conflicts(f.restaurantId))[0].refund_status).toBe("refunded");
  });

  it("shows the restaurant's people, lets only a manager close it", async () => {
    const f = await fullOrderFixture(db);
    const session = `cs_${crypto.randomUUID()}`;
    await phonePayment(f, { stripeSession: session });
    await payCash(f);
    await settleStripe(session, "pi_seen");
    const [conflict] = await conflicts(f.restaurantId);

    const server = await db.createAuthUser();
    await addMember(db, f.restaurantId, server, "staff");
    const outsider = await db.createAuthUser();
    const visible = (userId: string) =>
      db
        .asUser(userId, (c) =>
          c.query("select id from public.payment_conflicts where id = $1;", [
            conflict.id,
          ]),
        )
        .then((r) => r.rows.length);
    expect(await visible(server)).toBe(1);
    expect(await visible(outsider)).toBe(0);
    expect(await visible(f.customerUserId)).toBe(0);

    const acknowledge = (userId: string) =>
      db.asUser(userId, (c) =>
        c.query("select public.acknowledge_payment_conflict($1);", [
          conflict.id,
        ]),
      );
    await expect(acknowledge(server)).rejects.toThrow(/PAYMENT_FORBIDDEN/);
    await acknowledge(f.staffUserId); // the fixture's owner
    const { rows } = await db.admin.query<{ acknowledged_by: string }>(
      "select acknowledged_by from public.payment_conflicts where id = $1;",
      [conflict.id],
    );
    expect(rows[0].acknowledged_by).toBe(f.staffUserId);
  });

  it("can't be written by signed-in callers", async () => {
    const f = await fullOrderFixture(db);
    await expect(
      db.asUser(f.staffUserId, (c) =>
        c.query("select public.settle_stripe_checkout('cs_x', 'pi_x');"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asUser(f.staffUserId, (c) =>
        c.query(
          `insert into public.payment_conflicts
             (restaurant_id, payment_id, provider, provider_payment_id, amount, currency)
           values ($1, gen_random_uuid(), 'stripe', 'pi_forged', 1, 'USD');`,
          [f.restaurantId],
        ),
      ),
    ).rejects.toThrow(/permission denied|row-level security/);
  });
});
