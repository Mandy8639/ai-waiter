-- The specific modifier options chosen for a cart line. modifier_id (the
-- group) is stored alongside modifier_option_id specifically so a
-- tenant-scoped composite FK can verify the GROUP belongs to this row's
-- restaurant — modifier_options itself still has no restaurant_id (see
-- 20260821131000_modifier_options.sql), so verifying that the chosen
-- OPTION actually belongs to modifier_id is an application-level check
-- (src/lib/cart/actions.ts), the same way menu_item_modifiers already
-- documents that split of responsibility.
create table public.cart_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  cart_item_id uuid not null,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  modifier_id uuid not null,
  modifier_option_id uuid not null references public.modifier_options (id) on delete restrict,
  name text not null,
  price_adjustment numeric(10, 2) not null,
  created_at timestamptz not null default now(),

  constraint cart_item_modifiers_item_same_restaurant
    foreign key (restaurant_id, cart_item_id)
    references public.cart_items (restaurant_id, id)
    on delete cascade,
  constraint cart_item_modifiers_group_same_restaurant
    foreign key (restaurant_id, modifier_id)
    references public.menu_item_modifiers (restaurant_id, id)
    on delete restrict
);

comment on table public.cart_item_modifiers is
  'The modifier options selected for one cart line. name/price_adjustment are server-computed snapshots at add-to-cart time, never client-supplied.';

create index cart_item_modifiers_cart_item_id_idx on public.cart_item_modifiers (cart_item_id);
create index cart_item_modifiers_modifier_option_id_idx on public.cart_item_modifiers (modifier_option_id);

alter table public.cart_item_modifiers enable row level security;

create policy "cart_item_modifiers_select_own"
  on public.cart_item_modifiers
  for select
  to authenticated
  using (
    exists (
      select 1 from public.cart_items ci
      where ci.id = cart_item_modifiers.cart_item_id and public.cart_belongs_to_caller(ci.cart_id)
    )
  );

create policy "cart_item_modifiers_insert_own"
  on public.cart_item_modifiers
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.cart_items ci
      where ci.id = cart_item_modifiers.cart_item_id and public.cart_belongs_to_caller(ci.cart_id)
    )
  );

create policy "cart_item_modifiers_delete_own"
  on public.cart_item_modifiers
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.cart_items ci
      where ci.id = cart_item_modifiers.cart_item_id and public.cart_belongs_to_caller(ci.cart_id)
    )
  );

-- No UPDATE policy: a line's modifier selections change by deleting and
-- re-inserting the rows (mirrors menu_item_ingredients' same reasoning).
