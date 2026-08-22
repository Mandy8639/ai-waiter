-- Line items on a submitted order. Unlike cart_items (a live-ish working
-- set), every value here is a permanent snapshot taken at submit_order()
-- time — item_name/unit_price never re-read menu_items after creation, so a
-- later price change or rename on the menu does not alter historical
-- orders (see docs/database.md#order-items-batch-5).
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  order_id uuid not null,
  -- Nullable + ON DELETE SET NULL: menu items can be hard-deleted
  -- (src/lib/menu/actions.ts deleteMenuItem) — losing the live FK target
  -- must never take the historical order_item row with it. item_name/
  -- unit_price are the source of truth for display, not this column.
  menu_item_id uuid references public.menu_items (id) on delete set null,
  item_name text not null,
  quantity integer not null,
  unit_price numeric(10, 2) not null,
  modifier_total numeric(10, 2) not null default 0,
  line_total numeric(10, 2) not null,
  notes text,
  created_at timestamptz not null default now(),

  constraint order_items_item_name_not_blank check (length(trim(item_name)) > 0),
  constraint order_items_quantity_range check (quantity > 0 and quantity <= 99),
  constraint order_items_unit_price_non_negative check (unit_price >= 0),
  constraint order_items_line_total_non_negative check (line_total >= 0),
  constraint order_items_notes_length check (notes is null or length(notes) <= 300),
  -- Composite unique target for order_item_modifiers' tenant-scoped FK.
  constraint order_items_restaurant_id_id_key unique (restaurant_id, id),
  constraint order_items_order_same_restaurant
    foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id)
    on delete cascade,
  -- menu_item_id has no composite tenant-scoped FK: it's already nullable
  -- and SET NULL on delete (see column comment) — a plain FK is enough
  -- since restaurant_id here is independently trustworthy (copied from the
  -- order, itself server-derived, never client input).
  constraint order_items_menu_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id)
);

comment on table public.order_items is
  'Immutable line-item snapshots on a submitted order. item_name/unit_price/modifier_total/line_total are frozen at order time — never re-derived from current menu_items. See docs/security.md#order-immutability.';

create index order_items_order_id_idx on public.order_items (order_id);
create index order_items_menu_item_id_idx on public.order_items (menu_item_id);

alter table public.order_items enable row level security;

create policy "order_items_select_own_or_staff"
  on public.order_items
  for select
  to authenticated
  using (
    public.order_belongs_to_caller(order_id)
    or public.is_restaurant_member(restaurant_id)
  );

-- No INSERT/UPDATE/DELETE policy: written only by submit_order() (SECURITY
-- DEFINER), same reasoning as orders itself.
