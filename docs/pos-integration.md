# Connecting a restaurant's POS

Nothing in this repository talks to Toast, Square or Clover. What exists is the **seam** a
connector plugs into — the three things that are expensive to retrofit and cheap to add before
anyone needs them.

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
