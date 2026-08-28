# Database

**Status: implemented (Batches 2–8).** Schema, constraints, indexes, and RLS policies below are
live in [`supabase/migrations/`](../supabase/migrations/) and covered by automated tests in
[`tests/integration/db/`](../tests/integration/db/). Customer sessions, carts (Batch 4), orders
(Batch 5), the order state machine / kitchen workflow (Batch 6), AI conversation transcripts
(Batch 7), and two abuse-protection count functions (Batch 8) are all implemented.

Database: Supabase PostgreSQL. UUID primary keys throughout (`gen_random_uuid()`, built into
Postgres 13+, no extension required). `created_at`/`updated_at` are set by the database, never
the application — `updated_at` is kept current by a shared `set_updated_at()` trigger
(`supabase/migrations/20260821130000_helper_functions.sql`), attached per-table.

## Entity map

```
restaurants
  ├─ restaurant_users (role per user, per restaurant)
  ├─ restaurant_settings (1:1)
  ├─ order_number_counters (1:1, internal only — see Order numbers below)
  ├─ tables (public_token — QR entry point)
  │    └─ customer_sessions (table_id + restaurant_id, one per anonymous auth.uid())
  │         ├─ carts (1:1 with a customer_session)
  │         │    └─ cart_items (menu_item_id, tenant-scoped FK)
  │         │         └─ cart_item_modifiers (modifier_id + modifier_option_id)
  │         ├─ orders (1:many — a session can place more than one order)
  │         │    ├─ order_items (menu_item_id, snapshotted — see Order items below)
  │         │    │    └─ order_item_modifiers (snapshotted)
  │         │    └─ order_status_history
  │         └─ ai_conversation_messages (1:many — the AI waiter transcript, Batch 7)
  ├─ categories
  │    └─ menu_items (category_id, tenant-scoped FK — see below)
  │         ├─ menu_item_modifiers
  │         │    └─ modifier_options
  │         ├─ menu_item_ingredients ↔ ingredients
  │         └─ menu_item_allergens ↔ allergens
```

Every table below carries `restaurant_id`, directly or (for `modifier_options`) transitively
through its parent. `customer_sessions`, `carts`, `cart_items`, and `cart_item_modifiers` were
added in Batch 4 for the QR-to-cart customer flow; `order_number_counters`, `orders`,
`order_items`, `order_item_modifiers`, and `order_status_history` were added in Batch 5 for order
submission. Batch 6 added no new tables — it added the order state machine
(`transition_order_status()`), a `previous_status` column on `order_status_history`, and Realtime
delivery on top of this same schema. Batch 7 added `ai_conversation_messages`, plus two new
columns returned by `get_public_order_settings()`. Batch 8 added no new tables — it added two
count-only `SECURITY DEFINER` functions for abuse protection (see
["Abuse-protection functions (Batch 8)"](#abuse-protection-functions-batch-8) below). See the
dedicated sections below for all batches.

## The cross-tenant integrity problem, and how it's solved

A plain `menu_items.category_id references categories(id)` only guarantees the category _exists
somewhere_ — nothing stops it belonging to a **different** restaurant than the menu item itself.
Relying on application code to always add `AND category.restaurant_id = menu_item.restaurant_id`
is exactly the kind of thing a rushed PR forgets.

The fix used throughout this schema: every parent table that's a tenant-scoped FK target
declares a **composite `UNIQUE (restaurant_id, id)`** constraint (free — `id` alone is already
unique, so `(restaurant_id, id)` trivially is too), and every child references it with a
**composite foreign key**:

```sql
foreign key (restaurant_id, category_id) references categories (restaurant_id, id)
```

Postgres then rejects any insert/update where the child's `restaurant_id` doesn't match the
referenced parent row's `restaurant_id` — unconditionally, at the constraint level, regardless of
which role or RLS policy let the statement through. This was verified directly (not just written
and assumed correct): `tests/integration/db/cross-tenant-fk.test.ts` inserts cross-tenant rows
against a real Postgres engine and asserts the foreign key constraint rejects them.

Applied to:

- `menu_items (restaurant_id, category_id)` → `categories (restaurant_id, id)`
- `menu_item_modifiers (restaurant_id, menu_item_id)` → `menu_items (restaurant_id, id)`
- `menu_item_ingredients (restaurant_id, menu_item_id)` → `menu_items (restaurant_id, id)`, and
  `(restaurant_id, ingredient_id)` → `ingredients (restaurant_id, id)`
- `menu_item_allergens` — same pattern as `menu_item_ingredients`, against `allergens`

`modifier_options` is the one exception: it has no `restaurant_id` column of its own (per the
schema below) because its tenant is fully determined by `modifier_id` — there's no second
reference on that table that could disagree with the first, so there's nothing for a composite FK
to protect against.

## Tables

### restaurants

Tenant root. `slug` is unique and constrained to lowercase kebab-case
(`^[a-z0-9]+(-[a-z0-9]+)*$`). `currency` is constrained to a 3-letter uppercase code shape
(`^[A-Z]{3}$` — not validated against the real ISO 4217 list at the DB layer). `tax_rate` and
`service_charge` are fractions (`0.0825`, not `8.25`), constrained to `[0, 1]`.

### restaurant_users

Links `auth.users` to a restaurant with a `role` — `owner | manager | kitchen | staff`, enforced
by a `CHECK` constraint. `UNIQUE (user_id, restaurant_id)`: one person, many restaurants, but at
most one role per restaurant. Indexed on both `restaurant_id` and `user_id` — every RLS policy in
this schema resolves to a lookup here, so both directions matter.

### restaurant_settings

1:1 with `restaurants` (`UNIQUE restaurant_id`). Operational toggles, including flags that will
govern the future AI waiter (`allow_ai_recommendations`, `allow_upselling`, `max_order_items`).
Created exclusively by `create_restaurant()` (see below) — no client INSERT/DELETE path.

### tables

`table_number` is `UNIQUE (restaurant_id, table_number)`, **not** globally unique — "Table 1"
legitimately exists at every restaurant.

### categories

`UNIQUE (restaurant_id, name)`. `display_order` is per-restaurant.

### menu_items

`UNIQUE (restaurant_id, slug)` (not globally unique — see the tenant-scoped-FK section above for
why `category_id` is safe). `price >= 0`, `preparation_time` nullable but `>= 0` when present,
`spice_level` constrained to `none | mild | medium | hot | very_hot` (or `NULL`). Booleans for
`is_vegetarian`, `is_vegan`, `is_spicy`, `contains_nuts`, `contains_dairy`, `contains_gluten` —
see "AI readiness" below for why these are individual columns rather than a free-text field.

### menu_item_modifiers / modifier_options

A modifier group (e.g. "Choose a size") with `min_selections`/`max_selections`
(`max_selections >= min_selections`, enforced), and its selectable options. `price_adjustment` on
an option is intentionally unconstrained in sign — a modifier can discount as well as upcharge
(e.g. "No cheese: −$1.00").

### ingredients / menu_item_ingredients

Restaurant-scoped ingredient catalog (`UNIQUE (restaurant_id, name)`) and the item↔ingredient
join table, `UNIQUE (menu_item_id, ingredient_id)` to prevent duplicate links.

### allergens / menu_item_allergens

Same shape as ingredients. Restaurant-scoped, not a shared/global taxonomy — for this version,
each restaurant's own declared allergen data is the source of truth, avoiding the need to
reconcile disagreements against a shared list.

### tables.public_token (Batch 4)

Every table has a `public_token uuid unique default gen_random_uuid()` — the value encoded in
that table's QR code, at `/r/{slug}/table/{public_token}`. It's opaque and unguessable (a random
UUID, not a sequential table number or the table's own primary key), and it's looked up
exclusively through `get_table_by_token(p_public_token)`, a `SECURITY DEFINER` RPC granted to
`anon, authenticated` — there is **no** general `SELECT` policy on `tables`, so a client can't
enumerate every table's token by scanning the table. "Regenerate QR" (`src/lib/tables/actions.ts`)
just assigns a fresh `gen_random_uuid()` to the same row, which immediately invalidates the old
token (the old value no longer matches any row, so `get_table_by_token` starts returning "not
found" for it) — there's no separate revocation list to maintain.

### customer_sessions (Batch 4)

One row per anonymous customer's visit to a specific table. Created by the QR route handler
(`src/app/r/[restaurantSlug]/table/[token]/route.ts`) after it resolves the token via
`get_table_by_token()` — `restaurant_id` and `table_id` come from that server-side lookup, **never**
from anything the browser submits. `user_id` is the `auth.uid()` of a fresh Supabase Anonymous
Auth identity (`signInAnonymously()`) — customers are not `restaurant_users` and never appear in
that table. `session_token` (`unique`, `default gen_random_uuid()`) exists for the same reason
`tables.public_token` does — currently unused externally in URLs (state travels 1:1 via the
Supabase Auth session cookie instead) but kept as a documented, real column rather than never
mattering.

`status` is `active | expired | closed`. `expires_at` defaults to 4 hours from creation
(`CUSTOMER_SESSION_DURATION_HOURS` in `src/lib/customer/session.ts`) — a session is only usable
while `status = 'active' and expires_at > now()`; the QR route handler treats an existing but
timed-out session as absent and starts a new one rather than reviving it. There is no background
expiry sweep — expiration is enforced by every read checking the timestamp, not by a row actually
being deleted or flipped to `expired` on a timer.

A composite FK, `foreign key (restaurant_id, table_id) references tables (restaurant_id, id)`,
applies the same cross-tenant protection described above. RLS restricts all access to
`user_id = auth.uid()`. That alone isn't enough, though — an `UPDATE` policy scoped to
`user_id = auth.uid()` says nothing about _which columns_ the owning user may change, so a
customer could otherwise `UPDATE` their own session's `restaurant_id`/`table_id` to hop to a
different table without rescanning a QR code. A `BEFORE UPDATE` trigger,
`prevent_customer_session_relocation()`, closes that gap by raising an exception whenever either
column would change — enforced at the trigger level regardless of role, not just by policy intent.

### carts / cart_items / cart_item_modifiers (Batch 4)

A cart is 1:1 with a `customer_session` (`UNIQUE customer_session_id`), created alongside it by
the same QR route handler. `cart_items` holds one row per distinct item added to the cart —
`quantity` (`check` 1–99), `unit_price`, `modifiers_price`, and `line_total` (all `check >= 0`).
`cart_item_modifiers` records which options were selected for a given cart item, with the
`price_adjustment` copied at add-time.

**Every price on these tables is server-computed, never client-submitted.** Adding to a cart
(`src/lib/cart/actions.ts` → `src/lib/cart/validate.ts`) re-derives `unit_price` and
`modifiers_price` from the current `menu_items`/`modifier_options` rows in the database — a
request that also happened to include a `price` field is simply ignored; nothing in the server
action reads a price out of client input. The same validation step also re-checks the menu item's
and its category's `is_available`/`is_active`, confirms every selected option actually belongs to
that menu item, and enforces each modifier group's `min_selections`/`max_selections`/`is_required`
— so a crafted request selecting an option that doesn't belong to the item, or violating a group's
selection rules, is rejected before any row is written.

Composite FKs chain the cross-tenant protection all the way down: `carts` → `customer_sessions`
(via `restaurant_id`), `cart_items` → `carts` and → `menu_items`, `cart_item_modifiers` →
`cart_items` and → `menu_item_modifiers` (all `(restaurant_id, id)` pairs). `modifier_options`
still has no `restaurant_id` of its own (see above), so `cart_item_modifiers.modifier_option_id`
is a plain FK, backed by application-level validation instead — the same gap that already exists
for `menu_item_modifiers`/`modifier_options`, not a new one.

RLS on all three tables routes through `cart_belongs_to_caller(cart_id)`, a `SECURITY DEFINER`
function (needed because a _function_ that calls `auth.uid()` from inside an RLS policy, unlike an
inline policy expression, has to escalate its own privileges to reach the `auth` schema — see
`current_restaurant_role()` for the established pattern this follows) that checks the cart's
`customer_session.user_id = auth.uid()`. Cart mutations run through the ordinary per-request
Supabase server client — **the same RLS-respecting client every other batch uses**, never the
admin/service-role client — so this policy is what actually stops one customer from touching
another's cart, not just application-layer discipline.

### Public storefront RLS (Batch 4)

Before Batch 4, every `SELECT` policy on menu-related tables was scoped to `restaurant_users`
membership — there was no way for an unauthenticated visitor (or an anonymous-auth customer) to
read a menu at all. New `anon, authenticated` `SELECT` policies were added to `restaurants`,
`categories`, `menu_items`, `menu_item_modifiers`, `modifier_options`, `ingredients`, `allergens`,
`menu_item_ingredients`, and `menu_item_allergens`, gated by two helper functions:

- `is_restaurant_publicly_active(target_restaurant_id)` — true only if the restaurant row exists
  and `is_active`.
- `is_menu_item_publicly_visible(target_menu_item_id)` — true only if the item, its category, and
  its restaurant are all active/available.

`restaurants_select_public` is the one exception: it's `using (true)`, unconditional, because the
public landing page (`/r/[restaurantSlug]`) needs to read an _inactive_ restaurant's row in order
to show the "temporarily unavailable" state — an RLS policy can't selectively hide some columns
while allowing others, so gating the whole row on `is_active` would make that page indistinguishable
from a restaurant that doesn't exist. Every other public policy in this batch, by contrast, is
scoped strictly to active/available data.

One side effect worth calling out explicitly: because restaurant staff also hold the
`authenticated` role, and Postgres OR's every applicable RLS policy together, staff now
incidentally satisfy these public policies too — a Restaurant A owner can read Restaurant B's
_active_ menu, the same as any anonymous customer already could. This is not a new leak (see
`tests/integration/db/rls-tenant-isolation.test.ts`'s header comment for the full reasoning): it
grants staff no more than the public storefront already exposes to anyone, and the tenant-isolation
boundary that actually matters — writes, and reads of _inactive/unavailable_ data — is unchanged
and still covered by tests.

### Order numbers (Batch 5)

`orders.order_number` is a human-friendly, per-restaurant sequential number (`#1042`, not a UUID)
— never the row's own `id`. It's backed by `order_number_counters`, one row per restaurant
(`restaurant_id primary key, last_number bigint`), incremented **atomically** inside
`submit_order()` via:

```sql
insert into public.order_number_counters (restaurant_id, last_number)
values ($1, 1)
on conflict (restaurant_id) do update set last_number = order_number_counters.last_number + 1
returning last_number;
```

This is deliberately **not** `select max(order_number) + 1 from orders` — that pattern lets two
concurrent transactions both read the same max before either commits, producing a duplicate. The
`insert ... on conflict do update ... returning` shape above is a single atomic statement: Postgres
takes a row lock on the counter row, so a second concurrent caller for the same restaurant blocks
until the first commits (or rolls back), then sees the already-incremented value — no lost updates,
no duplicates, verified in `tests/integration/db/orders.test.ts`'s "order numbers" suite (including
that the backing `orders_unique_order_number_per_restaurant unique (restaurant_id, order_number)`
constraint rejects a collision even via a raw insert, independent of the function's own logic).
`order_number_counters` has RLS enabled but **no policies at all** — it's never read or written by
anything except `submit_order()`.

### orders, order_items, order_item_modifiers (Batch 5)

`orders` is created **exclusively** by `submit_order()` (below) — there is no client-facing
INSERT/UPDATE/DELETE policy on `orders`, `order_items`, `order_item_modifiers`, or
`order_status_history` at all, the same way `restaurants` has none and `create_restaurant()` is its
only writer. This is what makes "a customer cannot change price/total/status/restaurant_id/
table_id/order ownership" structurally true rather than merely policy-enforced: there is no write
path through which any of those values could be submitted in the first place.

`status` is `text` + `CHECK (status in ('pending', 'confirmed', 'preparing', 'ready', 'served',
'cancelled'))` — a controlled vocabulary, not a native Postgres `enum`, matching every other
status-like column in this schema (`restaurant_users.role`, `customer_sessions.status`,
`menu_items.spice_level`) so a future status doesn't need an enum-alteration migration.

`currency` is copied from `restaurants.currency` at submission time, not read live afterward — a
restaurant changing its currency later must never retroactively change what an existing order says
it charged. `idempotency_key` is caller-supplied per submission attempt, unique per
`(customer_session_id, idempotency_key)` — see "Idempotent order submission" below.

**Every monetary/name value on `order_items`/`order_item_modifiers` is a permanent snapshot**,
taken fresh from `menu_items`/`modifier_options` at submission time and never re-read afterward:
`item_name`, `unit_price`, `modifier_total`, `line_total`, `modifier_group_name`,
`modifier_option_name`, `price_adjustment`. A restaurant renaming a dish, changing its price, or
even hard-deleting it (`menu_item_id`/`modifier_option_id` are nullable, `ON DELETE SET NULL`) has
zero effect on any historical order — the FK losing its target just nulls the link column; the
snapshot columns are the source of truth for display, always. Verified directly in
`tests/integration/db/orders.test.ts`'s "snapshot immutability" suite (rename/reprice after
ordering, delete the menu item after ordering, attempt a direct `UPDATE`/`INSERT` on `orders`).

Tenant-scoped composite FKs (the same `(restaurant_id, id)` pattern used throughout this schema)
chain `orders → tables`, `orders → customer_sessions`, `order_items → orders`, `order_items →
menu_items`, `order_item_modifiers → order_items`. Both `tables` and `customer_sessions` are
referenced `ON DELETE RESTRICT` from `orders` (not `CASCADE`) — a table or a customer session with
order history attached can't be deleted out from under it, so historical orders survive unrelated
cleanup elsewhere in the schema.

### order_status_history (Batch 5 schema, Batch 6 workflow)

An append-only audit trail. `submit_order()` writes exactly one row per new order — the initial
`'pending'` event, `previous_status = NULL`, `actor_type = 'customer'`, `actor_id` the submitting
customer's `auth.uid()`. As of Batch 6, `transition_order_status()` (below) writes one additional
row per operational status change, so the full lifecycle of any order is reconstructable from this
table alone: every row names the transition (`previous_status → status`), who performed it
(`actor_type`/`actor_id`), and when (`created_at`) — see "Auditability" in
[`docs/security.md`](./security.md#auditability). `previous_status` was added in Batch 6
(`20260824090050_order_status_history_previous_status.sql`) specifically so each row is
self-describing; Batch 5's original rows (customer-submitted orders) simply have it `NULL`, the
correct value for "there was no prior status."

There is still no client-facing INSERT/UPDATE/DELETE policy on this table for any role — only
`transition_order_status()` (and `submit_order()`, for the initial row) ever write to it, both
`SECURITY DEFINER`. Verified directly: a raw client `INSERT`/`UPDATE`/`DELETE` against
`order_status_history` is rejected regardless of role, in
`tests/integration/db/order-status-transitions.test.ts`.

### Order state machine (Batch 6)

```
pending → confirmed → preparing → ready → served
pending → cancelled
confirmed → cancelled
```

Every other transition is illegal — explicitly including skipping a step (`pending → preparing`),
moving backward (`preparing → pending`, `ready → preparing`), re-applying the same transition twice
(`ready → ready`), and moving out of a terminal state (`served`/`cancelled` never transition to
anything). The legal-transition table lives in exactly one place,
`is_valid_order_status_transition(from_status, to_status)`
(`supabase/migrations/20260824090100_order_status_transitions.sql`) — a pure, deterministic SQL
function, not scattered `if` statements. Two independent things read from it:

- **`trg_orders_enforce_status_transition`**, a `BEFORE UPDATE` trigger on `orders` that rejects
  any illegal status change **regardless of who or what issues the UPDATE** — this is the real,
  structural enforcement (spec: "do not rely only on application code"), not just
  `transition_order_status()`'s own logic. It also stamps `confirmed_at`/`cancelled_at` the first
  time an order reaches those statuses.
- **`role_can_transition_order(actor_role, from_status, to_status)`**, the role-permission matrix
  layered on top (below) — owner/manager delegate straight to the base legality table; kitchen and
  staff each get a smaller, explicitly-documented subset.

A sibling trigger, **`trg_orders_enforce_immutable_fields`**, unconditionally rejects any `UPDATE`
that changes `subtotal`/`tax`/`service_charge`/`total`/`currency`/`restaurant_id`/`table_id`/
`customer_session_id`/`order_number`/`idempotency_key` — on every `orders` update, not just status
ones. Batch 5's `submit_order()` had to be restructured
(`20260824090150_submit_order_single_insert.sql`) to insert an order with its final totals in one
shot rather than insert-then-update, specifically because this new trigger correctly no longer
distinguishes "a legitimate internal update" from a hostile one — see that migration's comment for
the full story.

### Role permission matrix (Batch 6)

| Role    | pending→confirmed | confirmed→preparing | preparing→ready | ready→served | pending→cancelled | confirmed→cancelled |
| ------- | ----------------- | ------------------- | --------------- | ------------ | ----------------- | ------------------- |
| owner   | yes               | yes                 | yes             | yes          | yes               | yes                 |
| manager | yes               | yes                 | yes             | yes          | yes               | yes                 |
| kitchen | yes               | yes                 | yes             | no           | no                | no                  |
| staff   | no                | no                  | no              | yes          | yes               | no                  |

Customers can never transition any order — they hold no `restaurant_users` row for any restaurant,
so `current_restaurant_role()` always returns `NULL` for them, which
`transition_order_status()` treats as an unconditional rejection before role logic is even
consulted. staff can cancel a still-`pending` order (a front-of-house catch before the kitchen has
committed to it) but not a `confirmed` one — by then the kitchen has already started acting on it,
so that's a manager/owner call. kitchen cannot serve or cancel at all. This matrix lives in
`role_can_transition_order()` (same migration as the state machine above) — see
[`docs/security.md`](./security.md#staff-role-matrix) for the full authorization reasoning.

### Status transition: `transition_order_status()` (Batch 6)

The order engine's second entry point, alongside `submit_order()` — same established pattern
(`SECURITY DEFINER`, called via the caller's own RLS-respecting client, never the admin client).
Signature: `transition_order_status(p_order_id uuid, p_target_status text)` — **no restaurant_id,
no customer_session_id, no current_status.** Every one of those is derived server-side:

1. `auth.uid()` must be non-null (rejects unauthenticated callers — the grant itself already
   excludes `anon`, see below).
2. The order is read under `SELECT ... FOR UPDATE` — a row lock held for the rest of the
   function, which is what makes concurrent transition attempts on the _same_ order resolve
   safely: a second caller blocks until the first commits, then re-reads the now-current status,
   so a stale assumption never gets applied on top of someone else's change.
3. `current_restaurant_role(order.restaurant_id)` derives the caller's role from their real
   `restaurant_users` membership — never a client-supplied value.
4. Structural legality is checked first (`is_valid_order_status_transition`, raising
   `ORDER_TRANSITION_INVALID_TRANSITION` if the move doesn't exist in the state machine at all),
   then role permission (`role_can_transition_order`, raising `ORDER_TRANSITION_FORBIDDEN`) — two
   distinct checks with two distinct error codes, so "that transition doesn't exist" and "you're
   not allowed to do that" are never conflated.
5. The `UPDATE` itself only ever sets `status` — `trg_orders_enforce_status_transition` and
   `trg_orders_enforce_immutable_fields` (above) both re-validate independently regardless.
6. Inserts the `order_status_history` row (`previous_status`, `status`, `actor_type` = the
   caller's real role, `actor_id` = `auth.uid()`).

Grants: `EXECUTE` is revoked from `PUBLIC` (Postgres's implicit default for every new function —
easy to overlook) and re-granted only to `authenticated`. An `anon`-role caller is therefore
rejected at the grant level itself ("permission denied for function"), before the function body's
own `auth.uid()` check would otherwise have to catch it — verified in
`tests/integration/db/order-status-transitions.test.ts`.

### Realtime (Batch 6)

`orders` is added to the `supabase_realtime` publication and set to `REPLICA IDENTITY FULL`
(`20260824090300_orders_realtime.sql`, guarded to no-op against this project's PGlite test harness,
which has no Realtime layer at all). Supabase's Realtime server evaluates every `postgres_changes`
row event against the **same RLS policies** an ordinary query would, using the subscribing client's
own JWT — `orders_select_own_or_staff` (unchanged since Batch 5) is therefore already the complete
security boundary for order events; this migration only turns on change _delivery_ for a table
whose read access was already correctly tenant/session-scoped. See
[`docs/security.md`](./security.md#realtime-security) for the full model, including why the
client-side subscription `filter` is a bandwidth optimization and explicitly _not_ the thing
preventing cross-tenant leakage.

### Order submission: `submit_order()`

The order engine's single entry point, mirroring `create_restaurant()`'s established pattern: one
`SECURITY DEFINER` PL/pgSQL function
(`supabase/migrations/20260823100600_submit_order_function.sql`), called via the caller's own
per-request (RLS-respecting) Supabase client — **never** the admin/service-role client. The
elevated privilege is needed for the same class of reason `create_restaurant()` needed it: this
function writes across six tables as one atomic transaction, including `order_number_counters`,
which has no client-facing RLS policy at all.

Signature: `submit_order(p_idempotency_key text, p_customer_note text default null)`. That's it —
**no cart id, no line items, no prices, no restaurant/table/session id.** Everything else is
derived entirely server-side from `auth.uid()` and current database state:

1. Resolve the caller's own active `customer_sessions` row from `auth.uid()` (never a client id).
2. **Idempotency fast path**: if an order already exists for `(this session, this key)`, return it
   unchanged — no re-validation, no new order number burned.
3. Verify the restaurant is active and `restaurant_settings.accepting_orders` is true.
4. Verify the session's cart exists and has at least one item.
5. Allocate an order number and insert the order row (subtotal/tax/total start at 0) — wrapped in
   its own exception-handling block scoped to just this step (see "Idempotent order submission"
   below for why).
6. For every cart line: re-read the **current** `menu_items`/`categories` availability, re-read
   every selected `modifier_options`' current availability and price, re-check the modifier
   group's **current** `is_required`/`min_selections`/`max_selections` against what's actually
   selected, compute `unit_price + modifier_total`, insert the `order_items`/`order_item_modifiers`
   snapshot rows, accumulate the subtotal. Any failure here `RAISE EXCEPTION`s, which — because
   nothing in this function has committed yet — rolls back the entire transaction, including the
   order row and counter increment from step 5. **A failed submission never leaves a partial
   order.**
7. Compute `tax`/`service_charge` from the restaurant's **current** `tax_rate`/`service_charge`,
   update the order with final totals, insert the initial `'pending'` status-history row.
8. Clear the cart's `cart_items` (the `carts` row itself is kept — see "Cart-to-order lifecycle"
   below) and return the finished order.

This necessarily **re-expresses in SQL** the same availability/modifier-group-rule/pricing
predicates `src/lib/cart/validate.ts` already applies at add-to-cart/update-quantity time — the two
can't literally share one function body, since `submit_order()` must run as a single atomic
transaction across six tables while `validateAndPriceSelection()` is a single-item,
PostgREST-backed check called from a Server Action. This is a deliberate, documented tradeoff (see
[`docs/security.md`](./security.md#order-pricing)), not an oversight: both sides enforce identical
rules and are covered by tests asserting matching behavior (stale price, unavailable item, a
modifier group tightened after the cart was built).

### Idempotent order submission (Batch 5)

`orders_unique_idempotency_per_session unique (customer_session_id, idempotency_key)` is the actual
concurrency-safe backstop — not `submit_order()`'s own pre-check alone. The pre-check (step 2
above) handles the common case (sequential retries, a slow double-tap) cheaply, without hitting the
database's conflict path at all. For a genuine race — two calls for the same `(session, key)`
in flight at once — the pre-check on both can pass before either commits; the _second_ to reach the
`orders` insert then hits `unique_violation` on that constraint, which `submit_order()` catches (a
scoped `BEGIN ... EXCEPTION WHEN unique_violation` block) and resolves by returning the _winner's_
row — so **both callers get the same logical order back**, and exactly one order row exists,
regardless of which one "won." See the header comment in `tests/integration/db/orders.test.ts` for
what this test harness can and can't directly exercise here (its single PGlite connection can't
produce genuine simultaneous transactions) — the logical guarantee (repeated calls collapse to one
order) and the constraint itself (rejects a duplicate even via a raw admin insert) are both
verified directly; true multi-connection locking behavior is a well-established property of
Postgres itself.

### Cart-to-order lifecycle (Batch 5)

On successful order creation, `submit_order()` deletes the cart's `cart_items` (cascading to their
`cart_item_modifiers`) but **keeps the `carts` row itself**. This was a deliberate choice between
two documented options (spec: "clear cart, or mark cart submitted/closed — do not destroy useful
historical information unnecessarily"):

- Clearing (chosen): the customer's existing 1:1 cart is immediately reusable — they can order a
  second round (dessert after mains) without a new QR scan. Simple, reuses the exact deletion
  pattern `clearCart()` already used in Batch 4.
- Closing (not chosen): would need a new `status` column on `carts` plus RLS review of it, for a
  benefit (a queryable "this cart was submitted" marker) that `orders`/`order_items` already fully
  provide — every value the cart had is already an independent, permanent snapshot by the time it's
  cleared.

The order is fully independent of the cart from the moment it's created — nothing about an order's
correctness depends on the cart still existing or still containing anything.

## Indexes

Beyond what unique constraints already back automatically: `restaurant_users.restaurant_id`,
`restaurant_users.user_id`, `tables.restaurant_id`, `categories.restaurant_id`,
`menu_items.restaurant_id`, `menu_items.category_id`, `menu_items.is_available`,
`menu_item_modifiers.menu_item_id`, `modifier_options.modifier_id`, `ingredients.restaurant_id`,
`menu_item_ingredients.menu_item_id`, `menu_item_ingredients.ingredient_id`,
`allergens.restaurant_id`, `menu_item_allergens.menu_item_id`, `menu_item_allergens.allergen_id`,
`tables.public_token` (unique index, backs the QR lookup), `customer_sessions.user_id`,
`customer_sessions.restaurant_id`, `customer_sessions.table_id`, `carts.customer_session_id`
(unique), `cart_items.cart_id`, `cart_items.menu_item_id`, `cart_item_modifiers.cart_item_id`,
`orders.restaurant_id`, `orders.customer_session_id`, `orders.table_id`, `orders.status`,
`order_items.order_id`, `order_items.menu_item_id`, `order_item_modifiers.order_item_id`,
`order_item_modifiers.modifier_option_id`, `order_status_history.order_id`,
`order_status_history.created_at`. Chosen because every one of these is either an RLS policy lookup
path or a foreign key an application query will filter/join on — not applied blindly to every
column.

## Row Level Security

Enabled on every table above, from the migration that creates it — there is never a window where
a table exists without RLS on. See [`docs/multi-tenancy.md`](./multi-tenancy.md) for the full
policy model and role matrix.

## Restaurant creation: `create_restaurant()`

Restaurant creation is **not** a client `INSERT` — there is no INSERT policy on `restaurants` for
the `authenticated` role at all. The only path is `public.create_restaurant(p_name, p_slug, ...)`,
a `SECURITY DEFINER` function that:

1. Requires `auth.uid()` to be non-null (rejects anonymous calls).
2. Inserts the restaurant, its settings row, and a `restaurant_users` row — **always** with
   `role = 'owner'` and `user_id = auth.uid()`, neither of which is a parameter the caller can
   override (the function signature has no `role` argument at all).
3. Runs as one PL/pgSQL function body, which Postgres already executes as a single transaction —
   a duplicate slug rolls back the whole call, leaving no orphaned settings row.

Verified in `tests/integration/db/create-restaurant-function.test.ts`, including the rollback
behavior. A thin application-layer wrapper (`src/lib/restaurants/create-restaurant.ts`) validates
input with Zod and calls this function via the per-request Supabase server client, so the RPC
runs as the signed-in user.

## QR table lookup: `get_table_by_token()`

The customer-facing mirror of `create_restaurant()`. `public.get_table_by_token(p_public_token)`
is a `SECURITY DEFINER` function, granted to `anon` and `authenticated`, that looks up a table by
its `public_token` and returns `(table_id, restaurant_id, restaurant_slug, table_number,
display_name)` — enough for the QR route handler to bootstrap a customer session, and nothing
more (no internal counts, no other tables, no staff data). It's the _only_ read path onto `tables`
for anonymous/customer callers; there is deliberately no `SELECT` policy that would let a client
list or enumerate every row.

## ai_conversation_messages (Batch 7)

The AI waiter's conversation transcript — one row per turn (`role`: `user | assistant | tool`),
scoped to exactly one `customer_session_id` via the same composite tenant-scoped FK pattern used
throughout this schema (`foreign key (restaurant_id, customer_session_id) references
customer_sessions (restaurant_id, id)`). Serves three purposes at once, deliberately kept as one
table rather than three: conversation memory (so a page reload doesn't lose context), the signal
`src/lib/ai/rate-limit.ts` counts against, and an audit trail for AI-driven cart/order mutations
(`tool` rows carry `tool_name`/`tool_success`, written by the orchestrator from the tool's own real
result, never fabricated by the model). `content` is capped at 8000 characters (`CHECK`). RLS
mirrors carts: `customer_sessions.user_id = auth.uid()`, append-only (no UPDATE/DELETE policy for
any role, matching `order_status_history`'s philosophy) — verified in
`tests/integration/db/ai-conversation-messages.test.ts`. Like `customer_sessions` itself, there's
no background retention/cleanup job for this table yet — see "Known limitations" below.

`get_public_order_settings()` was extended in the same batch to also return
`allow_ai_recommendations`/`allow_upselling` (pre-existing `restaurant_settings` columns since
Batch 2, unused until now) — the AI waiter's master enable/disable toggle and upsell-permission
gate, respectively. See [`docs/ai.md`](./ai.md) for the full AI architecture built on top of this
schema.

## Abuse-protection functions (Batch 8)

Two narrow, count-only `SECURITY DEFINER` functions, following the same minimal-exposure pattern
as `get_table_by_token()`/`get_public_order_settings()` — return only an integer count, never row
content:

- `count_recent_sessions_for_table(p_table_id, p_window_seconds)` — how many `customer_sessions`
  rows a table has accumulated recently. Backs `src/lib/customer/rate-limit.ts`; granted to `anon`
  since it runs before any customer identity/session exists.
- `count_recent_orders_for_session(p_customer_session_id, p_window_seconds)` — how many `orders`
  a session has actually created recently (not attempts — a retried idempotency key never
  increments this). Backs `src/lib/orders/rate-limit.ts`; granted to `authenticated` only (a
  session must already exist for this check to mean anything).

See [`docs/security.md`](./security.md#customer-session-creation-rate-limiting--implemented-in-batch-8)
for the full design and [`docs/production-audit.md`](./production-audit.md) for why these were
added. Verified in `tests/integration/db/abuse-protection-rpcs.test.ts`.

## audit_log (production-hardening addition)

An append-only "who changed what" trail for admin-side CRUD — `restaurant_users`, `categories`,
`restaurant_settings`, `menu_items`, `modifier_options`, `menu_item_modifiers`, `allergens`,
`ingredients`, and `tables` each had only `updated_at` (when, never who or what it used to be)
before this addition. One generic table + a single `record_audit_log()` `SECURITY DEFINER` trigger
function attached to all nine, rather than nine bespoke history tables: each row records a
strictly monotonic `seq` (independent of `created_at`, whose resolution isn't fine enough to
unambiguously order two writes to the same row within the same millisecond), `table_name`,
`row_id`, `operation`, `actor_id`/`actor_role` (role captured at write time, not joined later), and
the full `old_data`/`new_data` row as JSON. `modifier_options` has no
`restaurant_id` column of its own (see below), so the trigger resolves it via the row's owning
`menu_item_modifiers.restaurant_id`. Append-only, same philosophy as `order_status_history`: no
client-facing `INSERT`/`UPDATE`/`DELETE` policy for any role, read scoped to
`is_restaurant_manager_or_owner()`. See
[`docs/security.md#admin-crud-audit-log--production-hardening-addition`](./security.md#admin-crud-audit-log--production-hardening-addition)
for the full design and verified in `tests/integration/db/admin-audit-log.test.ts`.

## AI readiness (schema support, unchanged reasoning since Batch 2)

Beyond the AI-specific table above, the core menu schema exposes the structured data the AI tool
layer (see [`docs/ai.md`](./ai.md)) answers questions like "show me vegetarian dishes," "what's
under $15," or "does this contain dairy" from — without inventing or guessing: `is_vegetarian`,
`is_vegan`, `spice_level`, `contains_dairy`/`contains_nuts`/`contains_gluten`, `price`, and
`is_available` are all queryable columns, and `menu_item_modifiers`/`modifier_options` expose what
customization is actually available per item.

## Seed data

`supabase/seed.sql` creates one demo restaurant ("Nashta (Demo)", slug `nashta-demo`) with 8
tables, 5 categories, and (expanded in Batch 8, from 9) 20 menu items — with realistic
ingredients, allergens, dietary flags, and 9 modifier groups spanning both required (e.g. a
required spice-level choice) and optional (e.g. add-ons) — applied automatically by
`supabase db reset`. One item (Rava Dosa) is deliberately seeded `is_available = false`, with a
realistic reason ("seasonal, currently unavailable") and full ingredient/allergen/modifier data —
a genuine temporarily-86'd dish, not a broken fixture, so the seed exercises unavailable-item
handling (cart revalidation, AI tool "not available" responses) the same way a real restaurant's
menu would. It does **not**
create any `restaurant_users` rows, because that requires real `auth.users` rows, which requires
either a password or the Supabase Admin API — and per project policy, no password belongs in
source-controlled SQL. See [`scripts/seed-dev-users.ts`](../scripts/seed-dev-users.ts) for the
documented, credential-free way to create the four dev logins (owner/manager/kitchen/staff)
locally; it prints a random password once per user and never writes one to disk.

This is demo data only. No application code may hardcode anything about "Nashta" — the schema
and backend work identically for any restaurant row (see
[`docs/multi-tenancy.md`](./multi-tenancy.md)).

## Known limitations

- `ai_conversation_messages` has no background retention/cleanup job, the same limitation
  `customer_sessions` already has (see below) — rows accumulate for as long as the session exists
  and are never automatically pruned. Bounded in practice by the AI rate limit (at most
  `AI_RATE_LIMIT_MAX_MESSAGES` new rows per session per window), but worth revisiting if long-term
  storage/retention ever becomes a concern.
- No kitchen display _UI_ beyond the board itself has order-detail actions like editing an order,
  splitting it, or merging tables — out of scope for this batch (spec explicitly excludes
  payments/POS/inventory), and there's no write path for any of that regardless.
- `customer_sessions` has no background expiry job — a timed-out session is treated as inactive by
  every read (`status = 'active' and expires_at > now()`), but the row itself isn't deleted or
  flipped to `expired` automatically. Fine for this batch's scope; worth revisiting if stale rows
  ever need cleanup (e.g. for storage/retention reasons).
- `restaurants` has no DELETE path (deactivate via `is_active` instead) — intentional for this
  batch, not yet revisited.
- `submit_order()`'s and `transition_order_status()`'s concurrency guarantees (idempotency,
  order-number uniqueness, exactly-one-transition-succeeds) rest on Postgres's own row-level
  locking and unique constraints, which is correct on a real server but can't be _directly_
  exercised by this project's test harness (`@electric-sql/pglite`, a single connection — see
  `tests/integration/db/setup.ts`'s header comment, and the header comments in
  `tests/integration/db/orders.test.ts` and `tests/integration/db/order-status-transitions.test.ts`
  for exactly what is and isn't covered as a result).
- Realtime's actual delivery behavior (reconnect timing, event ordering under real network
  conditions, the RLS-based authorization Supabase documents for `postgres_changes`) can only be
  verified against a real Supabase project — PGlite has no Realtime layer to test against at all.
  See "Real Supabase validation" in the Batch 6 final report.
- Currency and country codes are format-checked, not validated against real ISO lists.
- The RLS/constraint test suite runs against `@electric-sql/pglite` (WASM Postgres), not a live
  Supabase project — see the header comment in `tests/integration/db/setup.ts` for why, and what
  it does and doesn't stand in for.
