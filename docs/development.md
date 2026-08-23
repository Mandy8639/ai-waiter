# Development workflow

## Prerequisites

- Node.js 20+
- npm
- A Supabase project (free tier is fine for local development), with **Anonymous Auth enabled**
  (Authentication → Providers → Anonymous Sign-Ins) — required for the entire customer-facing flow
  (QR scan → menu → cart → order → AI waiter), and not something a migration can turn on for you.
- Optionally, `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`, or `AI_PROVIDER=openrouter` +
  `OPENROUTER_API_KEY` (free, no cost for local development), to exercise the AI waiter —
  everything else (menu, cart, checkout, order tracking, the kitchen display) works identically
  without either configured; see
  [`docs/ai.md`](./ai.md#failure-fallback--the-ai-is-purely-additive).

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in real Supabase values
npm run dev
```

Open http://localhost:3000.

## Scripts

| Script                  | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`           | Start the Next.js dev server.                                                 |
| `npm run build`         | Production build.                                                             |
| `npm run start`         | Serve a production build.                                                     |
| `npm run lint`          | ESLint.                                                                       |
| `npm run typecheck`     | `tsc --noEmit`.                                                               |
| `npm run format`        | Prettier, writes changes.                                                     |
| `npm run format:check`  | Prettier, check only (used in CI).                                            |
| `npm test`              | Vitest unit + DB/RLS integration tests, single run.                           |
| `npm run test:watch`    | Vitest in watch mode.                                                         |
| `npm run test:e2e`      | Playwright end-to-end tests (builds/starts the app itself).                   |
| `npm run db:seed:users` | Creates the 4 dev-only restaurant logins (Admin API, no committed passwords). |

## Before opening a PR

```bash
npm run lint
npm run typecheck
npm run format:check
npm test
npm run build
```

All five should pass. `npm run test:e2e` is worth running locally for anything touching routing,
layout, or error pages.

## Code style

- TypeScript strict mode; avoid `any` and `@ts-ignore` — if one seems necessary, that's usually a
  sign the types should be fixed instead.
- Validate all external input (forms, API bodies, environment variables) with Zod at the
  boundary, not deep inside business logic.
- Prefer small, single-purpose functions and files over large ones; don't duplicate a utility
  that already exists under `src/lib/`.
- No comments explaining _what_ code does — name things so the code reads on its own. Comment
  only the _why_, when it's genuinely non-obvious (see the Supabase client files in
  `src/lib/supabase/` for the intended tone).

## Working with Supabase locally

See [`supabase/migrations/README.md`](../supabase/migrations/README.md) for the migration
workflow. To get a local database with demo data:

```bash
supabase db reset          # applies every migration, then supabase/seed.sql
npm run db:seed:users      # creates owner/manager/kitchen/staff logins (Admin API)
```

You don't need any of this to run the automated DB tests — `tests/integration/db/` builds its own
throwaway Postgres instance per test file (see that directory's `setup.ts`) and doesn't touch a
real Supabase project at all.

## Running the full e2e flow against a real Supabase project

`tests/e2e/dashboard-flow.spec.ts`, `customer-flow.spec.ts`, `order-flow.spec.ts`, and
`kitchen-flow.spec.ts` all need real Auth and Postgres round trips, so each is skipped unless
`NEXT_PUBLIC_SUPABASE_URL` in `.env.local` points at an actual project (and isn't the placeholder
value from `.env.example`). `tests/e2e/ai-waiter-flow.spec.ts`'s full conversational flow
additionally needs a real credential for whichever `AI_PROVIDER` is configured
(`ANTHROPIC_API_KEY` for `anthropic`, `OPENROUTER_API_KEY` for `openrouter` — see
`tests/e2e/ai-provider-gate.ts`); its second test (ordering still works with the AI unconfigured)
only needs the real Supabase project. To run any of them:

1. Point `.env.local` at a **disposable test** Supabase project — never production.
2. If that project requires email confirmation, either disable it for testing (Auth settings) or
   the test will detect the "check your email" state and skip itself with a clear reason.
3. `npm run test:e2e` — every gated flow creates a new throwaway user
   (`e2e-*-<timestamp>@example.com`) and restaurant on every run, so re-running is safe.

`playwright.config.ts` loads `.env.local` the same way Next.js itself does (`@next/env`, already
bundled with `next` — not a new dependency) before any spec file's credential check runs — a
Batch 8 fix for a real bug where the Playwright test process never saw `.env.local` at all (only
the Next.js app it separately builds/starts did), so these suites would have silently skipped
forever even with correct credentials configured exactly as above. See
[`docs/production-audit.md`](./production-audit.md) for the full story.

`tests/e2e/route-protection.spec.ts` and `home.spec.ts` (including the health-check test) always
run — they don't need a real project.

## Branching

Small, reviewable commits. Run the full check list above before pushing. This repo does not yet
have CI configured — that's expected to land alongside the first deploy-worthy feature, not in
this foundational batch.
