create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  category_id uuid not null,
  name text not null,
  slug text not null,
  description text,
  price numeric(10, 2) not null,
  image_url text,
  is_available boolean not null default true,
  is_vegetarian boolean not null default false,
  is_vegan boolean not null default false,
  is_spicy boolean not null default false,
  spice_level text,
  contains_nuts boolean not null default false,
  contains_dairy boolean not null default false,
  contains_gluten boolean not null default false,
  preparation_time integer,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint menu_items_name_not_blank check (length(trim(name)) > 0),
  constraint menu_items_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint menu_items_price_non_negative check (price >= 0),
  constraint menu_items_preparation_time_non_negative check (preparation_time is null or preparation_time >= 0),
  constraint menu_items_display_order_non_negative check (display_order >= 0),
  constraint menu_items_spice_level_valid check (
    spice_level is null or spice_level in ('none', 'mild', 'medium', 'hot', 'very_hot')
  ),
  constraint menu_items_unique_slug_per_restaurant unique (restaurant_id, slug),
  -- Composite unique target so child tables (modifiers, ingredients,
  -- allergens) can enforce a tenant-scoped FK back to this row.
  constraint menu_items_restaurant_id_id_key unique (restaurant_id, id),
  -- The tenant-scoped FK described in docs/database.md: rejects a menu item
  -- whose category_id points at a category belonging to a DIFFERENT
  -- restaurant, even though category_id alone would be a "valid" UUID.
  -- ON DELETE RESTRICT (not CASCADE): a category with items in it can't be
  -- deleted out from under them.
  constraint menu_items_category_same_restaurant
    foreign key (restaurant_id, category_id)
    references public.categories (restaurant_id, id)
    on delete restrict
);

comment on table public.menu_items is
  'Dishes. category_id is enforced (via the composite FK on restaurant_id) to belong to the same restaurant as the item itself — see docs/database.md.';
comment on constraint menu_items_category_same_restaurant on public.menu_items is
  'Tenant-scoped foreign key: prevents attaching a category from a different restaurant.';

create index menu_items_restaurant_id_idx on public.menu_items (restaurant_id);
create index menu_items_category_id_idx on public.menu_items (category_id);
create index menu_items_is_available_idx on public.menu_items (is_available);

create trigger trg_menu_items_set_updated_at
  before update on public.menu_items
  for each row
  execute function public.set_updated_at();

alter table public.menu_items enable row level security;

create policy "menu_items_select_members"
  on public.menu_items
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "menu_items_insert_owner_manager"
  on public.menu_items
  for insert
  to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "menu_items_update_owner_manager"
  on public.menu_items
  for update
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "menu_items_delete_owner_manager"
  on public.menu_items
  for delete
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));
