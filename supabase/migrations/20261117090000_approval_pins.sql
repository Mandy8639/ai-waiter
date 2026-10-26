-- Settle up, small batch: a manager's PIN approves a waiter's void, comp
-- or discount.
--
-- Adjusting a bill (20261113090000) was for owners and managers on their
-- own login, so a waiter at the table had to hand over the tablet or find
-- the manager's phone. Now a manager sets a 4 to 6 digit PIN, and types it
-- on the waiter's tablet to approve one change at a time. The change is
-- recorded as the waiter's, approved by that manager (approved_by).
--
-- WHY A TOKEN, NOT THE PIN, REACHES adjust_order()
--
-- A PIN is short, so what protects it is counting wrong guesses. A count
-- kept inside adjust_order() would be rolled back with the refusal, and a
-- waiter could guess forever by calling it directly. So checking is its
-- own step: verify_approval_pin() records every wrong PIN and never
-- raises (so the count commits), locks the waiter out for 15 minutes
-- after 5 wrong PINs in 15 minutes, and on a match returns a single-use
-- token that expires in 2 minutes. adjust_order() and
-- remove_order_adjustment() accept only that token from a waiter.
--
-- PINs are stored hashed with a per-row salt (sha256), in a table no
-- client role can read. Two managers at one restaurant can't share a PIN,
-- so a PIN names exactly one approver.

create table public.approval_pins (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  salt bytea not null,
  pin_hash bytea not null,
  updated_at timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);

comment on table public.approval_pins is
  'Managers'' approval PINs, hashed. No policies: read and written only by the approval functions.';

create table public.approval_attempts (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  failures integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  primary key (restaurant_id, user_id)
);

create table public.approval_tokens (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  approved_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table public.approval_pins enable row level security;
alter table public.approval_attempts enable row level security;
alter table public.approval_tokens enable row level security;

alter table public.order_adjustments
  add column approved_by uuid references auth.users (id) on delete set null;

comment on column public.order_adjustments.approved_by is
  'The manager whose PIN approved a waiter''s adjustment (20261117090000). Null when an owner or manager made it themselves.';

create function public.approval_pin_hash(p_salt bytea, p_pin text)
returns bytea
language sql
immutable
set search_path = public, pg_temp
as $$
  select sha256(p_salt || convert_to(p_pin, 'UTF8'))
$$;

revoke execute on function public.approval_pin_hash(bytea, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Setting a PIN
-- ---------------------------------------------------------------------------

create function public.set_approval_pin(p_restaurant_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_salt bytea := convert_to(gen_random_uuid()::text, 'UTF8');
begin
  if coalesce(public.current_restaurant_role(p_restaurant_id), '') not in ('owner', 'manager') then
    raise exception 'PIN_FORBIDDEN: only an owner or manager can approve with a PIN' using errcode = '42501';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN_INVALID: use 4 to 6 digits' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.approval_pins ap
    where ap.restaurant_id = p_restaurant_id
      and ap.user_id <> auth.uid()
      and ap.pin_hash = public.approval_pin_hash(ap.salt, p_pin)
  ) then
    raise exception 'PIN_TAKEN: another manager here uses that PIN; choose a different one'
      using errcode = '22023';
  end if;
  insert into public.approval_pins (restaurant_id, user_id, salt, pin_hash)
  values (p_restaurant_id, auth.uid(), v_salt, public.approval_pin_hash(v_salt, p_pin))
  on conflict (restaurant_id, user_id) do update
    set salt = excluded.salt, pin_hash = excluded.pin_hash, updated_at = now();
end;
$$;

revoke execute on function public.set_approval_pin(uuid, text) from public, anon;
grant execute on function public.set_approval_pin(uuid, text) to authenticated, service_role;

create function public.clear_approval_pin(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.approval_pins
  where restaurant_id = p_restaurant_id and user_id = auth.uid();
end;
$$;

revoke execute on function public.clear_approval_pin(uuid) from public, anon;
grant execute on function public.clear_approval_pin(uuid) to authenticated, service_role;

create function public.my_approval_pin_set(p_restaurant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return exists (
    select 1 from public.approval_pins
    where restaurant_id = p_restaurant_id and user_id = auth.uid()
  );
end;
$$;

revoke execute on function public.my_approval_pin_set(uuid) from public, anon;
grant execute on function public.my_approval_pin_set(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- verify_approval_pin: never raises for a wrong PIN, so the count commits
-- ---------------------------------------------------------------------------

create function public.verify_approval_pin(p_restaurant_id uuid, p_pin text)
returns table (outcome text, token uuid, approver_email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt public.approval_attempts%rowtype;
  v_approver uuid;
  v_token uuid;
begin
  if coalesce(public.current_restaurant_role(p_restaurant_id), '') not in ('owner', 'manager', 'staff') then
    raise exception 'PIN_FORBIDDEN: not front of house at this restaurant' using errcode = '42501';
  end if;

  insert into public.approval_attempts (restaurant_id, user_id)
  values (p_restaurant_id, auth.uid())
  on conflict (restaurant_id, user_id) do nothing;
  select * into v_attempt from public.approval_attempts
  where restaurant_id = p_restaurant_id and user_id = auth.uid()
  for update;

  if v_attempt.locked_until is not null and v_attempt.locked_until > now() then
    return query select 'locked'::text, null::uuid, null::text;
    return;
  end if;

  select ap.user_id into v_approver
  from public.approval_pins ap
  join public.restaurant_users ru
    on ru.restaurant_id = ap.restaurant_id and ru.user_id = ap.user_id
  where ap.restaurant_id = p_restaurant_id
    and ru.role in ('owner', 'manager')
    and p_pin ~ '^[0-9]{4,6}$'
    and ap.pin_hash = public.approval_pin_hash(ap.salt, p_pin)
  limit 1;

  if v_approver is null then
    update public.approval_attempts
    set failures = case when window_start < now() - interval '15 minutes' then 1 else failures + 1 end,
        window_start = case when window_start < now() - interval '15 minutes' then now() else window_start end,
        locked_until = case
          when window_start >= now() - interval '15 minutes' and failures + 1 >= 5
            then now() + interval '15 minutes'
        end
    where restaurant_id = p_restaurant_id and user_id = auth.uid();
    return query
      select case when a.locked_until is not null then 'locked' else 'wrong' end, null::uuid, null::text
      from public.approval_attempts a
      where a.restaurant_id = p_restaurant_id and a.user_id = auth.uid();
    return;
  end if;

  update public.approval_attempts
  set failures = 0, window_start = now(), locked_until = null
  where restaurant_id = p_restaurant_id and user_id = auth.uid();

  insert into public.approval_tokens (restaurant_id, requested_by, approved_by, expires_at)
  values (p_restaurant_id, auth.uid(), v_approver, now() + interval '2 minutes')
  returning id into v_token;

  return query
    select 'ok'::text, v_token, (select u.email::text from auth.users u where u.id = v_approver);
end;
$$;

revoke execute on function public.verify_approval_pin(uuid, text) from public, anon;
grant execute on function public.verify_approval_pin(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Who may change a bill: an owner or manager, or a waiter with a token
-- ---------------------------------------------------------------------------

create function public.adjustment_approver(p_order public.orders, p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(public.current_restaurant_role(p_order.restaurant_id), '');
  v_approver uuid;
begin
  if v_role in ('owner', 'manager') then
    return null;
  end if;
  if v_role = 'staff' and p_token is not null then
    update public.approval_tokens t
    set used_at = now()
    where t.id = p_token
      and t.restaurant_id = p_order.restaurant_id
      and t.requested_by = auth.uid()
      and t.used_at is null
      and t.expires_at > now()
    returning t.approved_by into v_approver;
    if v_approver is not null then
      return v_approver;
    end if;
  end if;
  raise exception 'ADJUST_FORBIDDEN: a manager has to approve this with their PIN'
    using errcode = '42501';
end;
$$;

revoke execute on function public.adjustment_approver(public.orders, uuid) from public, anon, authenticated;

create or replace function public.assert_order_adjustable(p_order public.orders)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
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

drop function public.adjust_order(uuid, text, text, uuid, integer, numeric, numeric);

create function public.adjust_order(
  p_order_id uuid,
  p_kind text,
  p_reason text,
  p_order_item_id uuid default null,
  p_quantity integer default null,
  p_percent numeric default null,
  p_amount numeric default null,
  p_approval_token uuid default null
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
  v_approver uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ADJUST_NOT_FOUND: that order was not found' using errcode = 'P0002';
  end if;
  v_approver := public.adjustment_approver(v_order, p_approval_token);
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
    restaurant_id, order_id, order_item_id, kind, quantity, percent, amount, reason, created_by,
    approved_by
  ) values (
    v_order.restaurant_id, p_order_id,
    case when p_kind = 'discount' then null else p_order_item_id end,
    p_kind,
    case when p_kind = 'discount' then null else p_quantity end,
    case when p_kind = 'discount' then p_percent end,
    v_amount, btrim(p_reason), auth.uid(), v_approver
  )
  returning id into v_id;

  perform public.recalculate_order_totals(p_order_id);
  return v_id;
end;
$$;

revoke execute on function public.adjust_order(uuid, text, text, uuid, integer, numeric, numeric, uuid) from public, anon;
grant execute on function public.adjust_order(uuid, text, text, uuid, integer, numeric, numeric, uuid) to authenticated, service_role;

drop function public.remove_order_adjustment(uuid);

create function public.remove_order_adjustment(
  p_adjustment_id uuid,
  p_approval_token uuid default null
)
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
  perform public.adjustment_approver(v_order, p_approval_token);
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

revoke execute on function public.remove_order_adjustment(uuid, uuid) from public, anon;
grant execute on function public.remove_order_adjustment(uuid, uuid) to authenticated, service_role;
