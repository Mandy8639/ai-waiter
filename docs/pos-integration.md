# Connecting a restaurant's POS

**Square is connected** (phase 1: connect an account and import its menu; see "Square" below).
Toast and Clover are not. Underneath is the **seam** any connector plugs into — the three things
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

Settings → Point of sale. Phase 1 of four: connect the restaurant's Square account and import its
menu. Diner payments through Square (phase 2), Square Terminal and cash (phase 3) and pay-when-
ordering (phase 4) come next.

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

| Square | Tableside | `external_id` |
| --- | --- | --- |
| Category | Section ("Other" for none) | category id |
| Item, one variation | Dish | the **variation** id (what an order line points at) |
| Item, several variations | Dish at the cheapest price + required "Choose one" group | item id; group `var:<item id>`; options are variation ids |
| Modifier list | A group on every dish it's attached to | `ml:<list id>:<item id>`; options are modifier ids |

- Only items present at the connected location; per-location price and sold-out apply.
- Variable-priced items are skipped and named, never guessed at.
- Re-importing updates by `external_id`. Square owns name, price, section and availability;
  photos, allergens and dietary flags added in Tableside are kept.
- Nothing is deleted (carts and orders point at menu rows): what Square dropped is hidden, and a
  dropped group stops being required so it can't block an order. Dishes added by hand in
  Tableside are never touched.
- An import that maps to zero dishes is refused rather than applied, since it would hide the
  whole menu.
