-- Square, phase 3: in person. Staff take cards on a Square Terminal, and
-- cash recorded in Tableside is sent to Square as a cash sale, so every way
-- a Square restaurant gets paid lands in Square.
--
-- Same rules as every card payment so far:
--   * the amount comes from the orders, never from the staff member;
--   * nothing is marked paid on anyone's say-so: the server reads the
--     payment back from Square (as Tap to Pay reads Stripe), and the
--     webhook settles as a backstop, both through a service-role function;
--   * one succeeded payment per order (the existing trigger).
-- What's new is the tip: on a Terminal the diner adds it on the device, so
-- Tableside learns it from Square's payment rather than asking first.

-- ── What the connection was granted ──────────────────────────────────
-- Pairing a Terminal needs DEVICE_CREDENTIAL_MANAGEMENT, which phase 1
-- didn't ask for. Recording the granted scopes lets the settings page say
-- "reconnect to pair a Terminal" instead of failing at Square.
alter table public.pos_credentials add column scopes text;

comment on column public.pos_credentials.scopes is
  'Space-separated OAuth scopes requested when this connection was made. NULL for connections older than 20261111090000.';

-- ── Terminals ─────────────────────────────────────────────────────────

create table public.pos_devices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  provider text not null default 'square',
  name text not null,
  -- While pairing: Square's device code object and the code typed on the
  -- Terminal. Kept afterwards only for the record.
  device_code_id text,
  pairing_code text,
  pair_by timestamptz,
  -- Once paired: what checkouts are sent to.
  device_id text,
  status text not null default 'pairing',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pos_devices_status_valid check (status in ('pairing', 'paired', 'removed')),
  constraint pos_devices_name_not_blank check (length(trim(name)) > 0),
  constraint pos_devices_paired_has_device check (status <> 'paired' or device_id is not null)
);

comment on table public.pos_devices is
  'Card readers paired with a restaurant''s POS (Square Terminal). Staff read them to send a bill; owners and managers pair and remove them.';

create unique index pos_devices_device_per_restaurant
  on public.pos_devices (restaurant_id, device_id)
  where device_id is not null and status = 'paired';
create index pos_devices_restaurant_idx on public.pos_devices (restaurant_id);

create trigger trg_pos_devices_set_updated_at
  before update on public.pos_devices
  for each row execute function public.set_updated_at();

alter table public.pos_devices enable row level security;

-- Front of house needs to see which Terminals exist to send a bill to one.
create policy "pos_devices_select_members"
  on public.pos_devices for select to authenticated
  using (public.is_restaurant_member(restaurant_id));
create policy "pos_devices_insert_owner_manager"
  on public.pos_devices for insert to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));
create policy "pos_devices_update_owner_manager"
  on public.pos_devices for update to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));
-- No DELETE: removing is status = 'removed', which keeps the history.

-- ── Square's side of an in-person payment ─────────────────────────────

alter table public.order_payments
  add column square_terminal_checkout_id text,
  -- The diner adds the tip on the Terminal; it's filled in at settlement.
  add column tip_on_device boolean not null default false;

create unique index order_payments_square_terminal_checkout_key
  on public.order_payments (square_terminal_checkout_id)
  where square_terminal_checkout_id is not null;

-- ── Starting a Terminal payment ───────────────────────────────────────
-- The tap_to_pay rules (20261105090000) with Square in place of Stripe:
-- any member may take payment; the restaurant must accept card and take it
-- through Square; the amount is the orders' total; the tip is 0 here and
-- set from Square's payment, because the diner adds it on the device.
create or replace function public.start_square_terminal_payment(p_order_ids uuid[])
returns table (
  payment_id uuid,
  amount numeric,
  total_amount numeric,
  currency text,
  tipping_enabled boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_settings public.restaurant_settings%rowtype;
  v_currency text;
  v_total numeric(10, 2);
  v_count integer;
  v_payment_id uuid;
begin
  if p_order_ids is null or array_length(p_order_ids, 1) is null then
    raise exception 'PAYMENT_NO_ORDERS: no orders given' using errcode = '22023';
  end if;

  select count(distinct o.restaurant_id) into v_count
  from public.orders o where o.id = any(p_order_ids);
  if v_count = 0 then
    raise exception 'PAYMENT_ORDER_NOT_FOUND: no such order' using errcode = 'P0002';
  end if;
  if v_count > 1 then
    raise exception 'PAYMENT_MIXED_RESTAURANTS: orders belong to different restaurants'
      using errcode = '22023';
  end if;

  select o.restaurant_id into v_restaurant_id
  from public.orders o where o.id = any(p_order_ids) limit 1;

  if not public.is_restaurant_member(v_restaurant_id) then
    raise exception 'PAYMENT_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;

  select * into v_settings
  from public.restaurant_settings s where s.restaurant_id = v_restaurant_id;
  if not found or not v_settings.accept_card then
    raise exception 'PAYMENT_CARD_NOT_ACCEPTED: restaurant does not accept card' using errcode = '22023';
  end if;

  if public.restaurant_card_provider(v_restaurant_id) <> 'square' then
    raise exception 'PAYMENT_NOT_SQUARE: this restaurant does not take cards through Square'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.orders o
    where o.id = any(p_order_ids) and o.status = 'cancelled'
  ) then
    raise exception 'PAYMENT_ORDER_CANCELLED: order was cancelled' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.payment_orders po
    join public.order_payments p on p.id = po.payment_id
    where po.order_id = any(p_order_ids) and p.status = 'succeeded'
  ) then
    raise exception 'PAYMENT_ALREADY_PAID: order already has a succeeded payment'
      using errcode = '23505';
  end if;

  select sum(o.total), min(o.currency)
  into v_total, v_currency
  from public.orders o where o.id = any(p_order_ids);
  if exists (
    select 1 from public.orders o
    where o.id = any(p_order_ids) and o.currency <> v_currency
  ) then
    raise exception 'PAYMENT_MIXED_CURRENCY: orders mix currencies' using errcode = '22023';
  end if;

  -- An earlier in-person attempt for the same orders that never finished
  -- (a Terminal that timed out, a Tap to Pay that was abandoned) gives way.
  update public.order_payments p
  set status = 'cancelled'
  where p.status = 'pending'
    and p.card_present
    and p.id in (
      select po.payment_id from public.payment_orders po
      where po.order_id = any(p_order_ids)
    );

  insert into public.order_payments (
    restaurant_id, status, method, card_present, tip_on_device,
    amount, tip_amount, currency, recorded_by
  ) values (
    v_restaurant_id, 'pending', 'card', true, true,
    v_total, 0, v_currency, auth.uid()
  )
  returning id into v_payment_id;

  insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
  select v_payment_id, o.id, v_restaurant_id, o.total
  from public.orders o where o.id = any(p_order_ids);

  return query
    select p.id, p.amount, p.total_amount, p.currency, v_settings.tipping_enabled
    from public.order_payments p
    where p.id = v_payment_id;
end;
$$;

revoke execute on function public.start_square_terminal_payment(uuid[]) from public, anon;
grant execute on function public.start_square_terminal_payment(uuid[]) to authenticated, service_role;

-- ── The bill, for staff too ───────────────────────────────────────────
-- 20261110090000 let a diner read their own bill lines. Staff now need the
-- same lines to put an itemised order on the Terminal (and on a cash sale):
-- a member of the payment's restaurant may read them as well.
create or replace function public.payment_bill_lines(p_payment_id uuid)
returns table (
  order_id uuid,
  item_name text,
  options text,
  quantity integer,
  unit_amount numeric,
  line_total numeric,
  order_total numeric
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
    select
      oi.order_id,
      oi.item_name,
      (
        select string_agg(m.modifier_option_name, ', ' order by m.created_at)
        from public.order_item_modifiers m
        where m.order_item_id = oi.id
      ),
      oi.quantity,
      oi.unit_price + oi.modifier_total,
      oi.line_total,
      o.total
    from public.payment_orders po
    join public.orders o on o.id = po.order_id
    join public.order_items oi on oi.order_id = o.id
    where po.payment_id = p_payment_id
    order by o.created_at, oi.created_at;
end;
$$;

-- ── Recording Square's ids ────────────────────────────────────────────

-- The Terminal checkout a staff member just sent, for a pending in-person
-- payment of their own restaurant.
create or replace function public.attach_square_terminal_checkout(
  p_payment_id uuid,
  p_square_order_id text,
  p_checkout_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
begin
  select * into v_payment from public.order_payments where id = p_payment_id;
  if not found or not public.is_restaurant_member(v_payment.restaurant_id) then
    raise exception 'PAYMENT_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;
  if v_payment.status <> 'pending' or not v_payment.tip_on_device then
    raise exception 'PAYMENT_NOT_PENDING: payment is not a pending Terminal payment'
      using errcode = '22023';
  end if;
  if v_payment.square_terminal_checkout_id is not null
     and v_payment.square_terminal_checkout_id <> p_checkout_id then
    raise exception 'PAYMENT_NOT_PENDING: payment already has a different Terminal checkout'
      using errcode = '22023';
  end if;

  update public.order_payments
  set square_order_id = p_square_order_id,
      square_terminal_checkout_id = p_checkout_id
  where id = p_payment_id;
end;
$$;

revoke execute on function public.attach_square_terminal_checkout(uuid, text, text) from public, anon;
grant execute on function public.attach_square_terminal_checkout(uuid, text, text) to authenticated, service_role;

-- Staff stop a Terminal payment that won't complete (the diner changed
-- their mind, the checkout timed out). Only a pending Terminal payment.
create or replace function public.cancel_square_terminal_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
begin
  select * into v_payment from public.order_payments where id = p_payment_id;
  if not found or not public.is_restaurant_member(v_payment.restaurant_id) then
    raise exception 'PAYMENT_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;
  update public.order_payments
  set status = 'cancelled'
  where id = p_payment_id and status = 'pending' and tip_on_device;
end;
$$;

revoke execute on function public.cancel_square_terminal_payment(uuid) from public, anon;
grant execute on function public.cancel_square_terminal_payment(uuid) to authenticated, service_role;

-- The Square cash sale a recorded cash payment was copied to. A record of
-- where the copy went, so it's sent once; the payment itself was settled
-- when staff recorded it.
create or replace function public.attach_square_cash_sale(
  p_payment_id uuid,
  p_square_order_id text,
  p_square_payment_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
begin
  select * into v_payment from public.order_payments where id = p_payment_id;
  if not found or not public.is_restaurant_member(v_payment.restaurant_id) then
    raise exception 'PAYMENT_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;
  if v_payment.method <> 'cash' or v_payment.status <> 'succeeded' then
    raise exception 'PAYMENT_NOT_CASH: only a recorded cash payment can be sent to Square'
      using errcode = '22023';
  end if;
  if v_payment.square_payment_id is not null then
    return; -- already sent
  end if;
  update public.order_payments
  set square_order_id = p_square_order_id,
      square_payment_id = p_square_payment_id
  where id = p_payment_id;
end;
$$;

revoke execute on function public.attach_square_cash_sale(uuid, text, text) from public, anon;
grant execute on function public.attach_square_cash_sale(uuid, text, text) to authenticated, service_role;

-- ── Settling, with a tip from the device ─────────────────────────────
-- One settlement path for every Square payment. Online (20261110090000):
-- the tip was chosen in Tableside and is part of the order, so Square's
-- total must equal the payment's total. Terminal: the diner added the tip
-- on the device, so what's left after Square's tip must equal the orders'
-- amount, and the tip is recorded from Square. Either way a mismatch is
-- refused, never settled.
create or replace function public.settle_square_payment(
  p_square_order_id text,
  p_square_payment_id text,
  p_total_minor_units bigint,
  p_tip_minor_units bigint,
  p_currency text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
  v_scale integer;
  v_tip bigint := greatest(coalesce(p_tip_minor_units, 0), 0);
begin
  select * into v_payment
  from public.order_payments
  where square_order_id = p_square_order_id;

  if not found then
    return 'unknown';
  end if;
  if v_payment.status = 'succeeded' then
    return 'already';
  end if;
  if v_payment.status <> 'pending' or upper(p_currency) <> v_payment.currency then
    return 'mismatch';
  end if;

  -- Cents for most currencies, whole yen for JPY.
  v_scale := case when v_payment.currency = 'JPY' then 1 else 100 end;

  if v_payment.tip_on_device then
    if p_total_minor_units - v_tip <> round(v_payment.amount * v_scale)::bigint then
      return 'mismatch';
    end if;
    update public.order_payments
    set status = 'succeeded',
        paid_at = now(),
        tip_amount = v_tip::numeric / v_scale,
        square_payment_id = p_square_payment_id
    where id = v_payment.id;
  else
    if p_total_minor_units <> round(v_payment.total_amount * v_scale)::bigint then
      return 'mismatch';
    end if;
    update public.order_payments
    set status = 'succeeded',
        paid_at = now(),
        square_payment_id = p_square_payment_id
    where id = v_payment.id;
  end if;

  return 'settled';
end;
$$;

comment on function public.settle_square_payment(text, text, bigint, bigint, text) is
  'Settles any Square payment (online or Terminal) after the server or the signed webhook has read it from Square. Idempotent; refuses mismatches. service_role only.';

revoke execute on function public.settle_square_payment(text, text, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.settle_square_payment(text, text, bigint, bigint, text) to service_role;

-- The phase 2 entry point stays for any caller still using it, now going
-- through the one settlement path.
create or replace function public.mark_square_payment_succeeded(
  p_square_order_id text,
  p_square_payment_id text,
  p_total_minor_units bigint,
  p_currency text
)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.settle_square_payment(
    p_square_order_id, p_square_payment_id, p_total_minor_units, 0, p_currency
  )
$$;
