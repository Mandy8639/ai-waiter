-- RLS policies for restaurants and restaurant_users. Split from the table
-- creation migrations because both policies depend on
-- current_restaurant_role(), which itself depends on restaurant_users
-- existing — see 20260821130300_auth_helpers.sql. Both tables were already
-- RLS-enabled (deny-all) from the moment they were created, so there was
-- never a window of unprotected access.

-- restaurants -----------------------------------------------------------

create policy "restaurants_select_members"
  on public.restaurants
  for select
  to authenticated
  using (public.is_restaurant_member(id));

-- No INSERT policy: restaurant creation only happens through the
-- create_restaurant() SECURITY DEFINER function (20260821131500), which
-- bypasses RLS internally and always assigns the caller as owner. This is
-- what stops a client from POSTing a restaurants row directly.
--
-- No DELETE policy: restaurants are deactivated via is_active, not deleted,
-- in this batch.

create policy "restaurants_update_owner_manager"
  on public.restaurants
  for update
  to authenticated
  using (public.is_restaurant_manager_or_owner(id))
  with check (public.is_restaurant_manager_or_owner(id));

-- restaurant_users --------------------------------------------------------

-- Any member can see the full staff list for restaurants they belong to
-- (needed for a "who works here" dashboard view later).
create policy "restaurant_users_select_members"
  on public.restaurant_users
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- Owners may add a member with any role, including another owner. Managers
-- may add staff/kitchen/manager but never owner — this is what stops a
-- manager from self-granting ownership by inviting a second account and
-- handing it the keys. Neither role is checked against the *new* row's own
-- claims — restaurant_id and role both come from the inserted row itself,
-- and role is constrained by the CASE below regardless of what the client
-- sends.
--
-- Note this also blocks ALL inserts on a brand-new restaurant (no members
-- yet -> current_restaurant_role returns NULL -> falls to ELSE -> false).
-- That's intentional: the very first owner row is created exclusively by
-- create_restaurant(), which bypasses this policy via SECURITY DEFINER.
create policy "restaurant_users_insert_owner_manager"
  on public.restaurant_users
  for insert
  to authenticated
  with check (
    case public.current_restaurant_role(restaurant_id)
      when 'owner' then true
      when 'manager' then role <> 'owner'
      else false
    end
  );

-- Only owners can change an existing member's role. This is the policy that
-- stops a staff member from updating their own row to role = 'owner': the
-- USING clause is evaluated against the CALLER's current role, which for a
-- staff member is 'staff', not 'owner', regardless of what role value they
-- attempt to write.
create policy "restaurant_users_update_owner"
  on public.restaurant_users
  for update
  to authenticated
  using (public.current_restaurant_role(restaurant_id) = 'owner')
  with check (public.current_restaurant_role(restaurant_id) = 'owner');

-- Only owners can remove a member.
create policy "restaurant_users_delete_owner"
  on public.restaurant_users
  for delete
  to authenticated
  using (public.current_restaurant_role(restaurant_id) = 'owner');
