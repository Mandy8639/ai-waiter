-- Square, phase 2: diners pay through Square.
--
-- A restaurant connected to Square (20261109090000) can switch card
-- payments over to it. Diners then pay their tab (or one order) on
-- Square's hosted checkout instead of Stripe's, Tableside's fee is taken
-- with Square's app_fee_money, and the full itemised bill lands in Square.
--
-- Why Square has to take the payment, not just hear about it: Square
-- charges the app maker 1% on orders paid through anyone else, which is
-- Tableside's whole fee. See docs/pos-integration.md#square.
--
-- Everything that makes card payments safe stays exactly where it was:
--   * the diner never names the price (start_order_payment and
--     start_tab_payment still read it from the orders);
--   * returning from checkout proves nothing; only a signed webhook settles,
--     through a function granted to service_role alone;
--   * one succeeded payment per order (the existing trigger).
-- What changes is only which provider the account check looks for.

-- ── The switch ─────────────────────────────────────────────────────────

alter table public.restaurant_pos_integrations
  add column payments_enabled boolean not null default false;

alter table public.restaurant_pos_integrations
  add constraint restaurant_pos_integrations_payments_need_enabled
    check (not payments_enabled or is_enabled);

comment on column public.restaurant_pos_integrations.payments_enabled is
  'Diners'' card payments go through this POS (Square) instead of Stripe. Needs the integration enabled.';

-- Which provider takes a restaurant's card payments: 'square' when it has
-- switched Square payments on and a connection to use, otherwise 'stripe'.
create or replace function public.restaurant_card_provider(p_restaurant_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (
      select 1
      from public.restaurant_pos_integrations i
      join public.pos_credentials c on c.restaurant_id = i.restaurant_id
      where i.restaurant_id = p_restaurant_id
        and i.provider = 'square'
        and i.is_enabled
        and i.payments_enabled
    ) then 'square'
    else 'stripe'
  end
$$;

comment on function public.restaurant_card_provider(uuid) is
  'stripe or square: who takes this restaurant''s card payments. Square only with a live connection and payments switched on.';

revoke execute on function public.restaurant_card_provider(uuid) from public, anon;
grant execute on function public.restaurant_card_provider(uuid) to authenticated, service_role;

-- ── Square's side of a payment ────────────────────────────────────────

alter table public.order_payments
  add column square_order_id text,
  add column square_payment_id text,
  add column square_checkout_url text;

create unique index order_payments_square_order_key
  on public.order_payments (square_order_id)
  where square_order_id is not null;
create unique index order_payments_square_payment_key
  on public.order_payments (square_payment_id)
  where square_payment_id is not null;

comment on column public.order_payments.square_order_id is
  'The Square order the hosted checkout created for this payment. Settlement keys on it, as Stripe settlement keys on the checkout session.';

-- ── The diner can see a card button ───────────────────────────────────

create or replace function public.get_public_payment_settings(
  target_restaurant_id uuid
)
returns table (
  can_take_card boolean,
  tipping_enabled boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(s.accept_card, false)
      and (
        public.restaurant_card_provider(s.restaurant_id) = 'square'
        or coalesce(a.charges_enabled, false)
      ) as can_take_card,
    coalesce(s.tipping_enabled, false) as tipping_enabled
  from public.restaurant_settings s
  left join public.restaurant_payment_accounts a
    on a.restaurant_id = s.restaurant_id
  where s.restaurant_id = target_restaurant_id
$$;

-- ── Starting a payment ────────────────────────────────────────────────
--
-- Both functions are the previous versions (20260902090000 and
-- 20261002090000) with one change: the Stripe account check is skipped
-- when the restaurant's card provider is Square. stripe_account_id then
-- comes back NULL, which is how the caller knows to open Square's
-- checkout (src/lib/payments/checkout.ts, tab-checkout.ts).

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

  -- The one change: Square restaurants don't need a Stripe account.
  if public.restaurant_card_provider(v_order.restaurant_id) <> 'square' then
    select * into v_account
    from public.restaurant_payment_accounts a
    where a.restaurant_id = v_order.restaurant_id;

    if not found or not v_account.charges_enabled then
      raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
    end if;
  end if;

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

create or replace function public.start_tab_payment(
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
  v_order_ids uuid[];
  v_total numeric(10, 2);
  v_currency text;
  v_currency_count integer;
  v_count integer;
  v_payment_id uuid;
  v_existing public.order_payments%rowtype;
begin
  if p_tip_amount is null or p_tip_amount < 0 then
    raise exception 'Tip cannot be negative' using errcode = '22023';
  end if;

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

  -- The one change: Square restaurants don't need a Stripe account.
  if public.restaurant_card_provider(v_session.restaurant_id) <> 'square' then
    select * into v_account
    from public.restaurant_payment_accounts a
    where a.restaurant_id = v_session.restaurant_id;

    if not found or not v_account.charges_enabled then
      raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
    end if;
  end if;

  select p.* into v_existing
  from public.order_payments p
  where p.restaurant_id = v_session.restaurant_id
    and p.status = 'pending'
    and p.split_id is null
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

  select
    array_agg(o.id),
    count(*)::integer,
    coalesce(sum(o.total), 0),
    min(o.currency),
    count(distinct o.currency)::integer
  into v_order_ids, v_count, v_total, v_currency, v_currency_count
  from public.orders o
  where o.customer_session_id = v_session.id
    and o.status <> 'cancelled'
    and not exists (
      select 1
      from public.payment_orders po
      join public.order_payments p on p.id = po.payment_id
      where po.order_id = o.id and p.status = 'succeeded'
    )
    and not exists (
      select 1
      from public.tab_split_orders so
      join public.tab_splits s on s.id = so.split_id
      where so.order_id = o.id and so.active and s.status = 'open'
    );

  if v_count = 0 then
    raise exception 'PAYMENT_NOTHING_TO_PAY: this tab has no unpaid orders' using errcode = '22023';
  end if;

  if v_currency_count > 1 then
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
  select v_payment_id, o.id, v_session.restaurant_id, o.total
  from public.orders o
  where o.id = any(v_order_ids);

  return query
    select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
           v_account.stripe_account_id, v_count
    from public.order_payments p
    where p.id = v_payment_id;
end;
$$;

-- ── What goes on Square's bill ────────────────────────────────────────
--
-- The lines of every order a pending payment covers, so the bill in
-- Square is itemised. Only the diner whose orders these are may read
-- them (the same ownership rule attach_payment_checkout_session uses).
-- Amounts are what the diner was charged at the time (order_items are
-- immutable), never the current menu price.
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
begin
  select count(*), count(*) filter (where public.order_belongs_to_caller(po.order_id))
  into v_covered, v_mine
  from public.payment_orders po
  where po.payment_id = p_payment_id;

  if v_covered = 0 or v_mine <> v_covered then
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

revoke execute on function public.payment_bill_lines(uuid) from public, anon;
grant execute on function public.payment_bill_lines(uuid) to authenticated, service_role;

-- ── Recording the checkout, and settling it ───────────────────────────

-- The diner's request records which Square order its checkout created.
-- Same ownership and state rules as attach_payment_checkout_session().
create or replace function public.attach_square_checkout(
  p_payment_id uuid,
  p_square_order_id text,
  p_checkout_url text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_covered integer;
  v_mine integer;
  v_existing text;
  v_status text;
begin
  select count(*), count(*) filter (where public.order_belongs_to_caller(po.order_id))
  into v_covered, v_mine
  from public.payment_orders po
  where po.payment_id = p_payment_id;

  if v_covered = 0 or v_mine <> v_covered then
    raise exception 'PAYMENT_NOT_YOUR_ORDER: order belongs to another session' using errcode = '42501';
  end if;

  select square_order_id, status into v_existing, v_status
  from public.order_payments
  where id = p_payment_id;

  if v_existing is not null and v_existing = p_square_order_id then
    return;
  end if;

  if v_status <> 'pending' or v_existing is not null then
    raise exception 'PAYMENT_NOT_PENDING: payment is not pending or already has a different checkout'
      using errcode = '22023';
  end if;

  update public.order_payments
  set square_order_id = p_square_order_id,
      square_checkout_url = p_checkout_url
  where id = p_payment_id;
end;
$$;

revoke execute on function public.attach_square_checkout(uuid, text, text) from public, anon;
grant execute on function public.attach_square_checkout(uuid, text, text) to authenticated, service_role;

-- Square's signed webhook settles, exactly as Stripe's does: the only path
-- to 'succeeded' for a Square payment, idempotent under redelivery. It
-- also refuses an amount that doesn't match what the diner was asked to
-- pay, which should never happen and must never be settled silently if it
-- does.
create or replace function public.mark_square_payment_succeeded(
  p_square_order_id text,
  p_square_payment_id text,
  p_total_minor_units bigint,
  p_currency text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
  v_expected bigint;
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

  -- Square amounts are in the currency's smallest unit: cents for most,
  -- whole yen for JPY (the one zero-decimal currency Square supports).
  v_expected := round(
    v_payment.total_amount * case when v_payment.currency = 'JPY' then 1 else 100 end
  )::bigint;
  if p_total_minor_units <> v_expected or upper(p_currency) <> v_payment.currency then
    return 'mismatch';
  end if;

  update public.order_payments
  set status = 'succeeded',
      paid_at = now(),
      square_payment_id = p_square_payment_id
  where id = v_payment.id;

  return 'settled';
end;
$$;

comment on function public.mark_square_payment_succeeded(text, text, bigint, text) is
  'Settles a Square payment from a verified Square webhook. The only path that sets a Square payment succeeded. Idempotent; refuses a mismatched amount. service_role only.';

revoke execute on function public.mark_square_payment_succeeded(text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.mark_square_payment_succeeded(text, text, bigint, text) to service_role;
