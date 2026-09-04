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
stored in the database against it, listing what must be reset and why. Run it **before** the
cutover (expect all-OK in test mode) and **after** each step below.

## The sequence

Order matters. Each step is verifiable before moving on.

### 1. Live API keys

In Vercel → Production, replace `STRIPE_SECRET_KEY` with the live key (`sk_live_...`). Get it from
the Stripe dashboard with the **Test mode** toggle **off**.

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

Put each signing secret into Vercel → Production. Paste them straight from Stripe; never through an
intermediary.

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
