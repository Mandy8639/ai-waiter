# Architecture

AI Waiter is a multi-tenant SaaS platform: one application, many restaurants. This document
describes the intended end-state architecture. As of Batch 7, the AI waiter is real and working: a
customer scans a table's QR code, browses a restaurant's real menu, builds a priced cart, and
submits a server-validated order — either through the deterministic UI (Batches 4–5, unchanged) or
conversationally through the AI waiter, which calls the exact same validated boundaries. Kitchen
staff see the order appear on a live kitchen display the moment it's submitted, walk it through
confirmed → preparing → ready → served (or cancel it, from the right state and role); the customer
watches their own order's status update live, the whole way through — and can ask the AI waiter
for that same status in natural language. Where a component isn't implemented yet, it's marked
**(not implemented)**.

## Guiding principle: the database is the source of truth

The AI is a _consumer_ of restaurant data, never its owner. Menu items, prices, availability,
modifiers, ingredients, allergens, orders, tables, and restaurant configuration all live in
PostgreSQL and are managed by the restaurant dashboard and backend — never invented, cached, or
overridden by the model. See [`docs/ai.md`](./ai.md) for how the AI is kept on a short leash
around that data.

## Three surfaces, one backend

### Customer

```
QR code                    (implemented — per-table public_token, see docs/database.md)
  ↓
Customer Web App            (implemented — deterministic browse/search/cart/checkout,
  ↓                          /r/[restaurantSlug]/*; works with or without the AI)
AI Waiter                  (implemented — Batch 7, src/components/customer/ai-waiter*.tsx —
  ↓                        talks to the customer, answers menu questions, takes orders
  ↓                        conversationally; purely additive, never a dependency)
Validated AI Tools         (implemented — Batch 7, src/lib/ai/tools/ — search_menu,
  ↓                        add_item_to_cart, submit_order, … wrap the exact functions
  ↓                        below, never replace them; see docs/ai.md)
Application Backend         (implemented — Server Actions in src/lib/cart/, src/lib/orders/,
  ↓                          src/lib/customer/, calling submit_order() for order submission)
PostgreSQL                  (schema + RLS implemented, including customer_sessions/carts
  ↓                          (Batch 4), orders/order_items (Batch 5), the order state
  ↓                          machine (Batch 6), and ai_conversation_messages (Batch 7) —
  ↓                          see docs/database.md)
Realtime                   (implemented — Batch 6, see the Kitchen surface below; the
  ↓                          customer order page also subscribes to its own order's changes)
Kitchen
```

A diner scans a table's QR code, which resolves server-side to a specific restaurant and table
(never trusting anything the URL claims beyond the opaque token itself) and starts an anonymous
customer session scoped to that restaurant+table. From there the customer can browse the menu,
search, view item detail, build a cart, and submit an order — all through deterministic, non-AI
code paths; every price is computed server-side from current menu data, never accepted from the
client, and re-verified again at order submission time (menu data can change between "add to cart"
and "place order"). Once submitted, the customer's own order confirmation page
(`/r/[restaurantSlug]/order/[orderId]`) stays live via Supabase Realtime
(`src/components/customer/order-status-sync.tsx`) — as kitchen staff confirm, prepare, and serve
the order, the customer sees each change without refreshing.

As of Batch 7, the same customer can instead (or additionally) open the AI waiter and do all of
the above conversationally — "what vegetarian dishes do you have?", "add the paneer dosa, medium
spice", "what's in my cart?", "place the order", "where is my order?" The AI still never talks to
Postgres directly: every action it takes goes through the validated tool layer
(`src/lib/ai/tools/`), which calls the exact same `submit_order()`/`addToCart()`/`getCart()`/
`getOrdersForSession()` functions and `src/lib/cart/` validation these earlier batches already
built — not a parallel AI-specific path. See [`docs/ai.md`](./ai.md) for the full design.

### Restaurant (owner/staff dashboard)

```
Restaurant Dashboard        (implemented — /dashboard/*, see docs/development.md)
  ↓
Backend                     (Server Actions per entity, RPCs for restaurant/order creation
  ↓                          and status transitions — see docs/database.md)
PostgreSQL                  (schema + RLS implemented — see docs/database.md)
```

Restaurant owners and staff manage their menu, tables, QR codes, settings, staff accounts, and (as
of Batch 6) live orders here. Every read and write is scoped to that restaurant via Supabase Row
Level Security — see [`docs/multi-tenancy.md`](./multi-tenancy.md).

### Kitchen

```
Kitchen Display System       (implemented — /dashboard/kitchen, see below)
  ↓
Realtime                     (implemented — Batch 6, Supabase Realtime on `orders`)
  ↓
Order Database                (implemented — orders/order_items/order_item_modifiers/
                              order_status_history, see docs/database.md)
```

Kitchen staff see incoming orders the moment they're submitted, via a Realtime subscription against
`orders` (`src/components/kitchen/kitchen-board.tsx`) — no polling, no separate order store, no
manual refresh required for the board to reflect a new order or another staff member's action. RLS
(`orders_select_own_or_staff`, unchanged since Batch 5) is what actually scopes which events any
given connection can receive — see
[`docs/security.md`](./security.md#realtime-security). A restaurant's staff can view every order at
their own restaurant regardless of role; which action buttons render (Confirm / Start preparing /
Mark ready / Mark served / Cancel) is role-scoped per
[`docs/database.md`](./database.md#role-permission-matrix-batch-6), though — per the spec's own
"UI is not security" instruction — the actual enforcement is `transition_order_status()`, which
re-derives the caller's role and re-validates the transition itself regardless of what the client
rendered or attempted.

## What Batch 8 added

Production-readiness hardening, not new product surface — see
[`docs/production-audit.md`](./production-audit.md) for the full audit this batch performed
before making any change.

- Abuse throttling for the two public-facing surfaces the Batch 7 final report flagged as gaps:
  customer session creation (`src/lib/customer/rate-limit.ts`, scoped to `table_id`) and order
  submission (`src/lib/orders/rate-limit.ts`, scoped to `customer_session_id`, deliberately
  counting actual created orders so it can never punish a legitimate idempotent retry) — backed by
  two new count-only `SECURITY DEFINER` functions
  (`supabase/migrations/20260826090000_abuse_protection_rpcs.sql`).
- A real, previously-undiscovered bug found and fixed: the Playwright e2e suite's
  `hasRealSupabaseProject`/`hasRealAiProvider` gating checks never actually saw `.env.local` (only
  the separately-spawned Next.js app did) — meaning the real-credential-gated suites would have
  silently skipped forever even with correct credentials configured exactly as documented.
  `playwright.config.ts` now loads env vars the same way Next.js itself does
  (`@next/env#loadEnvConfig`, already bundled, no new dependency) before test files evaluate their
  gating checks. Reproduced and confirmed both the bug and the fix directly, not by inspection
  alone — see [`docs/production-audit.md`](./production-audit.md#4-e2e-real-credential-gating-silently-never-actually-ran-even-with-real-credentials-configured).
  This changes test infrastructure only — no application behavior changed.
- A health check endpoint (`GET /api/health`) reporting high-level readiness (booleans only —
  Supabase/AI configured — never a secret or connection detail) for deployment monitoring.
- `src/lib/ai/env-helpers.ts` moved to `src/lib/env-helpers.ts` — it's no longer AI-specific now
  that both new rate limiters read tunables from the environment the same way `src/lib/ai/config.ts`
  already did; a mechanical rename, no behavior change.
- One real performance fix: the customer menu page (`src/app/r/[restaurantSlug]/menu/page.tsx`)
  fetched categories and menu items sequentially despite neither depending on the other —
  parallelized. Every other data-fetching path audited (item detail, cart retrieval, the AI menu
  tools, the kitchen board query) was already correctly batched/parallelized; no change needed
  there.
- The demo seed restaurant (`supabase/seed.sql`) expanded from 9 to 20 menu items across the same
  5 categories, including one deliberately-unavailable item (a realistic "seasonal, currently
  86'd" dish, not a broken fixture) and additional modifier groups — for realistic full-system
  simulation (spec section 33), still not hardcoded into any application logic.
- Stale documentation caught and fixed: `README.md`, `docs/database.md`,
  `docs/multi-tenancy.md`, and `docs/development.md` still described the system as of Batch 6, with
  no mention of the AI waiter or its schema — inconsistent with `docs/ai.md`/`architecture.md`/
  `security.md`, which Batch 7 did update. All four brought current this batch.
- `docs/production-audit.md` — the full audit this batch performed, including what was reviewed
  and found already correct (not just what changed).

No architecture changed: every fix above operates within boundaries Batches 1–7 already
established (`SECURITY DEFINER` functions following the existing narrow-count pattern,
session-derived identity, RLS-respecting clients only). No payments, POS, voice, reservations,
loyalty, delivery, or analytics were added, per this batch's explicit exclusions.

Still pending (requires a real Supabase project and/or a real Anthropic API key, neither available
in this sandbox): every Realtime/Auth/live-model validation item — see
[`docs/production-audit.md`](./production-audit.md#confirmed-pending-requires-real-supabase-andor-real-anthropic-credentials)
and the Batch 8 final report for the complete list.

## What Batch 7 added

- The conversational AI waiter: `src/lib/ai/` (provider client/config, system prompt, the
  tool-calling loop, tool registry, orchestrator, conversation memory, rate limiting, structured
  logging) plus `src/components/customer/ai-waiter*.tsx` (the floating chat button and panel) and
  `src/lib/ai/actions.ts` (the `sendChatMessage` Server Action, gated on restaurant
  `allow_ai_recommendations`).
- 11 Zod-validated tools (`search_menu`, `get_menu_item`, `get_restaurant_info`, `get_cart`,
  `add_item_to_cart`, `update_cart_item`, `remove_cart_item`, `clear_cart`, `submit_order`,
  `get_order_status`, `get_customer_order_history`) — every one a thin, authorized adapter over
  the existing Batch 4/5 business logic, never a reimplementation of it. No `execute_sql`,
  `query_database`, `admin_supabase`, `arbitrary_rpc`, or `generic_mutation` tool exists, checked
  by a static-analysis test against the actual source files, not just documented intent.
- `ai_conversation_messages`, a new table serving triple duty as conversation memory,
  rate-limiting signal, and AI tool-call audit trail — RLS-scoped to the owning customer session,
  append-only (no UPDATE/DELETE policy for any role).
- `get_public_order_settings()` extended to also return `allow_ai_recommendations`/
  `allow_upselling`, reusing pre-existing `restaurant_settings` columns as the AI's master
  enable/disable toggle and upsell-permission gate, respectively.
- Server-side tool authorization: every tool call's context (`restaurant_id`, `customer_session_id`)
  is derived from the authenticated customer session, never from a model argument, conversation
  text, or the model's choice to call a tool — verified per-schema and structurally (see
  [`docs/security.md`](./security.md#ai-tool-authorization)).
- Prompt injection defense, allergen-safety policy, modifier-clarification policy, and an
  order-confirmation-before-submission requirement, all designed into the system prompt and tool
  layer together — see [`docs/ai.md`](./ai.md) for the full design and
  [`docs/security.md`](./security.md#ai-hostile-review) for the hostile-review checklist.
- Uses `claude-opus-5` via the Anthropic beta Messages endpoint (server-side refusal fallbacks),
  adaptive thinking, and `output_config.effort` for cost/latency control instead of sampling
  parameters (which Opus 5 rejects) — see [`docs/ai.md`](./ai.md#provider-and-configuration).
- The AI is purely additive: unset `ANTHROPIC_API_KEY`, a disabled restaurant toggle, or a
  provider outage all degrade to "the AI waiter isn't offered/available," never to a broken menu,
  cart, checkout, or order-tracking experience — verified by a dedicated e2e test that exercises
  the full ordering flow independent of AI configuration.
- 3 new unit test files (schemas, tool-surface static analysis, tool-calling loop — including
  refusal/`pause_turn` handling), 1 new DB integration test file, and a new (real-credentials-gated)
  e2e spec covering the full conversational order flow — 338 tests passing total.

Still not implemented: payments, POS integration, inventory, reservations, loyalty, delivery, or
analytics — all explicitly out of scope for this batch, see [`docs/ai.md`](./ai.md#whats-explicitly-out-of-scope-for-this-batch).

## What Batch 6 added

- The order state machine: `transition_order_status()`, a second `SECURITY DEFINER` entry point
  alongside `submit_order()`, enforcing `pending → confirmed → preparing → ready → served` (plus
  cancellation from `pending`/`confirmed`) — with the legal-transition table and a role permission
  matrix (owner/manager: full access; kitchen: confirm/preparing/ready; staff: serve and
  pending-only cancel) both centralized in SQL, and a `BEFORE UPDATE` trigger enforcing the state
  machine independent of the function's own logic — see
  [`docs/database.md`](./database.md#order-state-machine-batch-6) and
  [`docs/security.md`](./security.md#order-status-transitions).
- A second, always-on immutability trigger (`trg_orders_enforce_immutable_fields`) rejecting any
  change to an order's price/tax/total/currency/tenant-identity fields, on every `UPDATE`, from
  every role — including a scoped fix to Batch 5's `submit_order()` (which briefly needed to
  `UPDATE` an order's totals after insert) so it stays compatible with this new, stricter guarantee.
- A kitchen display at `/dashboard/kitchen` (`src/components/kitchen/`) — a live board grouped by
  status, mobile/tablet-appropriate (large touch targets, no dense admin table), with per-order
  cards showing items/modifiers/notes/elapsed time, role-scoped action buttons, a synthesized
  new-order chime (Web Audio, no bundled asset) with a persisted mute preference, and an order
  detail dialog with the full audit trail.
- Supabase Realtime on `orders`, both for the kitchen board and for the customer's own order
  confirmation page (`src/components/customer/order-status-sync.tsx`) — RLS
  (`orders_select_own_or_staff`, unchanged since Batch 5) is the actual security boundary for
  every event delivered; every Realtime event triggers a full authoritative re-fetch rather than a
  partial client-side patch, which is what makes reconnect/duplicate-event handling a non-issue
  (there's no special-case "resync" logic — every update, live or on reconnect, is the same code
  path). See [`docs/security.md`](./security.md#realtime-security).
- `order_status_history` gained a `previous_status` column, so every row names the exact
  transition it recorded, not just the resulting status — full "who did what, when" auditability
  for any order, queryable directly.
- 37 new integration tests (`tests/integration/db/order-status-transitions.test.ts`) covering the
  state machine (every explicitly-disallowed transition, including re-applying the same one
  twice), the full role matrix, customer/unauthenticated/cross-tenant denial, append-only history,
  financial immutability under a transition, and cancellation policy — plus a new Playwright e2e
  spec covering the full customer-order → live-KDS-receipt → staff-walks-it-through →
  customer-sees-each-update-live flow, no-controls-for-customers, and cross-tenant KDS isolation.

Still not implemented (as of Batch 6): the AI waiter (added in Batch 7), payments, POS
integration, inventory, reservations, loyalty, delivery, or analytics.

## What Batch 5 added

- The order engine: a customer's cart becomes a real, immutable order via `submit_order()`, a
  single `SECURITY DEFINER` Postgres function (mirroring `create_restaurant()`'s established
  pattern) that re-validates and re-prices every line against **current** menu data, computes
  tax/service charge from the restaurant's current rates, atomically allocates a human-friendly
  per-restaurant order number, and writes the order/items/modifiers/status-history as one
  transaction — see [`docs/database.md`](./database.md#order-submission-submit_order) for the full
  step-by-step and [`docs/security.md`](./security.md#order-submission) for the threat model.
- Four new tables — `orders`, `order_items`, `order_item_modifiers`, `order_status_history` — plus
  `order_number_counters`, an internal-only counter backing race-safe order numbers. None of them
  have a client-facing INSERT/UPDATE/DELETE policy; `submit_order()` is the only writer.
- Idempotent submission: a caller-supplied idempotency key, unique per `(customer_session_id, key)`
  at the database level, means a double-tap or a retried request produces exactly one order and
  both callers see the same result — see
  [`docs/database.md`](./database.md#idempotent-order-submission-batch-5).
- Two new customer-facing routes: `/r/[restaurantSlug]/order/[orderId]` (confirmation — order
  number, items, totals, status) and `/r/[restaurantSlug]/orders` (session-scoped order history,
  not account-based — see [`docs/database.md`](./database.md#orders-order_items-order_item_modifiers-batch-5)).
  The cart page (`/r/[restaurantSlug]/cart`) gained a "Place order" control and an optional
  customer-note field, gated on the restaurant being active _and_ currently
  `accepting_orders` (a narrower, separate toggle from `is_active` — see
  `get_public_order_settings()` in the migrations).
- Permanent, immutable snapshots: `order_items.item_name`/`unit_price` and
  `order_item_modifiers.modifier_group_name`/`modifier_option_name`/`price_adjustment` are frozen
  at order time and never re-derived from `menu_items`/`modifier_options` afterward — a later menu
  rename, reprice, or even hard-delete has zero effect on historical orders.
  `orders.currency`/`tax`/`service_charge` are similarly snapshotted from the restaurant's rates at
  submission time, not recomputed later.
- 37 new integration tests (`tests/integration/db/orders.test.ts`) covering pricing/tax/service
  charge calculation, snapshot immutability (including menu-item deletion), stale-cart
  revalidation (price changes, items going unavailable, modifier rules tightening after the cart
  was built), idempotency (including the unique-constraint backstop), order-number
  uniqueness/sequencing, customer-note policy, and RLS-based access (customer-own-order-only,
  any-role staff access, cross-tenant staff/customer denial) — plus a new Playwright e2e spec for
  the full QR → cart → submit → confirmation → refresh-persists → no-duplicate →
  cross-session-denied flow (gated to a real Supabase test project).

Still not implemented: the AI waiter, the kitchen display, Supabase Realtime, payments, order
status transitions beyond `'pending'`, reservations, loyalty, analytics, or POS integrations.

## What Batch 4 added

- The customer-facing QR-to-cart flow: `/r/[restaurantSlug]`, `/r/[restaurantSlug]/menu`,
  `/r/[restaurantSlug]/item/[id]`, `/r/[restaurantSlug]/cart`, and the QR entry point itself at
  `/r/[restaurantSlug]/table/[token]`. Mobile-first layout, no AI, no order submission — see
  [`docs/database.md`](./database.md) for the schema and
  [`docs/security.md`](./security.md) for the threat model.
- Per-table QR codes: a random `public_token` on `tables`, generated locally with the `qrcode`
  package (no third-party QR SaaS), viewable/downloadable/copyable from
  `/dashboard/tables/[id]/qr`, with a confirmed "regenerate" action that invalidates the previous
  token immediately.
- Customer identity without signup: Supabase Anonymous Auth (`signInAnonymously()`) gives every
  visitor a real `auth.uid()`, so the same RLS machinery that protects staff data also protects
  customer sessions and carts — no separate authorization system, no `restaurant_users` rows
  created for customers.
- `customer_sessions` and `carts`/`cart_items`/`cart_item_modifiers` tables, with a
  `BEFORE UPDATE` trigger preventing a session from being silently relocated to a different
  table/restaurant, and a `SECURITY DEFINER` `cart_belongs_to_caller()` helper backing the cart RLS
  policies.
- Public (anon-readable) storefront RLS policies on `restaurants`/`categories`/`menu_items`/
  modifiers/ingredients/allergens, scoped strictly to active/available data — see the "Public
  storefront RLS" section of [`docs/database.md`](./database.md) for why this is safe and what it
  does and doesn't expose.
- Server-side price/availability validation for every cart mutation
  (`src/lib/cart/validate.ts`) — the browser can submit a menu item ID and selected option IDs,
  never a price, and every constraint (item/category active, option belongs to item, group
  min/max/required) is re-checked against the database on every add.
- 29 new integration tests covering table token uniqueness/regeneration/no-enumeration, customer
  session isolation (cross-restaurant, cross-table, relocation-prevention), public menu
  visibility, cart price/quantity constraints, and cross-tenant cart attacks — plus a new
  Playwright e2e spec for the full dashboard → QR → browse → modifiers → cart →
  quantity/remove/clear flow (gated to a real Supabase test project, like the existing dashboard
  e2e suite).

Still not implemented: order submission, payments, the AI waiter, the kitchen display,
reservations, loyalty, analytics, or POS integrations.

## What Batch 2 added

- The core multi-tenant database schema: 12 tables covering restaurants, staff roles, tables,
  menu, modifiers, ingredients, and allergens — see [`docs/database.md`](./database.md).
- Row Level Security on every one of those tables, plus the composite-foreign-key mechanism that
  stops a menu item from being attached to another restaurant's category/ingredient/allergen even
  when RLS alone can't catch it — see [`docs/multi-tenancy.md`](./multi-tenancy.md).
- `create_restaurant()`, the only path that creates a restaurant, guaranteeing the caller becomes
  its owner and nothing else.
- 79 automated tests (`tests/integration/db/`) that actually attempt cross-tenant reads/writes,
  privilege escalation, and constraint violations against a real Postgres engine
  (`@electric-sql/pglite`, since no Docker/Postgres was available to run the normal Supabase local
  dev stack) — not just RLS policies reviewed by eye.
- Demo seed data (`supabase/seed.sql`) and a documented, credential-free way to create dev logins
  (`scripts/seed-dev-users.ts`).
- `Database` types for the Supabase clients (`src/lib/supabase/database.types.ts`), hand-written
  to match the migrations since no live project exists yet to run `supabase gen types` against.

Still not implemented at the end of Batch 2: any AI, ordering, kitchen display, payments, QR
generation, or login UI.

## What Batch 3 added

- Email/password auth (`/login`, `/signup`) via Supabase Auth, with `src/proxy.ts` (Next.js
  middleware — renamed from `middleware.ts` per the framework's current convention) refreshing
  the session on every request and redirecting unauthenticated requests away from
  `/dashboard`/`/onboarding` before any page renders.
- `/onboarding`, calling `create_restaurant()` (Batch 2) so the signed-up user becomes the
  restaurant's owner — never client-chosen.
- A protected `/dashboard` — responsive sidebar/nav, a real-data overview (menu/category/table
  counts, restaurant status), and full CRUD for categories, menu items, modifier groups/options,
  ingredients, allergens, and tables, plus a settings page for the restaurant profile and
  operational toggles.
- Every dashboard mutation follows the same pattern: authenticate → confirm restaurant membership
  and role → validate with Zod → write through the RLS-respecting client (the admin client is
  never used in any dashboard code path) → friendly error messages instead of raw Postgres errors.
  `restaurant_id` is never read from client-submitted form data — every action gets it server-bound
  from the authenticated user's actual membership.
- 58 new automated tests: Zod schema validation (negative prices, invalid modifier min/max, etc.),
  new integration/db coverage for modifier/ingredient/allergen role authorization and cross-tenant
  isolation, and a Playwright e2e suite (route protection, form validation, plus a full
  signup-to-logout flow gated to run only against a real Supabase test project).

Still not implemented: any AI, ordering, kitchen display, payments, QR generation, reservations,
loyalty, analytics, or POS integrations.

## What Batch 1 actually built

- Next.js 16 App Router project (TypeScript, strict mode, Tailwind CSS v4, shadcn/ui) that
  builds, lints, type-checks, and runs.
- A clean split between browser, per-request server, and privileged admin Supabase clients
  (`src/lib/supabase/`) so a secret key can never reach the browser bundle by accident.
- A typed, fail-fast environment configuration (`src/lib/env.ts`).
- The migration workflow (`supabase/migrations/`) with no schema yet.
- This documentation set, describing the target architecture so later batches have a shared
  plan instead of ad hoc decisions.
- A minimal home page, `not-found` page, and error boundary — proof the shell works, nothing
  more.

## Directory structure

```
src/
  app/
    login/, signup/, onboarding/    Auth + restaurant-creation pages
    dashboard/                       Protected layout + overview + one folder per entity
                                      (categories, menu, modifiers, ingredients, allergens,
                                      tables, settings), each with page/new/[id]/edit routes;
                                      tables/[id]/qr shows/regenerates a table's QR code;
                                      kitchen/ is the live order board (Batch 6)
    r/[restaurantSlug]/              Customer-facing storefront: landing page, menu, item/[id]
                                      detail, cart (Batch 4); order/[orderId] confirmation
                                      (Realtime-live as of Batch 6) and orders history (Batch
                                      5); table/[token] (the QR entry point that bootstraps a
                                      customer session); the AI waiter (Batch 7) renders as a
                                      floating panel in this layout, not a separate route
    r/table-not-found/               Informational page for an invalid/unknown QR token; also
                                      the redirect target when session creation is throttled
                                      (?reason=busy — Batch 8)
    api/health/                      Batch 8 — GET /api/health, high-level readiness (booleans
                                      only, never a secret) for deployment monitoring
  components/
    ui/                shadcn/ui primitives (dialog.tsx added in Batch 6, reused by the AI
                        waiter panel in Batch 7)
    auth/, dashboard/, categories/, menu/, modifiers/, onboarding/, settings/, tables/
                        Feature-scoped form/list components — see docs/development.md
    customer/           Customer-facing components (item detail form, cart line item, menu
                        card, place-order-form (Batch 5), order-status-sync (Batch 6),
                        ai-waiter.tsx + ai-waiter-panel.tsx (Batch 7))
    kitchen/            Kitchen display components (Batch 6) — kitchen-board.tsx (Realtime +
                        columns), order-card.tsx, order-detail-dialog.tsx, the notification
                        sound and elapsed-time hooks
  lib/
    env.ts             Typed, validated server environment
    supabase/           Browser / server / admin Supabase client factories + Database types
    auth/                Session helpers (requireUser) + signIn/signUp/signOut server actions
    restaurants/          create-restaurant.ts, membership lookup, current-restaurant context,
                          authorizeRestaurantAction (the role-check every mutation runs first)
    categories/, menu/, modifiers/, ingredients/, allergens/, tables/, settings/
                        Zod schema + server actions per dashboard entity
    customer/            Customer session helpers — getActiveCustomerSession,
                          requireActiveCustomerSession, session expiry/touch, public restaurant
                          lookup by slug, public order settings lookup (Batch 5, extended in
                          Batch 7 with the AI toggles); rate-limit.ts (Batch 8, session-creation
                          throttling)
    cart/                Cart schema, server-side price/availability validation, cart server
                          actions, and cart-summary retrieval (Batch 4) — see docs/database.md
    orders/              Order submission (Batch 5) — schemas.ts, submit-order.ts, queries.ts,
                          errors.ts, format.ts; the state machine (Batch 6) — status.ts (shared
                          status/role constants, UI-only), transition.ts (the RPC wrapper),
                          kitchen.ts (board/history queries), kitchen-actions.ts (client-callable
                          wrappers); rate-limit.ts (Batch 8, order-submission throttling)
    errors/              toFriendlyError() — maps Postgres errors to user-safe messages
    forms/                Shared FormData -> primitive coercion helpers
    env-helpers.ts       Pure envInt/envFloat parsing helpers (moved here from src/lib/ai/ in
                        Batch 8 — shared by config.ts and both new rate limiters)
    ai/                 The AI waiter (Batch 7) — client.ts/config.ts (provider setup),
                        system-prompt.ts, loop.ts (tool-calling loop, pure/testable),
                        orchestrator.ts (sendAiMessage, ties it together), conversation.ts,
                        rate-limit.ts, logging.ts, actions.ts (sendChatMessage Server Action),
                        tools/ (schemas.ts, types.ts, menu.ts, cart.ts, order.ts, index.ts) —
                        see docs/ai.md
  proxy.ts              Next.js middleware: session refresh + route protection (renamed from
                        middleware.ts — Next.js's current convention)
supabase/
  migrations/           SQL migration history — restaurant/menu schema (Batch 2), QR tokens,
                        customer sessions, carts, and public storefront RLS (Batch 4), the
                        order engine and submit_order() (Batch 5), the order state machine,
                        transition_order_status(), and Realtime enablement (Batch 6),
                        ai_conversation_messages and the AI settings extension (Batch 7),
                        the two abuse-protection count RPCs (Batch 8)
  seed.sql               Demo restaurant + menu (Batch 2, expanded to 20 items in Batch 8)
scripts/
  seed-dev-users.ts     Credential-free local dev login creation — see docs/database.md
tests/
  unit/                 Vitest unit tests (including Zod schema validation and, as of Batch 7,
                        the AI tool schemas/surface/loop)
  integration/db/        RLS/constraint/role tests against a real Postgres engine, including
                        customer-sessions-and-cart.test.ts (Batch 4), orders.test.ts (Batch
                        5), order-status-transitions.test.ts (Batch 6),
                        ai-conversation-messages.test.ts (Batch 7), and
                        abuse-protection-rpcs.test.ts (Batch 8)
  e2e/                  Playwright end-to-end tests, including the QR-to-cart flow (Batch 4),
                        the QR-to-order flow (Batch 5), the full kitchen workflow (Batch 6),
                        and the conversational AI waiter flow (Batch 7)
docs/                    This documentation set, plus docs/production-audit.md (Batch 8)
```

`src/app/api/` now exists as of Batch 8, but only for the health check endpoint
(`api/health/route.ts`) — every mutation still uses Server Actions (or, for the QR entry point and
Realtime subscriptions, direct Supabase client calls), which continues to cover every ordinary
request without a broader route handler tree.

## Next batch

The full loop — QR scan → browse → cart → order → live kitchen workflow → live customer status —
is in place either deterministically or conversationally through the AI waiter (Batch 7), both
resting on the exact same validated boundaries (`submit_order()`/`transition_order_status()`/
`src/lib/cart/validate.ts`), now with abuse throttling on every public-facing surface (Batch 8).
See [`docs/ai.md`](./ai.md) for the AI design, [`docs/security.md`](./security.md) for what's been
reviewed against a hostile-customer/hostile-AI checklist, and
[`docs/production-audit.md`](./production-audit.md) for the full Batch 8 audit, including what
remains genuinely unvalidated (everything requiring a live Supabase project or a live Anthropic
API key — neither available in this sandbox).

The application-layer work this spec's success criteria call for is complete; what's left before a
real restaurant could depend on this system is **validation against real services**, not more
code: applying the migrations to an actual Supabase project, enabling Anonymous Auth, confirming
Realtime delivery under real network conditions, and running the golden-path E2E against a real
Anthropic API key. None of that can happen in this sandbox. Gaps still open for a later batch (by
explicit spec exclusion, not oversight): payments, POS integration, inventory, reservations,
loyalty, delivery, analytics, voice/phone ordering, and staff-facing AI.
