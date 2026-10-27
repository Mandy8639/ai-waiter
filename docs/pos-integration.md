# Connecting a restaurant's POS

**Square and Clover are connected** (see "Square" and "Clover" below). Toast is not. Underneath is the **seam** any connector plugs into — the three things
that are expensive to retrofit and cheap to add before anyone needs them.

## Why a seam and not a connector

Every POS is its own integration; there is no shared standard. Building one before a specific
restaurant needs a specific POS is weeks of work, plus partner approval, for a customer who does
not exist yet. Building the seam is a day, and it means the first real connector is an addition
rather than a rewrite.

It is also worth being honest that many independent restaurants have no API-capable POS at all.
For them AI Waiter **is** the till and the KDS, and none of this applies.

## The three pieces

### 1. Which POS a restaurant runs

`restaurant_pos_integrations`, one row per restaurant, owner/manager readable only — the same
boundary as payments, because a kitchen login has no business reading which POS account the
business is wired to.

Disabled by default. `is_enabled` cannot be set without an `external_location_id`, because a
half-configured integration that starts queueing work it can never deliver is worse than one that
does nothing.

**It never holds credentials.** `credentials_ref` names a secret; it is not the secret. A
per-restaurant API token in a Postgres column is readable by anyone who can read the row,
restorable from every backup and printed in every dump — see
[`backup-and-restore.md`](./backup-and-restore.md) for how routinely those move around. The token
belongs in the deployment's secret store, looked up by this name at delivery time.

### 2. What each row is called on the other side

`external_id` on `categories`, `menu_items`, `menu_item_modifiers` and `modifier_options`.

A column per table rather than one mapping table: a restaurant runs one POS, joins stay simple,
and a menu sync is an ordinary update. If two providers per restaurant ever become real, these
columns become the first rows of a mapping table — a migration, not a redesign.

Unique **per restaurant**, not globally. Two restaurants on the same POS vendor will collide on ids
otherwise, which is the single most likely way a naive mapping corrupts a menu.

One exception: `modifier_options` carries no `restaurant_id` — it is tenant-scoped transitively
through its modifier group — so uniqueness there is enforced per group. The narrower guard still
catches the mistake that actually happens.

### 3. A reliable record that an order happened

`pos_outbox`, written by a trigger **inside the order's own transaction**.

That is the whole reason it is in the database rather than in application code after
`submit_order()` returns: an order and its outbound event either both exist or neither does. A
process that dies between the two cannot lose an order the POS never hears about, and a rolled-back
order cannot leave behind an event that pushes a sale nobody made.

The row is a **pointer, not a snapshot**. `order_items` are immutable once written, so a delivery
attempt tomorrow reads exactly what one today would have — and copying the lines into the outbox
would create a second copy of the truth that can silently drift from the first.

`UNIQUE (order_id, event_type)` is the idempotency key. A retry storm, a double-fired trigger, or a
worker that delivers and then crashes before marking the row cannot push the same sale twice.

Restaurants with no enabled integration write nothing at all, so the outbox stays the size of the
work there is rather than the size of the order table.

## Delivery policy

`src/lib/pos/outbox-core.ts` — pure, `server-only`-free, and unit tested. It is the half of a
connector that can be written and proven before choosing a vendor, and the half that is easy to get
quietly wrong.

- Exponential backoff from 15 seconds, capped at 15 minutes. The cap matters more than the curve:
  without it the eighth retry is hours away, and an order that reaches the till after the diner has
  eaten is not a recovered order, it is a confusing one.
- Eight attempts, roughly an hour end to end — long enough to ride out a POS restart, short enough
  that staff find out during the same service rather than the next morning.
- A retryable failure stays `pending` with a later `next_attempt_at`. It is **not** marked `failed`,
  because a row saying "failed" while it is still going to be retried tells whoever reads the
  dashboard the opposite of the truth. `abandoned` is terminal and means a human is now the
  fallback.

## What a connector still has to do

1. Claim due rows (`status = 'pending' and next_attempt_at <= now()`), using the service key —
   nobody can write this table through RLS, deliberately, since a staff member marking a failed
   push as delivered would hide a missing sale.
2. Read the order, map each line through `external_id`, and call the vendor's API.
3. Write back with `afterAttempt()`.
4. Sync the menu the other way, populating `external_id`.
5. Surface abandoned rows to staff. **This does not exist**, and until it does, a POS that was down
   for an hour loses those orders silently.

## What is deliberately not here

- No credentials storage, no OAuth flow, no vendor SDK.
- No `order.status_changed` event. `event_type` is constrained to `order.created`; widening it is a
  one-line migration when a connector needs it.
- No delivery worker. There is nothing to deliver to yet.

## Square

Settings → Point of sale. Phase 1: connect the restaurant's Square account and import its menu.
Phase 2: diners pay through Square. Phase 3: Square Terminal and cash. Pay-when-ordering (phase 4) comes next.

### Two Square facts that shape everything

- **Square only shows an API order on the register, and only prints it, once it is fully paid**
  ("Orders with fulfillment that have been fully paid are pushed to the Square Point of Sale",
  Square's Orders API overview). In a sit-down restaurant that pays at the end, Square sees the
  sale when the bill is paid; kitchen tickets keep coming from Tableside's own kitchen screen or
  printer. Where diners pay when they order, Square prints straight away.
- **Orders paid through anyone but Square cost the app maker 1%** (Square's payments pricing).
  That is Tableside's whole fee, so a Square restaurant's diners pay through Square, and
  Tableside's fee is collected with `app_fee_money` on those payments. Square supports that on
  hosted checkout links and Terminal checkouts, with the `PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS`
  permission, which is why the connection asks for it now.

### Connecting

`startSquareConnect` → Square's consent screen → `/api/pos/square/callback`.

- **One redirect URL.** Square allows one per application, so `SQUARE_REDIRECT_URI` names it and
  the flow always starts and ends on that host (an owner signed in on the other domain is sent
  there first). The state value is checked against an httpOnly cookie, so a link someone else
  started can't attach their Square account here.
- **Tokens.** The seam above said tokens belong in the deployment's secret store. That works for a
  single deployment-wide key, not for OAuth, where every restaurant gets its own token at runtime.
  So `pos_credentials` holds them, **as ciphertext only** (AES-256-GCM, `src/lib/pos/token-crypto.ts`)
  under `POS_TOKEN_ENCRYPTION_KEY`, which stays in the secret store. The table has no RLS policies
  and no grants to signed-in roles: only the service key reads it, through
  `src/lib/pos/square/api.ts` alone (importers pinned by `tests/unit/square-connection.test.ts`).
  A dump or backup holds nothing usable without the key. Access tokens are refreshed a week before
  their 30-day expiry. Disconnecting revokes Tableside's access at Square and deletes the row.
- **Who.** Owners and managers, checked twice before the token store is touched: the membership
  row, then `is_restaurant_manager_or_owner()` (two-step verification included). The callback also
  writes the integration row through RLS before saving any token.

### Importing the menu

`listCatalog` → `mapSquareCatalog` (`catalog-core.ts`, pure and unit-tested) →
`apply_pos_menu_sync()`, one transaction.

| Square                   | Tableside                                                | `external_id`                                             |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------- |
| Category                 | Section ("Other" for none)                               | category id                                               |
| Item, one variation      | Dish                                                     | the **variation** id (what an order line points at)       |
| Item, several variations | Dish at the cheapest price + required "Choose one" group | item id; group `var:<item id>`; options are variation ids |
| Modifier list            | A group on every dish it's attached to                   | `ml:<list id>:<item id>`; options are modifier ids        |

- Only items present at the connected location; per-location price and sold-out apply.
- Variable-priced items are skipped and named, never guessed at.
- Re-importing updates by `external_id`. Square owns name, price, section and availability;
  photos, allergens and dietary flags added in Tableside are kept.
- Nothing is deleted (carts and orders point at menu rows): what Square dropped is hidden, and a
  dropped group stops being required so it can't block an order. Dishes added by hand in
  Tableside are never touched.
- An import that maps to zero dishes is refused rather than applied, since it would hide the
  whole menu.

### Diners paying through Square (phase 2)

The owner presses **Take card payments through Square** (`restaurant_pos_integrations.payments_enabled`,
which needs the connection enabled; disconnecting or reconnecting switches it off).
`restaurant_card_provider()` then answers `square`, and:

- `get_public_payment_settings()` offers card without a Stripe account.
- `start_order_payment()` / `start_tab_payment()` skip the Stripe account check and return a NULL
  `stripe_account_id`. That NULL is how `checkout.ts` / `tab-checkout.ts` know to call
  `openSquareCheckout()` instead of Stripe. Everything else about the payment row (price from the
  orders, tip validation, one pending payment reused, one succeeded payment per order) is unchanged.
- `openSquareCheckout()` (`src/lib/pos/square/checkout.ts`) reads the bill through
  `payment_bill_lines()` (the diner's own orders only), works out Tableside's fee with the same
  `platform_fee_for_payment()` as Stripe, builds the request (`checkout-core.ts`) and creates a
  Square payment link. The bill is itemised: one line per dish at the price charged, one "Tax &
  charges" line (or a discount), the tip as a "Tip" service charge, Tableside's fee as
  `app_fee_money` on the bill without the tip, and Square's own tip screen off. A request whose total
  isn't the payment total to the cent is refused. `attach_square_checkout()` records the Square
  order id; a pending payment reopens the same checkout.
- **Only the webhook settles** (`/api/webhooks/square`): signature checked over
  `SQUARE_WEBHOOK_URL` + raw body with `SQUARE_WEBHOOK_SIGNATURE_KEY`; a completed `payment.*` event
  calls `mark_square_payment_succeeded()` (service role only, idempotent), which refuses an amount or
  currency that doesn't match and reports it. Payments the restaurant took in Square itself come
  back `unknown` and are ignored.
- The switch refuses to turn on without the webhook settings, because a payment that can't settle
  would go through and never show as paid.

Not through Square yet: **split bills** (hidden for Square restaurants) and **refunds** (done in the
Square Dashboard; Tableside says so).

### In person: Square Terminal and cash (phase 3)

**Pairing.** Settings → Point of sale → Square Terminals → _Get pairing code_ calls the Devices
API (`CreateDeviceCode`, `TERMINAL_API`, the connected location). The owner signs in on the Terminal
with the 6-character code, then presses _Check pairing_, which reads the code back and stores the
`device_id` in `pos_devices` (members read, owners and managers write, never deleted). This needs
the `DEVICE_CREDENTIAL_MANAGEMENT` scope, which connections made before phase 3 lack:
`pos_credentials.scopes` records what was asked for, and the page asks those owners to reconnect.
In Square's test mode the page also offers Square's simulated Terminals (`SQUARE_TEST_TERMINALS`),
which complete checkouts up to $25 without hardware.

**Taking a card.** Settle up and Take order show _Square Terminal_ (and hide Stripe's Tap to Pay)
for Square restaurants with a paired Terminal. `start_square_terminal_payment()` (any member,
amount from the orders, tip 0, `tip_on_device`) opens the payment; `in-person.ts` creates the
itemised Square order, then a Terminal checkout for exactly its total with `order_id`,
`show_itemized_cart`, Tableside's fee as `app_fee_money`, and the Terminal's tip screen on if the
restaurant takes tips. The dialog asks Square every 3 seconds; when the checkout completes, the
server reads the payment from Square and settles through `settle_square_payment()` (service role),
which, for a Terminal payment, checks that the total minus Square's tip is the bill and records the
tip. The webhook settles the same way as a backstop. Staff can cancel a checkout the guest hasn't
paid; a cancelled payment is never settled later (`mismatch`, reported).

**Cash.** After `record_in_person_payment()` records cash, `cash-actions.ts` copies it to Square in
`after()`: the itemised order (tip as a service charge) and a `CASH` payment for its total, recorded
with `attach_square_cash_sale()` so it's sent once. Best effort: the cash is recorded in Tableside
regardless, and a failure is reported. Card-machine records ("paid on your own card machine") are not
copied: Square would count them as external payments, which cost the app maker 1%.

## Clover

Settings → Point of sale, offered to the restaurants `CLOVER_RESTAURANTS` names (Clover talks to its
sandbox until Clover approves the app for production). One POS per restaurant: the Clover card hides
while Square is connected, and the other way round. Phase 1: connect, import the menu, and every
Tableside order created on the Clover register. Phase 2 (next): diners pay through Clover.

### Two Clover facts that shape everything

- **No per-transaction app fee.** Clover's Ecommerce API can't take a platform cut on each payment
  (Clover Developer Relations, 2026-10-27), unlike Stripe's `application_fee_amount` or Square's
  `app_fee_money`. A Clover restaurant pays Tableside by subscription (App Market billing).
- **Orders go to Clover as they're placed.** Unlike Square, Clover shows an API order on the register
  straight away, so the pos_outbox seam above finally has a deliverer.

### Connecting

`startCloverConnect` → Clover's `/oauth/v2/authorize` → `/api/pos/clover/callback` (the app's
Alternate Launch Path). Clover returns `code` and `merchant_id`; `/oauth/v2/token` gives an expiring
access token and a single-use refresh token, stored like Square's (ciphertext in `pos_credentials`,
`src/lib/pos/clover/api.ts` the only reader, importers pinned by
`tests/unit/clover-connection.test.ts`). Tokens refresh five minutes before expiry and the new pair
is saved at once. The state is an httpOnly cookie (Clover doesn't document echoing `state`; if it
does, it must match). A Clover merchant is one location, so the connection is enabled on connect.
Disconnecting forgets the tokens; uninstalling the app in Clover revokes them there.

### Importing the menu

`listCloverInventory` (items with categories and modifier groups, modifier groups with modifiers,
categories; every page) → `mapCloverInventory` (`catalog-core.ts`, pure, unit-tested) →
`apply_pos_menu_sync()`, the same function and the same keep-what-Tableside-added rules as Square.

| Clover         | Tableside                           | `external_id`             |
| -------------- | ----------------------------------- | ------------------------- |
| Category       | Section, by Clover's sortOrder      | category id               |
| Item           | Dish (hidden/unavailable → hidden)  | item id                   |
| Modifier group | A group on every dish it's attached | `mg:<group id>:<item id>` |
| Modifier       | Option                              | modifier id               |

Variable and per-unit priced items are skipped and named.

### Orders on the register

`enqueue_pos_order_created()` writes a `pos_outbox` row in the order's own transaction, now for Clover
connections only. Right after an order is placed (`scheduleCloverDelivery`, next to the kitchen push,
from both `submitOrder` and the POS), `deliverCloverOrders` claims the restaurant's due rows
(`claim_pos_outbox()`, service role, leased two minutes so two workers never push one sale twice),
builds each order (`order-core.ts`) and creates it with `POST /v3/merchants/{mId}/atomic_order/orders`:

- Imported dishes point at their Clover item and modifiers, priced as Tableside charged; dishes added
  in Tableside go as named custom lines. One line per unit. A dine-in order type if the merchant has
  one. The order's note names the Tableside order and table.
- The Clover order id is kept on the outbox row. Failures retry with `outbox-core.ts`'s backoff (about
  an hour); one that gives up is listed on Settings → Point of sale so staff ring it up by hand.
- Retries also go out with the restaurant's next order: there is no per-minute cron on this plan.
