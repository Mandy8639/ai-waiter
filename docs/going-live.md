# Going live with Stripe

The cutover from test mode to live mode. **It is not a config change** — read
[Why this is not just env vars](#why-this-is-not-just-env-vars) before starting, because the step
most people expect to be a no-op is the one that silently does nothing.

Everything here needs credentials only the account owner has. Nothing in this runbook can be
performed by an automated agent: entering API keys, entering real bank details, and completing a
real payment are all deliberately out of scope for one.

## Why this is not just env vars

Stripe object ids are **mode-scoped**. A `price_...`, `acct_...`, `cus_...` or `sub_...` created in
test mode does not exist in live mode. This application stores all four in Postgres:

| Table                         | Column                                         | If left stale after cutover                                                           |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `platform_plans`              | `stripe_price_id`                              | Subscription checkout fails with "No such price"                                      |
| `restaurant_payment_accounts` | `stripe_account_id`                            | Charges fail — the live account has no such connected account                         |
| `restaurant_subscriptions`    | `stripe_subscription_id`, `stripe_customer_id` | **The restaurant keeps its paid plan's fee rate with no real subscription behind it** |

That third row is a revenue bug, not just an error: `record_restaurant_subscription()` also updates
`restaurant_plans`, and `platform_fee_for_payment()` reads the plan. A leftover test-mode "active"
subscription means the platform keeps charging the discounted rate forever.

> ⚠️ **`npm run billing:setup-prices` used to be a silent no-op here.** It skipped any plan whose
> `stripe_price_id` column was non-empty — and after test-mode setup, every plan's is. It would
> report "already set up" for each plan, leave the test ids in place, and the first real subscriber
> would hit "No such price". It is now mode-aware: it verifies the stored id actually resolves
> against the configured key and replaces it if not.

## Before you start

```bash
npm run billing:preflight
```

Read-only. It reports the mode of the configured `STRIPE_SECRET_KEY` and checks every Stripe id
stored in the database against it, listing what must be reset and why.

> Note its blind spot: it can only check rows that hold a Stripe id. `restaurant_plans` holds none,
> so a stale paid-plan row passes preflight silently. Step 2 clears it explicitly for that reason. Run it **before** the
> cutover (expect all-OK in test mode) and **after** each step below.

## The sequence

Order matters. Each step is verifiable before moving on.

### 0. Know which Stripe account you are in

This project's test-mode work was done in a **Stripe Sandbox**, which is a separate account, not a
toggle on the real one. Sandboxes cannot be activated for live mode at all, so "turn off test
mode" is not the move — you switch accounts.

|         | Account                                                           | Use                             |
| ------- | ----------------------------------------------------------------- | ------------------------------- |
| Sandbox | `acct_1UA0T2PBja26BrVt` — "Beacon Digital Consulting **sandbox**" | everything done so far          |
| Live    | `acct_1UA0SwPI26hGxVnb` — "Beacon Digital Consulting"             | the real one, already activated |

Confirmed 2026-09-04: the live account is activated (a `pk_live_...` key is present on its
dashboard) and Connect settings are available on it. If a future account is _not_ activated,
Stripe's own "Go live" checklist on the dashboard is the path — identity verification first, keys
after.

This matters beyond fetching a key: because the two are different accounts, **every** Stripe id in
the database belongs to the sandbox and none of them exist in live. That is exactly what step 2
resets.

### 1. Live API keys

In Vercel → Production, replace `STRIPE_SECRET_KEY` with the live key (`sk_live_...`), taken from
the **live** account above — not the sandbox.

Do not redeploy yet — the database still holds test-mode ids, and a deploy now would put a live key
in front of them.

### 2. Reset the stale rows

With the live key in `.env.local`, run the preflight. It will now report the stored ids as STALE.
Then, against production Postgres:

```sql
-- Plans: clear so setup-prices can create live ones (step 3).
update public.platform_plans set stripe_price_id = null;

-- Subscriptions: delete. A test-mode subscription must not keep granting
-- a paid plan's fee rate in live mode.
delete from public.restaurant_subscriptions
 where stripe_subscription_id like 'sub_%';

-- restaurant_plans: delete too, and do NOT skip this.
--
-- Deleting the subscription does not reset the plan. record_restaurant_
-- subscription() writes BOTH, but only the subscription row carries a
-- stripe id, so a cutover that deletes "everything with a stripe id"
-- leaves the plan behind. platform_fee_minor_units() reads
-- restaurant_plans, so the restaurant keeps its paid plan's discounted
-- rate with no subscription behind it — the exact silent revenue leak
-- this runbook warns about, reintroduced by the runbook itself.
--
-- Found by running this procedure for real on 2026-09-04: after deleting
-- the subscription, Nashta was still on `standard` at 0.50%.
--
-- Deleting is correct rather than repointing at the default:
-- platform_fee_minor_units() coalesces a missing row to the default plan,
-- so no row is exactly the state a brand-new restaurant is in.
delete from public.restaurant_plans
 where restaurant_id in (select id from public.restaurants);

-- Connect accounts: delete so onboarding starts clean in live mode (step 5).
delete from public.restaurant_payment_accounts
 where stripe_account_id like 'acct_%';
```

Preview each with `select count(*)` first. `pg_safeupdate` is enabled on the PostgREST roles, so an
unqualified `delete`/`update` is rejected — every statement above is qualified.

Leave `stripe_webhook_events` alone. It's the idempotency ledger; live event ids can't collide with
test ones, and clearing it buys nothing.

### 3. Create the live prices

```bash
npm run billing:setup-prices
```

It prints the key mode first. Confirm it says **LIVE**, then confirm it creates a price per paid
plan rather than skipping.

### 4. Recreate both event destinations

There are **two** webhook endpoints, and both need recreating in live mode:

| Endpoint                                                 | Secret                           |
| -------------------------------------------------------- | -------------------------------- |
| `/api/webhooks/stripe` (diner payments, `@accounts`)     | `STRIPE_WEBHOOK_SECRET`          |
| `/api/webhooks/stripe/platform` (subscriptions, `@self`) | `STRIPE_PLATFORM_WEBHOOK_SECRET` |

> `events_from` is **create-only**. An existing destination cannot be edited to change its source —
> it has to be created fresh. This is why the step is "recreate", not "update".

The event lists each endpoint needs, taken from the handlers themselves:

| `/api/webhooks/stripe` (`@accounts`)    | `/api/webhooks/stripe/platform` (`@self`) |
| --------------------------------------- | ----------------------------------------- |
| `account.updated`                       | `customer.subscription.created`           |
| `checkout.session.completed`            | `customer.subscription.updated`           |
| `checkout.session.expired`              | `customer.subscription.deleted`           |
| `checkout.session.async_payment_failed` |                                           |
| `charge.refund.updated`                 |                                           |
| `refund.updated`                        |                                           |
| `refund.failed`                         |                                           |

`account.updated` on the first one is what tells the app a restaurant finished Connect onboarding.
Without it, step 5 looks permanently stuck.

Put each signing secret into Vercel → Production. Paste them straight from Stripe; never through an
intermediary.

#### Verify these through the v2 API, not v1

These are **v2 event destinations**. The older `/v1/webhook_endpoints` API lists the same objects
but does **not** populate `connect` on this API version, so a v1 check reports `undefined` for a
destination whose source is perfectly correct.

Read that as "your account" and you will conclude a correct endpoint is misconfigured. On
2026-09-09 that is exactly what happened: a correctly-created destination was reported WRONG twice
and deleted on the strength of it, then recreated — losing its signing secret for no reason.

```bash
curl -s https://api.stripe.com/v2/core/event_destinations \
  -H "Authorization: Bearer $STRIPE_SECRET_KEY" \
  -H "Stripe-Version: 2026-08-26.dahlia"
```

Each destination should report `"events_from": ["@accounts"]` or `["@self"]` and `"status":
"enabled"`. That is the authoritative view; anything v1 says about the source is not.

> Creating a destination — by API or dashboard — returns a **new signing secret**, and the old one
> stops working immediately. Recreate one and you must update its Vercel variable, even if you did
> not mean to change anything. This is a real cost of "just recreate it to be sure", and a reason
> to verify properly before deleting.

### 5. Re-onboard the restaurant's Connect account

With real business and bank details, through the app's own onboarding flow. The test-mode account
is gone (step 2) and cannot be migrated — live Connect requires real identity verification.

Verify `charges_enabled` and `payouts_enabled` are both true before taking a payment.

### 6. Redeploy, then one real payment

Redeploy so the live keys and secrets take effect. Then take **one real card payment** — a small
real amount on a real card, not a test card.

Confirm afterwards:

- the payment row lands in the database with the right amount
- the platform fee matches the restaurant's plan `fee_bps`
- both webhook destinations show a `200`, not a `400`
- `npm run billing:preflight` reports all ids resolving in **live** mode

Refund it if it was only a test of the pipeline.

## After cutover

Re-run `npm run billing:preflight` any time payments behave oddly. "The key is live but the
database still points at test-mode objects" is the failure mode this whole document exists to
prevent, and it is one command to rule out.
