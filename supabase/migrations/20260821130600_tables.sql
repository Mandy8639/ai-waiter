-- A restaurant's physical tables. table_number is only unique within a
-- restaurant — "Table 1" legitimately exists at every restaurant.
create table public.tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  table_number text not null,
  display_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tables_table_number_not_blank check (length(trim(table_number)) > 0),
  constraint tables_unique_number_per_restaurant unique (restaurant_id, table_number)
);

comment on table public.tables is
  'Physical tables at a restaurant. table_number is scoped per-restaurant, not globally unique.';

create index tables_restaurant_id_idx on public.tables (restaurant_id);

create trigger trg_tables_set_updated_at
  before update on public.tables
  for each row
  execute function public.set_updated_at();

alter table public.tables enable row level security;

create policy "tables_select_members"
  on public.tables
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "tables_manage_owner_manager"
  on public.tables
  for insert
  to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "tables_update_owner_manager"
  on public.tables
  for update
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "tables_delete_owner_manager"
  on public.tables
  for delete
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));
