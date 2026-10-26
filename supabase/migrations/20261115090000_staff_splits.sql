-- Settle up, second batch: staff split a table's bill.
--
-- Phase J (20261002090000) lets a diner split their own tab and have each
-- person pay their part on their phone, through Stripe. A pay-at-end
-- restaurant also needs the waiter to do it at the table: "split it three
-- ways", "I'll pay for the biryani", each part paid in cash, on the card
-- machine or on a Square Terminal.
--
-- This reuses Phase J's engine whole: the same tab_splits / units /
-- orders, the same exact allocation, the same rule that no order counts as
-- paid until every part is, the same trigger (follow_split_payment) that
-- marks parts paid and writes coverage on the last one, and the same guard
-- that keeps every other payment off an order in an open split. What's new:
--
--   - A split can be made by staff for any of a restaurant's unpaid orders
--     (create_staff_split), with no diner session behind it, so
--     tab_splits.customer_session_id becomes nullable and created_by says
--     who made it.
--   - Parts are paid in person: cash or card machine at once
--     (pay_split_in_person), or a Square Terminal (start_split_terminal_
--     payment, then the existing Terminal attach/check/cancel and the
--     existing settle_square_payment()).
--   - Staff can see every open split, a diner's included, so the last part
--     of a phone split can be paid in cash (settle_up_splits), and cancel
--     one nobody has started paying (cancel_staff_split).
--
-- BY-DISH PARTS AFTER ADJUSTMENTS (20261113090000)
--
-- A dish's part was its line total plus its slice of tax and service.
-- After a void, comp or discount, the order's total no longer starts from
-- those line totals, so the slice could go negative and the split would
-- fail. build_split_units() prices each line at what's still charged for
-- it (voided and comped units out) and spreads the rest of the order total
-- — tax and service, less any order discount — across the lines in
-- proportion, so the parts of an order still add up to its total exactly.
-- create_tab_split() is re-created to use it; its own checks are
-- unchanged.

alter table public.tab_splits
  alter column customer_session_id drop not null,
  add column created_by uuid references auth.users (id) on delete set null;

comment on column public.tab_splits.customer_session_id is
  'The diner whose tab this is (Phase J). Null for a split staff made on Settle up (created_by).';
comment on column public.tab_splits.created_by is
  'The staff member who split the bill on Settle up (20261115090000). Null for a diner''s own split.';

-- ---------------------------------------------------------------------------
-- build_split_units: the parts, for both kinds of split
-- ---------------------------------------------------------------------------

create function public.build_split_units(
  p_split uuid,
  p_restaurant_id uuid,
  p_order_ids uuid[],
  p_mode text,
  p_share_count integer,
  p_currency text,
  p_total numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shares bigint[];
  v_i integer;
  v_position integer := 0;
  v_order record;
  v_line_ids uuid[];
  v_line_names text[];
  v_line_qty integer[];
  v_line_minor bigint[];
  v_rest bigint;
  v_extras bigint[];
begin
  if p_mode = 'equal' then
    v_shares := public.allocate_minor(
      public.to_minor_units(p_total, p_currency),
      array_fill(1::bigint, array[p_share_count])
    );
    for v_i in 1 .. p_share_count loop
      insert into public.tab_split_units (split_id, restaurant_id, position, kind, label, amount)
      values (
        p_split, p_restaurant_id, v_i, 'share',
        format('Share %s of %s', v_i, p_share_count),
        public.from_minor_units(v_shares[v_i], p_currency)
      );
    end loop;
  else
    for v_order in
      select o.id, o.order_number, o.total
      from public.orders o
      where o.id = any(p_order_ids)
      order by o.order_number
    loop
      -- Each line at what's still charged for it: voided and comped units
      -- out. Lines with nothing left to pay get no part.
      select array_agg(l.id order by l.created_at, l.item_name, l.id),
             array_agg(l.item_name order by l.created_at, l.item_name, l.id),
             array_agg(l.charged order by l.created_at, l.item_name, l.id),
             array_agg(public.to_minor_units((l.unit_amount * l.charged)::numeric(10, 2), p_currency)
                       order by l.created_at, l.item_name, l.id)
      into v_line_ids, v_line_names, v_line_qty, v_line_minor
      from (
        select oi.id, oi.item_name, oi.created_at,
               oi.unit_price + oi.modifier_total as unit_amount,
               oi.quantity - coalesce((
                 select sum(a.quantity) from public.order_adjustments a
                 where a.order_item_id = oi.id and a.kind in ('void', 'comp')
                   and a.removed_at is null
               ), 0)::integer as charged
        from public.order_items oi
        where oi.order_id = v_order.id
      ) l
      where l.charged > 0 and l.unit_amount > 0;

      if v_line_ids is null then
        raise exception 'SPLIT_ORDER_HAS_NO_ITEMS: order #% has nothing to split', v_order.order_number
          using errcode = '22023';
      end if;

      -- What the order adds beyond its lines (tax and service, less any
      -- order discount), spread in proportion. Allocated as a positive
      -- amount either way, so allocate_minor() only ever sees one.
      v_rest := public.to_minor_units(v_order.total, p_currency)
        - (select sum(m) from unnest(v_line_minor) as m)::bigint;
      v_extras := public.allocate_minor(abs(v_rest), v_line_minor);

      for v_i in 1 .. array_length(v_line_ids, 1) loop
        v_position := v_position + 1;
        insert into public.tab_split_units
          (split_id, restaurant_id, position, kind, label, order_id, order_item_id, amount)
        values (
          p_split, p_restaurant_id, v_position, 'dish',
          case when v_line_qty[v_i] > 1
            then format('%s× %s', v_line_qty[v_i], v_line_names[v_i])
            else v_line_names[v_i] end,
          v_order.id, v_line_ids[v_i],
          public.from_minor_units(
            v_line_minor[v_i] + sign(v_rest)::bigint * v_extras[v_i], p_currency
          )
        );
      end loop;
    end loop;
  end if;

  -- The invariant the phase exists for, checked where it is made.
  if (select sum(u.amount) from public.tab_split_units u where u.split_id = p_split) <> p_total then
    raise exception 'SPLIT_SUM_MISMATCH: parts do not add up to the bill' using errcode = 'XX000';
  end if;
end;
$$;

revoke execute on function public.build_split_units(uuid, uuid, uuid[], text, integer, text, numeric)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_tab_split: as in 20261002090000, with the parts from
-- build_split_units()
-- ---------------------------------------------------------------------------

create or replace function public.create_tab_split(p_mode text, p_share_count integer default null)
returns table (new_split_id uuid, new_split_token text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions%rowtype;
  v_settings public.restaurant_settings%rowtype;
  v_account public.restaurant_payment_accounts%rowtype;
  v_order_ids uuid[];
  v_total numeric(10, 2);
  v_currency text;
  v_currency_count integer;
  v_total_minor bigint;
  v_split uuid;
  v_token text;
begin
  if p_mode not in ('equal', 'by_dish') then
    raise exception 'SPLIT_INVALID_MODE' using errcode = '22023';
  end if;
  if p_mode = 'equal' and (p_share_count is null or p_share_count < 2 or p_share_count > 20) then
    raise exception 'SPLIT_INVALID_SHARES: split into 2 to 20 shares' using errcode = '22023';
  end if;

  select * into v_session
  from public.customer_sessions cs
  where cs.user_id = auth.uid()
    and cs.status = 'active'
    and cs.expires_at > now();
  if not found then
    raise exception 'PAYMENT_NO_SESSION: no active session for this diner' using errcode = 'P0002';
  end if;

  select * into v_settings from public.restaurant_settings s
  where s.restaurant_id = v_session.restaurant_id;
  if not found or not v_settings.accept_card then
    raise exception 'PAYMENT_CARD_NOT_ACCEPTED: restaurant does not accept card' using errcode = '22023';
  end if;

  select * into v_account from public.restaurant_payment_accounts a
  where a.restaurant_id = v_session.restaurant_id;
  if not found or not v_account.charges_enabled then
    raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.tab_splits s
    where s.customer_session_id = v_session.id and s.status = 'open'
  ) then
    raise exception 'SPLIT_ALREADY_OPEN: this bill is already being split' using errcode = '22023';
  end if;

  perform 1 from public.orders o
  where o.customer_session_id = v_session.id and o.status <> 'cancelled'
  for update;

  select array_agg(o.id order by o.order_number), coalesce(sum(o.total), 0),
         min(o.currency), count(distinct o.currency)::integer
  into v_order_ids, v_total, v_currency, v_currency_count
  from public.orders o
  where o.customer_session_id = v_session.id
    and o.status <> 'cancelled'
    and not exists (
      select 1 from public.payment_orders po
      join public.order_payments p on p.id = po.payment_id
      where po.order_id = o.id and p.status = 'succeeded'
    );

  if v_order_ids is null or v_total <= 0 then
    raise exception 'PAYMENT_NOTHING_TO_PAY: this tab has no unpaid orders' using errcode = '22023';
  end if;
  if v_currency_count > 1 then
    raise exception 'PAYMENT_MIXED_CURRENCY: this tab mixes currencies' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.payment_orders po
    join public.order_payments p on p.id = po.payment_id
    where po.order_id = any(v_order_ids) and p.status = 'pending'
  ) then
    raise exception 'PAYMENT_IN_PROGRESS: a payment for this bill is already open' using errcode = '22023';
  end if;

  v_total_minor := public.to_minor_units(v_total, v_currency);
  if p_mode = 'equal' and v_total_minor < p_share_count then
    raise exception 'SPLIT_TOO_SMALL: the bill is too small to split that many ways' using errcode = '22023';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.tab_splits (restaurant_id, customer_session_id, mode, currency, total, token_hash, share_token)
  values (v_session.restaurant_id, v_session.id, p_mode, v_currency, v_total, public.split_token_hash(v_token), v_token)
  returning id into v_split;

  insert into public.tab_split_orders (split_id, order_id, restaurant_id)
  select v_split, unnest(v_order_ids), v_session.restaurant_id;

  perform public.build_split_units(
    v_split, v_session.restaurant_id, v_order_ids, p_mode, p_share_count, v_currency, v_total
  );

  return query select v_split, v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- Front of house: who may split and take payment for parts
-- ---------------------------------------------------------------------------

create function public.assert_front_of_house(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.current_restaurant_role(p_restaurant_id), '') not in ('owner', 'manager', 'staff') then
    raise exception 'PAYMENT_FORBIDDEN: not front of house at this restaurant' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.assert_front_of_house(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_staff_split
-- ---------------------------------------------------------------------------

create function public.create_staff_split(
  p_order_ids uuid[],
  p_mode text,
  p_share_count integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_count integer;
  v_total numeric(10, 2);
  v_currency text;
  v_currency_count integer;
  v_restaurant_count integer;
  v_split uuid;
  v_token text;
begin
  if p_mode not in ('equal', 'by_dish') then
    raise exception 'SPLIT_INVALID_MODE' using errcode = '22023';
  end if;
  if p_mode = 'equal' and (p_share_count is null or p_share_count < 2 or p_share_count > 20) then
    raise exception 'SPLIT_INVALID_SHARES: split into 2 to 20 shares' using errcode = '22023';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) not between 1 and 50 then
    raise exception 'PAYMENT_NO_ORDERS: no orders given' using errcode = '22023';
  end if;

  select min(o.restaurant_id::text)::uuid, count(*)::integer,
         count(distinct o.restaurant_id)::integer
  into v_restaurant_id, v_count, v_restaurant_count
  from public.orders o where o.id = any(p_order_ids);
  if v_count <> cardinality(array(select distinct unnest(p_order_ids))) then
    raise exception 'PAYMENT_ORDER_NOT_FOUND: no such order' using errcode = 'P0002';
  end if;
  if v_restaurant_count > 1 then
    raise exception 'PAYMENT_MIXED_RESTAURANTS: orders belong to different restaurants' using errcode = '22023';
  end if;
  perform public.assert_front_of_house(v_restaurant_id);

  perform 1 from public.orders o where o.id = any(p_order_ids) for update;

  if exists (select 1 from public.orders o where o.id = any(p_order_ids) and o.status = 'cancelled') then
    raise exception 'PAYMENT_ORDER_CANCELLED: order was cancelled' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.payment_orders po
    join public.order_payments p on p.id = po.payment_id
    where po.order_id = any(p_order_ids) and p.status = 'succeeded'
  ) then
    raise exception 'PAYMENT_ALREADY_PAID: order already has a succeeded payment' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.payment_orders po
    join public.order_payments p on p.id = po.payment_id
    where po.order_id = any(p_order_ids) and p.status = 'pending'
  ) then
    raise exception 'PAYMENT_IN_PROGRESS: a payment for this bill is already open' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.tab_split_orders so
    join public.tab_splits s on s.id = so.split_id
    where so.order_id = any(p_order_ids) and so.active and s.status = 'open'
  ) then
    raise exception 'SPLIT_ALREADY_OPEN: this bill is already being split' using errcode = '22023';
  end if;

  select coalesce(sum(o.total), 0), min(o.currency), count(distinct o.currency)::integer
  into v_total, v_currency, v_currency_count
  from public.orders o where o.id = any(p_order_ids);
  if v_total <= 0 then
    raise exception 'PAYMENT_NOTHING_TO_PAY: nothing left to pay on these orders' using errcode = '22023';
  end if;
  if v_currency_count > 1 then
    raise exception 'PAYMENT_MIXED_CURRENCY: these orders mix currencies' using errcode = '22023';
  end if;
  if p_mode = 'equal' and public.to_minor_units(v_total, v_currency) < p_share_count then
    raise exception 'SPLIT_TOO_SMALL: the bill is too small to split that many ways' using errcode = '22023';
  end if;

  -- Staff splits are never shared by link; the token only satisfies the
  -- table's shape.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.tab_splits (
    restaurant_id, customer_session_id, mode, currency, total, token_hash, share_token, created_by
  ) values (
    v_restaurant_id, null, p_mode, v_currency, v_total, public.split_token_hash(v_token), v_token, auth.uid()
  )
  returning id into v_split;

  insert into public.tab_split_orders (split_id, order_id, restaurant_id)
  select v_split, o.id, v_restaurant_id
  from public.orders o where o.id = any(p_order_ids);

  perform public.build_split_units(
    v_split, v_restaurant_id,
    array(select o.id from public.orders o where o.id = any(p_order_ids)),
    p_mode, p_share_count, v_currency, v_total
  );

  return v_split;
end;
$$;

revoke execute on function public.create_staff_split(uuid[], text, integer) from public, anon;
grant execute on function public.create_staff_split(uuid[], text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- cancel_staff_split: any open split nobody has started paying, a diner's
-- included (one that was abandoned at the table)
-- ---------------------------------------------------------------------------

create function public.cancel_staff_split(p_split_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_split public.tab_splits%rowtype;
begin
  select * into v_split from public.tab_splits where id = p_split_id for update;
  if not found then
    raise exception 'SPLIT_NOT_FOUND: no such split' using errcode = 'P0002';
  end if;
  perform public.assert_front_of_house(v_split.restaurant_id);
  if v_split.status <> 'open' then
    raise exception 'SPLIT_CLOSED: this bill is already settled or the split was cancelled' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.tab_split_units u
    where u.split_id = p_split_id and u.status <> 'open'
  ) then
    raise exception 'SPLIT_STARTED: someone has already paid or is paying a part' using errcode = '22023';
  end if;
  update public.tab_splits set status = 'cancelled', cancelled_at = now() where id = p_split_id;
  update public.tab_split_orders set active = false where split_id = p_split_id;
end;
$$;

revoke execute on function public.cancel_staff_split(uuid) from public, anon;
grant execute on function public.cancel_staff_split(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Claiming parts for one in-person payer (shared by cash and Terminal)
-- ---------------------------------------------------------------------------

create function public.claim_split_units(
  p_split_id uuid,
  p_unit_ids uuid[],
  p_payment_id uuid
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_open integer;
  v_amount numeric(10, 2);
begin
  select count(*)::integer,
         count(*) filter (where u.status = 'open')::integer,
         coalesce(sum(u.amount), 0)
  into v_count, v_open, v_amount
  from (
    select u.* from public.tab_split_units u
    where u.id = any(p_unit_ids) and u.split_id = p_split_id
    for update
  ) u;
  if v_count <> cardinality(array(select distinct unnest(p_unit_ids))) then
    raise exception 'SPLIT_UNKNOWN_PART: one of those parts is not on this bill' using errcode = '22023';
  end if;
  if v_open <> v_count then
    raise exception 'SPLIT_PART_TAKEN: someone is already paying for one of those' using errcode = '22023';
  end if;
  if p_payment_id is not null then
    update public.tab_split_units u
    set status = 'pending', payment_id = p_payment_id
    where u.id = any(p_unit_ids) and u.split_id = p_split_id;
  end if;
  return v_amount;
end;
$$;

revoke execute on function public.claim_split_units(uuid, uuid[], uuid) from public, anon, authenticated;

create function public.open_split_for_payment(p_split_id uuid)
returns public.tab_splits
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_split public.tab_splits%rowtype;
begin
  select * into v_split from public.tab_splits where id = p_split_id for update;
  if not found then
    raise exception 'SPLIT_NOT_FOUND: no such split' using errcode = 'P0002';
  end if;
  perform public.assert_front_of_house(v_split.restaurant_id);
  if v_split.status <> 'open' then
    raise exception 'SPLIT_CLOSED: this bill is already settled or the split was cancelled' using errcode = '22023';
  end if;
  return v_split;
end;
$$;

revoke execute on function public.open_split_for_payment(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- pay_split_in_person: cash or card machine, settled at once
-- ---------------------------------------------------------------------------

create function public.pay_split_in_person(
  p_split_id uuid,
  p_unit_ids uuid[],
  p_method text,
  p_tip_amount numeric default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_split public.tab_splits%rowtype;
  v_settings public.restaurant_settings%rowtype;
  v_amount numeric(10, 2);
  v_payment uuid;
begin
  if p_method not in ('cash', 'card_terminal') then
    raise exception 'PAYMENT_INVALID_METHOD: cash or card machine only' using errcode = '22023';
  end if;
  if p_tip_amount is null or p_tip_amount < 0 then
    raise exception 'Tip cannot be negative' using errcode = '22023';
  end if;
  if p_unit_ids is null or cardinality(p_unit_ids) = 0 then
    raise exception 'SPLIT_NOTHING_CHOSEN: choose what is being paid for' using errcode = '22023';
  end if;

  v_split := public.open_split_for_payment(p_split_id);

  select * into v_settings from public.restaurant_settings s where s.restaurant_id = v_split.restaurant_id;
  if p_method = 'cash' and not coalesce(v_settings.accept_cash, false) then
    raise exception 'PAYMENT_CASH_NOT_ACCEPTED: restaurant does not accept cash' using errcode = '22023';
  end if;
  if p_method = 'card_terminal' and not coalesce(v_settings.accept_card_terminal, false) then
    raise exception 'PAYMENT_CARD_TERMINAL_NOT_ACCEPTED: restaurant does not take card-machine payments'
      using errcode = '22023';
  end if;
  if p_tip_amount > 0 and not coalesce(v_settings.tipping_enabled, false) then
    raise exception 'PAYMENT_TIPPING_DISABLED: restaurant has tipping switched off' using errcode = '22023';
  end if;

  v_amount := public.claim_split_units(p_split_id, p_unit_ids, null);
  if v_amount <= 0 then
    raise exception 'SPLIT_NOTHING_TO_PAY: those parts come to nothing' using errcode = '22023';
  end if;

  -- Inserted pending and then settled, so follow_split_payment() (an
  -- AFTER UPDATE OF status trigger) marks the parts paid and, on the last
  -- one, writes coverage for the whole split.
  insert into public.order_payments (
    restaurant_id, status, method, amount, tip_amount, currency, split_id, recorded_by
  ) values (
    v_split.restaurant_id, 'pending', p_method, v_amount, p_tip_amount, v_split.currency, v_split.id, auth.uid()
  )
  returning id into v_payment;

  perform public.claim_split_units(p_split_id, p_unit_ids, v_payment);

  update public.order_payments
  set status = 'succeeded', paid_at = now()
  where id = v_payment;

  return v_payment;
end;
$$;

revoke execute on function public.pay_split_in_person(uuid, uuid[], text, numeric) from public, anon;
grant execute on function public.pay_split_in_person(uuid, uuid[], text, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- start_split_terminal_payment: a pending Square Terminal payment for some
-- parts. Sent, checked, cancelled and settled exactly like any other
-- Terminal payment (attach_square_terminal_checkout, settle_square_payment,
-- cancel_square_terminal_payment); follow_split_payment() does the rest.
-- ---------------------------------------------------------------------------

create function public.start_split_terminal_payment(
  p_split_id uuid,
  p_unit_ids uuid[]
)
returns table (
  payment_id uuid,
  amount numeric,
  currency text,
  tipping_enabled boolean,
  label text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_split public.tab_splits%rowtype;
  v_settings public.restaurant_settings%rowtype;
  v_amount numeric(10, 2);
  v_payment uuid;
begin
  if p_unit_ids is null or cardinality(p_unit_ids) = 0 then
    raise exception 'SPLIT_NOTHING_CHOSEN: choose what is being paid for' using errcode = '22023';
  end if;

  v_split := public.open_split_for_payment(p_split_id);

  select * into v_settings from public.restaurant_settings s where s.restaurant_id = v_split.restaurant_id;
  if not found or not v_settings.accept_card then
    raise exception 'PAYMENT_CARD_NOT_ACCEPTED: restaurant does not accept card' using errcode = '22023';
  end if;
  if public.restaurant_card_provider(v_split.restaurant_id) <> 'square' then
    raise exception 'PAYMENT_NOT_SQUARE: this restaurant does not take cards through Square'
      using errcode = '22023';
  end if;

  v_amount := public.claim_split_units(p_split_id, p_unit_ids, null);
  if v_amount <= 0 then
    raise exception 'SPLIT_NOTHING_TO_PAY: those parts come to nothing' using errcode = '22023';
  end if;

  insert into public.order_payments (
    restaurant_id, status, method, card_present, tip_on_device,
    amount, tip_amount, currency, split_id, recorded_by
  ) values (
    v_split.restaurant_id, 'pending', 'card', true, true,
    v_amount, 0, v_split.currency, v_split.id, auth.uid()
  )
  returning id into v_payment;

  perform public.claim_split_units(p_split_id, p_unit_ids, v_payment);

  return query
    select v_payment, v_amount, v_split.currency, coalesce(v_settings.tipping_enabled, false),
           (select string_agg(u.label, ', ' order by u.position)
            from public.tab_split_units u where u.payment_id = v_payment);
end;
$$;

revoke execute on function public.start_split_terminal_payment(uuid, uuid[]) from public, anon;
grant execute on function public.start_split_terminal_payment(uuid, uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- settle_up_splits: every open split at the restaurant, for Settle up
-- ---------------------------------------------------------------------------

create function public.settle_up_splits(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_restaurant_member(p_restaurant_id) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id,
      'mode', s.mode,
      'currency', s.currency,
      'total', s.total,
      'by_staff', s.customer_session_id is null,
      'paid_total', coalesce((
        select sum(u.amount) from public.tab_split_units u
        where u.split_id = s.id and u.status = 'paid'), 0),
      'order_ids', (
        select coalesce(jsonb_agg(so.order_id), '[]'::jsonb)
        from public.tab_split_orders so where so.split_id = s.id and so.active),
      'units', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', u.id, 'label', u.label, 'amount', u.amount, 'status', u.status,
          'payment_id', u.payment_id) order by u.position), '[]'::jsonb)
        from public.tab_split_units u where u.split_id = s.id)
    ) order by s.created_at)
    from public.tab_splits s
    where s.restaurant_id = p_restaurant_id and s.status = 'open'
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.settle_up_splits(uuid) from public, anon;
grant execute on function public.settle_up_splits(uuid) to authenticated, service_role;
