-- A diner is a real authenticated user.
--
-- Scanning a table's QR code signs the phone in via Supabase Anonymous
-- Auth (see 20260822090200_customer_sessions.sql), and that identity does
-- not expire on its own. create_restaurant() only checked that auth.uid()
-- was not null, and `grant execute ... to authenticated` covers anonymous
-- identities too — so a diner who reached /onboarding could create a real
-- restaurant, owning it as a throwaway identity that disappears when they
-- clear their browser or scan another table. Nobody could ever sign in to
-- claim it.
--
-- Found on 2026-09-12, from the other half of the same confusion: tapping
-- "Sign in" as a diner landed on "Create your restaurant".
--
-- The route is closed in the middleware too (src/lib/auth/route-access.ts),
-- but that is a door, not a lock: this function is reachable by anyone who
-- can call the API with an anonymous token. Every other rule that matters
-- in this schema is enforced here rather than in the app, and this one is
-- now as well.
--
-- Reads auth.users.is_anonymous rather than the JWT's claim: the column is
-- the server's own record of how the identity was created, and cannot be
-- shaped by whatever the caller presents.
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
  v_is_anonymous boolean;
begin
  if v_user_id is null then
    raise exception 'create_restaurant requires an authenticated user' using errcode = '28000';
  end if;

  select u.is_anonymous into v_is_anonymous
  from auth.users u
  where u.id = v_user_id;

  if coalesce(v_is_anonymous, false) then
    raise exception 'RESTAURANT_ANONYMOUS_CALLER: a restaurant needs a real account, not a guest session'
      using errcode = '42501';
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
  'Transactionally creates a restaurant + its settings row + an owner membership for the calling user. The only supported path for restaurant creation — role is always ''owner'' and always auth.uid(), never client-supplied. Refuses anonymous (diner) identities: a restaurant owned by a guest session could never be signed in to again.';

grant execute on function public.create_restaurant(text, text, text, text, text) to authenticated;
