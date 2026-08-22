-- A submitted, priced order. Created exclusively by submit_order() (see
-- 20260823100600_submit_order_function.sql) — there is no INSERT/UPDATE/
-- DELETE policy on this table for any client role, the same way
-- `restaurants` has none and create_restaurant() is the only writer. Once a
-- row exists here, every monetary/snapshot value on it is immutable for the
-- lifetime of this batch (see docs/security.md#order-immutability) — no
-- code path updates one after creation, including this migration's own
-- policies, which grant SELECT only.
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  table_id uuid not null,
  customer_session_id uuid not null references public.customer_sessions (id) on delete restrict,
  order_number bigint not null,
  -- Text + CHECK, not a native Postgres enum — matches every other
  -- controlled-vocabulary column in this schema (restaurant_users.role,
  -- customer_sessions.status, menu_items.spice_level, ...), so adding a
  -- future status doesn't require an enum-alteration migration.
  status text not null default 'pending',
  subtotal numeric(10, 2) not null default 0,
  tax numeric(10, 2) not null default 0,
  service_charge numeric(10, 2) not null default 0,
  total numeric(10, 2) not null default 0,
  -- Copied from restaurants.currency at submission time — restaurants can
  -- change their currency later; this order's currency must not follow it.
  currency text not null,
  customer_note text,
  -- Caller-supplied, scoped per customer session (see the unique constraint
  -- below) — the mechanism behind "double-tap/retry creates one order."
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,

  constraint orders_status_valid check (
    status in ('pending', 'confirmed', 'preparing', 'ready', 'served', 'cancelled')
  ),
  constraint orders_subtotal_non_negative check (subtotal >= 0),
  constraint orders_tax_non_negative check (tax >= 0),
  constraint orders_service_charge_non_negative check (service_charge >= 0),
  constraint orders_total_non_negative check (total >= 0),
  constraint orders_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint orders_customer_note_length check (customer_note is null or length(customer_note) <= 500),
  constraint orders_idempotency_key_not_blank check (length(trim(idempotency_key)) > 0),
  constraint orders_idempotency_key_length check (length(idempotency_key) <= 100),
  -- The order-number-uniqueness half of "human-friendly, not globally
  -- unique, race-safe" — see order_number_counters.
  constraint orders_unique_order_number_per_restaurant unique (restaurant_id, order_number),
  -- The idempotency half: one (session, key) pair can back at most one
  -- order. submit_order() relies on this constraint firing (not just its
  -- own pre-check) as the actual concurrency-safe backstop.
  constraint orders_unique_idempotency_per_session unique (customer_session_id, idempotency_key),
  -- Composite unique target so order_items/order_item_modifiers/
  -- order_status_history can enforce tenant-scoped FKs back to this row.
  constraint orders_restaurant_id_id_key unique (restaurant_id, id),
  -- Tenant-scoped FKs, same pattern used throughout this schema (see
  -- docs/database.md#the-cross-tenant-integrity-problem-and-how-its-solved).
  -- ON DELETE RESTRICT (not CASCADE) on both: a table or a customer session
  -- with order history attached can't be deleted out from under it, so
  -- "historical orders must remain accurate" holds even against unrelated
  -- cleanup elsewhere in the schema.
  constraint orders_table_same_restaurant
    foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id)
    on delete restrict,
  constraint orders_session_same_restaurant
    foreign key (restaurant_id, customer_session_id)
    references public.customer_sessions (restaurant_id, id)
    on delete restrict
);

comment on table public.orders is
  'A submitted, server-priced order. Created only by submit_order() — no client INSERT/UPDATE/DELETE path exists. See docs/database.md#orders-batch-5.';
comment on column public.orders.order_number is
  'Human-friendly, per-restaurant sequential number (#1042), allocated atomically in submit_order() via order_number_counters. Not globally unique — always shown alongside/scoped to a restaurant.';
comment on column public.orders.idempotency_key is
  'Caller-supplied per submission attempt. Unique per (customer_session_id, idempotency_key) — a retried request with the same key returns the original order instead of creating a second one.';

create index orders_restaurant_id_idx on public.orders (restaurant_id);
create index orders_customer_session_id_idx on public.orders (customer_session_id);
create index orders_table_id_idx on public.orders (table_id);
create index orders_status_idx on public.orders (status);

create trigger trg_orders_set_updated_at
  before update on public.orders
  for each row
  execute function public.set_updated_at();

alter table public.orders enable row level security;

-- SECURITY DEFINER for the same reason cart_belongs_to_caller() is: called
-- from inside RLS policies (on order_items etc.) evaluated as
-- `authenticated`, which needs the escalation to reach auth.uid() from a
-- separately-invoked function body — see 20260822090400_cart_items.sql for
-- the full explanation, unchanged here.
create or replace function public.order_belongs_to_caller(target_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.orders o
    join public.customer_sessions cs on cs.id = o.customer_session_id
    where o.id = target_order_id
      and cs.user_id = auth.uid()
  )
$$;

comment on function public.order_belongs_to_caller(uuid) is
  'True if the given order belongs to the calling customer''s own session. Used throughout order_items/order_item_modifiers/order_status_history RLS.';

grant execute on function public.order_belongs_to_caller(uuid) to authenticated;

-- A customer sees only their own orders (via their session's user_id); any
-- restaurant staff member sees every order at their own restaurant,
-- regardless of role — read-only, matching the existing "any member can
-- read" convention for tables/menu/categories (docs/multi-tenancy.md). No
-- staff-write policy exists in this batch (see docs/security.md#order-status
-- for why status transitions are deferred, not silently permitted).
create policy "orders_select_own_or_staff"
  on public.orders
  for select
  to authenticated
  using (
    exists (
      select 1 from public.customer_sessions cs
      where cs.id = orders.customer_session_id and cs.user_id = auth.uid()
    )
    or public.is_restaurant_member(restaurant_id)
  );

-- No INSERT/UPDATE/DELETE policy for any role: submit_order() is a
-- SECURITY DEFINER function and writes bypass RLS entirely, the same way
-- create_restaurant() bypasses the (nonexistent) INSERT policy on
-- restaurants. This is what makes "a customer cannot change restaurant_id/
-- table_id/session_id/price/total/status/order ownership" structurally
-- true rather than merely policy-enforced — there is no write path to try.
