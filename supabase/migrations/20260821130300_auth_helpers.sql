-- Authorization helpers used by every RLS policy in this schema.
--
-- SECURITY DEFINER is deliberate: it lets this function read
-- restaurant_users as its owner (a privileged role that isn't itself
-- subject to restaurant_users' RLS policies), so a policy ON
-- restaurant_users can call this function without triggering infinite
-- recursion (policy -> function -> query against the same
-- RLS-protected table -> policy -> ...). The function is still safe to
-- expose to `authenticated`/`anon` because it only ever returns data
-- scoped to auth.uid() — it can't be used to read anyone else's
-- membership.
--
-- `set search_path` pins name resolution so the function can't be tricked
-- by a caller-controlled search_path into resolving `public.restaurant_users`
-- to some other object.
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
  limit 1
$$;

comment on function public.current_restaurant_role(uuid) is
  'The calling user''s role in the given restaurant, or NULL if they are not a member. SECURITY DEFINER to avoid RLS recursion on restaurant_users — always filtered by auth.uid(), never exposes another user''s membership.';

create or replace function public.is_restaurant_member(target_restaurant_id uuid)
returns boolean
language sql
stable
as $$
  select public.current_restaurant_role(target_restaurant_id) is not null
$$;

comment on function public.is_restaurant_member(uuid) is
  'True if the calling user has any role in the given restaurant.';

create or replace function public.is_restaurant_manager_or_owner(target_restaurant_id uuid)
returns boolean
language sql
stable
as $$
  select public.current_restaurant_role(target_restaurant_id) in ('owner', 'manager')
$$;

comment on function public.is_restaurant_manager_or_owner(uuid) is
  'True if the calling user is an owner or manager of the given restaurant. Used to gate menu/table/settings management.';

-- Only authenticated (and, for completeness, anon — who will always get
-- NULL/false back) may call these; they are read-only and self-scoped.
grant execute on function public.current_restaurant_role(uuid) to authenticated, anon;
grant execute on function public.is_restaurant_member(uuid) to authenticated, anon;
grant execute on function public.is_restaurant_manager_or_owner(uuid) to authenticated, anon;
