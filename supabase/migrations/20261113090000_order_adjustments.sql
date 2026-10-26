-- Settle up, first batch: voids, comps and discounts, applied by an owner
-- or manager before a table pays.
--
-- WHERE THE MONEY CHANGES
--
-- Every way of paying (cash, card machine, Square Terminal, Tap to Pay, a
-- diner's phone, a split) freezes each order's `orders.total` into
-- payment_orders when the payment starts. So an adjustment lowers the
-- order's stored total, and every one of those paths charges the new
-- amount without being touched. The alternative — leaving the total alone
-- and teaching each payment function to subtract — would mean a dozen
-- functions that each have to remember, and one that forgets overcharges.
--
--   orders.subtotal        stays the sum of the dishes as ordered
--   orders.discount_total  everything taken off before tax (new)
--   orders.tax / service_charge
--                          rescaled to what's left, from the amounts the
--                          order was created with (base_tax,
--                          base_service_charge, kept on first adjustment
--                          so a later change of tax rate never leaks in)
--   orders.total           subtotal - discount_total + tax + service_charge
--
-- The totals stay locked against every other writer:
-- enforce_order_immutable_fields() lets them change only inside
-- recalculate_order_totals(), which marks its own update with a
-- transaction-local setting, and checks the sum still adds up.
--
-- WHAT CAN'T BE ADJUSTED
--
-- An order a payment is already taking money for (pending) or has taken
-- money for (succeeded), and an order frozen in an open split: their
-- amounts are fixed elsewhere, and changing the order underneath would
-- make them disagree. Cancelled orders, too.
--
-- NOTHING LEFT TO PAY
--
-- An order brought to zero (everything comped, or written off after a
-- walkout) is settled with a $0 payment, method 'comp', so every screen
-- that asks "is this paid?" — Settle up, a diner's pay button, the
-- payment functions — already answers yes without being changed. Undoing
-- an adjustment reverses that payment. Takings reports leave comp
-- payments out; the payment history still lists them.

-- ---------------------------------------------------------------------------
-- Orders: what was taken off, and the tax it started with
-- ---------------------------------------------------------------------------

alter table public.orders
  add column discount_total numeric(10, 2) not null default 0,
  add column base_tax numeric(10, 2),
  add column base_service_charge numeric(10, 2),
  add constraint orders_discount_total_valid
    check (discount_total >= 0 and discount_total <= subtotal);

comment on column public.orders.discount_total is
  'Voids, comps and discounts taken off before tax (order_adjustments). Written only by recalculate_order_totals().';
comment on column public.orders.base_tax is
  'The tax the order was created with, kept when it is first adjusted so tax is always rescaled from the original. Null until then.';
comment on column public.orders.base_service_charge is
  'The service charge the order was created with; see base_tax.';

create or replace function public.enforce_order_immutable_fields()
returns trigger
language plpgsql
as $$
declare
  v_recalculating boolean :=
    coalesce(current_setting('tableside.recalculating_order', true), '') = old.id::text;
begin
  if new.subtotal <> old.subtotal
    or (not v_recalculating and (
      new.tax <> old.tax
      or new.service_charge <> old.service_charge
      or new.total <> old.total
      or new.discount_total <> old.discount_total
      or new.base_tax is distinct from old.base_tax
      or new.base_service_charge is distinct from old.base_service_charge
    ))
    or new.currency <> old.currency
    or new.restaurant_id <> old.restaurant_id
    or new.table_id <> old.table_id
    or new.customer_session_id is distinct from old.customer_session_id
    or new.order_number <> old.order_number
    or new.idempotency_key <> old.idempotency_key
    or new.fulfillment <> old.fulfillment
    or new.pickup_name is distinct from old.pickup_name
    or new.source <> old.source
    or new.placed_by is distinct from old.placed_by
  then
    raise exception 'orders: financial and identity fields are immutable after creation';
  end if;
  if v_recalculating
    and new.total <> new.subtotal - new.discount_total + new.tax + new.service_charge then
    raise exception 'orders: total must equal subtotal - discounts + tax + service charge';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Comp payments
-- ---------------------------------------------------------------------------

alter table public.order_payments
  drop constraint order_payments_method_valid,
  add constraint order_payments_method_valid check (
    method in ('card', 'cash', 'card_terminal', 'comp')
  ),
  add constraint order_payments_comp_is_free check (
    method <> 'comp' or (amount = 0 and tip_amount = 0)
  );

-- ---------------------------------------------------------------------------
-- order_adjustments
-- ---------------------------------------------------------------------------

create table public.order_adjustments (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  order_id uuid not null,
  -- A void or comp is of some units of one dish; a discount is of the order.
  order_item_id uuid references public.order_items (id) on delete cascade,
  kind text not null,
  quantity integer,
  -- A percentage discount keeps what it was, for the record; `amount` is
  -- what it came to when applied, and is what's taken off.
  percent numeric(5, 2),
  amount numeric(10, 2) not null,
  reason text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Undone adjustments stay, for the record.
  removed_at timestamptz,
  removed_by uuid references auth.users (id) on delete set null,

  constraint order_adjustments_order_same_restaurant
    foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete cascade,
  constraint order_adjustments_kind_valid check (kind in ('void', 'comp', 'discount')),
  constraint order_adjustments_item_shape check (
    (kind in ('void', 'comp') and order_item_id is not null and quantity > 0 and percent is null)
    or (kind = 'discount' and order_item_id is null and quantity is null)
  ),
  constraint order_adjustments_percent_range check (percent is null or (percent > 0 and percent <= 100)),
  constraint order_adjustments_amount_positive check (amount > 0),
  constraint order_adjustments_reason_length check (char_length(btrim(reason)) between 1 and 200),
  constraint order_adjustments_removed_by_needs_removed_at check (removed_by is null or removed_at is not null)
);

comment on table public.order_adjustments is
  'Voids, comps and discounts on an order, applied by an owner or manager on Settle up. Written only by adjust_order() / remove_order_adjustment().';

create index order_adjustments_order_id_idx on public.order_adjustments (order_id);
create index order_adjustments_restaurant_id_idx on public.order_adjustments (restaurant_id, created_at);

alter table public.order_adjustments enable row level security;

-- Staff see why a bill is lower; nobody writes here directly.
create policy "order_adjustments_select_staff"
  on public.order_adjustments
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- ---------------------------------------------------------------------------
-- recalculate_order_totals: the only writer of an order's money columns
-- ---------------------------------------------------------------------------

create function public.recalculate_order_totals(p_order_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_base_tax numeric(10, 2);
  v_base_service numeric(10, 2);
  v_discount numeric(10, 2);
  v_net numeric(10, 2);
  v_tax numeric(10, 2);
  v_service numeric(10, 2);
  v_total numeric(10, 2);
  v_comp_payment uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;

  v_base_tax := coalesce(v_order.base_tax, v_order.tax);
  v_base_service := coalesce(v_order.base_service_charge, v_order.service_charge);

  select coalesce(sum(a.amount), 0) into v_discount
  from public.order_adjustments a
  where a.order_id = p_order_id and a.removed_at is null;

  v_net := v_order.subtotal - v_discount;
  if v_order.subtotal > 0 then
    v_tax := round(v_base_tax * v_net / v_order.subtotal, 2);
    v_service := round(v_base_service * v_net / v_order.subtotal, 2);
  else
    v_tax := v_base_tax;
    v_service := v_base_service;
  end if;
  v_total := v_net + v_tax + v_service;

  perform set_config('tableside.recalculating_order', p_order_id::text, true);
  update public.orders
  set discount_total = v_discount,
      base_tax = v_base_tax,
      base_service_charge = v_base_service,
      tax = v_tax,
      service_charge = v_service,
      total = v_total
  where id = p_order_id;
  perform set_config('tableside.recalculating_order', '', true);

  select p.id into v_comp_payment
  from public.payment_orders po
  join public.order_payments p on p.id = po.payment_id
  where po.order_id = p_order_id and p.method = 'comp' and p.status = 'succeeded';

  if v_total = 0 and v_comp_payment is null then
    insert into public.order_payments (
      restaurant_id, status, method, amount, tip_amount, currency, paid_at, recorded_by
    ) values (
      v_order.restaurant_id, 'succeeded', 'comp', 0, 0, v_order.currency, now(), auth.uid()
    )
    returning id into v_comp_payment;
    insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
    values (v_comp_payment, p_order_id, v_order.restaurant_id, 0);
  elsif v_total > 0 and v_comp_payment is not null then
    update public.order_payments
    set status = 'reversed',
        reversed_at = now(),
        reversed_by = auth.uid(),
        reversal_reason = 'Adjustment undone'
    where id = v_comp_payment;
  end if;

  return v_total;
end;
$$;

revoke execute on function public.recalculate_order_totals(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The checks adjust_order() and remove_order_adjustment() share
-- ---------------------------------------------------------------------------

create function public.assert_order_adjustable(p_order public.orders)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.current_restaurant_role(p_order.restaurant_id), '') not in ('owner', 'manager') then
    raise exception 'ADJUST_FORBIDDEN: only an owner or manager can change a bill'
      using errcode = '42501';
  end if;
  if p_order.status = 'cancelled' then
    raise exception 'ADJUST_CANCELLED: that order was cancelled' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.payment_orders po
    join public.order_payments p on p.id = po.payment_id
    where po.order_id = p_order.id
      and p.method <> 'comp'
      and p.status in ('pending', 'succeeded')
  ) then
    raise exception 'ADJUST_PAYMENT_STARTED: a payment for this order has started or finished; finish or cancel it first'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.tab_split_orders so
    join public.tab_splits s on s.id = so.split_id
    where so.order_id = p_order.id and so.active and s.status = 'open'
  ) then
    raise exception 'ADJUST_SPLIT_OPEN: the guests are splitting this bill; cancel the split first'
      using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.assert_order_adjustable(public.orders) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- adjust_order
-- ---------------------------------------------------------------------------

create function public.adjust_order(
  p_order_id uuid,
  p_kind text,
  p_reason text,
  p_order_item_id uuid default null,
  p_quantity integer default null,
  p_percent numeric default null,
  p_amount numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_left integer;
  v_remaining numeric(10, 2);
  v_amount numeric(10, 2);
  v_id uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ADJUST_NOT_FOUND: that order was not found' using errcode = 'P0002';
  end if;
  perform public.assert_order_adjustable(v_order);

  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 200 then
    raise exception 'ADJUST_INVALID: give a reason' using errcode = '22023';
  end if;

  if p_kind in ('void', 'comp') then
    select * into v_item from public.order_items
    where id = p_order_item_id and order_id = p_order_id;
    if not found then
      raise exception 'ADJUST_INVALID: that dish is not on this order' using errcode = '22023';
    end if;
    select v_item.quantity - coalesce(sum(a.quantity), 0) into v_left
    from public.order_adjustments a
    where a.order_item_id = v_item.id and a.removed_at is null;
    if p_quantity is null or p_quantity < 1 or p_quantity > v_left then
      raise exception 'ADJUST_INVALID: only % of that dish left to change', v_left
        using errcode = '22023';
    end if;
    v_amount := (v_item.unit_price + v_item.modifier_total) * p_quantity;
  elsif p_kind = 'discount' then
    v_remaining := v_order.subtotal - v_order.discount_total;
    if (p_percent is null) = (p_amount is null) then
      raise exception 'ADJUST_INVALID: give a percentage or an amount' using errcode = '22023';
    end if;
    if p_percent is not null then
      if p_percent <= 0 or p_percent > 100 then
        raise exception 'ADJUST_INVALID: a percentage is between 0 and 100' using errcode = '22023';
      end if;
      v_amount := round(v_remaining * p_percent / 100, 2);
    else
      v_amount := round(p_amount, 2);
    end if;
    if v_amount <= 0 or v_amount > v_remaining then
      raise exception 'ADJUST_INVALID: a discount can be at most what is left on the order'
        using errcode = '22023';
    end if;
  else
    raise exception 'ADJUST_INVALID: unknown kind of change' using errcode = '22023';
  end if;

  insert into public.order_adjustments (
    restaurant_id, order_id, order_item_id, kind, quantity, percent, amount, reason, created_by
  ) values (
    v_order.restaurant_id, p_order_id,
    case when p_kind = 'discount' then null else p_order_item_id end,
    p_kind,
    case when p_kind = 'discount' then null else p_quantity end,
    case when p_kind = 'discount' then p_percent end,
    v_amount, btrim(p_reason), auth.uid()
  )
  returning id into v_id;

  perform public.recalculate_order_totals(p_order_id);
  return v_id;
end;
$$;

revoke execute on function public.adjust_order(uuid, text, text, uuid, integer, numeric, numeric) from public, anon;
grant execute on function public.adjust_order(uuid, text, text, uuid, integer, numeric, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- remove_order_adjustment
-- ---------------------------------------------------------------------------

create function public.remove_order_adjustment(p_adjustment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_adjustment public.order_adjustments%rowtype;
  v_order public.orders%rowtype;
begin
  select * into v_adjustment from public.order_adjustments where id = p_adjustment_id;
  if not found then
    raise exception 'ADJUST_NOT_FOUND: that change was not found' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders where id = v_adjustment.order_id for update;
  perform public.assert_order_adjustable(v_order);
  if v_adjustment.removed_at is not null then
    return;
  end if;

  update public.order_adjustments
  set removed_at = now(), removed_by = auth.uid()
  where id = p_adjustment_id;

  perform public.recalculate_order_totals(v_order.id);
end;
$$;

revoke execute on function public.remove_order_adjustment(uuid) from public, anon;
grant execute on function public.remove_order_adjustment(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- settle_up_orders: what Settle up lists
--
-- The restaurant's orders since p_since that no succeeded payment covers
-- (a comp payment included), the same definition every payment function
-- uses. A function rather than two client queries so a month of orders
-- isn't sent back and forth only to throw the paid ones away. Runs as the
-- caller: the orders policy is what limits it to a member's restaurant.
-- ---------------------------------------------------------------------------

create function public.settle_up_orders(p_restaurant_id uuid, p_since timestamptz)
returns table (
  id uuid,
  order_number bigint,
  status text,
  total numeric,
  discount_total numeric,
  currency text,
  table_id uuid,
  customer_session_id uuid,
  pickup_at timestamptz,
  pickup_name text,
  created_at timestamptz
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return query
    select o.id, o.order_number, o.status, o.total, o.discount_total, o.currency,
           o.table_id, o.customer_session_id, o.pickup_at, o.pickup_name, o.created_at
    from public.orders o
    where o.restaurant_id = p_restaurant_id
      and public.is_restaurant_member(p_restaurant_id)
      and o.status <> 'cancelled'
      and o.created_at > p_since
      and not exists (
        select 1
        from public.payment_orders po
        join public.order_payments p on p.id = po.payment_id
        where po.order_id = o.id and p.status = 'succeeded'
      )
    order by o.created_at
    limit 500;
end;
$$;

revoke execute on function public.settle_up_orders(uuid, timestamptz) from public, anon;
grant execute on function public.settle_up_orders(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Square's itemised bill: voided units left out, comped units at no
-- charge, order discounts carried separately so Square shows them as a
-- discount rather than folding them into "Tax & charges".
-- ---------------------------------------------------------------------------

drop function public.payment_bill_lines(uuid);

create function public.payment_bill_lines(p_payment_id uuid)
returns table (
  order_id uuid,
  item_name text,
  options text,
  quantity integer,
  unit_amount numeric,
  line_total numeric,
  order_total numeric,
  order_discount numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_covered integer;
  v_mine integer;
  v_restaurant_id uuid;
begin
  select count(*), count(*) filter (where public.order_belongs_to_caller(po.order_id))
  into v_covered, v_mine
  from public.payment_orders po
  where po.payment_id = p_payment_id;

  select restaurant_id into v_restaurant_id
  from public.order_payments where id = p_payment_id;

  if v_covered = 0
     or (v_mine <> v_covered and not public.is_restaurant_member(v_restaurant_id)) then
    raise exception 'PAYMENT_NOT_YOUR_ORDER: order belongs to another session' using errcode = '42501';
  end if;

  return query
    with items as (
      select
        oi.order_id,
        oi.item_name,
        (
          select string_agg(m.modifier_option_name, ', ' order by m.created_at)
          from public.order_item_modifiers m
          where m.order_item_id = oi.id
        ) as options,
        oi.quantity,
        oi.unit_price + oi.modifier_total as unit_amount,
        coalesce((
          select sum(a.quantity) from public.order_adjustments a
          where a.order_item_id = oi.id and a.kind = 'void' and a.removed_at is null
        ), 0)::integer as voided,
        coalesce((
          select sum(a.quantity) from public.order_adjustments a
          where a.order_item_id = oi.id and a.kind = 'comp' and a.removed_at is null
        ), 0)::integer as comped,
        o.total as order_total,
        coalesce((
          select sum(a.amount) from public.order_adjustments a
          where a.order_id = o.id and a.kind = 'discount' and a.removed_at is null
        ), 0) as order_discount,
        o.created_at as order_created_at,
        oi.created_at as item_created_at
      from public.payment_orders po
      join public.orders o on o.id = po.order_id
      join public.order_items oi on oi.order_id = o.id
      where po.payment_id = p_payment_id
    ),
    lines as (
      select i.order_id, i.item_name, i.options, i.quantity - i.voided - i.comped as quantity,
             i.unit_amount, i.order_total, i.order_discount, i.order_created_at, i.item_created_at, 0 as part
      from items i
      union all
      select i.order_id, i.item_name || ' (comped)', i.options, i.comped,
             0::numeric(10, 2), i.order_total, i.order_discount, i.order_created_at, i.item_created_at, 1
      from items i
    )
    select l.order_id, l.item_name, l.options, l.quantity, l.unit_amount,
           l.unit_amount * l.quantity, l.order_total, l.order_discount
    from lines l
    where l.quantity > 0
    order by l.order_created_at, l.item_created_at, l.part;
end;
$$;

revoke execute on function public.payment_bill_lines(uuid) from public, anon;
grant execute on function public.payment_bill_lines(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comp payments print nothing and open no drawer
-- ---------------------------------------------------------------------------

create or replace function public.queue_payment_prints()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status <> 'succeeded'
    or new.method = 'comp'
    or (tg_op = 'UPDATE' and old.status = 'succeeded') then
    return new;
  end if;
  begin
    insert into public.print_jobs (restaurant_id, printer_id, kind, payment_id, open_drawer)
    select new.restaurant_id, p.id,
           case when p.auto_print then 'receipt' else 'drawer' end,
           case when p.auto_print then new.id end,
           new.method = 'cash' and p.opens_drawer
    from public.printers p
    where p.restaurant_id = new.restaurant_id
      and p.role = 'receipt'
      and p.is_active
      and (p.auto_print or (new.method = 'cash' and p.opens_drawer));
  exception when others then
    raise warning 'queue_payment_prints: %', sqlerrm;
  end;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settle up refreshes when a payment lands (the orders table is already
-- published, 20260824090300_orders_realtime.sql). Same guard as there: the test harness has no
-- realtime publication.
-- ---------------------------------------------------------------------------

alter table public.order_payments replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'order_payments'
    ) then
      alter publication supabase_realtime add table public.order_payments;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Takings leave comp payments out: they took no money, and counting them
-- would lower the average order. get_payment_history still lists them.
-- Bodies as in 20260902140000_reporting.sql, plus that one filter.
-- ---------------------------------------------------------------------------

create or replace function public.get_takings_summary(
  target_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  gross numeric,
  refunded numeric,
  refunds_pending numeric,
  net numeric,
  tips numeric,
  payment_count integer,
  order_count integer,
  average_order_value numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_can_view_reports(target_restaurant_id);

  -- Written as scalar subqueries over a FROM-less SELECT so exactly one
  -- row always comes back. An aggregate with GROUP BY returns NO rows over
  -- an empty set, which would mean a restaurant with no takings got
  -- nothing at all rather than zeros — indistinguishable, to the page,
  -- from a failure.
  return query
  with settled as (
    select p.id, p.amount, p.tip_amount, p.total_amount
    from public.order_payments p
    where p.restaurant_id = target_restaurant_id
      and p.status = 'succeeded'
      and p.method <> 'comp'
      and p.paid_at >= p_from
      and p.paid_at < p_to
  ),
  refunds as (
    select
      coalesce(sum(r.amount) filter (where r.status = 'succeeded'), 0) as settled_refunds,
      coalesce(sum(r.amount) filter (where r.status = 'pending'), 0) as pending_refunds
    from public.payment_refunds r
    join settled s on s.id = r.payment_id
  ),
  covered as (
    -- Distinct because one payment may cover several orders (a tab), and
    -- one order must never be counted twice.
    select count(distinct po.order_id) as orders
    from public.payment_orders po
    join settled s on s.id = po.payment_id
  )
  select
    coalesce((select sum(x.total_amount) from settled x), 0)::numeric,
    (select rf.settled_refunds from refunds rf)::numeric,
    (select rf.pending_refunds from refunds rf)::numeric,
    (coalesce((select sum(x.total_amount) from settled x), 0)
      - (select rf.settled_refunds from refunds rf))::numeric,
    coalesce((select sum(x.tip_amount) from settled x), 0)::numeric,
    (select count(*) from settled)::integer,
    (select cv.orders from covered cv)::integer,
    case
      when (select cv.orders from covered cv) > 0
        then round(
          coalesce((select sum(x.amount) from settled x), 0)
            / (select cv.orders from covered cv), 2)
      else 0
    end::numeric;
end;
$$;

create or replace function public.get_takings_by_method(
  target_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  method text,
  payment_count integer,
  gross numeric,
  refunded numeric,
  net numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_can_view_reports(target_restaurant_id);

  return query
  select
    p.method,
    count(*)::integer,
    coalesce(sum(p.total_amount), 0)::numeric,
    coalesce(sum(
      (select coalesce(sum(r.amount), 0)
       from public.payment_refunds r
       where r.payment_id = p.id and r.status = 'succeeded')
    ), 0)::numeric,
    (coalesce(sum(p.total_amount), 0) - coalesce(sum(
      (select coalesce(sum(r.amount), 0)
       from public.payment_refunds r
       where r.payment_id = p.id and r.status = 'succeeded')
    ), 0))::numeric
  from public.order_payments p
  where p.restaurant_id = target_restaurant_id
    and p.status = 'succeeded'
    and p.method <> 'comp'
    and p.paid_at >= p_from
    and p.paid_at < p_to
  group by p.method
  order by p.method;
end;
$$;
