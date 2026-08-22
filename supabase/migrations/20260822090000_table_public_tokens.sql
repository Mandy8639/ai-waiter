-- Public QR/table identification. `public_token` is a second,
-- independently-generated random UUID — not derived from `id` in any way,
-- so knowing one never helps guess the other. Every table gets one by
-- default; regenerating it (see the dashboard's table actions) simply
-- assigns a fresh random value, which immediately invalidates any
-- previously-printed QR code for that table.
alter table public.tables
  add column public_token uuid not null default gen_random_uuid() unique;

comment on column public.tables.public_token is
  'Public, guessable-only-by-brute-force identifier encoded in the table''s QR code. Independent of id — never derivable from it. Regenerating this value is how a QR code is invalidated.';

-- Composite unique target so customer_sessions (added later this batch) can
-- enforce a tenant-scoped FK back to this row — same pattern as every other
-- tenant-scoped FK in the schema, see docs/database.md.
alter table public.tables
  add constraint tables_restaurant_id_id_key unique (restaurant_id, id);

-- Customers look up a table by this token before they have any session or
-- identity at all, so this can't go through an ordinary RLS SELECT policy
-- on `tables` — a policy like `using (is_active)` would let anyone list
-- every active table's token for a restaurant in a single query (e.g.
-- `GET /rest/v1/tables?restaurant_id=eq.X`), defeating "hard to guess" by
-- making guessing unnecessary. A SECURITY DEFINER function scoped to an
-- exact token match, returning only what the customer flow needs, avoids
-- that entirely: `tables` keeps no public SELECT policy at all.
create or replace function public.get_table_by_token(p_public_token uuid)
returns table (
  table_id uuid,
  restaurant_id uuid,
  restaurant_slug text,
  table_number text,
  display_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.restaurant_id, r.slug, t.table_number, t.display_name
  from public.tables t
  join public.restaurants r on r.id = t.restaurant_id
  where t.public_token = p_public_token
    and t.is_active = true
    and r.is_active = true
$$;

comment on function public.get_table_by_token(uuid) is
  'The only way to resolve a table QR token into a restaurant/table — never expose tables via a general SELECT policy (see column comment above). Returns nothing for an unknown, inactive, or belonging-to-an-inactive-restaurant token.';

grant execute on function public.get_table_by_token(uuid) to anon, authenticated;
