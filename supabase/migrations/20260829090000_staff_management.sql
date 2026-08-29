-- Staff management UI feature: restaurant_users' own RLS already
-- anticipated this ("Any member can see the full staff list for
-- restaurants they belong to (needed for a "who works here" dashboard
-- view later)" — see 20260821130400_core_rls_policies.sql), but no code
-- ever exercised it. Two pieces are needed beyond that existing policy:
--
-- 1. A readable identifier per member. restaurant_users only stores
--    user_id; there's no RLS-reachable path from a normal client onto
--    auth.users, and this codebase deliberately never uses the
--    admin/service-role client from application code (see
--    docs/security.md) — so get_restaurant_staff() joins auth.users
--    itself, SECURITY DEFINER, gated by the caller's own membership,
--    returning only (id, user_id, email, role, created_at) — never more.
--
-- 2. Adding a member by email needs the same auth.users crossing, plus
--    the exact authorization logic restaurant_users_insert_owner_manager
--    already encodes (owner can add any role; manager can add anyone
--    except owner) — SECURITY DEFINER bypasses that policy entirely, so
--    add_restaurant_staff_by_email() re-implements it explicitly rather
--    than relying on the policy to backstop it.
--
-- v1 scope (explicit product decision): the invited email must already
-- have an AI Waiter account — no invite-email flow yet. A closed,
-- generic "no account with that email" error avoids turning this into an
-- account-existence oracle beyond what an owner/manager (who already has
-- restaurant access) could otherwise learn.
--
-- LANGUAGE plpgsql, not the more idiomatic `language sql` a pure SELECT
-- like this would normally use: confirmed directly against the live
-- project that a `language sql` function whose body joins auth.users
-- (a schema outside PostgREST's exposed-schemas list) returns PGRST202
-- ("not found in schema cache") from the REST API indefinitely — surviving
-- NOTIFY pgrst reload schema, a full project restart, and re-issuing the
-- exact same function as CREATE OR REPLACE. A plpgsql body is opaque to
-- Postgres/PostgREST until it actually runs, which sidesteps whatever in
-- their schema-cache-building introspection chokes on a `language sql`
-- body crossing into `auth`; switching this one function to plpgsql (no
-- logic change) fixed it immediately, first request, no cache action
-- needed. If a future auth.users-crossing function hits the same
-- PGRST202 symptom, try this before assuming the deploy failed.
create function public.get_restaurant_staff(target_restaurant_id uuid)
returns table (
  id uuid,
  user_id uuid,
  email text,
  role text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_restaurant_member(target_restaurant_id) then
    return;
  end if;

  return query
    select ru.id, ru.user_id, u.email, ru.role, ru.created_at
    from public.restaurant_users ru
    join auth.users u on u.id = ru.user_id
    where ru.restaurant_id = target_restaurant_id
    order by ru.created_at asc;
end;
$$;

comment on function public.get_restaurant_staff(uuid) is
  'The full staff list for a restaurant, resolved to real emails via auth.users. SECURITY DEFINER to cross into auth.users; gated by the caller''s own membership in target_restaurant_id, checked internally — never exposes another restaurant''s staff.';

-- Postgres grants EXECUTE on every newly created function to PUBLIC by
-- default (spec section 28: "review EXECUTE grants") — explicitly
-- revoked here, matching every other non-anon function in this schema.
-- An anon caller has no membership in anything, so this would only ever
-- return zero rows regardless — the revoke makes that a clean permission
-- denial instead of a silently-empty result, which is what "not meant for
-- anon" should look like.
revoke execute on function public.get_restaurant_staff(uuid) from public;
grant execute on function public.get_restaurant_staff(uuid) to authenticated;

create function public.add_restaurant_staff_by_email(
  target_restaurant_id uuid,
  p_email text,
  p_role text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role text;
  v_target_user_id uuid;
  v_new_id uuid;
begin
  v_caller_role := public.current_restaurant_role(target_restaurant_id);

  if v_caller_role is null or v_caller_role not in ('owner', 'manager') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;
  if v_caller_role = 'manager' and p_role = 'owner' then
    raise exception 'managers_cannot_grant_owner' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'manager', 'kitchen', 'staff') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  select id into v_target_user_id from auth.users where email = p_email;
  if v_target_user_id is null then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  insert into public.restaurant_users (restaurant_id, user_id, role)
  values (target_restaurant_id, v_target_user_id, p_role)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

comment on function public.add_restaurant_staff_by_email(uuid, text, text) is
  'Adds an existing AI Waiter account (looked up by email) as a restaurant_users member. Re-implements restaurant_users_insert_owner_manager''s own authorization (owner: any role; manager: any role except owner) explicitly, since SECURITY DEFINER bypasses that policy. v1: the email must already have an account — no invite-email flow yet.';

revoke execute on function public.add_restaurant_staff_by_email(uuid, text, text) from public;
grant execute on function public.add_restaurant_staff_by_email(uuid, text, text) to authenticated;

-- A restaurant must always keep at least one owner — otherwise it becomes
-- permanently unmanageable (no one left who can add/remove/promote
-- anyone). restaurant_users_update_owner/_delete_owner already restrict
-- WHO can change/remove a member (only owners) — this trigger adds the
-- orthogonal WHAT restriction (never the LAST owner), and applies
-- uniformly to any writer, including a future SECURITY DEFINER function,
-- since triggers fire regardless of RLS/privilege level.
create function public.enforce_at_least_one_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if OLD.role = 'owner' and (TG_OP = 'DELETE' or NEW.role <> 'owner') then
    if (
      select count(*) from public.restaurant_users
      where restaurant_id = OLD.restaurant_id and role = 'owner'
    ) <= 1 then
      raise exception 'Cannot remove or demote the last owner of a restaurant'
        using errcode = '23514';
    end if;
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

comment on function public.enforce_at_least_one_owner() is
  'Blocks demoting/removing a restaurant''s last remaining owner. See docs/security.md#staff-management.';

create trigger trg_restaurant_users_enforce_owner
  before update or delete on public.restaurant_users
  for each row execute function public.enforce_at_least_one_owner();
