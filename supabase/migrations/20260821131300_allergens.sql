-- Restaurant-specific, not a global catalog: for this first version, the
-- restaurant's own declared allergen data is the source of truth, not a
-- shared taxonomy we'd have to keep in sync and arbitrate disagreements
-- over. A global/shared allergen catalog can be layered in later if two
-- restaurants' data needs to be reconciled for some cross-restaurant view.
create table public.allergens (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint allergens_name_not_blank check (length(trim(name)) > 0),
  constraint allergens_unique_name_per_restaurant unique (restaurant_id, name),
  -- Composite unique target for menu_item_allergens' tenant-scoped FK.
  constraint allergens_restaurant_id_id_key unique (restaurant_id, id)
);

comment on table public.allergens is
  'A restaurant''s own allergen catalog (not a shared/global taxonomy in this version).';

create index allergens_restaurant_id_idx on public.allergens (restaurant_id);

create trigger trg_allergens_set_updated_at
  before update on public.allergens
  for each row
  execute function public.set_updated_at();

alter table public.allergens enable row level security;

create policy "allergens_select_members"
  on public.allergens
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "allergens_insert_owner_manager"
  on public.allergens
  for insert
  to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "allergens_update_owner_manager"
  on public.allergens
  for update
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "allergens_delete_owner_manager"
  on public.allergens
  for delete
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));
