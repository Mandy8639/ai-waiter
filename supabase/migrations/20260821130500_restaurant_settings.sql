-- One row per restaurant, created alongside it (see create_restaurant()).
-- Kept separate from `restaurants` so operational toggles — especially the
-- ones that will govern the future AI waiter's behavior — don't churn the
-- same row as core identity/branding fields.
create table public.restaurant_settings (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants (id) on delete cascade,
  accepting_orders boolean not null default true,
  allow_customer_notes boolean not null default true,
  allow_ai_recommendations boolean not null default true,
  allow_upselling boolean not null default true,
  max_order_items integer not null default 50,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint restaurant_settings_max_order_items_positive check (max_order_items > 0)
);

comment on table public.restaurant_settings is
  'Per-restaurant operational toggles, including future AI waiter behavior flags. 1:1 with restaurants.';

create trigger trg_restaurant_settings_set_updated_at
  before update on public.restaurant_settings
  for each row
  execute function public.set_updated_at();

alter table public.restaurant_settings enable row level security;

create policy "restaurant_settings_select_members"
  on public.restaurant_settings
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "restaurant_settings_update_owner_manager"
  on public.restaurant_settings
  for update
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

-- No INSERT/DELETE policy: the row is created exclusively by
-- create_restaurant() and lives and dies with its restaurant (ON DELETE
-- CASCADE), so there's no legitimate client-side create or delete path.
