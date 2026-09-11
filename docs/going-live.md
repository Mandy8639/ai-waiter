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

Order matters, and two of these orderings are load-bearing rather than stylistic: the reset (2)
must precede price creation (3) or the new prices land beside stale ids, and the redeploy (5) must
precede Connect onboarding (6) or the account is created in the wrong mode. Each step is verifiable
before moving on.

### 0. Know which Stripe account you are in

This project's test-mode work was done in a **Stripe Sandbox**, which is a separate account, not a
toggle on the real one. Sandboxes cannot be activated for live mode at all, so "turn off test
mode" is not the move — you switch accounts.

|         | Account                                                           | Use                    |
| ------- | ----------------------------------------------------------------- | ---------------------- |
| Sandbox | `acct_1UA0T2PBja26BrVt` — "Beacon Digital Consulting **sandbox**" | everything done so far |
| Live    | `acct_1UA0SwPI26hGxVnb` — "Beacon Digital Consulting"             | the real one           |

> ⚠️ **Having live keys does not mean the account is activated.** This section used to say the
> live account was "confirmed activated" on 2026-09-04, because a `pk_live_...` key was on its
> dashboard. On 2026-09-11 the same account reported `charges_enabled: false` and
> `details_submitted: false`, and Stripe refused to create Connect accounts until activation was
> finished. Check the account, not the keys page:
>
> ```bash
> curl -s https://api.stripe.com/v1/account -u "$STRIPE_SECRET_KEY:" \
>   | grep -E '"(id|charges_enabled|payouts_enabled|details_submitted)"'
> ```
>
> All three flags must be `true` before step 6, and step 6 lists further gates on top of these.

**Always put the account id in dashboard URLs.** A link like `dashboard.stripe.com/connect/accounts`
opens whichever account you used last. On 2026-09-11 that was the sandbox, which looks almost
identical. Use `dashboard.stripe.com/acct_1UA0SwPI26hGxVnb/...` for everything in this runbook.

This matters beyond fetching a key: because the two are different accounts, **every** Stripe id in
the database belongs to the sandbox and none of them exist in live. That is exactly what step 2
resets.

### 1. Live API keys

In Vercel → Production, replace `STRIPE_SECRET_KEY` with the live key (`sk_live_...`), taken from
the **live** account above — not the sandbox.

Vercel marks this variable **Sensitive**: it is write-only, `vercel env pull` returns
`[SENSITIVE]` placeholders, and nobody can read the value back to check it. Check the timestamp
instead: in Vercel → Settings → Environment Variables, the row must say **Updated** just now.
`vercel env ls` shows when a variable was _created_, not updated, so it can't answer this.

On 2026-09-11 both webhook secrets had been updated, but `STRIPE_SECRET_KEY` still said "Updated
2d ago". Production was using a key from a different Stripe account, and the Connect account it
created belonged to that account. See
[Prove which account production uses](#prove-which-account-production-uses).

Do not redeploy yet — the database still holds test-mode ids, and a deploy now would put a live key
in front of them.

### 2. Reset the stale rows

With the live key in `.env.local`, run the preflight. It will now report the stored ids as STALE.
Then, against production Postgres:

> Run these in the **production** project, `dqypmprjcyxoeywsumxr`. Check the project id in the
> SQL editor's URL: the disposable E2E project (`iriwghorcramhpmekktq`) also shows an orange
> **PRODUCTION** badge, because that badge marks the `main` branch, not the live database.

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

-- Connect accounts: delete so onboarding starts clean in live mode (step 6).
delete from public.restaurant_payment_accounts
 where stripe_account_id like 'acct_%';
```

Preview each with `select count(*)` first. `pg_safeupdate` is enabled on the PostgREST roles, so an
unqualified `delete`/`update` is rejected — every statement above is qualified.

Leave `stripe_webhook_events` alone. It's the idempotency ledger; live event ids can't collide with
test ones, and clearing it buys nothing.

`order_payments` is not reset either, and that has a cost: test-mode payments stay marked
`succeeded` and count as revenue in reports. You can spot them by a `cs_test_...` checkout session
id. After this cutover Nashta still had two, from Sep 5 ($16.98) and Sep 9 ($10.47). Deleting them
is a business decision, not a correctness one; nothing breaks either way.

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
Without it, step 6 looks permanently stuck.

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

### 5. Redeploy

Redeploy so the live key and both signing secrets take effect.

**This has to happen before onboarding, not after.** `startPaymentOnboarding()` creates the Connect
account with whatever key the _running process_ holds — so onboarding a still-deployed test build
creates another **sandbox** account, silently undoing step 2 and leaving you to discover it when a
real charge fails.

That is not hypothetical: this step used to be numbered 6, after onboarding, and following it in
that order on 2026-09-09 would have recreated exactly the account the cutover had just deleted.

Running the app locally with the live key in `.env.local` is a valid alternative — same database,
same result — but it needs a staff login on `localhost`, which is a separate session from the
deployed site. Redeploying first is simpler and has no such trap.

### 6. Re-onboard the restaurant's Connect account

With real business and bank details, through the app's own onboarding flow on the **deployed**
site. The test-mode account is gone (step 2) and cannot be migrated — live Connect requires real
identity verification.

#### Stripe's gates come one at a time

On 2026-09-11 **Connect with Stripe** failed six times before it worked. Every failure was the
same `400 account_create_activation_required` on `POST /v2/core/accounts`, and the causes were
different. None of them appeared in the account's `requirements` through the API. They only show
in the dashboard, and each one only after the previous one is cleared:

| #   | Gate                                                     | Where it shows                                                                                 | Who                                                 |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | Activate the platform account (business, identity, bank) | `dashboard.stripe.com/account/onboarding`; the API shows `details_submitted: false`            | Owner                                               |
| 2   | Upload an identity document **for Connect**              | Banner on `…/acct_1UA0SwPI26hGxVnb/connect/accounts`: "Provide a valid identity document"      | Owner                                               |
| 3   | Confirm your integration choices                         | Same page: "Connect setup almost complete". The step itself is under Setup guide → **Go live** | Owner — this accepts the Connect Platform Agreement |

After each one clears, reload the Connected accounts page before retrying; it's the only place the
next gate appears. Gate 1 can also look finished early: `details_submitted` turned `true` a few
minutes before `charges_enabled` did.

For gate 3, answer to match what the code does:

| Stripe asks             | Answer                            | Because                                                                                                      |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Funds flow              | Sellers collect payments directly | Checkout runs on the restaurant's account (`stripeAccount`) with an `application_fee_amount`: direct charges |
| Account creation        | Onboarding hosted by Stripe       | `startPaymentOnboarding()` sends owners to Stripe-hosted account links                                       |
| Account management      | Sellers use the Stripe Dashboard  | Accounts are created with `dashboard: "full"`; the app has no payouts or disputes screens                    |
| Risk and loss liability | Stripe                            | Accounts are created with `losses_collector: "stripe"` and `fees_collector: "stripe"`                        |

#### The app hides the error

A failed **Connect with Stripe** or **Refresh status** shows only a generic "Something went wrong"
page, because the Stripe error is thrown rather than returned to the form. Read the real error in
the live account's API log (see
[Prove which account production uses](#prove-which-account-production-uses)): open the failed
`POST /v2/core/accounts` and read its response body.

#### Delete a Connect row created with the wrong key

`startPaymentOnboarding()` **reuses** a stored `stripe_account_id` rather than creating a new one.
If production ever onboarded with the wrong key, that row points at an account the live key can't
reach, and onboarding fails on it every time. The preflight shows the stored id not resolving. Delete
that one row and start again:

```sql
delete from public.restaurant_payment_accounts where stripe_account_id = 'acct_...';
```

#### Onboarding can return early

Stripe can send the owner back to the app before every field is collected. On 2026-09-11 the first
pass left the representative's home address and SSN missing, and card payments stayed
`restricted`. **Continue on Stripe** on the payments page reopens onboarding at the missing fields.

Verify `charges_enabled` and `payouts_enabled` are both true before taking a payment:

```bash
npm run billing:preflight
```

It resolves the stored `acct_...` against the live key, so a half-finished onboarding shows up here
rather than as a failed charge in front of a customer.

Onboarding is also the only real test of `STRIPE_WEBHOOK_SECRET`. The `@accounts` destination only
receives events from connected accounts, so nothing can reach it until one exists. Each
`account.updated` Stripe sends during onboarding should appear in `stripe_webhook_events`. The route
records an event only after its signature verifies, so a row there proves the secret.

### 7. One real payment

Take **one real card payment** — a small real amount on a real card, not a test card.

Confirm afterwards:

- an `order_payments` row with `status = succeeded`, a `paid_at`, and a `cs_live_...` checkout
  session id
- a `checkout.session.completed` row in `stripe_webhook_events`
- the platform fee matches the restaurant's plan `fee_bps` (`GET /v1/application_fees` on the
  platform key lists it)
- both webhook destinations show a `200`, not a `400`
- `npm run billing:preflight` reports all ids resolving in **live** mode

Refund it if it was only a test of the pipeline. Stripe keeps its processing fee on a refund.

Done for real on 2026-09-11: a $1.99 card payment on Nashta's account, with a $0.01 platform fee
at the Starter rate (1%).

## Prove which account production uses

Vercel won't show you the key, so ask Stripe instead. Trigger any Stripe call from production (the
payments page's **Refresh status** or **Connect with Stripe** will do), then open the live account's
API log:

`https://dashboard.stripe.com/acct_1UA0SwPI26hGxVnb/workbench/logs/api`

Click **Clear filters** first. The default filters hide GET requests, which is most of what the app
sends. If your request appears there, production is using this account's key. If it doesn't,
production's key belongs to another account.

The same log shows the full response body for any failed call, which the app itself doesn't display.

## After cutover

Re-run `npm run billing:preflight` any time payments behave oddly. "The key is live but the
database still points at test-mode objects" is the failure mode this whole document exists to
prevent, and it is one command to rule out.
