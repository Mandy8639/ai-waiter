-- Helper shared by cart_items and cart_item_modifiers policies — avoids
-- repeating the cart -> customer_session -> auth.uid() join in every one.
--
-- SECURITY DEFINER for the same reason as current_restaurant_role() in
-- 20260821130300_auth_helpers.sql: called from inside RLS policies
-- evaluated as `authenticated`, which (correctly) has no direct schema
-- access to `auth` — without this, the auth.uid() call inside this
-- function's own body fails with "permission denied for schema auth".
-- Referencing auth.uid() directly inline in a policy's USING/WITH CHECK
-- (as customer_sessions'/carts' own policies do) doesn't hit this, since
-- policy expressions execute under the table owner's context already —
-- it's specifically calling auth.uid() from inside a separately-invoked
-- function that needs the explicit privilege escalation.
create or replace function public.cart_belongs_to_caller(target_cart_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.carts c
    join public.customer_sessions cs on cs.id = c.customer_session_id
    where c.id = target_cart_id
      and cs.user_id = auth.uid()
  )
$$;

comment on function public.cart_belongs_to_caller(uuid) is
  'True if the given cart belongs to the calling customer''s own session. Used throughout cart_items/cart_item_modifiers RLS.';

grant execute on function public.cart_belongs_to_caller(uuid) to authenticated;

-- One line per (menu item + modifier combination) added to a cart. Prices
-- are snapshots captured server-side at the moment the item was added —
-- see docs/security.md#price-validation — never trusted from the client
-- and never a live join back to menu_items.price (which could change
-- after the fact).
create table public.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  menu_item_id uuid not null,
  quantity integer not null,
  unit_price numeric(10, 2) not null,
  modifiers_price numeric(10, 2) not null default 0,
  line_total numeric(10, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cart_items_quantity_range check (quantity > 0 and quantity <= 99),
  constraint cart_items_unit_price_non_negative check (unit_price >= 0),
  constraint cart_items_line_total_non_negative check (line_total >= 0),
  -- Composite unique target so cart_item_modifiers can enforce a
  -- tenant-scoped FK back to this row.
  constraint cart_items_restaurant_id_id_key unique (restaurant_id, id),
  -- Tenant-scoped FKs: the cart and the menu item must both actually
  -- belong to this row's own restaurant_id.
  constraint cart_items_cart_same_restaurant
    foreign key (restaurant_id, cart_id)
    references public.carts (restaurant_id, id)
    on delete cascade,
  constraint cart_items_menu_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id)
    on delete restrict
);

comment on table public.cart_items is
  'Line items in a customer''s cart. unit_price/modifiers_price/line_total are server-computed snapshots, never client-supplied.';
comment on column public.cart_items.line_total is
  '(unit_price + modifiers_price) * quantity, computed server-side on every mutation.';

create index cart_items_cart_id_idx on public.cart_items (cart_id);
create index cart_items_menu_item_id_idx on public.cart_items (menu_item_id);

create trigger trg_cart_items_set_updated_at
  before update on public.cart_items
  for each row
  execute function public.set_updated_at();

alter table public.cart_items enable row level security;

create policy "cart_items_select_own"
  on public.cart_items
  for select
  to authenticated
  using (public.cart_belongs_to_caller(cart_id));

create policy "cart_items_insert_own"
  on public.cart_items
  for insert
  to authenticated
  with check (public.cart_belongs_to_caller(cart_id));

create policy "cart_items_update_own"
  on public.cart_items
  for update
  to authenticated
  using (public.cart_belongs_to_caller(cart_id))
  with check (public.cart_belongs_to_caller(cart_id));

create policy "cart_items_delete_own"
  on public.cart_items
  for delete
  to authenticated
  using (public.cart_belongs_to_caller(cart_id));
