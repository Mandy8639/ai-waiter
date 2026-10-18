-- Pricing, decided 2026-10-18: a free first month, then Starter at $19/month.
--
-- Every new restaurant gets 30 days in which Tableside takes nothing from
-- card payments (the platform fee is 0). After that Starter is $19/month
-- plus 1% of card payments; Standard and Pro are unchanged. Restaurants that
-- existed before this migration (Nashta and the two demos) are "billing
-- exempt": they keep the old free Starter, 1% and no monthly fee.
--
-- ENFORCEMENT, deliberately, and with care.
-- 20260902220000_platform_subscriptions.sql chose NOT to enforce payment,
-- because a false positive (a late webhook, one failed card) would take a
-- real restaurant offline mid-service. Enforcement is now a decision, made
-- here in its own migration, with these protections:
--   * 7 days of grace after the free month before anything pauses.
--   * A subscription Stripe is still collecting on counts as paying:
--     trialing, active and past_due (Stripe retries a failed card for
--     weeks). One declined card never pauses ordering.
--   * A cancelled or unpaid subscription keeps working until 7 days after
--     the period it paid for.
--   * What pauses is NEW QR ORDERS only. The menu stays up, orders already
--     placed carry on, and staff keep every dashboard tool. Diners see the
--     existing "isn't accepting orders right now" message, never billing.
--   * Unknown state fails OPEN (orders allowed), not closed.

alter table public.restaurants
  add column trial_ends_at timestamptz default (now() + interval '30 days'),
  add column billing_exempt boolean not null default false;

comment on column public.restaurants.trial_ends_at is
  'End of the free first month: no platform fee on card payments before it, and no subscription needed until 7 days after it. Null for billing-exempt restaurants.';
comment on column public.restaurants.billing_exempt is
  'Restaurants from before 2026-10-18 pricing (Nashta, the demos): free Starter, no monthly fee, never paused for billing.';

-- Everyone already here is grandfathered. (Every existing row has the new
-- column's default, false; the WHERE is for pg_safeupdate, which refuses an
-- unqualified UPDATE: tests/unit/migrations-safe-writes.test.ts.)
update public.restaurants
  set billing_exempt = true, trial_ends_at = null
  where billing_exempt = false;

-- Owners and managers may update their own restaurant row through RLS, so
-- without this they could extend their own trial or exempt themselves.
-- Same pattern as menu_items_guard_image_columns (20260919100000).
create function public.restaurants_guard_billing_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.billing_exempt then
        raise exception 'RESTAURANT_BILLING_COLUMNS_READ_ONLY';
      end if;
    elsif new.trial_ends_at is distinct from old.trial_ends_at
       or new.billing_exempt is distinct from old.billing_exempt then
      raise exception 'RESTAURANT_BILLING_COLUMNS_READ_ONLY';
    end if;
  end if;
  return new;
end;
$$;

create trigger restaurants_guard_billing_columns
  before insert or update on public.restaurants
  for each row execute function public.restaurants_guard_billing_columns();

revoke execute on function public.restaurants_guard_billing_columns() from public, anon, authenticated;

-- Starter now costs $19/month. Its Stripe price comes from
-- scripts/setup-stripe-prices.ts, run by hand (it writes to live Stripe).
update public.platform_plans set monthly_price_cents = 1900 where slug = 'starter';


-- Whether this restaurant may take new QR orders, billing-wise. Fails open.
create function public.restaurant_billing_ok(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select r.billing_exempt
        or r.trial_ends_at is null
        or now() < r.trial_ends_at + interval '7 days'
        or exists (
          select 1 from public.restaurant_subscriptions s
          where s.restaurant_id = r.id
            and (s.status in ('trialing', 'active', 'past_due')
                 or (s.current_period_end is not null
                     and now() < s.current_period_end + interval '7 days'))
        )
    from public.restaurants r
    where r.id = p_restaurant_id
  ), true)
$$;

comment on function public.restaurant_billing_ok(uuid) is
  'False only when a non-exempt restaurant is past its free month plus 7 days of grace with no subscription Stripe is collecting on. Fails open. See 20261018120000_free_month_then_starter.sql.';

revoke execute on function public.restaurant_billing_ok(uuid) from public, anon, authenticated;


-- The lock: new orders refused once billing has lapsed, whatever page or
-- AI tool tried. The message is the existing "not accepting orders" one.
create function public.refuse_order_when_billing_lapsed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.restaurant_billing_ok(new.restaurant_id) then
    raise exception 'ORDER_RESTAURANT_UNAVAILABLE: this restaurant is not currently accepting orders'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.refuse_order_when_billing_lapsed() from public, anon, authenticated;

create trigger trg_orders_refuse_when_billing_lapsed
  before insert on public.orders
  for each row
  execute function public.refuse_order_when_billing_lapsed();


-- The door: diner pages and the AI waiter read accepting_orders from here,
-- so a lapsed restaurant's menu says it isn't taking orders before anyone
-- builds a cart. The restaurant's own setting is left untouched.
create or replace function public.get_public_order_settings(target_restaurant_id uuid)
returns table (
  accepting_orders boolean,
  allow_customer_notes boolean,
  allow_ai_recommendations boolean,
  allow_upselling boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select accepting_orders and public.restaurant_billing_ok(restaurant_id),
         allow_customer_notes, allow_ai_recommendations, allow_upselling
  from public.restaurant_settings
  where restaurant_id = target_restaurant_id
$$;


-- No platform fee during the free month.
create or replace function public.platform_fee_minor_units(
  p_restaurant_id uuid,
  p_total_minor_units integer
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (
      select 1 from public.restaurants r
      where r.id = p_restaurant_id
        and not r.billing_exempt
        and r.trial_ends_at > now()
    ) then 0
    else floor(
      p_total_minor_units::numeric
      * coalesce(
          (select pl.fee_bps
           from public.restaurant_plans rp
           join public.platform_plans pl on pl.id = rp.plan_id
           where rp.restaurant_id = p_restaurant_id),
          (select pl.fee_bps from public.platform_plans pl where pl.is_default),
          0
        )
      / 10000
    )::integer
  end
$$;


-- What the dashboard shows a restaurant's own staff.
create function public.get_restaurant_billing(target_restaurant_id uuid)
returns table (
  state text,
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  subscription_status text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_r public.restaurants%rowtype;
  v_status text;
  v_period_end timestamptz;
  v_grace timestamptz;
begin
  if public.current_restaurant_role(target_restaurant_id) is null then
    raise exception 'BILLING_FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_r from public.restaurants where id = target_restaurant_id;
  select s.status, s.current_period_end into v_status, v_period_end
  from public.restaurant_subscriptions s
  where s.restaurant_id = target_restaurant_id;

  v_grace := greatest(v_r.trial_ends_at, v_period_end) + interval '7 days';

  return query select
    case
      when v_r.billing_exempt or v_r.trial_ends_at is null then 'exempt'
      when v_status = 'past_due' then 'past_due'
      when v_status in ('trialing', 'active') then 'subscribed'
      when now() < v_r.trial_ends_at then 'trial'
      when now() < v_grace then 'grace'
      else 'lapsed'
    end,
    v_r.trial_ends_at,
    v_grace,
    v_status;
end;
$$;

comment on function public.get_restaurant_billing(uuid) is
  'A restaurant''s billing state for its own members: exempt, trial, subscribed, past_due, grace or lapsed, with the dates behind it.';

revoke execute on function public.get_restaurant_billing(uuid) from public, anon;
grant execute on function public.get_restaurant_billing(uuid) to authenticated;
