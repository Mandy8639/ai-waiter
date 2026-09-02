-- Payments phase 3, step 1 — one payment can cover several orders.
--
-- A restaurant tab is many orders settled together. Phase 2's model could
-- not express that: `order_payments.order_id` holds exactly one order, so
-- a diner with four orders had to pay four times, which is not a tab.
--
-- WHY A JOIN TABLE, AND WHY order_id IS DROPPED RATHER THAN KEPT
--
-- The obvious cheap move is to leave `order_id` in place for single-order
-- payments and add a side table for tabs. That gives two sources of truth
-- for the same question — "which orders did this payment settle?" — and
-- they drift the moment one write path forgets the other. In money code
-- that drift is unrecoverable: you cannot later tell whether an order was
-- paid. So `payment_orders` becomes the only answer to that question, and
-- `order_id` goes.
--
-- Existing rows are backfilled first, so no payment loses its order.
--
--
-- THE INVARIANT HAS TO MOVE TOO
--
-- Phase 2 guaranteed "at most one succeeded payment per order" with a
-- partial unique index on order_payments (order_id). Coverage now lives in
-- another table, and a unique index cannot span tables — so the guarantee
-- is re-implemented as a trigger that locks the affected order rows before
-- checking. Locking matters: without it, two concurrent settlements could
-- each look, see nothing, and both proceed.
--
-- This is strictly weaker than a unique index (it is code, not a
-- constraint) and that is worth being honest about. It is mitigated by
-- being the only write path — order_payments has no client-facing
-- INSERT/UPDATE policy at all — and by SELECT ... FOR UPDATE serialising
-- the check.

create table public.payment_orders (
  payment_id uuid not null references public.order_payments (id) on delete cascade,
  order_id uuid not null,
  restaurant_id uuid not null,

  -- This order's share of the payment: its own total, frozen here for the
  -- same reason order_payments.amount is frozen — what was charged must
  -- never be re-derived from something that could since have changed.
  amount numeric(10, 2) not null,

  primary key (payment_id, order_id),

  constraint payment_orders_order_same_restaurant
    foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id)
    on delete cascade,

  constraint payment_orders_amount_non_negative check (amount >= 0)
);

comment on table public.payment_orders is
  'Which orders a payment settles. The single source of truth for order coverage — one payment may cover many orders (a tab). See docs/security.md#payments.';

create index payment_orders_order_id_idx on public.payment_orders (order_id);
create index payment_orders_restaurant_id_idx on public.payment_orders (restaurant_id);

-- Backfill before anything starts depending on the new shape.
insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
select p.id, p.order_id, p.restaurant_id, p.amount
from public.order_payments p
where p.order_id is not null;

alter table public.payment_orders enable row level security;

-- Same visibility rule as the payment itself: the diner whose order it is,
-- or any staff member at that restaurant. Read-only for both.
create policy "payment_orders_select_own_or_staff"
  on public.payment_orders
  for select
  to authenticated
  using (
    public.order_belongs_to_caller(order_id)
    or public.is_restaurant_member(restaurant_id)
  );


-- The order_payments RLS policy referenced order_id, so it must be
-- replaced before the column can go.
drop policy "order_payments_select_own_or_staff" on public.order_payments;

create policy "order_payments_select_own_or_staff"
  on public.order_payments
  for select
  to authenticated
  using (
    public.is_restaurant_member(restaurant_id)
    or exists (
      select 1
      from public.payment_orders po
      where po.payment_id = order_payments.id
        and public.order_belongs_to_caller(po.order_id)
    )
  );

drop index public.order_payments_one_succeeded_per_order;
alter table public.order_payments drop column order_id;


-- Re-implementation of "at most one succeeded payment per order".
--
-- Fires when a payment becomes succeeded. Locks every order it covers, so
-- a concurrent settlement of an overlapping payment waits rather than
-- racing, then refuses if any of those orders is already settled by a
-- different payment.
create function public.enforce_one_succeeded_payment_per_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict uuid;
begin
  if NEW.status <> 'succeeded' or OLD.status = 'succeeded' then
    return NEW;
  end if;

  -- Lock the covered orders. Any competing settlement touching the same
  -- orders blocks here until this transaction commits or rolls back.
  perform 1
  from public.orders o
  where o.id in (
    select po.order_id from public.payment_orders po where po.payment_id = NEW.id
  )
  for update;

  select po_other.order_id into v_conflict
  from public.payment_orders po_mine
  join public.payment_orders po_other
    on po_other.order_id = po_mine.order_id
   and po_other.payment_id <> po_mine.payment_id
  join public.order_payments p_other
    on p_other.id = po_other.payment_id
   and p_other.status = 'succeeded'
  where po_mine.payment_id = NEW.id
  limit 1;

  if v_conflict is not null then
    raise exception 'PAYMENT_ORDER_ALREADY_SETTLED: order % already has a succeeded payment', v_conflict
      using errcode = '23505';
  end if;

  return NEW;
end;
$$;

comment on function public.enforce_one_succeeded_payment_per_order() is
  'Replaces phase 2''s partial unique index now that order coverage lives in payment_orders. Locks the covered orders before checking, so concurrent settlements serialise rather than both succeeding.';

create trigger trg_order_payments_one_succeeded_per_order
  before update on public.order_payments
  for each row
  execute function public.enforce_one_succeeded_payment_per_order();


-- start_order_payment(), rebuilt on the join table. Behaviour is otherwise
-- unchanged from 20260901200000: derive the amount from the order, reuse a
-- pending payment rather than opening a second chargeable session.
create or replace function public.start_order_payment(
  p_order_id uuid,
  p_tip_amount numeric default 0
)
returns table (
  payment_id uuid,
  amount numeric,
  tip_amount numeric,
  total_amount numeric,
  currency text,
  stripe_account_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_settings public.restaurant_settings%rowtype;
  v_account public.restaurant_payment_accounts%rowtype;
  v_payment_id uuid;
  v_existing public.order_payments%rowtype;
begin
  if p_tip_amount is null or p_tip_amount < 0 then
    raise exception 'Tip cannot be negative' using errcode = '22023';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'PAYMENT_ORDER_NOT_FOUND: no such order' using errcode = 'P0002';
  end if;

  if not public.order_belongs_to_caller(p_order_id) then
    raise exception 'PAYMENT_NOT_YOUR_ORDER: order belongs to another session' using errcode = '42501';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'PAYMENT_ORDER_CANCELLED: order was cancelled' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.payment_orders po
    join public.order_payments p on p.id = po.payment_id
    where po.order_id = p_order_id and p.status = 'succeeded'
  ) then
    raise exception 'PAYMENT_ALREADY_PAID: order already has a succeeded payment' using errcode = '23505';
  end if;

  select * into v_settings
  from public.restaurant_settings s
  where s.restaurant_id = v_order.restaurant_id;

  if not found or not v_settings.accept_card then
    raise exception 'PAYMENT_CARD_NOT_ACCEPTED: restaurant does not accept card' using errcode = '22023';
  end if;

  if not v_settings.tipping_enabled and p_tip_amount > 0 then
    raise exception 'PAYMENT_TIPPING_DISABLED: restaurant has tipping switched off' using errcode = '22023';
  end if;

  select * into v_account
  from public.restaurant_payment_accounts a
  where a.restaurant_id = v_order.restaurant_id;

  if not found or not v_account.charges_enabled then
    raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
  end if;

  -- Reuse a payment already in flight (see 20260901200000 for why).
  select p.* into v_existing
  from public.order_payments p
  join public.payment_orders po on po.payment_id = p.id
  where po.order_id = p_order_id
    and p.status = 'pending'
  order by p.created_at
  limit 1;

  if found then
    if v_existing.tip_amount <> p_tip_amount then
      raise exception 'PAYMENT_IN_PROGRESS: a payment for this order is already open with a different tip'
        using errcode = '22023';
    end if;

    return query
      select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
             v_account.stripe_account_id
      from public.order_payments p
      where p.id = v_existing.id;
    return;
  end if;

  insert into public.order_payments (
    restaurant_id, status, method, amount, tip_amount, currency
  ) values (
    v_order.restaurant_id, 'pending', 'card',
    v_order.total, p_tip_amount, v_order.currency
  )
  returning id into v_payment_id;

  insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
  values (v_payment_id, p_order_id, v_order.restaurant_id, v_order.total);

  return query
    select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
           v_account.stripe_account_id
    from public.order_payments p
    where p.id = v_payment_id;
end;
$$;

revoke execute on function public.start_order_payment(uuid, numeric) from public;
grant execute on function public.start_order_payment(uuid, numeric) to authenticated;


-- Pay a whole tab: every unpaid, uncancelled order in the caller's own
-- session, settled by one charge.
--
-- The amount is the sum of those orders' totals, computed here. As with a
-- single order, nothing about the price comes from the caller.
create function public.start_tab_payment(
  p_tip_amount numeric default 0
)
returns table (
  payment_id uuid,
  amount numeric,
  tip_amount numeric,
  total_amount numeric,
  currency text,
  stripe_account_id text,
  order_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions%rowtype;
  v_settings public.restaurant_settings%rowtype;
  v_account public.restaurant_payment_accounts%rowtype;
  v_total numeric(10, 2);
  v_currency text;
  v_count integer;
  v_payment_id uuid;
  v_existing public.order_payments%rowtype;
begin
  if p_tip_amount is null or p_tip_amount < 0 then
    raise exception 'Tip cannot be negative' using errcode = '22023';
  end if;

  -- The caller's own session is derived from auth.uid(), never passed in:
  -- a session id parameter would be a way to pay — or read the total of —
  -- someone else's table.
  select * into v_session
  from public.customer_sessions cs
  where cs.user_id = auth.uid();

  if not found then
    raise exception 'PAYMENT_NO_SESSION: no active session for this diner' using errcode = 'P0002';
  end if;

  select * into v_settings
  from public.restaurant_settings s
  where s.restaurant_id = v_session.restaurant_id;

  if not found or not v_settings.accept_card then
    raise exception 'PAYMENT_CARD_NOT_ACCEPTED: restaurant does not accept card' using errcode = '22023';
  end if;

  if not v_settings.tipping_enabled and p_tip_amount > 0 then
    raise exception 'PAYMENT_TIPPING_DISABLED: restaurant has tipping switched off' using errcode = '22023';
  end if;

  select * into v_account
  from public.restaurant_payment_accounts a
  where a.restaurant_id = v_session.restaurant_id;

  if not found or not v_account.charges_enabled then
    raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
  end if;

  -- Reuse a tab payment already in flight, for the same reason a
  -- single-order one is reused: a second Checkout session is a second
  -- charge. A tab payment is recognised by covering more than one order,
  -- or by being the only pending payment in this session.
  select p.* into v_existing
  from public.order_payments p
  where p.restaurant_id = v_session.restaurant_id
    and p.status = 'pending'
    and exists (
      select 1
      from public.payment_orders po
      join public.orders o on o.id = po.order_id
      where po.payment_id = p.id and o.customer_session_id = v_session.id
    )
  order by p.created_at
  limit 1;

  if found then
    if v_existing.tip_amount <> p_tip_amount then
      raise exception 'PAYMENT_IN_PROGRESS: a payment for this tab is already open with a different tip'
        using errcode = '22023';
    end if;

    return query
      select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
             v_account.stripe_account_id,
             (select count(*)::integer from public.payment_orders po where po.payment_id = p.id)
      from public.order_payments p
      where p.id = v_existing.id;
    return;
  end if;

  -- Everything still owed on this tab.
  create temporary table if not exists tab_orders_tmp (
    id uuid, total numeric(10, 2), currency text
  ) on commit drop;
  delete from tab_orders_tmp;

  insert into tab_orders_tmp (id, total, currency)
  select o.id, o.total, o.currency
  from public.orders o
  where o.customer_session_id = v_session.id
    and o.status <> 'cancelled'
    and not exists (
      select 1
      from public.payment_orders po
      join public.order_payments p on p.id = po.payment_id
      where po.order_id = o.id and p.status = 'succeeded'
    );

  select count(*), coalesce(sum(t.total), 0), min(t.currency)
  into v_count, v_total, v_currency
  from tab_orders_tmp t;

  if v_count = 0 then
    raise exception 'PAYMENT_NOTHING_TO_PAY: this tab has no unpaid orders' using errcode = '22023';
  end if;

  -- Orders freeze their currency individually, so a session could in
  -- principle hold two currencies if the restaurant changed its own
  -- between orders. One Stripe charge cannot span currencies; refusing is
  -- honest, and paying order by order still works.
  if exists (select 1 from tab_orders_tmp t where t.currency <> v_currency) then
    raise exception 'PAYMENT_MIXED_CURRENCY: this tab mixes currencies and must be paid per order'
      using errcode = '22023';
  end if;

  insert into public.order_payments (
    restaurant_id, status, method, amount, tip_amount, currency
  ) values (
    v_session.restaurant_id, 'pending', 'card', v_total, p_tip_amount, v_currency
  )
  returning id into v_payment_id;

  insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
  select v_payment_id, t.id, v_session.restaurant_id, t.total
  from tab_orders_tmp t;

  return query
    select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
           v_account.stripe_account_id, v_count
    from public.order_payments p
    where p.id = v_payment_id;
end;
$$;

comment on function public.start_tab_payment(numeric) is
  'Creates — or reuses — one pending card payment covering every unpaid order in the caller''s own session. Derives the session from auth.uid() and the amount from those orders, never from the caller. See docs/security.md#payments.';

revoke execute on function public.start_tab_payment(numeric) from public;
grant execute on function public.start_tab_payment(numeric) to authenticated;


-- attach_payment_checkout_session() authorised its caller by reading
-- order_payments.order_id, which no longer exists. Coverage now comes from
-- payment_orders, and for a tab that is several orders — the caller must
-- own ALL of them, not merely one. Owning one and being handed the rest
-- would let a diner attach their own Stripe session to a payment covering
-- a neighbouring table's orders.
create or replace function public.attach_payment_checkout_session(
  p_payment_id uuid,
  p_checkout_session_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing text;
  v_status text;
  v_covered integer;
  v_mine integer;
begin
  select count(*) into v_covered
  from public.payment_orders po
  where po.payment_id = p_payment_id;

  select count(*) into v_mine
  from public.payment_orders po
  where po.payment_id = p_payment_id
    and public.order_belongs_to_caller(po.order_id);

  if v_covered = 0 or v_mine <> v_covered then
    raise exception 'PAYMENT_NOT_YOUR_ORDER: order belongs to another session' using errcode = '42501';
  end if;

  select stripe_checkout_session_id, status into v_existing, v_status
  from public.order_payments
  where id = p_payment_id;

  if not found then
    raise exception 'PAYMENT_NOT_PENDING: no such payment' using errcode = '22023';
  end if;

  -- Idempotent no-op: this exact session is already linked (see
  -- 20260901200000 — payment reuse re-runs the whole action).
  if v_existing is not null and v_existing = p_checkout_session_id then
    return;
  end if;

  if v_status <> 'pending' or v_existing is not null then
    raise exception 'PAYMENT_NOT_PENDING: payment is not pending or already has a different session'
      using errcode = '22023';
  end if;

  update public.order_payments
  set stripe_checkout_session_id = p_checkout_session_id
  where id = p_payment_id;
end;
$$;

revoke execute on function public.attach_payment_checkout_session(uuid, text) from public;
grant execute on function public.attach_payment_checkout_session(uuid, text) to authenticated;
