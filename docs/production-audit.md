# Production audit

**Last updated 2026-09-19** (fully rewritten 2026-09-03). This document states what has actually
been validated against real services and what has not. Its one job is to be honest about that
boundary, so read the [Not validated](#not-validated) section as carefully as the passing one —
an item's absence from the passing list is meaningful.

Two rules this file is written under, carried over from the Batch 8 audit that started it and
worth keeping:

1. **Never convert "skipped" into "passed."** A test that didn't run is not a test that succeeded.
2. **A green test suite is not validation.** Nine of the defects found in this project's history
   were invisible to a fully passing suite and only appeared when something touched a live service.

## Current state

|                                   |                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit + integration tests          | **1366 passing** (95 files: 63 unit, 32 PGlite integration)                                                                                                              |
| E2E                               | Last full run 2026-09-03: `npm run test:e2e` **17 passed / 1 skipped / 0 failed**; `npm run test:e2e:disposable` **1 passed**. Not re-run for this update (10 specs now) |
| Migrations                        | 75, all applied to production (checked 2026-09-19 with `npx supabase migration list`)                                                                                    |
| Production                        | https://order.beacondigitalconsulting.org, auto-deployed from `main`; the apex and `www` 307-redirect to it                                                              |
| Supabase (production)             | ref `dqypmprjcyxoeywsumxr` — a separate disposable project exists for `dashboard-flow.spec.ts`, see [`docs/development.md`](./development.md#e2e-disposable)             |
| Lint / typecheck / format / build | clean                                                                                                                                                                    |

## What exists now that didn't at the last audit

The Batch 8 body preserved below audits a system with no payments, no billing, no reservations and
no error monitoring. All of the following shipped after it, across 45 commits:

- **Payments** — Stripe Connect onboarding (Accounts **v2**; v1 is rejected outright for new
  integrations), card charging with tips, session tabs paying several orders at once, cash
  recording with reversal, and full/partial refunds. `src/lib/payments/` (18 modules).
- **Platform billing** — per-restaurant plans with a basis-point fee taken from each card payment,
  monthly subscriptions via a **separate** platform webhook endpoint, and a fee rate that follows
  the paid plan automatically.
- **Reservations** — customer-facing booking requests with staff confirmation, stored and displayed
  in the restaurant's timezone.
- **Error monitoring** — Sentry on both server (`@sentry/node`) and client (`@sentry/browser`),
  deliberately not `@sentry/nextjs` (build-coupled and version-gated against standard Next, which
  this fork is not). Includes the serverless flush that these SDKs need or events are silently
  dropped, PII scrubbing, and server source-map upload keyed to the commit SHA.
- **Reporting** — takings reporting with CSV export, and diner receipts that outlive the session.
- **AI hardening** — a cart-state guard, a replaced default model, and model fallback (below).

And since the 2026-09-03 rewrite:

- **Stripe live mode** — cutover completed 2026-09-11 (below), plus owner-facing messages for
  Stripe errors on the Payments page instead of a crash page.
- **Diner/operator separation** — a QR scan creates a real anonymous auth user; the owner routes
  and `create_restaurant()` now both refuse anonymous callers.
- **Order history and search** — `/dashboard/orders`, by date range, status, order number or dish.
- **A working logical backup** — `npm run db:backup` was broken by drift between three copies of
  the Supabase platform stub; now one shared stub, with CI replaying every migration against it.

## Validated against real services

Each item here was exercised against a live service, not a mock or PGlite.

### Core ordering (validated 2026-08-28, unchanged since)

Dashboard login and every sub-page; table QR generation; the full QR → menu → modifiers → cart
flow; Supabase Anonymous Auth; a real order submitted and verified end to end (order number,
pricing, item/modifier snapshots, audit trail, cart clearing, idempotency on retry); the complete
kitchen/staff status-transition permission matrix with real staff logins; cross-tenant and
cross-customer isolation checks; and Realtime `UPDATE` delivery on both the customer order page and
the kitchen board.

### Payments — live mode (validated 2026-09-11)

The live cutover in [`docs/going-live.md`](./going-live.md) was run for real. The first real
payment: a **$1.99 card charge** on a live connected account, with the platform fee ($0.01, 1% on
the Starter plan) collected, the `checkout.session.completed` webhook recorded, and the
`order_payments` row marked succeeded. Connect onboarding completed end to end, and the Connect
webhook endpoint's signing secret is proven by real `account.updated` events that passed signature
verification. Test-mode payment rows were removed from production on 2026-09-13, so takings
reports now match Stripe.

One payment is one payment: refunds, tabs, cash reversal and subscriptions have been proven in
test mode only (next section), never with real money.

### Payments and platform billing (test mode)

Proven end to end in Stripe **test mode**: a tab of 3 orders settled from a single webhook
($59.97, $0.59 platform fee), a single order ($19.99, $0.19 fee), a subscription recorded as
`status=active` on the `standard` plan, and — the part worth checking — **the per-payment fee
dropped from 1% to 0.5% automatically when the plan changed**.

> These runs were test mode. For live mode, see the section above.

### Error monitoring

Verified in production, not staging: a server error captured from the Lambda runtime with an email
alert delivered, a client-side error captured from a real browser, and 615 source-map artifacts
uploaded against a release. Client source maps remain **off** (`productionBrowserSourceMaps`
unset) — enabling them publishes client source, which is a deliberate trade, not an oversight.

### AI waiter (validated 2026-09-03)

Exercised through the real QR/table flow against production:

- A menu question — called `search_menu`, got an empty result, and **said so rather than inventing
  a dish**.
- A correct refusal on a non-existent item ("papad" is a category, not an item).
- A cart add — real `add_item_to_cart` call, real `cart_items` row, **verified in the database**
  rather than trusted from the model's own claim.
- The cart-state guard — asked for a count, the model called `get_cart` and reported the true
  quantity, contradicting an earlier fabricated claim still sitting in its own conversation
  history.
- Provider-failure fallback — an exhausted Anthropic credit balance surfaced as a structured
  `ai_error` while the menu, cart and ordering kept working.
- Model fallback — a request naming a dead primary was served by a later entry in the preference
  list (see [`docs/ai.md#model-fallback`](./ai.md#model-fallback)).

**The full conversational ordering path now completes against a live model** (2026-09-03, via
`npm run test:e2e`'s `ai-waiter-flow.spec.ts`): QR scan → ask about vegetarian dishes → add an item
with a required modifier → review cart → `request_order_confirmation` → confirm in a separate
message → `submit_order` → a real order visible on the customer's own orders page. The order is
asserted from the ordinary non-AI pages, not from anything the model claims.

Two honest qualifications on that:

- It ran against **localhost** with the live Supabase project and a live OpenRouter model — not
  against the deployed production app. The database, the model and the confirmation gate are all
  real; the web tier is the local build.
- It had **never passed before**. The spec sent the confirmation only when a `/confirm|yes/i`
  regex happened to match, which made a server-enforced mandatory turn conditional on a free
  model's phrasing — so the order was silently never placed. This document previously listed the
  path as unvalidated, correctly, for that reason.

## Not validated

Nothing below has been proven. Several are listed precisely because it would be easy to assume
they were covered.

### Blocking a real launch

1. **The Anthropic provider has never served a live turn.** Every live AI turn to date has gone
   through OpenRouter. `AI_PROVIDER=anthropic` is wired and typechecked but unexercised — the one
   attempt returned a credit-balance error.
2. **No real restaurant has used it.** Every order, payment and AI conversation to date came from
   the people building it. A pilot service is the largest remaining unknown.

### Known open, non-blocking

3. **Realtime `INSERT` delivery to anonymous-auth connections** — a platform-side issue with
   Supabase ticket **SU-452145** open. Independently reproduced: publication, `REPLICA IDENTITY`
   and triggers all confirmed correct; the same JWT's `UPDATE` delivery and REST `SELECT` both
   work. **Zero functional impact on customer-facing code**, which never subscribes to `INSERT`;
   the kitchen board depends on it and has a working non-Realtime fallback. No code or RLS change
   is justified by the evidence.
4. **E2E runs write to the production project.** `npm run test:e2e` points at whatever
   `.env.local` configures, which is the production Supabase project, so every run leaves test
   restaurants, menu items, sessions and orders behind. That is long-standing behaviour rather
   than a regression, but it is not written down anywhere else, and it means the production
   database accumulates test rows on every local run.
5. **AI latency on free models.** A one-tool-call turn measured **13.8s** in production.
   `AI_REQUEST_TIMEOUT_MS=25000` leaves headroom, but that is the real-world latency currently
   shipping to diners. Note this is _not_ the daily-cap problem: the OpenRouter account is above
   the $10 lifetime-credit threshold (1,000 free requests/day rather than 50), but the configured
   models still carry the `:free` suffix and so still queue behind paid traffic. Moving to a paid
   model would likely cut this materially; it has not been measured.
6. **Load and concurrency at scale.** Beyond the concurrent-order-submission race fixed and
   verified earlier, no load testing has been done. Peak-service behavior is unknown.
7. **There are no backups of the production database.** Not "untested" — absent. The project is on
   the Free plan, which includes no scheduled backups ("Free Plan does not include project
   backups"), and point-in-time recovery is a Pro add-on from $100/month. A logical backup you
   control now exists and its restore is verified end to end — most recently 2026-09-13, 5,633 rows
   across 37 tables, every foreign key satisfied — see
   [`docs/backup-and-restore.md`](./backup-and-restore.md). Two limits: it runs only when someone
   runs `npm run db:backup` (nothing schedules it), and it covers the `public` schema only, so it
   restores every restaurant, menu, order and payment record and **no logins** — Supabase's `auth`
   schema is not in it. Scheduled or managed backups, and an auth export, remain genuinely open.

## Why not IP address (both rate limiters)

Consistent with the reasoning already established for AI conversation rate limiting in Batch 7
(`docs/security.md#rate-limiting`): a restaurant's customers are commonly on the same shared
Wi-Fi, so IP address both over-blocks (many legitimate diners, one IP) and under-identifies (NAT,
proxies, mobile carriers). `table_id` (for session creation) and `customer_session_id` (for order
submission) are both meaningful, already-authenticated-or-derived identity boundaries specific to
this application's actual usage pattern, not a generic network-layer proxy for identity.

## Appendix: Batch 8 audit (historical, 2026-08)

> **Historical snapshot. Do not rely on it for current state** — it was written when no real
> Supabase project existed, before payments, billing, reservations or monitoring were built, and
> its environment description is no longer true of this repository. It is kept because its
> findings and reasoning still explain why several things are the way they are.

### Environment reality check (read this first)

Before auditing code, the environment itself was checked:

- `NEXT_PUBLIC_SUPABASE_URL` in `.env.local` is `https://placeholder-local-test.supabase.co` —
  literally named "placeholder," confirmed byte-for-byte different from `.env.example`'s own
  placeholder, i.e. a deliberate local-build-only stand-in. **There is no real Supabase project in
  this sandbox**, consistent with every batch since Batch 1.
- `SUPABASE_SECRET_KEY` and `ANTHROPIC_API_KEY` are both unset in `.env.local`.
- An `ANTHROPIC_API_KEY` **is** present in this session's raw process environment, but not in
  `.env.local` — its ownership/purpose is unconfirmed (most likely the coding agent's own runtime
  credential, not a value the user configured for this application). Per explicit user direction
  when asked, it was **not** used for any real Anthropic API call in this batch — every
  Anthropic-dependent validation item below is reported as pending, not passed.

This means every item in this batch requiring a live Supabase project or a live Anthropic API key
is **PENDING**, not PASS — see the final report for the complete PASS/SKIPPED/PENDING breakdown
(spec section 50's explicit requirement: never convert "skipped" into "passed").

### Fixed this batch

#### 1. Customer session creation had no abuse protection

**Risk**: `src/app/r/[restaurantSlug]/table/[token]/route.ts` created a new anonymous Supabase
Auth identity + `customer_sessions` row on every request that didn't already have a reusable
active session — nothing stopped a script from hammering a table's QR URL to mint unlimited
anonymous identities and session rows.

**Fix**: `count_recent_sessions_for_table()` (new `SECURITY DEFINER` SQL function,
`supabase/migrations/20260826090000_abuse_protection_rpcs.sql`) plus
`src/lib/customer/rate-limit.ts`, checked in the route handler before creating a new session —
never before reusing an existing one, so a returning customer is never throttled. Scoped to
`table_id`, not IP (see "Why not IP" below). Default: 30 new sessions per table per 5-minute
window — see [`docs/security.md`](./security.md#customer-session-creation-rate-limiting).

#### 2. Order submission had no protection beyond idempotency

**Risk**: `submit_order()`'s idempotency guarantee (Batch 5) correctly collapses repeated calls
with the _same_ key into one order, but nothing stopped a session from submitting many
_genuinely distinct_ orders in rapid succession (a fresh idempotency key each time).

**Fix**: `count_recent_orders_for_session()` (same migration) plus
`src/lib/orders/rate-limit.ts`, checked in `submitOrder()` before calling the RPC. Counts actual
created orders, not attempts — a retried/duplicate idempotency key never inflates the count, so
this cannot punish a legitimate double-click/refresh/network-retry, only many truly distinct
orders. Default: 10 orders per session per 10-minute window. Verified this specific
non-interference-with-retries property directly in
`tests/integration/db/abuse-protection-rpcs.test.ts`.

#### 3. Four top-level docs were never updated for Batch 7

`README.md`, `docs/database.md`, `docs/multi-tenancy.md`, and `docs/development.md`.

**Risk**: All four still described the system as of Batch 6, with no mention of the AI waiter,
`ai_conversation_messages`, or the two Batch 7 migrations — a real risk for anyone onboarding from
docs alone, and inconsistent with `docs/ai.md`/`architecture.md`/`security.md`, which _were_
updated in Batch 7. Documentation drift is itself a production risk (wrong setup instructions,
wrong mental model of what's implemented).

**Fix**: All four updated this batch — see "Documentation" in the Batch 8 final report.

#### 4. E2E real-credential gating silently never actually ran, even with real credentials configured

**Risk (the most significant finding in this audit)**: every e2e spec's `hasRealSupabaseProject`/
`hasRealAiProvider` check reads `process.env.NEXT_PUBLIC_SUPABASE_URL`/`ANTHROPIC_API_KEY` at
test-collection time, in the `playwright test` CLI process. That process is a plain Node process —
**it never automatically loads `.env.local`**; only the Next.js app Playwright's `webServer`
spawns as a _separate child process_ does that internally. A developer who followed
`docs/development.md`'s exact documented setup (fill in `.env.local`, run `npm run test:e2e`)
would have every real-credential-gated suite silently skip forever, with no error — exactly what
spec section 39 explicitly warns against ("do not allow them to silently skip when credentials are
present").

Confirmed by direct reproduction, not assumption: a debug harness set a real-looking (non-
placeholder) `NEXT_PUBLIC_SUPABASE_URL` in `.env.local` and ran a gated spec both before and after
the fix. Before: `hasRealSupabaseProject` read `false` (`process.env.NEXT_PUBLIC_SUPABASE_URL` was
literally `undefined` inside the test process) and the suite unconditionally skipped. After: it
correctly read `true` and the test actually executed its body (failing on the fake, non-resolving
URL, as expected — the point was proving execution was attempted, not that a fake backend works).

**Fix**: `playwright.config.ts` now calls `loadEnvConfig(process.cwd())` from `@next/env` —
the exact loader Next.js itself uses internally, already bundled with the `next` dependency (no
new package) — before `defineConfig()` runs, so every spec file's top-level env checks see
`.env.local` exactly as the app itself would. See the header comment on that call site for the
full mechanism.

#### 5. Two independent SDK-correctness fixes carried over from the Batch 7 final report

Already applied at the end of Batch 7 (model id, sampling params removed, beta-endpoint refusal
fallback, `effort`/`thinking` config) — re-verified as still correct against the `claude-api`
skill's model catalog during this batch's model-validation pass (see "Model validation" below).
No further change needed.

#### 6. Minor performance fix: sequential queries on the customer menu page

**Risk**: `src/app/r/[restaurantSlug]/menu/page.tsx` fetched `categories` and `menu_items` in two
sequential `await`s despite neither depending on the other's result — an unnecessary round trip on
a customer-facing page.

**Fix**: Parallelized via `Promise.all`; also added a defensive `.limit(500)` on the menu-items
query (no realistic restaurant menu approaches this, but an explicit bound costs nothing and rules
out an unbounded query in principle). Every other data-fetching path audited (item detail page,
`getCart()`, the AI menu tools, the kitchen board query) was already parallelized/batched
correctly — see "Performance audit" below for the full list reviewed.

### Reviewed and confirmed safe (no change needed)

#### AI rate limiting is already multi-instance-safe

`src/lib/ai/rate-limit.ts`'s `isRateLimited()` counts `ai_conversation_messages` rows via a
Postgres query through the RLS-respecting client — there is no in-memory counter anywhere, so this
mechanism is inherently correct across any number of application server instances (every instance
reads the same database). This is a strength, not a gap flagged by this audit.

The one honest caveat: it's a **check-then-act** pattern (count, then let the caller proceed to
insert), so two requests from the same session arriving within the same few milliseconds could
both pass the check before either's message is counted — a narrow race that could let the limit be
exceeded by one or two messages in a rare case. This is a deliberate, accepted tradeoff, not an
oversight: this rate limit is an abuse throttle (spec section 27's own framing), not a financial or
tenant-isolation boundary like order idempotency — the consequence of the race is "a customer's
chat session sent 21 messages in the window instead of 20," not a security or billing incident. A
database-level backstop (e.g. a trigger capping insert rate) was considered and rejected as
disproportionate: it would need either a hardcoded threshold divorced from the app-configurable
`AI_RATE_LIMIT_MAX_MESSAGES` env var, or new plumbing to keep the two in sync, for a failure mode
whose worst case is negligible. Order submission (a real financial/inventory action) has its own,
separate, actually-authoritative protection: `submit_order()`'s idempotency constraint.

#### AI tool authorization architecture

Re-reviewed against the exact Batch 8 checklist (spec sections 16, 23, 24): every AI tool's
`ToolContext` (`restaurant_id`, `customer_session_id`) is still derived exclusively from the
authenticated customer session server-side, never from a model argument — confirmed by re-reading
`src/lib/ai/tools/*.ts` and `tests/unit/ai-tool-surface.test.ts`/`ai-tool-schemas.test.ts` in full.
No regression since Batch 7. See [`docs/security.md`](./security.md#ai-tool-authorization) for the
full mechanism, unchanged.

#### Error handling

`src/lib/errors/database-error.ts`, `src/lib/orders/errors.ts` — both already map raw
Postgres/RPC errors to a fixed set of customer-safe messages via error codes, never passing
`error.message` through unfiltered for an unrecognized code. `src/lib/ai/orchestrator.ts`'s
catch block logs the raw error server-side (`logAiError`) but only ever returns a fixed, generic
string to the caller. No stack trace, SQL fragment, or internal identifier reaches a response body
anywhere in the codebase that was checked.

#### Secret handling

`grep`-audited the full `src` tree for `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `service_role`,
`dangerouslySetInnerHTML`, and the five forbidden AI tool names — every hit is either the one
designated file that legitimately reads that secret (`src/lib/supabase/admin.ts`,
`src/lib/ai/client.ts`), documentation, or a comment _describing_ what's forbidden (never an
actual usage). `npm audit` reports zero vulnerabilities across all 843 dependencies (prod + dev +
optional + peer). See the Batch 8 final report's "Dependency/security scan" section for the raw
output.

#### Performance — everything except the one page above

`src/lib/ai/tools/menu.ts#getMenuItem`, `src/lib/cart/get-cart.ts#getCart`,
`src/lib/orders/kitchen.ts#getActiveOrdersForRestaurant`, and
`src/app/r/[restaurantSlug]/item/[id]/page.tsx` were all already written with `Promise.all` for
independent queries and `.in()` batch lookups instead of per-row loops — `kitchen.ts` even has an
explicit doc comment calling out the N+1-avoiding shape. No AI tool call retrieves more than one
page of menu data, and the orchestrator never sends the full menu into a prompt — menu content only
reaches the model through tool results, bounded by each tool's own `.limit()` (spec section 42's
"never send the entire DB into every prompt" requirement, already satisfied since Batch 7).

## Appendix: what the 2026-09-03 E2E pass turned up

Two failures, where one was expected. Both are rule 2 again: the unit suite was fully green
throughout.

- **`ai-waiter-flow.spec.ts` never actually placed an order.** It sent the order confirmation only
  `if (getByText(/confirm|yes/i).isVisible())`. But confirming is not optional —
  `tools/order-confirmation.ts` requires the `request_order_confirmation` call to be _strictly
  earlier_ than the message that triggers `submit_order` ("a confirmation call and a submit_order
  call both happening within the same turn must never count"), so a separate customer message is
  required on every run. Making that conditional on a loose regex meant a free model's phrasing
  decided whether the mandatory turn happened at all. When it didn't match, the confirmation was
  skipped, no order was placed, and the failure surfaced twenty lines later as "Order #… not
  found" — pointing at the assertion rather than at the turn that never happened. The page
  snapshot showed it exactly: "Cart 1" in the header, "You haven't placed an order yet." in the
  body.

- **`dashboard-flow.spec.ts` was running its real `/signup` against production.** Its only guard
  asked whether `NEXT_PUBLIC_SUPABASE_URL` was a _placeholder_, which is false for the live
  project — so `npm run test:e2e` created real auth users in the production Supabase project, then
  failed after 30s because that project has "Confirm email" on and nothing reaches `/onboarding`
  without a human opening an email. The spec's own header had always said "never use production
  credentials here", and `docs/development.md` already claimed it "self-skips" in the main run.
  Neither was enforced; both were believed. It now requires `E2E_DISPOSABLE_PROJECT`, set only by
  `playwright.e2e-disposable.config.ts`, and both directions were verified — skipped in the main
  run, still passing on the disposable project.

  The general lesson is worth keeping separate from the fix: **a comment describing a safety
  property is not the safety property**, and a document asserting behaviour does not create it.
  Both existed here for weeks while the opposite happened on every run.

- A third, smaller one: the `"Added to cart."` assertion at the default 5s timed out once under
  parallel load. It is a persistent `<Alert>` bound to the form action's success state, with no
  auto-dismiss — so this was contention with a two-minute live-model turn on the shared dev
  server, not a disappearing toast. Raised to 15s in the four specs asserting it, which tolerates
  load without weakening a check on an element that cannot vanish by itself.

## Appendix: bugs found by running E2E against real services (2026-08-28)

Kept because it is the clearest evidence for this document's second rule. Six real-credential specs
had never executed against a real project; getting them running surfaced five defects that were
undiscoverable until then.

- `order-flow.spec.ts` asserted a cross-session order URL returns HTTP `404`. Not a security bug —
  verified directly that RLS serves the real "Page not found" UI and never leaks order data, and
  this Next.js version's own docs confirm a streamed `notFound()` legitimately keeps a `200`.
  Fixed to check rendered content instead.
- `kitchen-flow.spec.ts` — a real occasional Realtime miss correctly falling back to the 12s poll,
  but without enough margin in a 15s window. Margin widened.
- `ai-waiter-flow.spec.ts` — a hardcoded `waitForTimeout` racing a live model call, plus a
  strict-mode-violating cart assertion. Loosened to what the flow actually needs to prove, so a
  live free model's run-to-run variance doesn't fail it.
- `search_menu`'s Zod schema gave the model no guidance on its `query` field, so a weaker free
  model passed a redundant text query alongside a `dietary` filter, defeating both ("my searches
  are coming up empty" for a real vegetarian item). Fixed with `.describe()` guidance.
- `dashboard-flow.spec.ts` — a `waitForURL` race matching the already-current `/signup` URL before
  the async signup/redirect completed, misreporting "confirmation required"; and a
  strict-mode-violating locator where a fresh restaurant legitimately renders "New category" as
  both a header link and an empty-state CTA.

This document previously misdiagnosed all six as blocked by the live project's "Confirm email"
setting. Only `dashboard-flow.spec.ts` ever was; the other five used `createConfirmedTestUser()`
and never touched `/signup`.
