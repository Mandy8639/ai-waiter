# Migrations

This directory holds the SQL migration history for the AI Waiter database, applied with the
Supabase CLI.

**As of Batch 2:** 16 migrations create the core multi-tenant schema — restaurants, staff roles,
tables, menu/modifiers/ingredients/allergens, RLS policies, and the `create_restaurant()`
bootstrapping function. See [`docs/database.md`](../../docs/database.md) for the schema itself.
`orders`, `customer_sessions`, and `ai_conversations` are still not implemented — that's a later
batch.

Note on ordering within Batch 2's migrations: `restaurants` and `restaurant_users` are created
with RLS enabled but no policies yet (`20260821130100`/`20260821130200`), because the policies
depend on helper functions that themselves depend on `restaurant_users` existing
(`20260821130300`). Both tables were deny-all (not policy-less/open) for the short window between
creation and their policies landing two migrations later — never actually unprotected.

## Workflow

1. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and run `supabase login` /
   `supabase link` once per machine, pointing at the project's `NEXT_PUBLIC_SUPABASE_URL`.
2. Generate a new migration file:
   ```bash
   supabase migration new <short_description>
   ```
   This creates a timestamped file in this directory, e.g.
   `20260101000000_create_restaurants_table.sql`. Timestamps keep migrations ordered and make
   the history append-only — never edit a migration that has already been applied to a shared
   environment; write a new one instead.
3. Write plain SQL in the generated file (`CREATE TABLE`, `ALTER TABLE`, RLS policies, etc.).
4. Apply locally against the Supabase local dev stack:
   ```bash
   supabase db reset
   ```
5. Push to the linked remote project when ready:
   ```bash
   supabase db push
   ```

## Conventions

- One logical change per migration file (e.g. "create menu_items" is its own file, not bundled
  with "create orders").
- Every restaurant-owned table has Row Level Security **enabled** (deny-all) from the migration
  that creates it, and gets its actual policies as soon as the tables/functions they depend on
  exist — usually the same migration, occasionally a couple migrations later when a policy needs
  a helper function that needs another table first (see the note above). Never left open in the
  interim.
- Seed data belongs in `supabase/seed.sql`, not in a migration — migrations define structure,
  seeds populate demo data. It exists now (Batch 2) with a demo "Nashta (Demo)" restaurant — see
  [`docs/database.md`](../../docs/database.md#seed-data). It does not create login users; see
  `scripts/seed-dev-users.ts` for why and how that's done separately.
