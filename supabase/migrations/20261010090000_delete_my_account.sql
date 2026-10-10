-- Self-service account deletion for restaurant owners and staff.
--
-- Google Play requires an app with sign-up to let people delete their
-- account from inside the app, and the privacy policy (/privacy) promises
-- it. The Account page (/account) calls delete_my_account() through the
-- ordinary RLS-respecting client: the function deletes the caller's own
-- auth.users row and nothing else, so no service-role key is involved.
--
-- WHAT GOES WITH THE ACCOUNT. Everything that hangs off auth.users already
-- says what happens to it (checked against every `references auth.users`
-- in the migrations):
--   * on delete cascade: restaurant_users (the memberships), and through
--     them push_subscriptions (the account's devices); owner email
--     dispatches addressed to the account.
--   * on delete set null: the "who did this" columns on the restaurant's
--     own records (recorded_by, created_by, confirmed_by, resolved_by,
--     approved_by, done_by, accepted_by...). The record stays, because it
--     is the restaurant's: a cash payment or a confirmed allergen doesn't
--     vanish when the staff member who entered it leaves.
--   * order_status_history.actor_id and audit_log.actor_id have no
--     foreign key by design and keep the bare id, which identifies nobody
--     once the auth.users row (the only thing holding the email) is gone.
--
-- THE LAST OWNER. A restaurant must keep at least one owner
-- (enforce_at_least_one_owner, 20260829090000 / 20260831120000), so the
-- cascade above would refuse a restaurant's only owner anyway, with an
-- unreadable "Database error". This function checks first and refuses with
-- SOLE_OWNER, naming nothing (the page lists the restaurants itself, from
-- get_my_sole_owned_restaurants). The owner hands the restaurant over on
-- the Staff page, or emails privacy@tableside.menu to close it: deleting a
-- restaurant erases its orders and payment history, which no button in the
-- app should do as a side effect of leaving.
--
-- DINERS. A QR scan signs a diner in as a Supabase anonymous user. That is
-- not an account and has nothing to delete here; refused, so this can
-- never be used to throw away a diner's own visit mid-order.
--
-- language plpgsql, not sql: both functions read auth.users, and a
-- `language sql` function crossing into the auth schema is the PostgREST
-- schema-cache trap described in 20260929090000_owner_email.sql.

create function public.get_my_sole_owned_restaurants()
returns table (id uuid, name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select r.id, r.name
    from public.restaurant_users me
    join public.restaurants r on r.id = me.restaurant_id
    where me.user_id = auth.uid()
      and me.role = 'owner'
      and (
        select count(*) from public.restaurant_users o
        where o.restaurant_id = me.restaurant_id and o.role = 'owner'
      ) = 1
    order by r.name;
end;
$$;

comment on function public.get_my_sole_owned_restaurants() is
  'The restaurants where the caller is the only owner, which block delete_my_account() until someone else is made an owner. See 20261010090000_delete_my_account.sql.';

revoke execute on function public.get_my_sole_owned_restaurants() from public, anon;
grant execute on function public.get_my_sole_owned_restaurants() to authenticated;


create function public.delete_my_account()
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

  if exists (select 1 from public.get_my_sole_owned_restaurants()) then
    raise exception 'SOLE_OWNER: make someone else an owner first'
      using errcode = '23514';
  end if;

  delete from auth.users where id = v_user_id;
end;
$$;

comment on function public.delete_my_account() is
  'Deletes the caller''s own account (their auth.users row; memberships and devices cascade, authorship columns go null). Refuses anonymous diner sessions and a restaurant''s only owner. See 20261010090000_delete_my_account.sql.';

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
