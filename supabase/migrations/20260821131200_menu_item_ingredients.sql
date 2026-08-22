-- Join table: which ingredients are in which menu item. Carries its own
-- restaurant_id (rather than relying purely on its two parents agreeing)
-- so it can enforce, at the FK level, that BOTH the menu item AND the
-- ingredient belong to that same restaurant — see docs/database.md.
create table public.menu_item_ingredients (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  menu_item_id uuid not null,
  ingredient_id uuid not null,
  created_at timestamptz not null default now(),

  constraint menu_item_ingredients_unique unique (menu_item_id, ingredient_id),
  constraint menu_item_ingredients_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id)
    on delete cascade,
  constraint menu_item_ingredients_ingredient_same_restaurant
    foreign key (restaurant_id, ingredient_id)
    references public.ingredients (restaurant_id, id)
    on delete cascade
);

comment on table public.menu_item_ingredients is
  'Menu item <-> ingredient links. Both tenant-scoped FKs must resolve to the same restaurant_id as this row, so a menu item can never be linked to another restaurant''s ingredient.';

create index menu_item_ingredients_menu_item_id_idx on public.menu_item_ingredients (menu_item_id);
create index menu_item_ingredients_ingredient_id_idx on public.menu_item_ingredients (ingredient_id);

alter table public.menu_item_ingredients enable row level security;

create policy "menu_item_ingredients_select_members"
  on public.menu_item_ingredients
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "menu_item_ingredients_insert_owner_manager"
  on public.menu_item_ingredients
  for insert
  to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "menu_item_ingredients_delete_owner_manager"
  on public.menu_item_ingredients
  for delete
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

-- No UPDATE policy: this is a pure link row (item + ingredient); changing a
-- link is a delete-and-reinsert, not an update.
