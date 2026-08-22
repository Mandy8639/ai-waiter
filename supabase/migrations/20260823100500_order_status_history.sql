-- An append-only audit trail of status changes. In this batch, exactly one
-- row is ever written per order — the initial 'pending' event, inserted by
-- submit_order() in the same transaction as the order itself (see
-- docs/database.md#order-status-history-batch-5). No status-transition
-- workflow (confirm/prepare/cancel/etc.) is implemented yet — that's the
-- kitchen-facing batch this table is deliberately built ahead of, per this
-- batch's "do not overbuild future workflows yet" instruction.
create table public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  order_id uuid not null,
  status text not null,
  actor_type text not null,
  -- Nullable: 'system' events (not used yet, reserved for future automated
  -- transitions) have no human actor.
  actor_id uuid,
  created_at timestamptz not null default now(),

  constraint order_status_history_status_valid check (
    status in ('pending', 'confirmed', 'preparing', 'ready', 'served', 'cancelled')
  ),
  constraint order_status_history_actor_type_valid check (
    actor_type in ('customer', 'staff', 'manager', 'owner', 'system')
  ),
  constraint order_status_history_order_same_restaurant
    foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id)
    on delete cascade
);

comment on table public.order_status_history is
  'Append-only audit trail of order status changes. Batch 5 writes exactly one row per order (the initial ''pending'' event) — see submit_order().';

create index order_status_history_order_id_idx on public.order_status_history (order_id);
create index order_status_history_created_at_idx on public.order_status_history (created_at);

alter table public.order_status_history enable row level security;

create policy "order_status_history_select_own_or_staff"
  on public.order_status_history
  for select
  to authenticated
  using (
    public.order_belongs_to_caller(order_id)
    or public.is_restaurant_member(restaurant_id)
  );

-- No INSERT/UPDATE/DELETE policy: written only by submit_order(). Future
-- status-transition batches will need their own carefully-scoped INSERT
-- policy (staff-only, role-gated) — deliberately not built yet.
