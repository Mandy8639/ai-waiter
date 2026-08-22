-- Links a Supabase Auth user to a restaurant with a role. A person can hold
-- memberships in more than one restaurant (e.g. a consultant, or an owner of
-- two locations), so this is a join table, not a column on auth.users.
create table public.restaurant_users (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint restaurant_users_role_valid check (role in ('owner', 'manager', 'kitchen', 'staff')),
  constraint restaurant_users_unique_membership unique (user_id, restaurant_id)
);

comment on table public.restaurant_users is
  'Membership + role of an auth.users row within a restaurant. One user may have multiple rows (one per restaurant).';

-- Referenced constantly by RLS policies across the schema (every policy in
-- this project resolves to a lookup here), and by the dashboard's staff list.
create index restaurant_users_restaurant_id_idx on public.restaurant_users (restaurant_id);
create index restaurant_users_user_id_idx on public.restaurant_users (user_id);

create trigger trg_restaurant_users_set_updated_at
  before update on public.restaurant_users
  for each row
  execute function public.set_updated_at();

-- Deny-all until 20260821130400_core_rls_policies.sql adds real policies —
-- see that file for why restaurant_users' own policies can't be defined
-- until the auth helper functions exist.
alter table public.restaurant_users enable row level security;
