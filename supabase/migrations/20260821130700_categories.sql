create table public.categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null,
  description text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint categories_name_not_blank check (length(trim(name)) > 0),
  constraint categories_display_order_non_negative check (display_order >= 0),
  constraint categories_unique_name_per_restaurant unique (restaurant_id, name),
  -- Composite unique target so menu_items can enforce a tenant-scoped FK
  -- (see 20260821130800_menu_items.sql and docs/database.md for why).
  constraint categories_restaurant_id_id_key unique (restaurant_id, id)
);

comment on table public.categories is
  'Menu sections. Ordering and names are restaurant-scoped.';

create index categories_restaurant_id_idx on public.categories (restaurant_id);

create trigger trg_categories_set_updated_at
  before update on public.categories
  for each row
  execute function public.set_updated_at();

alter table public.categories enable row level security;

create policy "categories_select_members"
  on public.categories
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "categories_insert_owner_manager"
  on public.categories
  for insert
  to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "categories_update_owner_manager"
  on public.categories
  for update
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "categories_delete_owner_manager"
  on public.categories
  for delete
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));
