-- One cart per customer session (1:1) — created alongside the session.
-- restaurant_id is denormalized from the session so cart_items can enforce
-- a tenant-scoped FK back to this row (same composite-FK pattern used
-- throughout this schema — see docs/database.md).
create table public.carts (
  id uuid primary key default gen_random_uuid(),
  customer_session_id uuid not null unique references public.customer_sessions (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint carts_restaurant_id_id_key unique (restaurant_id, id)
);

comment on table public.carts is
  'A customer session''s in-progress order, before any order exists. 1:1 with customer_sessions.';

create index carts_customer_session_id_idx on public.carts (customer_session_id);

create trigger trg_carts_set_updated_at
  before update on public.carts
  for each row
  execute function public.set_updated_at();

alter table public.carts enable row level security;

-- Every policy resolves through the owning session's user_id = auth.uid()
-- — a customer can only ever reach their own cart, never another
-- customer's or another restaurant's, regardless of what restaurant_id or
-- customer_session_id a request claims (see docs/security.md).
create policy "carts_select_own"
  on public.carts
  for select
  to authenticated
  using (
    exists (
      select 1 from public.customer_sessions cs
      where cs.id = carts.customer_session_id and cs.user_id = auth.uid()
    )
  );

create policy "carts_insert_own"
  on public.carts
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.customer_sessions cs
      where cs.id = carts.customer_session_id and cs.user_id = auth.uid()
    )
  );

create policy "carts_update_own"
  on public.carts
  for update
  to authenticated
  using (
    exists (
      select 1 from public.customer_sessions cs
      where cs.id = carts.customer_session_id and cs.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.customer_sessions cs
      where cs.id = carts.customer_session_id and cs.user_id = auth.uid()
    )
  );
