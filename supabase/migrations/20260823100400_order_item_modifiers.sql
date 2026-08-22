-- Modifier snapshots on an order line — the order-time equivalent of
-- cart_item_modifiers, but permanent: modifier_group_name/
-- modifier_option_name/price_adjustment are frozen at submit_order() time,
-- never re-read from menu_item_modifiers/modifier_options afterward.
create table public.order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  order_item_id uuid not null,
  -- Nullable + ON DELETE SET NULL, same reasoning as order_items.menu_item_id
  -- — a later-deleted modifier option must not take the historical snapshot
  -- row with it. modifier_group_name/modifier_option_name/price_adjustment
  -- are the source of truth for display, not this column.
  modifier_option_id uuid references public.modifier_options (id) on delete set null,
  modifier_group_name text not null,
  modifier_option_name text not null,
  price_adjustment numeric(10, 2) not null,
  -- Always 1 in this batch — modifier selections are single choices, not
  -- individually quantity-multipliable. Present for schema completeness /
  -- forward compatibility ("quantity if applicable" per spec), not written
  -- to by submit_order() beyond its default.
  quantity integer not null default 1,
  created_at timestamptz not null default now(),

  constraint order_item_modifiers_group_name_not_blank check (length(trim(modifier_group_name)) > 0),
  constraint order_item_modifiers_option_name_not_blank check (length(trim(modifier_option_name)) > 0),
  constraint order_item_modifiers_quantity_positive check (quantity > 0),
  constraint order_item_modifiers_item_same_restaurant
    foreign key (restaurant_id, order_item_id)
    references public.order_items (restaurant_id, id)
    on delete cascade
  -- No tenant-scoped FK to modifier_options: like modifier_options'
  -- relationship to cart_item_modifiers, it has no restaurant_id of its own
  -- (see 20260821131000_modifier_options.sql) — the plain, nullable FK
  -- above is the full extent of what's checkable at the DB layer here.
);

comment on table public.order_item_modifiers is
  'Immutable modifier snapshots on an order line item. Frozen at order time — never re-derived from current modifier_options. See docs/security.md#order-immutability.';

create index order_item_modifiers_order_item_id_idx on public.order_item_modifiers (order_item_id);
create index order_item_modifiers_modifier_option_id_idx on public.order_item_modifiers (modifier_option_id);

alter table public.order_item_modifiers enable row level security;

create policy "order_item_modifiers_select_own_or_staff"
  on public.order_item_modifiers
  for select
  to authenticated
  using (
    exists (
      select 1 from public.order_items oi
      where oi.id = order_item_modifiers.order_item_id
        and (
          public.order_belongs_to_caller(oi.order_id)
          or public.is_restaurant_member(oi.restaurant_id)
        )
    )
  );

-- No INSERT/UPDATE/DELETE policy: written only by submit_order().
