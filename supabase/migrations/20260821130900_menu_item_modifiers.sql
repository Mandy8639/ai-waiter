-- A modifier group on a menu item, e.g. "Choose a size" or "Spice level".
create table public.menu_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  menu_item_id uuid not null,
  name text not null,
  description text,
  is_required boolean not null default false,
  min_selections integer not null default 0,
  max_selections integer not null default 1,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint menu_item_modifiers_name_not_blank check (length(trim(name)) > 0),
  constraint menu_item_modifiers_min_selections_non_negative check (min_selections >= 0),
  constraint menu_item_modifiers_max_gte_min check (max_selections >= min_selections),
  -- Tenant-scoped FK: the modifier group's menu item must belong to the same
  -- restaurant as the modifier group itself.
  constraint menu_item_modifiers_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id)
    on delete cascade
);

comment on table public.menu_item_modifiers is
  'Modifier groups attached to a menu item (e.g. "Choose a size"). See modifier_options for the selectable choices within a group.';

create index menu_item_modifiers_menu_item_id_idx on public.menu_item_modifiers (menu_item_id);

create trigger trg_menu_item_modifiers_set_updated_at
  before update on public.menu_item_modifiers
  for each row
  execute function public.set_updated_at();

alter table public.menu_item_modifiers enable row level security;

create policy "menu_item_modifiers_select_members"
  on public.menu_item_modifiers
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "menu_item_modifiers_insert_owner_manager"
  on public.menu_item_modifiers
  for insert
  to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "menu_item_modifiers_update_owner_manager"
  on public.menu_item_modifiers
  for update
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "menu_item_modifiers_delete_owner_manager"
  on public.menu_item_modifiers
  for delete
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));
