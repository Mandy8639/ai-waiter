# Tableside

An AI waiter for restaurants — a multi-tenant SaaS platform where an AI talks to customers,
answers menu questions, recommends food, takes customized orders, confirms them, and sends them
to the kitchen, alongside dashboards for restaurant owners and kitchen staff.

**Live, taking real money.** On 2026-09-11 a real diner card payment went through a real
restaurant's own Stripe account, with the platform fee collected correctly — so the whole path
(QR scan → menu → AI waiter → order → kitchen board → card payment → payout) has now run
end-to-end in production, not just in tests.

Deployed at **https://order.beacondigitalconsulting.org**. `beacondigitalconsulting.org` and its
`www` redirect there.

Built since: **payments** — Stripe Connect onboarding per restaurant, card checkout for a single
order or a whole table's tab, tips, cash recorded by staff, refunds, receipts, and three platform
plans (Starter free at 1%, Standard $49/mo at 0.5%, Pro $149/mo at 0.25%) billed by Stripe
subscription; a **customer-facing order tracker**; **kitchen alerts** that keep sounding until an
order is accepted; per-line **spice preferences and kitchen notes**; **preparation-time estimates**;
and the **seam a POS connector plugs into** (see [`docs/pos-integration.md`](docs/pos-integration.md))
— no Toast/Square connector is built, deliberately; and **pickup ordering**, where a pickup counter
is a kind of table whose diners choose a pickup time and a name, and the kitchen sees when to start
(see [`docs/pickup-ordering.md`](docs/pickup-ordering.md)).

What exists: the Next.js foundation; the full multi-tenant database schema (restaurants, staff
roles, menu, modifiers, ingredients, allergens, customer sessions, carts, orders, the order state
machine, and AI conversation transcripts) with Row Level Security; email/password auth, restaurant
onboarding, and a protected dashboard with full CRUD for categories, menu items, modifiers,
ingredients, allergens, and tables (including per-table QR code generation); a public,
mobile-first customer flow (Batch 4): scan a table's QR code, browse a real menu with search and
category filters, configure modifiers, and build a server-priced cart, with no signup required
(Supabase Anonymous Auth); real order submission (Batch 5): the cart becomes an immutable,
server-priced order via a single transactional, idempotent database function, with a confirmation
page and session-scoped order history; a live kitchen display (Batch 6, `/dashboard/kitchen`)
where staff walk each order through confirmed → preparing → ready → served (or cancel it) with
server-enforced, role-scoped transitions, live over Supabase Realtime, with the customer's own
order page updating in real time too; a conversational AI waiter (Batch 7) — a floating chat panel
where customers can browse the menu, build a cart, and place an order in natural language, backed
entirely by the same validated tools (`submit_order()`, cart mutation, RLS) the deterministic UI
already uses, never a parallel AI-specific path; and, as of Batch 8, production hardening — abuse
throttling on customer session creation and order submission, a health check endpoint, and a full
audit (see [`docs/production-audit.md`](docs/production-audit.md)); and Batch 9, a provider
abstraction so the AI waiter can run on either Anthropic (production default) or OpenRouter (a
cost-free development alternative), selected via `AI_PROVIDER` — see
[`docs/ai.md`](docs/ai.md#provider-and-configuration). Since then: staff management
(`/dashboard/staff` — add members by email, change roles, with a trigger that will not let a
restaurant lose its last owner); kitchen ticket splitting and merging, where one order's items can
fire as several independent tickets or several orders can share one, and the customer's status is
derived as the least-advanced ticket so they are never told "served" early; and reservations
(`/dashboard/reservations` — staff-entered bookings against a specific table, with 90-minute
double-booking prevention and a confirmed → seated → completed lifecycle). 1,301 automated tests,
run by CI on every push. See
[`docs/architecture.md`](docs/architecture.md) for the target architecture and what's actually
implemented today versus planned, and [`docs/ai.md`](docs/ai.md) for the AI waiter's design.

**A real Supabase project has since been provisioned and extensively validated** (dashboard,
customer QR-to-order flow, kitchen display, real order submission with audit trail, and
cross-tenant security checks all confirmed against live data — see
[`docs/production-audit.md`](docs/production-audit.md#current-status-production-hardening-pass)
for the full breakdown), and a live AI conversation has since completed successfully against a real
model provider. One thing remains genuinely open there, and it is not an application bug: Supabase
Realtime `postgres_changes` `INSERT` delivery to anonymous-auth connections is a platform-side
issue under Supabase support investigation (ticket SU-452145). It has no impact on any
customer-facing code path — the kitchen display carries a polling fallback for exactly this. The
AI waiter has still never been exercised against the Anthropic provider, only OpenRouter.

## Technology stack

- **Frontend:** Next.js (App Router), React, TypeScript
- **Styling:** Tailwind CSS, shadcn/ui
- **Backend:** Next.js server-side (route handlers, server actions)
- **Database:** Supabase PostgreSQL — schema + RLS implemented, see [`docs/database.md`](docs/database.md)
- **Auth:** Supabase Auth — email/password login, signup, session handling, and role checks implemented
- **Storage:** Supabase Storage _(not wired up yet)_
- **Realtime:** Supabase Realtime — kitchen display + customer order status (implemented, Batch 6)
- **QR codes:** `qrcode` (local generation, no third-party service)
- **Validation:** Zod
- **Testing:** Vitest (unit + DB/RLS integration), Playwright (e2e)
- **Formatting/linting:** Prettier, ESLint
- **CI:** GitHub Actions — lint, typecheck, format, tests, and build on every push
- **Hosting:** Vercel — deployed, see [Deployment](#deployment)

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in real Supabase values, see below
npm run dev
```

Open http://localhost:3000.

## Environment setup

Copy `.env.example` to `.env.local` and fill in real values from your Supabase project (Project
Settings → API):

| Variable                               | Scope       | Purpose                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Public      | Your Supabase project URL.                                                                                                                                                                                                                                              |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public      | The publishable/anon key — safe for the browser, subject to RLS.                                                                                                                                                                                                        |
| `SUPABASE_SECRET_KEY`                  | Server only | The secret/service_role key. Bypasses RLS — never exposed to the browser. See [`src/lib/supabase/admin.ts`](src/lib/supabase/admin.ts).                                                                                                                                 |
| `AI_PROVIDER`                          | Server only | Optional — `anthropic` (production default) or `openrouter` (a cost-free development alternative). See [`docs/ai.md`](docs/ai.md#provider-and-configuration).                                                                                                           |
| `ANTHROPIC_API_KEY`                    | Server only | Optional — required only when `AI_PROVIDER=anthropic`. If neither provider's key is set, the AI waiter simply isn't offered; everything else works normally. See [`src/lib/ai/providers/`](src/lib/ai/providers/) and [`docs/ai.md`](docs/ai.md).                       |
| `OPENROUTER_API_KEY`                   | Server only | Optional — required only when `AI_PROVIDER=openrouter`. Never required alongside `ANTHROPIC_API_KEY`, and vice versa. Get one free at [openrouter.ai/keys](https://openrouter.ai/keys). See [`src/lib/ai/providers/openrouter.ts`](src/lib/ai/providers/openrouter.ts). |

`src/lib/env.ts` validates the two public vars with Zod and fails immediately, with a clear
message, if either is missing — not deep inside a request. `SUPABASE_SECRET_KEY`,
`ANTHROPIC_API_KEY`, and `OPENROUTER_API_KEY` all validate separately, lazily, in the one file that
reads each (`src/lib/supabase/admin.ts`, `src/lib/ai/providers/anthropic.ts`,
`src/lib/ai/providers/openrouter.ts`), so a page that never touches the admin client or the AI
waiter doesn't need any of them configured to build or run, and whichever provider isn't selected
via `AI_PROVIDER` is never even referenced. See
[`docs/security.md`](docs/security.md#server-only-secrets). `.env.example` also documents several
optional AI-tuning variables (model, effort, rate limits, timeouts) with sensible defaults — see
[`src/lib/ai/config.ts`](src/lib/ai/config.ts).

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Copy the URL and keys into `.env.local` as above.
3. **Enable Anonymous Auth** — Authentication → Providers → Anonymous Sign-Ins, in the Supabase
   dashboard. This is required for the entire customer-facing flow (QR scan → menu → cart →
   order → AI waiter) — every diner's identity is a real Supabase Anonymous Auth user (see
   [`docs/security.md`](docs/security.md#secure-customer-sessions--implemented-in-batch-4)), and
   it's a dashboard toggle no migration can turn on for you.
4. Link the project and apply the schema:
   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push          # applies supabase/migrations/
   ```
5. Optionally load demo data: `supabase db reset` (local dev stack) or manually run
   `supabase/seed.sql` against a linked project applies the "Nashta (Demo)" restaurant and a
   20-item menu. Then `npm run db:seed:users` creates the four dev logins (owner/manager/kitchen/
   staff) via the Supabase Admin API — see [`docs/database.md`](docs/database.md#seed-data) for
   why that's a separate script rather than part of the SQL seed.

See [`docs/database.md`](docs/database.md) for the schema itself and
[`supabase/migrations/README.md`](supabase/migrations/README.md) for the migration workflow.

## npm scripts

| Script                                    | What it does                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev`                             | Start the dev server.                                                                        |
| `npm run build`                           | Production build.                                                                            |
| `npm run start`                           | Serve a production build.                                                                    |
| `npm run lint`                            | ESLint.                                                                                      |
| `npm run typecheck`                       | `next typegen` (route/layout types), then TypeScript with no emit.                           |
| `npm run format` / `npm run format:check` | Prettier.                                                                                    |
| `npm test`                                | Vitest unit + DB/RLS integration tests.                                                      |
| `npm run test:e2e`                        | Playwright end-to-end tests.                                                                 |
| `npm run db:seed:users`                   | Create the 4 dev-only restaurant logins (requires `supabase db reset`/seed already applied). |

Full workflow details in [`docs/development.md`](docs/development.md).

## Project structure

```
src/
  app/
    login/, signup/, onboarding/    Auth + restaurant-creation pages
    dashboard/                       Protected layout, overview, and CRUD routes per entity
                                      (tables/[id]/qr shows/regenerates a table's QR code;
                                      kitchen/ is the live order board, Batch 6)
    r/[restaurantSlug]/              Public customer flow: landing, menu, item detail, cart
                                      (Batch 4); order/[orderId] confirmation (Realtime-live
                                      as of Batch 6) and orders history (Batch 5); the QR
                                      entry point at table/[token]; the AI waiter (Batch 7)
                                      renders as a floating panel here, not a separate route
    api/health/                     GET /api/health — readiness booleans only (Batch 8)
  components/                        ui/ (shadcn) + feature-scoped form/list components,
                                      including customer/ (item form, cart line, menu card,
                                      place-order form, order-status-sync, ai-waiter panel —
                                      Batch 7) and kitchen/ (the order board, cards, detail
                                      dialog — Batch 6)
  lib/
    env.ts             Typed, validated server environment (Zod)
    env-helpers.ts     Pure envInt/envFloat parsing helpers (Batch 8) — shared by AI config
                        and the two rate limiters below
    supabase/           Browser / server / admin Supabase client factories + Database types
    auth/                Session helpers + signIn/signUp/signOut server actions
    restaurants/          create-restaurant.ts, membership/role lookup, authorization helper
    categories/, menu/, modifiers/, ingredients/, allergens/, tables/, settings/, staff/
                        Zod schema + server actions per dashboard entity
    reservations/        Booking schema/actions plus timezone.ts — the single place a staff
                        member's wall-clock entry becomes a real instant, via the
                        restaurant's own timezone (DST-aware)
    customer/            Customer session helpers (active-session lookup, expiry, public
                        restaurant-by-slug lookup, public order settings), plus
                        rate-limit.ts (Batch 8, session-creation throttling)
    cart/                Cart schema, server-side price/availability validation, cart server
                        actions, cart-summary retrieval — see docs/database.md
    orders/              Order submission (Batch 5) and the status-transition/kitchen-board
                        RPC wrappers, RLS-scoped reads, error-code mapping (Batch 6), plus
                        rate-limit.ts (Batch 8, order-submission throttling) — see
                        docs/database.md
    errors/, forms/       Shared error-mapping and FormData helpers
    ai/                 The conversational AI waiter (Batch 7) — provider client/config,
                        system prompt, tool-calling loop, 11 tools, orchestration, rate
                        limiting, logging — see docs/ai.md
  proxy.ts              Next.js middleware — session refresh + route protection
supabase/
  migrations/           Restaurant/menu schema, RLS, create_restaurant() (Batch 2), QR tokens,
                        customer sessions, carts, and public storefront RLS (Batch 4), the
                        order engine and submit_order() (Batch 5), the order state machine,
                        transition_order_status(), and Realtime enablement (Batch 6),
                        ai_conversation_messages and AI settings (Batch 7), two
                        abuse-protection count RPCs (Batch 8), an admin audit log, staff
                        management RPCs, order ticket groups for kitchen split/merge, and
                        reservations
  seed.sql               Demo restaurant + 20-item menu (no auth users — see docs/database.md)
scripts/
  seed-dev-users.ts     Creates dev-only logins via the Supabase Admin API
tests/
  unit/                 Vitest (including Zod schema validation)
  integration/db/        RLS/constraint/role tests against a real Postgres engine, including
                        customer session/cart isolation, cross-tenant cart attacks (Batch 4),
                        the order engine (Batch 5), and the order state machine — role
                        matrix, concurrency, audit trail, financial immutability (Batch 6)
  e2e/                  Playwright, including the QR-to-cart (Batch 4), QR-to-order (Batch
                        5), full kitchen workflow (Batch 6), and conversational AI waiter
                        (Batch 7) flows
docs/                    Architecture, database, AI, security, multi-tenancy, dev workflow,
                        production audit (Batch 8)
```

More detail, including what's intentionally _not_ created yet and why, in
[`docs/architecture.md`](docs/architecture.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — system design, customer/restaurant/kitchen flows
- [`docs/database.md`](docs/database.md) — schema, constraints, indexes, RLS
- [`docs/ai.md`](docs/ai.md) — AI waiter architecture, tools, prompt injection defense
- [`docs/admin.md`](docs/admin.md) — the platform owner's Admin page: who can open it, AI model
  settings
- [`docs/pickup-ordering.md`](docs/pickup-ordering.md) — pickup counters, slots, when the kitchen
  starts
- [`docs/security.md`](docs/security.md) — security model, implemented vs. planned
- [`docs/multi-tenancy.md`](docs/multi-tenancy.md) — tenant isolation model
- [`docs/development.md`](docs/development.md) — day-to-day workflow
- [`docs/production-audit.md`](docs/production-audit.md) — Batch 8's full pre-implementation audit

## Testing

```bash
npm test          # unit tests + DB/RLS integration tests (Vitest)
npm run test:e2e  # end-to-end smoke test (Playwright)
```

`npm test` runs 1,301 tests across 91 files: unit tests (including Zod schema validation for every dashboard/cart
form, the AI tool schemas/surface, and the AI tool-calling loop) plus `tests/integration/db/` —
tenant isolation, cross-tenant foreign key rejection, role-based authorization, constraint
enforcement, QR token lifecycle, customer session/cart isolation (cross-restaurant, cross-table,
cross-customer attacks), the order engine (pricing, tax/service-charge calculation, price/modifier
snapshot immutability, stale-cart revalidation, idempotency, race-safe order numbering,
cross-tenant order/staff access), the order state machine (every allowed and disallowed
transition, the full owner/manager/kitchen/staff permission matrix, customer/unauthenticated/
cross-tenant denial, append-only audit history, financial immutability under a status change, and
cancellation policy), the AI conversation transcript's session isolation and append-only guarantee,
the two Batch 8 abuse-protection RPCs, staff management (role authorization and the
last-owner-standing trigger), kitchen ticket splitting/merging (split coverage validation, the
least-advanced-group status derivation, and a merged ticket driving two orders in lockstep),
reservations (double-booking prevention, the status state machine enforced both in the function and
by an independent trigger, and RLS excluding the kitchen role entirely), and reservation timezone
conversion across DST boundaries — against a real Postgres engine
(`@electric-sql/pglite`, since no Docker/Postgres was available to run the normal Supabase local
dev stack — see the header comment in `tests/integration/db/setup.ts`). The e2e suite covers route
protection, form validation, a full signup → dashboard → CRUD → logout flow, the full QR scan →
browse → modifiers → cart flow, the full QR scan → cart → submit order → confirmation flow, the
full customer-order → live-kitchen-display → staff-transitions → live-customer-status flow, the
full conversational AI waiter order flow, and an always-run check that ordering works whether or
not the AI is configured — the real-Supabase/real-Anthropic-gated specs are skipped without real
credentials, and (as of Batch 8) correctly detect and run against them when present — see
[`docs/development.md`](docs/development.md#scripts) for how to run them for real, and
[`docs/production-audit.md`](docs/production-audit.md) for the e2e-gating bug this batch found and
fixed.

## Deployment

Deployed on Vercel at **https://order.beacondigitalconsulting.org**, against the production
Supabase project. `GET /api/health` reports high-level readiness (Supabase/AI configured, never a
secret) and currently answers `{"status":"ok","supabaseConfigured":true,"aiConfigured":true}` — see
[`docs/security.md`](docs/security.md#health-check-endpoint--implemented-in-batch-8).

Three things to know about that deployment:

- **It is public**, and it is the address printed on real QR codes. That hostname must not change:
  the codes are stuck to tables.
- **Deploys are automatic** — every merge to `main` builds and deploys via the GitHub integration.
- **Stripe runs in live mode.** See [`docs/going-live.md`](docs/going-live.md) for the cutover
  procedure and the traps found running it for real.

The Node version is pinned in two places for two different readers: `.nvmrc` for CI
(`actions/setup-node`) and `engines.node` in `package.json` for Vercel, which does not read
`.nvmrc`.

## What's not built yet

Nearer-term gaps a real restaurant would notice within a week:

- **No email or SMS.** Nothing sends a message outside the app. A pending booking request shows as
  a badge in the dashboard nav, and that is the only alert.
- **No staff invitation flow.** An owner can only add someone who has already signed up.
- **Menu images are URL-only**, because Supabase Storage is not wired up.
- **Rescheduling a reservation means cancel-and-rebook** — a booking's table and time are immutable
  after creation.

Further out: POS integration (the seam exists in `src/lib/pos/`, no connector yet — Clover is the
likely first one, see [`docs/pos-integration.md`](docs/pos-integration.md)), inventory, loyalty,
delivery, deeper analytics, voice/phone ordering, and staff-facing AI.

Everything else is built and tested: restaurant management (auth, onboarding, menu/table/QR CRUD,
AI menu import from a photo), the customer-facing browse-and-cart flow, real order submission (cart
→ immutable, server-priced order → confirmation), the full kitchen workflow (live order board,
role-scoped status transitions, Realtime updates for both staff and the customer, ticket
splitting/merging), a conversational AI waiter that can browse the menu, build a cart, and place a
confirmed order in natural language through the exact same validated boundaries as the
deterministic UI, card payments through Stripe Connect in live mode (tips, tabs, cash, refunds) with
platform billing, takings reports with CSV export, order history and search
(`/dashboard/orders`), reservations including customer booking requests at `/r/<slug>/reserve`,
staff management, and abuse throttling across every public-facing surface. See
[`docs/architecture.md`](docs/architecture.md) for the full batch-by-batch history and
[`docs/production-audit.md`](docs/production-audit.md) for what remains genuinely unvalidated.
