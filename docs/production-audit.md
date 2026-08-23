# Production audit (Batch 8)

> **This document's original body (below) is a historical snapshot from Batch 8, written when no
> real Supabase project existed and every "confirmed pending" item was genuinely untested. A real
> Supabase project has since been provisioned and extensively live-validated, and a real
> OpenRouter-based AI provider has been configured. See
> ["Current status (Production Hardening pass)"](#current-status-production-hardening-pass) at the
> bottom of this file for what's actually true today — do not rely on the "Confirmed pending"
> section below as current.**

Full-system audit performed before any Batch 8 code changes, per the batch's own instruction to
inspect everything rather than assume Batches 1–7 are correct because their tests pass. Findings
below are grouped by outcome: **fixed this batch**, **reviewed and confirmed safe** (no change
needed), and **confirmed pending** (needs a real Supabase project and/or a real Anthropic API key
this sandbox doesn't have — see [`docs/security.md`](./security.md) and the Batch 8 final report
for the full validation-status breakdown).

## Environment reality check (read this first)

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

## Fixed this batch

### 1. Customer session creation had no abuse protection

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

### 2. Order submission had no protection beyond idempotency

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

### 3. Four top-level docs were never updated for Batch 7

`README.md`, `docs/database.md`, `docs/multi-tenancy.md`, and `docs/development.md`.

**Risk**: All four still described the system as of Batch 6, with no mention of the AI waiter,
`ai_conversation_messages`, or the two Batch 7 migrations — a real risk for anyone onboarding from
docs alone, and inconsistent with `docs/ai.md`/`architecture.md`/`security.md`, which _were_
updated in Batch 7. Documentation drift is itself a production risk (wrong setup instructions,
wrong mental model of what's implemented).

**Fix**: All four updated this batch — see "Documentation" in the Batch 8 final report.

### 4. E2E real-credential gating silently never actually ran, even with real credentials configured

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

### 5. Two independent SDK-correctness fixes carried over from the Batch 7 final report

Already applied at the end of Batch 7 (model id, sampling params removed, beta-endpoint refusal
fallback, `effort`/`thinking` config) — re-verified as still correct against the `claude-api`
skill's model catalog during this batch's model-validation pass (see "Model validation" below).
No further change needed.

### 6. Minor performance fix: sequential queries on the customer menu page

**Risk**: `src/app/r/[restaurantSlug]/menu/page.tsx` fetched `categories` and `menu_items` in two
sequential `await`s despite neither depending on the other's result — an unnecessary round trip on
a customer-facing page.

**Fix**: Parallelized via `Promise.all`; also added a defensive `.limit(500)` on the menu-items
query (no realistic restaurant menu approaches this, but an explicit bound costs nothing and rules
out an unbounded query in principle). Every other data-fetching path audited (item detail page,
`getCart()`, the AI menu tools, the kitchen board query) was already parallelized/batched
correctly — see "Performance audit" below for the full list reviewed.

## Reviewed and confirmed safe (no change needed)

### AI rate limiting is already multi-instance-safe

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

### AI tool authorization architecture

Re-reviewed against the exact Batch 8 checklist (spec sections 16, 23, 24): every AI tool's
`ToolContext` (`restaurant_id`, `customer_session_id`) is still derived exclusively from the
authenticated customer session server-side, never from a model argument — confirmed by re-reading
`src/lib/ai/tools/*.ts` and `tests/unit/ai-tool-surface.test.ts`/`ai-tool-schemas.test.ts` in full.
No regression since Batch 7. See [`docs/security.md`](./security.md#ai-tool-authorization) for the
full mechanism, unchanged.

### Error handling

`src/lib/errors/database-error.ts`, `src/lib/orders/errors.ts` — both already map raw
Postgres/RPC errors to a fixed set of customer-safe messages via error codes, never passing
`error.message` through unfiltered for an unrecognized code. `src/lib/ai/orchestrator.ts`'s
catch block logs the raw error server-side (`logAiError`) but only ever returns a fixed, generic
string to the caller. No stack trace, SQL fragment, or internal identifier reaches a response body
anywhere in the codebase that was checked.

### Secret handling

`grep`-audited the full `src` tree for `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `service_role`,
`dangerouslySetInnerHTML`, and the five forbidden AI tool names — every hit is either the one
designated file that legitimately reads that secret (`src/lib/supabase/admin.ts`,
`src/lib/ai/client.ts`), documentation, or a comment _describing_ what's forbidden (never an
actual usage). `npm audit` reports zero vulnerabilities across all 843 dependencies (prod + dev +
optional + peer). See the Batch 8 final report's "Dependency/security scan" section for the raw
output.

### Performance — everything except the one page above

`src/lib/ai/tools/menu.ts#getMenuItem`, `src/lib/cart/get-cart.ts#getCart`,
`src/lib/orders/kitchen.ts#getActiveOrdersForRestaurant`, and
`src/app/r/[restaurantSlug]/item/[id]/page.tsx` were all already written with `Promise.all` for
independent queries and `.in()` batch lookups instead of per-row loops — `kitchen.ts` even has an
explicit doc comment calling out the N+1-avoiding shape. No AI tool call retrieves more than one
page of menu data, and the orchestrator never sends the full menu into a prompt — menu content only
reaches the model through tool results, bounded by each tool's own `.limit()` (spec section 42's
"never send the entire DB into every prompt" requirement, already satisfied since Batch 7).

## Confirmed pending (requires real Supabase and/or real Anthropic credentials)

These cannot be validated in this sandbox — see the Batch 8 final report for the authoritative
PASS/SKIPPED/PENDING table. Listed here as the specific, unresolved production risks a real
deployment must still validate before launch:

- **Realtime delivery under real network conditions** (reconnect timing, event ordering, actual
  RLS-based `postgres_changes` authorization) — PGlite has no Realtime layer at all. Carried over
  from every prior batch's final report.
- **Live Anthropic API behavior**: the configured model (`claude-opus-5`), the beta
  refusal-fallback endpoint, actual tool-calling round trips, actual refusal responses, actual
  token usage/cost, and actual latency have only been verified against the `claude-api` skill's
  documented/cached model catalog and API semantics — never against a live request in this
  sandbox. See "Model validation" and "AI cost/latency" in the final report.
- **Supabase Auth configuration**: whether Anonymous Auth is actually enabled on a target project
  (a dashboard toggle, not something a migration can turn on) — documented as a required manual
  step in `docs/development.md`, never verified against a real project here.
- **Real cross-tenant/cross-customer/kitchen-simulation scenarios against a live project** (spec
  sections 5, 6, 23, 24, 32) — the _logic_ for all of these is covered by the PGlite integration
  suite (346 tests) and was re-reviewed in this audit, but PGlite is a single-connection WASM
  Postgres, not a live multi-connection Supabase project with real Realtime/Auth/network behavior.
- **Golden-path E2E with real services** (spec section 34) — `tests/e2e/ai-waiter-flow.spec.ts`
  is written, confirmed to skip cleanly without real credentials (not silently, per the fix above —
  it now correctly _would_ run given real ones), but has never executed against real services.

## Why not IP address (both new rate limiters)

Consistent with the reasoning already established for AI conversation rate limiting in Batch 7
(`docs/security.md#rate-limiting`): a restaurant's customers are commonly on the same shared
Wi-Fi, so IP address both over-blocks (many legitimate diners, one IP) and under-identifies (NAT,
proxies, mobile carriers). `table_id` (for session creation) and `customer_session_id` (for order
submission) are both meaningful, already-authenticated-or-derived identity boundaries specific to
this application's actual usage pattern, not a generic network-layer proxy for identity.

## Current status (Production Hardening pass)

Everything in this section reflects real validation against the live Supabase project (ref
`dqypmprjcyxoeywsumxr`) and the real OpenRouter provider — it supersedes the "Confirmed pending"
list above, which was written before any of this existed.

**Resolved / validated for real:**

- Dashboard login/data, all dashboard sub-pages, table QR generation, the full customer QR → menu
  → modifiers → cart flow, and Supabase Anonymous Auth are all validated against the real project.
- A real order was submitted, verified end to end (order number, pricing, item/modifier snapshots,
  audit trail, cart clearing, idempotency on retry) directly against the live database.
- The full kitchen/staff status-transition permission matrix (pending → confirmed → preparing →
  ready → served, plus the role-boundary rejections) was validated with real staff logins.
- Cross-tenant/cross-customer security checks (can't read another session's cart/order, can't
  modify totals/status, can't access another restaurant) were validated live where a real check was
  possible, and otherwise rest on the existing PGlite integration-test suite per the standing
  instruction not to manufacture unnecessary cross-tenant test data.
- Realtime `UPDATE` delivery (both the customer order page and the kitchen board) is validated live.
- `AI_PROVIDER=openrouter` + a real `OPENROUTER_API_KEY` is confirmed correctly wired end to end
  (`/api/health`, provider resolution, model selection) with zero dependency on `ANTHROPIC_API_KEY`.
- The e2e suite's real-AI gating (`tests/e2e/ai-waiter-flow.spec.ts`) now derives the required
  credential from `AI_PROVIDER` generically instead of hardcoding `ANTHROPIC_API_KEY` — see
  `tests/e2e/ai-provider-gate.ts` and its unit tests.

**Still genuinely open:**

1. **Realtime `INSERT` delivery to anonymous-auth connections** — a platform-side issue,
   independently reproduced with direct evidence (publication/`REPLICA IDENTITY`/trigger
   configuration all confirmed correct; the identical JWT's `UPDATE` delivery and REST `SELECT`
   both work; a `claims_role: anon` anomaly was observed for the anonymous connection despite its
   JWT's `role` claim being `authenticated`). Supabase support ticket **SU-452145** is open. Has
   zero functional impact on any customer-facing code (which never subscribes to `INSERT`); the
   kitchen board depends on it but has a working non-Realtime fallback. No code, RLS, or migration
   change has been made or is currently justified by the evidence.
2. **No live AI conversation has completed successfully.** The provider is correctly configured and
   wired (confirmed by inspection and by `/api/health`), but every real attempt against the
   configured free model (`google/gemma-4-26b-a4b-it:free`) has returned `429 Too Many Requests`
   from OpenRouter — an external rate limit, not an application defect. **Do not treat the AI
   waiter as production-validated** until a real conversational turn actually succeeds end to end.
3. **6 of 7 real-credential E2E specs are blocked by the real project's "Confirm email" Auth
   setting**, not by missing credentials: `dashboard-flow.spec.ts`, `customer-flow.spec.ts`,
   `order-flow.spec.ts`, `kitchen-flow.spec.ts` (both tests), and `ai-waiter-flow.spec.ts` (both
   tests) all start a fresh `/signup`, which the real project can't complete without a human
   clicking a confirmation email. The already-seeded dev users (`owner@nashta-demo.aiwaiter.test`
   etc.) can't substitute for this today — `scripts/seed-dev-users.ts` deliberately never persists
   their passwords anywhere, so no automated test currently holds a usable credential for them.
   Two real options exist, neither of which is a pure code change: (a) a dedicated, disposable
   Supabase test project with email confirmation off _only there_, or (b) explicitly provisioning
   one new dedicated e2e-login user (Admin API, stored password) in this project — a production
   Auth data mutation that needs an explicit decision, not a default. `dashboard-flow.spec.ts`
   specifically tests the signup flow itself, so it can only ever be unblocked by option (a).

**Regression baseline as of this pass**: lint/typecheck/format all clean, 376/376 unit+integration
tests pass (371 baseline + 5 new for the E2E provider-gating logic), production build succeeds,
e2e is 9 PASS / 7 SKIP (all 7 skips accounted for above) / 0 FAIL.
