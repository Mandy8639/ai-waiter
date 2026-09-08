-- The seam a POS connector will plug into. Not a connector.
--
-- Nothing here talks to Toast, Square or Clover. What it does is make the
-- first such integration an ADDITION rather than a rewrite, and the three
-- things that are expensive to retrofit are all here: somewhere to record
-- which POS a restaurant runs, somewhere to record what each menu row is
-- called on the other side, and a reliable record that an order happened.
--
-- Deliberately absent: credentials. `credentials_ref` names a secret, it
-- is not the secret. A per-restaurant API token sitting in a Postgres
-- column is readable by anyone who can read the row, restorable from
-- every backup, and printed in every dump — see docs/backup-and-restore.md
-- for how routinely those move around. The token itself belongs in the
-- deployment's secret store, looked up by this name at delivery time.

create table public.restaurant_pos_integrations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants (id) on delete cascade,
  -- Open-ended on purpose. A closed enum would need a migration to
  -- support a POS somebody asks for on a Friday.
  provider text not null,
  -- What the POS calls this restaurant: Square's location id, Toast's
  -- restaurant GUID. Null until someone completes the pairing.
  external_location_id text,
  -- The NAME of a secret, never a secret. See the header.
  credentials_ref text,
  -- Off by default. A half-configured integration that starts firing at
  -- a real POS is worse than one that does nothing.
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint restaurant_pos_integrations_provider_valid
    check (char_length(provider) between 1 and 60),
  -- Enabling without knowing which location to push to would queue work
  -- that can never be delivered.
  constraint restaurant_pos_integrations_enabled_needs_location
    check (not is_enabled or external_location_id is not null)
);

comment on table public.restaurant_pos_integrations is
  'Which POS a restaurant runs and how to address it. 1:1 with restaurants. Never holds credentials — credentials_ref names a secret held outside the database.';

create trigger trg_restaurant_pos_integrations_set_updated_at
  before update on public.restaurant_pos_integrations
  for each row
  execute function public.set_updated_at();

alter table public.restaurant_pos_integrations enable row level security;

-- Commercial configuration, like payments: owner/manager only, not every
-- member. A kitchen login has no business reading which POS account this
-- restaurant is wired to.
create policy "restaurant_pos_integrations_select_owner_manager"
  on public.restaurant_pos_integrations
  for select
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "restaurant_pos_integrations_insert_owner_manager"
  on public.restaurant_pos_integrations
  for insert
  to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "restaurant_pos_integrations_update_owner_manager"
  on public.restaurant_pos_integrations
  for update
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

-- No DELETE policy: disabling is is_enabled = false, which keeps the
-- external ids that were already mapped. Deleting the row throws that
-- mapping away and makes re-pairing a full menu re-sync.

-- ── What each row is called on the other side ──────────────────────────
--
-- A column per table rather than one mapping table. A restaurant runs one
-- POS, joins stay simple, and a menu sync is an ordinary update. If two
-- providers per restaurant ever become real, this becomes a mapping table
-- and these columns become its first rows — a migration, not a redesign.
--
-- Unique per restaurant, not globally: two restaurants on the same POS
-- vendor will absolutely collide on ids otherwise.

alter table public.categories add column external_id text;
alter table public.menu_items add column external_id text;
alter table public.menu_item_modifiers add column external_id text;
alter table public.modifier_options add column external_id text;

create unique index categories_external_id_per_restaurant
  on public.categories (restaurant_id, external_id)
  where external_id is not null;
create unique index menu_items_external_id_per_restaurant
  on public.menu_items (restaurant_id, external_id)
  where external_id is not null;
create unique index menu_item_modifiers_external_id_per_restaurant
  on public.menu_item_modifiers (restaurant_id, external_id)
  where external_id is not null;
-- modifier_options carries no restaurant_id — it is tenant-scoped
-- transitively, through its modifier group. So uniqueness is enforced per
-- GROUP, which a plain index can express, rather than per restaurant,
-- which would need a denormalised column this schema deliberately does
-- not have. The narrower guard still catches the mistake that actually
-- happens: the same POS option id mapped twice inside one group.
create unique index modifier_options_external_id_per_group
  on public.modifier_options (modifier_id, external_id)
  where external_id is not null;

comment on column public.menu_items.external_id is
  'What the restaurant''s POS calls this item. Null until a menu sync pairs them. Unique per restaurant, never globally — two restaurants on the same POS vendor will collide otherwise.';

-- ── The outbox ─────────────────────────────────────────────────────────
--
-- A transactional outbox, written by a trigger inside the same
-- transaction as the order itself. That is the whole point of doing it in
-- the database rather than in application code after submit_order()
-- returns: an order and its outbound event either both exist or neither
-- does. A process that dies between the two cannot lose an order the POS
-- never hears about, and a rolled-back order cannot leave an event that
-- pushes a sale nobody made.
--
-- The row is a POINTER, not a snapshot. order_items are immutable once
-- written, so a delivery attempt tomorrow reads exactly what a delivery
-- attempt today would have — and duplicating the lines here would create
-- a second copy of the truth that can silently drift from the first.

create table public.pos_outbox (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  event_type text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  -- When a worker may next try. Set forward on failure by the caller's
  -- backoff; a pending row whose time has come is claimable.
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),

  constraint pos_outbox_status_valid
    check (status in ('pending', 'delivered', 'failed', 'abandoned')),
  constraint pos_outbox_event_type_valid
    check (event_type in ('order.created')),
  constraint pos_outbox_attempts_nonneg check (attempts >= 0),
  -- The connector's idempotency key. One event per order per type, so a
  -- retry storm, a double-fired trigger or a worker that crashes after
  -- delivering but before marking cannot push the same sale twice.
  constraint pos_outbox_one_event_per_order unique (order_id, event_type)
);

comment on table public.pos_outbox is
  'Transactional outbox for POS delivery. Written by trigger inside the order''s own transaction, so an order and its event are never out of step. Rows point at the order rather than copying it — order_items are immutable. UNIQUE(order_id, event_type) is the idempotency key.';

-- The claim query: oldest due work first, for one restaurant or all.
create index pos_outbox_claimable
  on public.pos_outbox (next_attempt_at)
  where status = 'pending';

create index pos_outbox_by_restaurant on public.pos_outbox (restaurant_id, created_at desc);

alter table public.pos_outbox enable row level security;

-- Owner/manager may LOOK, to answer "did that order reach the till?".
-- Nobody may write: rows are created by the trigger below and updated by
-- the delivery worker using the service key, which bypasses RLS. There is
-- no legitimate client-side write, and a staff member marking a failed
-- push as delivered would hide a missing sale.
create policy "pos_outbox_select_owner_manager"
  on public.pos_outbox
  for select
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

-- ── The trigger ────────────────────────────────────────────────────────

create or replace function public.enqueue_pos_order_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only for restaurants that have actually turned an integration on.
  -- Every other restaurant on the platform writes nothing at all, so the
  -- outbox stays the size of the work there is rather than the size of
  -- the order table.
  if not exists (
    select 1
    from public.restaurant_pos_integrations i
    where i.restaurant_id = new.restaurant_id
      and i.is_enabled
  ) then
    return new;
  end if;

  -- ON CONFLICT DO NOTHING rather than letting a duplicate raise: this
  -- runs inside submit_order()'s transaction, and an outbox collision
  -- must never be the reason a customer's order fails to be placed. The
  -- unique constraint is there to prevent double delivery, not to police
  -- the ordering path.
  insert into public.pos_outbox (restaurant_id, order_id, event_type)
  values (new.restaurant_id, new.id, 'order.created')
  on conflict (order_id, event_type) do nothing;

  return new;
end;
$$;

comment on function public.enqueue_pos_order_created() is
  'Writes one pos_outbox row per new order, inside the order''s own transaction, for restaurants with an enabled POS integration. Silent no-op for everyone else.';

create trigger trg_orders_enqueue_pos
  after insert on public.orders
  for each row
  execute function public.enqueue_pos_order_created();

grant execute on function public.enqueue_pos_order_created() to authenticated;
