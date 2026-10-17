-- Two-step verification (TOTP authenticator apps) for owners and staff:
-- the database half.
--
-- Turning it on is optional (the Account page). Once someone has a verified
-- factor, a password alone must not be enough. The app sends a session that
-- hasn't passed the code step to /login/verify (src/proxy.ts), but the
-- publishable key ships in the website, so a stolen password could skip the
-- app and call the API directly. So the rule also lives here, in the one
-- place every staff permission passes through: current_restaurant_role().
-- is_restaurant_member(), is_restaurant_manager_or_owner(), the RLS policies
-- built on them, storage, reports and every staff RPC all call it.
--
-- For someone with a verified factor whose token is still aal1 (password
-- only), current_restaurant_role() now answers NULL: no restaurant, no
-- rows, no staff actions. People without a factor, and diners, are
-- unaffected.
--
-- delete_my_account() reads restaurant_users directly rather than through
-- current_restaurant_role(), so it gets the same check: a stolen password
-- must not be able to delete the account it can't otherwise use.

-- Safety net: every staff permission is about to depend on reading
-- auth.mfa_factors and auth.jwt(). Functions below run as the role applying
-- this migration, so if that role can't read them, fail here, inside the
-- migration's transaction, and change nothing, rather than install a check
-- that errors for every signed-in member.
do $$
begin
  perform 1 from auth.mfa_factors limit 1;
  perform auth.jwt();
end;
$$;

-- True when the caller has passed every step their account requires: their
-- token is aal2, or they have no verified factor to pass. plpgsql, not sql,
-- because it reads the auth schema (the PostgREST schema-cache trap noted in
-- 20260929090000_owner_email.sql).
create function public.caller_passed_two_factor()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.jwt() ->> 'aal', '') = 'aal2' then
    return true;
  end if;

  return not exists (
    select 1
    from auth.mfa_factors f
    where f.user_id = auth.uid()
      and f.status = 'verified'
  );
end;
$$;

comment on function public.caller_passed_two_factor() is
  'True unless the caller has a verified two-step verification factor and a token that has not passed it (aal1). See 20261018090000_two_factor_login.sql.';

-- Only ever called from inside SECURITY DEFINER functions, which run as
-- the owner, so no API role needs it.
revoke execute on function public.caller_passed_two_factor() from public, anon, authenticated;

-- CREATE OR REPLACE keeps the function's existing grants.
create or replace function public.current_restaurant_role(target_restaurant_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role
  from public.restaurant_users
  where restaurant_id = target_restaurant_id
    and user_id = auth.uid()
    and public.caller_passed_two_factor()
  limit 1
$$;

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_anonymous boolean;
begin
  if v_user_id is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  select u.is_anonymous into v_is_anonymous
  from auth.users u where u.id = v_user_id;

  if not found then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;
  if coalesce(v_is_anonymous, false) then
    raise exception 'ANONYMOUS_SESSION: a diner''s table visit is not an account'
      using errcode = '42501';
  end if;

  if not public.caller_passed_two_factor() then
    raise exception 'TWO_FACTOR_REQUIRED: enter your verification code first'
      using errcode = '42501';
  end if;

  if exists (select 1 from public.get_my_sole_owned_restaurants()) then
    raise exception 'SOLE_OWNER: make someone else an owner first'
      using errcode = '23514';
  end if;

  delete from auth.users where id = v_user_id;
end;
$$;
