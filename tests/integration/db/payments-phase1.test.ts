// @vitest-environment node
//
// Payments phase 1 (see supabase/migrations/20260830090000_payments_phase1.sql):
// Stripe Connect account linkage, per-restaurant payment settings, and the
// webhook replay-protection table. No money moves in this phase.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant, type Role } from "./helpers";

let accountSeq = 0;
/** stripe_account_id is globally unique by design — two restaurants must never share one — so every fixture needs its own. */
function uniqueAccount(): string {
  accountSeq += 1;
  return `acct_1Test${accountSeq}${Math.random().toString(36).slice(2, 8)}`;
}

async function fixture(db: TestDb, role: Role = "owner") {
  const restaurantId = await createRestaurant(db);
  const userId = await db.createAuthUser();
  await addMember(db, restaurantId, userId, role);
  return { restaurantId, userId };
}

interface PaymentAccountRow {
  id: string;
  restaurant_id: string;
  stripe_account_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}

function link(
  db: TestDb,
  userId: string,
  restaurantId: string,
  account = uniqueAccount(),
) {
  return db.asUser(userId, (c) =>
    c.query<PaymentAccountRow>(
      "select * from public.link_restaurant_payment_account($1, $2);",
      [restaurantId, account],
    ),
  );
}

describe("restaurant_settings payment columns", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  /**
   * The defaults are the whole safety story for this migration: phase 2
   * makes 'at_order' block an order from reaching the kitchen until it is
   * paid. If that were the default, this migration would silently break
   * every restaurant already taking orders the moment phase 2 shipped.
   */
  it("defaults leave an existing restaurant's behaviour unchanged", async () => {
    const restaurantId = await createRestaurant(db);
    const { rows } = await db.admin.query<{
      payment_timing: string;
      accept_card: boolean;
      accept_cash: boolean;
      tipping_enabled: boolean;
    }>(
      "select payment_timing, accept_card, accept_cash, tipping_enabled from public.restaurant_settings where restaurant_id = $1;",
      [restaurantId],
    );
    expect(rows[0].payment_timing).toBe("at_end");
    expect(rows[0].accept_card).toBe(false);
    expect(rows[0].accept_cash).toBe(false);
    expect(rows[0].tipping_enabled).toBe(false);
  });

  it("accepts the two valid payment timings", async () => {
    const restaurantId = await createRestaurant(db);
    for (const timing of ["at_order", "at_end"]) {
      await db.admin.query(
        "update public.restaurant_settings set payment_timing = $2 where restaurant_id = $1;",
        [restaurantId, timing],
      );
    }
    expect(true).toBe(true);
  });

  it("rejects an unknown payment timing", async () => {
    const restaurantId = await createRestaurant(db);
    await expect(
      db.admin.query(
        "update public.restaurant_settings set payment_timing = 'whenever' where restaurant_id = $1;",
        [restaurantId],
      ),
    ).rejects.toThrow();
  });
});

describe("link_restaurant_payment_account()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("links an account for an owner", async () => {
    const fx = await fixture(db, "owner");
    const account = uniqueAccount();
    const { rows } = await link(db, fx.userId, fx.restaurantId, account);
    expect(rows[0].stripe_account_id).toBe(account);
    // Capability flags are Stripe's to report, never assumed on creation.
    expect(rows[0].charges_enabled).toBe(false);
    expect(rows[0].payouts_enabled).toBe(false);
    expect(rows[0].details_submitted).toBe(false);
  });

  it("allows a manager too", async () => {
    const fx = await fixture(db, "manager");
    const account = uniqueAccount();
    const { rows } = await link(db, fx.userId, fx.restaurantId, account);
    expect(rows[0].stripe_account_id).toBe(account);
  });

  it("rejects staff and kitchen — this is commercial configuration", async () => {
    for (const role of ["staff", "kitchen"] as const) {
      const fx = await fixture(db, role);
      await expect(link(db, fx.userId, fx.restaurantId)).rejects.toThrow(
        /PAYMENT_ACCOUNT_FORBIDDEN/,
      );
    }
  });

  it("rejects a non-member", async () => {
    const fx = await fixture(db, "owner");
    const outsider = await db.createAuthUser();
    await expect(link(db, outsider, fx.restaurantId)).rejects.toThrow(
      /PAYMENT_ACCOUNT_FORBIDDEN/,
    );
  });

  it("rejects anything that is not a Stripe account id", async () => {
    const fx = await fixture(db, "owner");
    for (const bad of ["cus_123", "sk_live_abc", "acct_", "nonsense"]) {
      await expect(link(db, fx.userId, fx.restaurantId, bad)).rejects.toThrow();
    }
  });

  /**
   * Stripe's hosted onboarding can be abandoned and resumed, so the
   * dashboard may call this more than once for the same restaurant.
   */
  it("is re-runnable rather than erroring on a second attempt", async () => {
    const fx = await fixture(db, "owner");
    await link(db, fx.userId, fx.restaurantId, "acct_1First");
    const { rows } = await link(db, fx.userId, fx.restaurantId, "acct_1Second");
    expect(rows[0].stripe_account_id).toBe("acct_1Second");

    const { rows: all } = await db.admin.query(
      "select id from public.restaurant_payment_accounts where restaurant_id = $1;",
      [fx.restaurantId],
    );
    expect(all).toHaveLength(1);
  });

  it("will not let two restaurants share one Stripe account", async () => {
    const a = await fixture(db, "owner");
    const b = await fixture(db, "owner");
    await link(db, a.userId, a.restaurantId, "acct_1SharedAccount");
    await expect(
      link(db, b.userId, b.restaurantId, "acct_1SharedAccount"),
    ).rejects.toThrow();
  });
});

describe("restaurant_payment_accounts RLS", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("is visible to owner and manager, hidden from staff, kitchen and outsiders", async () => {
    const fx = await fixture(db, "owner");
    await link(db, fx.userId, fx.restaurantId);

    const { rows: ownerRows } = await db.asUser(fx.userId, (c) =>
      c.query("select id from public.restaurant_payment_accounts;"),
    );
    expect(ownerRows).toHaveLength(1);

    for (const role of ["manager", "staff", "kitchen"] as const) {
      const member = await db.createAuthUser();
      await addMember(db, fx.restaurantId, member, role);
      const { rows } = await db.asUser(member, (c) =>
        c.query("select id from public.restaurant_payment_accounts;"),
      );
      expect(rows).toHaveLength(role === "manager" ? 1 : 0);
    }

    const outsider = await db.createAuthUser();
    const { rows: outsiderRows } = await db.asUser(outsider, (c) =>
      c.query("select id from public.restaurant_payment_accounts;"),
    );
    expect(outsiderRows).toHaveLength(0);
  });

  it("cannot be written directly, even by an owner", async () => {
    const fx = await fixture(db, "owner");
    await link(db, fx.userId, fx.restaurantId);

    // No INSERT/UPDATE/DELETE policy exists: the SECURITY DEFINER function
    // and the webhook (as service_role) are the only write paths.
    await expect(
      db.asUser(fx.userId, (c) =>
        c.query(
          "update public.restaurant_payment_accounts set charges_enabled = true where restaurant_id = $1;",
          [fx.restaurantId],
        ),
      ),
    ).resolves.toMatchObject({ affectedRows: 0 });
  });
});

describe("stripe_webhook_events", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("makes a replayed event id impossible to record twice", async () => {
    await db.admin.query(
      "insert into public.stripe_webhook_events (stripe_event_id, event_type) values ($1, $2);",
      ["evt_replay_me", "account.updated"],
    );
    await expect(
      db.admin.query(
        "insert into public.stripe_webhook_events (stripe_event_id, event_type) values ($1, $2);",
        ["evt_replay_me", "account.updated"],
      ),
    ).rejects.toThrow();
  });

  it("is invisible to every authenticated user — it is platform infrastructure", async () => {
    await db.admin.query(
      "insert into public.stripe_webhook_events (stripe_event_id, event_type) values ($1, $2);",
      ["evt_hidden", "account.updated"],
    );
    const someone = await db.createAuthUser();
    const { rows } = await db.asUser(someone, (c) =>
      c.query("select stripe_event_id from public.stripe_webhook_events;"),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("sync_restaurant_payment_account_status()", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("updates the cached capability flags", async () => {
    const fx = await fixture(db, "owner");
    await link(db, fx.userId, fx.restaurantId);

    const { rows } = await db.asUser(fx.userId, (c) =>
      c.query<{
        charges_enabled: boolean;
        payouts_enabled: boolean;
        details_submitted: boolean;
      }>(
        "select * from public.sync_restaurant_payment_account_status($1, true, true, true);",
        [fx.restaurantId],
      ),
    );
    expect(rows[0].charges_enabled).toBe(true);
    expect(rows[0].payouts_enabled).toBe(true);
    expect(rows[0].details_submitted).toBe(true);
  });

  it("rejects staff and kitchen", async () => {
    const fx = await fixture(db, "owner");
    await link(db, fx.userId, fx.restaurantId);
    for (const role of ["staff", "kitchen"] as const) {
      const member = await db.createAuthUser();
      await addMember(db, fx.restaurantId, member, role);
      await expect(
        db.asUser(member, (c) =>
          c.query(
            "select * from public.sync_restaurant_payment_account_status($1, true, true, true);",
            [fx.restaurantId],
          ),
        ),
      ).rejects.toThrow(/PAYMENT_ACCOUNT_FORBIDDEN/);
    }
  });

  it("fails clearly when no account is linked yet", async () => {
    const fx = await fixture(db, "owner");
    await expect(
      db.asUser(fx.userId, (c) =>
        c.query(
          "select * from public.sync_restaurant_payment_account_status($1, true, true, true);",
          [fx.restaurantId],
        ),
      ),
    ).rejects.toThrow(/PAYMENT_ACCOUNT_NOT_FOUND/);
  });
});
