-- Join table: which allergens a menu item contains. Same tenant-scoped FK
-- pattern as menu_item_ingredients — see that migration and docs/database.md.
create table public.menu_item_allergens (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  menu_item_id uuid not null,
  allergen_id uuid not null,
  created_at timestamptz not null default now(),

  constraint menu_item_allergens_unique unique (menu_item_id, allergen_id),
  constraint menu_item_allergens_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id)
    on delete cascade,
  constraint menu_item_allergens_allergen_same_restaurant
    foreign key (restaurant_id, allergen_id)
    references public.allergens (restaurant_id, id)
    on delete cascade
);

comment on table public.menu_item_allergens is
  'Menu item <-> allergen links. Both tenant-scoped FKs must resolve to the same restaurant_id as this row.';

create index menu_item_allergens_menu_item_id_idx on public.menu_item_allergens (menu_item_id);
create index menu_item_allergens_allergen_id_idx on public.menu_item_allergens (allergen_id);

alter table public.menu_item_allergens enable row level security;

create policy "menu_item_allergens_select_members"
  on public.menu_item_allergens
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "menu_item_allergens_insert_owner_manager"
  on public.menu_item_allergens
  for insert
  to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "menu_item_allergens_delete_owner_manager"
  on public.menu_item_allergens
  for delete
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));
