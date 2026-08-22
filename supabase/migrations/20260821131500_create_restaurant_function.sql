-- The only legitimate way to create a restaurant. There is no INSERT policy
-- on public.restaurants for the `authenticated` role (see
-- 20260821130400_core_rls_policies.sql) — this SECURITY DEFINER function is
-- the sole path, specifically so a client can never submit its own
-- restaurant_users row with role = 'owner'. The owner is always
-- auth.uid(), read server-side inside the function, never a client-supplied
-- value.
--
-- All three inserts happen inside one PL/pgSQL function body, which
-- Postgres already runs as a single transaction — if any insert fails (a
-- duplicate slug, for instance), the whole call rolls back and no orphaned
-- restaurant/settings row is left behind.
create or replace function public.create_restaurant(
  p_name text,
  p_slug text,
  p_description text default null,
  p_timezone text default 'America/New_York',
  p_currency text default 'USD'
)
returns public.restaurants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant public.restaurants;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'create_restaurant requires an authenticated user' using errcode = '28000';
  end if;

  insert into public.restaurants (name, slug, description, timezone, currency)
  values (p_name, p_slug, p_description, coalesce(p_timezone, 'America/New_York'), coalesce(p_currency, 'USD'))
  returning * into v_restaurant;

  insert into public.restaurant_settings (restaurant_id)
  values (v_restaurant.id);

  -- Hardcoded 'owner' — this is the line that matters. p_name/p_slug came
  -- from the caller; role did not, and never will.
  insert into public.restaurant_users (restaurant_id, user_id, role)
  values (v_restaurant.id, v_user_id, 'owner');

  return v_restaurant;
end;
$$;

comment on function public.create_restaurant(text, text, text, text, text) is
  'Transactionally creates a restaurant + its settings row + an owner membership for the calling user. The only supported path for restaurant creation — role is always ''owner'' and always auth.uid(), never client-supplied.';

grant execute on function public.create_restaurant(text, text, text, text, text) to authenticated;
