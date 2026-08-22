create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ingredients_name_not_blank check (length(trim(name)) > 0),
  constraint ingredients_unique_name_per_restaurant unique (restaurant_id, name),
  -- Composite unique target for menu_item_ingredients' tenant-scoped FK.
  constraint ingredients_restaurant_id_id_key unique (restaurant_id, id)
);

comment on table public.ingredients is
  'A restaurant''s ingredient catalog, reusable across its own menu items.';

create index ingredients_restaurant_id_idx on public.ingredients (restaurant_id);

create trigger trg_ingredients_set_updated_at
  before update on public.ingredients
  for each row
  execute function public.set_updated_at();

alter table public.ingredients enable row level security;

create policy "ingredients_select_members"
  on public.ingredients
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "ingredients_insert_owner_manager"
  on public.ingredients
  for insert
  to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "ingredients_update_owner_manager"
  on public.ingredients
  for update
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "ingredients_delete_owner_manager"
  on public.ingredients
  for delete
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));
