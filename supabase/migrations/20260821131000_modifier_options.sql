-- The selectable choices within a modifier group (e.g. "Small" / "Large"
-- within the "Choose a size" group). No restaurant_id of its own — its
-- tenant is fully determined by modifier_id, so there's no cross-tenant
-- ambiguity to guard against with a composite FK here.
create table public.modifier_options (
  id uuid primary key default gen_random_uuid(),
  modifier_id uuid not null references public.menu_item_modifiers (id) on delete cascade,
  name text not null,
  price_adjustment numeric(10, 2) not null default 0,
  is_available boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint modifier_options_name_not_blank check (length(trim(name)) > 0)
  -- price_adjustment is intentionally unconstrained in sign: a modifier can
  -- discount the base price (e.g. "No cheese: -$1.00") as well as add to it.
);

comment on table public.modifier_options is
  'Selectable options within a modifier group. price_adjustment may be negative.';

create index modifier_options_modifier_id_idx on public.modifier_options (modifier_id);

create trigger trg_modifier_options_set_updated_at
  before update on public.modifier_options
  for each row
  execute function public.set_updated_at();

alter table public.modifier_options enable row level security;

create policy "modifier_options_select_members"
  on public.modifier_options
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.menu_item_modifiers mim
      where mim.id = modifier_options.modifier_id
        and public.is_restaurant_member(mim.restaurant_id)
    )
  );

create policy "modifier_options_insert_owner_manager"
  on public.modifier_options
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.menu_item_modifiers mim
      where mim.id = modifier_options.modifier_id
        and public.is_restaurant_manager_or_owner(mim.restaurant_id)
    )
  );

create policy "modifier_options_update_owner_manager"
  on public.modifier_options
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.menu_item_modifiers mim
      where mim.id = modifier_options.modifier_id
        and public.is_restaurant_manager_or_owner(mim.restaurant_id)
    )
  )
  with check (
    exists (
      select 1
      from public.menu_item_modifiers mim
      where mim.id = modifier_options.modifier_id
        and public.is_restaurant_manager_or_owner(mim.restaurant_id)
    )
  );

create policy "modifier_options_delete_owner_manager"
  on public.modifier_options
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.menu_item_modifiers mim
      where mim.id = modifier_options.modifier_id
        and public.is_restaurant_manager_or_owner(mim.restaurant_id)
    )
  );
