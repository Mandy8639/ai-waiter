# Multi-tenancy

**Status: implemented (Batches 2–8).** Every table listed below has Row Level Security enabled and
policies in place, verified by `tests/integration/db/rls-tenant-isolation.test.ts`,
`cross-tenant-fk.test.ts`, `roles-and-permissions.test.ts`, `customer-sessions-and-cart.test.ts`
(Batch 4), `orders.test.ts` (Batch 5), `order-status-transitions.test.ts` (Batch 6),
`ai-conversation-messages.test.ts` (Batch 7), and `abuse-protection-rpcs.test.ts` (Batch 8).

## The rule

AI Waiter serves many restaurants from one application and one database. Every restaurant-owned
resource is scoped to a `restaurant_id`, and isolation is enforced in Postgres via Row Level
Security — never only in application code, so a forgotten `WHERE` clause in one API route can't
become a cross-tenant data leak.

Restaurant-owned tables today: `restaurants`, `restaurant_users`, `restaurant_settings`, `tables`,
`categories`, `menu_items`, `menu_item_modifiers`, `modifier_options`, `ingredients`,
`menu_item_ingredients`, `allergens`, `menu_item_allergens`, plus (Batch 4) `customer_sessions`,
`carts`, `cart_items`, `cart_item_modifiers`, plus (Batch 5) `order_number_counters`, `orders`,
`order_items`, `order_item_modifiers`, `order_status_history`, plus (Batch 7)
`ai_conversation_messages`.

Batch 4's four new tables use a **second isolation axis alongside** the restaurant-membership one
described in this document: they're scoped to `user_id = auth.uid()` (an anonymous-auth customer
identity, never a `restaurant_users` row), not to restaurant membership — see
["Customer session and cart isolation"](#customer-session-and-cart-isolation-batch-4) below. Batch
4 also added the first **public** (`anon`-readable) RLS policies in this schema, on the menu-facing
tables — see ["Public storefront access"](#public-storefront-access-batch-4). Batch 5's order
tables combine **both** axes at once — see
["Order isolation"](#order-isolation-batch-5) below — plus a third pattern new to this batch: no
client-facing write policy at all, on any table, for any role. Batch 7's
`ai_conversation_messages` reuses the exact same second axis as carts — see
["AI conversation isolation"](#ai-conversation-isolation-batch-7) below.

## How membership is determined

`restaurant_users` links `auth.users` to a restaurant with a `role`. Every policy in the schema
resolves to a lookup here through two `SECURITY DEFINER` helper functions
(`supabase/migrations/20260821130300_auth_helpers.sql`):

- `current_restaurant_role(restaurant_id)` — the caller's role in that restaurant, or `NULL`.
- `is_restaurant_member(restaurant_id)` / `is_restaurant_manager_or_owner(restaurant_id)` — the
  two shapes almost every policy needs.

These are `SECURITY DEFINER` so that a policy _on_ `restaurant_users` can call them without
recursing into `restaurant_users`' own RLS (the function reads the table as its privileged owner,
already filtered to `auth.uid()`, so it never exposes another user's membership).

## Policy shape, table by table

| Table                                                                                                                                                       | Read                         | Write                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `restaurants`                                                                                                                                               | any member                   | `owner`/`manager` (UPDATE only — no client INSERT/DELETE, see below)                        |
| `restaurant_users`                                                                                                                                          | any member (staff directory) | INSERT: `owner` (any role) or `manager` (non-owner roles only); UPDATE/DELETE: `owner` only |
| `restaurant_settings`                                                                                                                                       | any member                   | `owner`/`manager` (UPDATE only — no client INSERT/DELETE)                                   |
| `tables`, `categories`, `menu_items`, `menu_item_modifiers`, `modifier_options`, `ingredients`, `menu_item_ingredients`, `allergens`, `menu_item_allergens` | any member                   | `owner`/`manager` (INSERT/UPDATE/DELETE)                                                    |

`kitchen` and `staff` are read-only across the board in this batch — deliberately not
over-built, since order-related kitchen workflows don't exist yet (see
[`docs/architecture.md`](./architecture.md)). The role architecture (four roles, checked via the
same two helper functions) is in place for when they do.

## Restaurant creation doesn't go through these policies at all

There's no INSERT policy on `restaurants` for `authenticated` — the only way to create one is the
`create_restaurant()` `SECURITY DEFINER` function, which bypasses RLS internally and always
assigns the caller as `owner`. See [`docs/database.md`](./database.md#restaurant-creation-create_restaurant)
for why, and `tests/integration/db/create-restaurant-function.test.ts` for the tests. This is what
stops a client from ever submitting `role = 'owner'` for itself directly.

## Privilege escalation — specifically tested, not just designed against

These are the exact questions a hostile reviewer would ask, each backed by a passing test in
`tests/integration/db/roles-and-permissions.test.ts`:

- **Can a user change their own role?** No — `restaurant_users` UPDATE requires the _caller's
  current_ role to be `owner` (checked via `current_restaurant_role`, not the row being edited),
  so a staff member's own UPDATE to `role = 'owner'` matches zero rows.
- **Can a manager grant `owner` to someone else?** No — the INSERT policy's `WITH CHECK`
  explicitly disallows `role = 'owner'` for a caller who is themselves only a `manager`.
- **Can a client submit a different `restaurant_id` to write outside its own tenant?** No — every
  write policy checks `current_restaurant_role(restaurant_id)` against the _value in the row
  being written_, not a value the client claims separately; submitting someone else's
  `restaurant_id` just means the check runs against a restaurant the caller isn't a member of.
- **Can a user attach another restaurant's category/ingredient/allergen to their own menu item?**
  No — RLS alone can't catch this (it only ever inspects `restaurant_id`, which is correctly the
  caller's own), so this is exactly what the composite tenant-scoped foreign keys in
  [`docs/database.md`](./database.md#the-cross-tenant-integrity-problem-and-how-its-solved) catch
  instead. Defense in depth: two independent mechanisms, not one.

## Customer session and cart isolation (Batch 4)

`customer_sessions`, `carts`, `cart_items`, and `cart_item_modifiers` are restaurant-owned (each
carries `restaurant_id`, and composite FKs enforce the usual cross-tenant integrity — see
[`docs/database.md`](./database.md)), but they are **not** governed by the
`current_restaurant_role()` membership model above, because their owner isn't a restaurant staff
member at all. Instead:

| Table                                        | Read/write scope                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `customer_sessions`                          | `user_id = auth.uid()` (the anonymous-auth identity that owns the session)            |
| `carts`, `cart_items`, `cart_item_modifiers` | `cart_belongs_to_caller(cart_id)` — resolves to the same `user_id = auth.uid()` check |

`cart_belongs_to_caller()` is `SECURITY DEFINER` for the same reason
`current_restaurant_role()` is: a function that calls `auth.uid()` from inside an RLS policy needs
its own elevated privilege to reach the `auth` schema, even though an inline `auth.uid()` inside a
policy's own expression doesn't. A restaurant's staff have **no** special access to that
restaurant's customer sessions or carts through these policies — a `customer_sessions`/`cart` row
is visible only to the one `auth.uid()` that created it, staff role notwithstanding. (Staff _can_
see completed orders, as of Batch 5 — the same way any restaurant system would — but that's a
deliberately separate table with its own, different isolation rule; see
["Order isolation"](#order-isolation-batch-5) below. A still-in-progress cart is never staff-visible
by design.)

A session/cart can't be relocated to a different table or restaurant after creation either — see
the `prevent_customer_session_relocation()` trigger in [`docs/database.md`](./database.md) and
[`docs/security.md`](./security.md#secure-customer-sessions--implemented-in-batch-4).

## Public storefront access (Batch 4)

`restaurants`, `categories`, `menu_items`, `menu_item_modifiers`, `modifier_options`,
`ingredients`, `allergens`, `menu_item_ingredients`, and `menu_item_allergens` each gained an
`anon, authenticated` `SELECT` policy, scoped to active/available data via
`is_restaurant_publicly_active()` / `is_menu_item_publicly_visible()` (the one exception being
`restaurants` itself, which is publicly readable unconditionally so the storefront can show an
inactive restaurant's "unavailable" state — see [`docs/database.md`](./database.md#public-storefront-rls-batch-4)
for why). This is additive, not a replacement: the existing membership-scoped policies on these
tables are untouched, and because Postgres OR's every matching policy together, staff retain their
existing membership-based access on top of the new public one. The one behavioral change this
causes — staff can now also read _another_ restaurant's active menu, the same as any anonymous
customer already could — is deliberate and reviewed, not a regression; see
[`docs/security.md`](./security.md#public-restaurant-menu-access--implemented-in-batch-4).

## Order isolation (Batch 5)

`orders`, `order_items`, `order_item_modifiers`, and `order_status_history` combine both isolation
axes already established in this document, in a single `SELECT` policy each:

```sql
using (
  exists (select 1 from customer_sessions cs where cs.id = orders.customer_session_id and cs.user_id = auth.uid())
  or is_restaurant_member(restaurant_id)
)
```

Unlike carts (customer-only, never staff-visible — see above), a **customer sees only their own
orders**, and **any restaurant staff member sees every order at their own restaurant**, regardless
of role — read-only, matching the existing "any member can read" convention this document already
established for menus/tables/categories. A Restaurant A staff member reading Restaurant B's orders
is blocked the same way reading any other Restaurant B data is: `is_restaurant_member(restaurant_id)`
requires an actual `restaurant_users` row for _that_ restaurant, which they don't have.

The pattern genuinely new to this batch: **no table in this group has an INSERT, UPDATE, or DELETE
policy at all, for any role.** `submit_order()` is the only writer, via its own `SECURITY DEFINER`
elevation — the same way `create_restaurant()` is the only writer for `restaurants` (which also has
no client-facing `INSERT` policy). This makes "a customer cannot change an order's price, total, or
ownership" true at the level of "there is no grant that would let them attempt it," not just "a
policy would reject it." (Status specifically gained a second, still-non-client writer in Batch 6 —
see below — but the "no client-facing write policy" property this paragraph describes is otherwise
unchanged.) See [`docs/security.md`](./security.md#order-immutability) and
[`docs/database.md`](./database.md#orders-order_items-order_item_modifiers-batch-5).

## Order status transition isolation (Batch 6)

`transition_order_status()` is the second (and, as of this batch, last) `SECURITY DEFINER` writer
in the `orders` group — still no client-facing `UPDATE` policy exists on `orders`, and still no
`INSERT` policy exists on `order_status_history`. What the function is allowed to change is
narrower than "the caller's role permits it": two `orders` triggers
(`supabase/migrations/20260824090100_order_status_transitions.sql`) enforce, independent of the
function's own code, that (a) a status change must be a structurally legal state-machine move, and
(b) no `UPDATE` — through this function or any other path — may ever touch a financial or
tenant-identity column. Role authorization (who may perform _this specific_ transition) is a
separate, additional check inside the function, using the same `current_restaurant_role()` helper
every other role-gated policy in this document uses — a customer, having no `restaurant_users` row
for any restaurant, always fails it. Cross-tenant staff (Restaurant A staff attempting to
transition a Restaurant B order) is blocked identically to every other cross-restaurant write in
this schema: the role lookup is scoped to the order's own `restaurant_id`, which the caller isn't a
member of. See [`docs/security.md`](./security.md#order-status-transitions) for the full mechanism
and [`docs/database.md`](./database.md#order-state-machine-batch-6) for the state machine and role
matrix.

Realtime (also Batch 6) introduces no new isolation model of its own — Supabase's Realtime server
evaluates `postgres_changes` events against the same RLS policies described above, using the
subscribing client's own JWT, so `orders_select_own_or_staff` is the complete authorization
boundary for order events exactly as it already is for a plain `SELECT`. See
[`docs/security.md`](./security.md#realtime-security).

## AI conversation isolation (Batch 7)

`ai_conversation_messages` follows the exact same second isolation axis as carts (see
["Customer session and cart isolation"](#customer-session-and-cart-isolation-batch-4) above):
scoped to `customer_sessions.user_id = auth.uid()`, never to restaurant membership — restaurant
staff have **no** special read access to a customer's AI conversation through RLS, the same way
they have none to an in-progress cart. Unlike orders (which staff _can_ read, once completed), a
customer's AI chat transcript is never staff-visible in this batch — there was no product need
for it, and not adding the policy is cheaper and safer than adding one nobody asked for. Also
append-only, matching `order_status_history`: no UPDATE/DELETE policy exists for any role,
including the customer who wrote the messages. See
[`docs/database.md`](./database.md#ai_conversation_messages-batch-7) for the schema and
[`docs/ai.md`](./ai.md#tool-authorization--server-side-never-the-models-choice) for how this table
fits into the AI tool-authorization model — the table itself is conversation memory, not a
security boundary; every AI tool independently re-derives its own authorization from the
authenticated session, never from anything stored here.

## Abuse-protection function scoping (Batch 8)

`count_recent_sessions_for_table()` and `count_recent_orders_for_session()` (see
[`docs/database.md`](./database.md#abuse-protection-functions-batch-8)) are both `SECURITY
DEFINER`, like every cross-cutting count/lookup function in this schema, but neither introduces a
new isolation model — each is scoped by its own single argument (a specific `table_id` or a
specific `customer_session_id`) and returns only a count for that one argument, never a set of
rows or another table's/session's activity. `count_recent_sessions_for_table()` is callable by
`anon` deliberately: it runs in the QR route handler _before_ any customer identity or session
exists, the one narrow case in this schema where a pre-authentication `SECURITY DEFINER` function
is the correct shape (the same reasoning `get_table_by_token()` already established).

## Service-role / admin access

The privileged admin Supabase client (`src/lib/supabase/admin.ts`) bypasses RLS entirely and is
restricted to trusted server-only code (enforced by the `server-only` import — see
[`docs/security.md`](./security.md#server-only-secrets)). Any code path that uses it is
responsible for re-checking tenant authorization itself in application code; the database will
not stop it. As of Batch 2, the only server-side code using elevated privileges is
`create_restaurant()` itself (a `SECURITY DEFINER` Postgres function, not the admin client) and
`scripts/seed-dev-users.ts` (a manually-run local dev script, never part of a request path).
