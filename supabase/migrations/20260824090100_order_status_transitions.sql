-- The order state machine, expressed as data (a pure lookup function), not
-- scattered across application code. Both the enforcement trigger below and
-- transition_order_status() (20260824090200_transition_order_status_function.sql)
-- read from this single source of truth — see docs/database.md#order-state-machine-batch-6.
--
--   pending -> confirmed -> preparing -> ready -> served
--   pending -> cancelled
--   confirmed -> cancelled
--
-- Deliberately NOT allowed (spec-explicit): pending -> preparing/ready/served
-- (skipping confirmation), any backward move (preparing -> pending, ready ->
-- preparing, ...), anything out of 'served' or 'cancelled' (both terminal).
create or replace function public.is_valid_order_status_transition(
  from_status text,
  to_status text
)
returns boolean
language sql
immutable
as $$
  select case
    when from_status = 'pending' and to_status in ('confirmed', 'cancelled') then true
    when from_status = 'confirmed' and to_status in ('preparing', 'cancelled') then true
    when from_status = 'preparing' and to_status = 'ready' then true
    when from_status = 'ready' and to_status = 'served' then true
    else false
  end
$$;

comment on function public.is_valid_order_status_transition(text, text) is
  'The order state machine''s legal-transition table. Used by both the orders BEFORE UPDATE trigger (structural enforcement, independent of who''s asking) and role_can_transition_order() (role-scoped permission on top of it).';

-- The role -> permitted-transitions matrix (spec section 4). owner/manager
-- get every structurally-valid transition; kitchen and staff each get a
-- documented subset. This is the ONLY place role permissions are decided —
-- transition_order_status() calls this rather than re-deriving the matrix
-- itself, and there is no other write path to an order's status at all.
--
-- | Role    | pending->confirmed | confirmed->preparing | preparing->ready | ready->served | pending->cancelled | confirmed->cancelled |
-- |---------|---------------------|-----------------------|-------------------|----------------|----------------------|------------------------|
-- | owner   | yes                 | yes                   | yes               | yes            | yes                  | yes                    |
-- | manager | yes                 | yes                   | yes               | yes            | yes                  | yes                    |
-- | kitchen | yes                 | yes                   | yes               | no             | no                   | no                     |
-- | staff   | no                  | no                    | no                | yes            | yes                  | no                     |
--
-- staff can cancel a still-`pending` order (a front-of-house catch before
-- the kitchen has committed anything) but not a `confirmed` one — by then
-- the kitchen has already started acting on it, so that's a manager/owner
-- call. staff cannot perform any of the kitchen-facing prep transitions,
-- and kitchen cannot serve or cancel — see docs/security.md#staff-role-matrix
-- for the full rationale.
create or replace function public.role_can_transition_order(
  actor_role text,
  from_status text,
  to_status text
)
returns boolean
language sql
immutable
as $$
  select case
    when actor_role in ('owner', 'manager') then public.is_valid_order_status_transition(from_status, to_status)
    when actor_role = 'kitchen' then (from_status, to_status) in (
      ('pending', 'confirmed'), ('confirmed', 'preparing'), ('preparing', 'ready')
    )
    when actor_role = 'staff' then (from_status, to_status) in (
      ('ready', 'served'), ('pending', 'cancelled')
    )
    else false
  end
$$;

comment on function public.role_can_transition_order(text, text, text) is
  'The staff role permission matrix for order status transitions — see the table in this migration''s comment and docs/security.md#staff-role-matrix.';

-- Defense in depth, independent of transition_order_status()'s own logic
-- (spec section 27: "do not rely only on application code"). Fires on
-- EVERY update to `orders`, not just ones through the function — so even a
-- bug in the function, or any future privileged code path, cannot produce
-- an illegal state transition or touch a financial/identity field. This is
-- the actual, structural enforcement; the function's own checks exist for
-- friendlier errors and role authorization, not as the only safety net.
create or replace function public.enforce_order_immutable_fields()
returns trigger
language plpgsql
as $$
begin
  if new.subtotal <> old.subtotal
    or new.tax <> old.tax
    or new.service_charge <> old.service_charge
    or new.total <> old.total
    or new.currency <> old.currency
    or new.restaurant_id <> old.restaurant_id
    or new.table_id <> old.table_id
    or new.customer_session_id <> old.customer_session_id
    or new.order_number <> old.order_number
    or new.idempotency_key <> old.idempotency_key
  then
    raise exception 'orders: financial and identity fields are immutable after creation';
  end if;
  return new;
end;
$$;

comment on function public.enforce_order_immutable_fields() is
  'Trigger: rejects any UPDATE that changes an order''s price/tax/total/currency/tenant-identity fields, regardless of role or write path. Only status (and, via the sibling trigger, confirmed_at/cancelled_at) may ever change after creation.';

create trigger trg_orders_enforce_immutable_fields
  before update on public.orders
  for each row
  execute function public.enforce_order_immutable_fields();

create or replace function public.enforce_order_status_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status <> old.status then
    if not public.is_valid_order_status_transition(old.status, new.status) then
      raise exception 'invalid order status transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;

    if new.status = 'confirmed' and old.confirmed_at is null then
      new.confirmed_at = now();
    end if;
    if new.status = 'cancelled' and old.cancelled_at is null then
      new.cancelled_at = now();
    end if;
  end if;
  return new;
end;
$$;

comment on function public.enforce_order_status_transition() is
  'Trigger: the structural half of the state machine — rejects any UPDATE that would set an illegal status, and stamps confirmed_at/cancelled_at on the way through. Fires regardless of who or what issues the UPDATE.';

create trigger trg_orders_enforce_status_transition
  before update on public.orders
  for each row
  execute function public.enforce_order_status_transition();
