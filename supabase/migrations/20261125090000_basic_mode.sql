-- Basic mode, and Tableside is free (decided 2026-10-28).
--
-- Tableside now sells one thing: guests scan the table's code, read the
-- menu, ask the AI waiter, and order; the order goes to the kitchen. Paying
-- stays exactly as the restaurant does it today (the server brings the
-- bill), so there is nothing to integrate and no fee to justify.
--
-- Everything else that was built (card and cash payments, Settle up, the
-- POS screen, Square and Clover, reservations, takings reports) stays in
-- the code, switched off per restaurant by restaurants.basic_mode, so it
-- can come back one restaurant at a time when the product expands.
--
-- What basic mode does here, in the database:
--   * get_public_payment_settings() says no card, so diner pages show no
--     pay buttons and no split.
--   * order_payments refuses new rows, so no page, server action, webhook
--     or AI tool can take a payment, whatever its path. ($0 'comp' rows
--     are allowed: they record an adjustment, not money.)
-- The app hides the pages (src/components/dashboard/nav-items.ts).
--
-- And free: every restaurant is billing-exempt (never paused, no
-- subscription needed) and the platform fee is 0. When charging starts,
-- a new migration turns the free month back on.

alter table public.restaurants
  add column basic_mode boolean not null default true;

comment on column public.restaurants.basic_mode is
  'QR menu, AI waiter and kitchen only: no payments, POS, Settle up, reservations or takings reports. On for every restaurant; only the platform owner turns it off. See 20261125090000_basic_mode.sql.';


-- ── Free for everyone ────────────────────────────────────────────────────

-- An exempt restaurant is never paused and pays no fee (below), so its
-- trial_ends_at no longer matters; it's left as it was, for when charging
-- starts.
alter table public.restaurants
  alter column billing_exempt set default true;

update public.restaurants
  set billing_exempt = true
  where billing_exempt = false;

-- Owners and managers may update their own restaurant row through RLS, so
-- they can't change these columns themselves. On INSERT (onboarding) the
-- values are set here rather than refused, because the column defaults
-- are what a new restaurant should get anyway: free, and basic.
-- (Previously 20261018120000: refused billing_exempt on insert.)
create or replace function public.restaurants_guard_billing_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.billing_exempt := true;
      new.basic_mode := true;
    elsif new.trial_ends_at is distinct from old.trial_ends_at
       or new.billing_exempt is distinct from old.billing_exempt
       or new.basic_mode is distinct from old.basic_mode then
      raise exception 'RESTAURANT_BILLING_COLUMNS_READ_ONLY';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.restaurants_guard_billing_columns() from public, anon, authenticated;

-- No platform fee for billing-exempt restaurants, which is now everyone.
-- (Previously 20261018120000: exempt restaurants paid their plan's fee.)
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
        and (r.billing_exempt or r.trial_ends_at > now())
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


-- ── No payments in basic mode ────────────────────────────────────────────

-- The door: diner pages read can_take_card from here.
-- (Previously 20261110090000.)
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
      and not r.basic_mode
      and (
        public.restaurant_card_provider(s.restaurant_id) = 'square'
        or coalesce(a.charges_enabled, false)
      ) as can_take_card,
    coalesce(s.tipping_enabled, false) as tipping_enabled
  from public.restaurant_settings s
  join public.restaurants r on r.id = s.restaurant_id
  left join public.restaurant_payment_accounts a
    on a.restaurant_id = s.restaurant_id
  where s.restaurant_id = target_restaurant_id
$$;

-- The lock: every way of taking money starts by inserting an
-- order_payments row (diner card, tab, split part, cash, card machine,
-- Square Terminal, Tap to Pay), so refusing it here covers them all.
create function public.refuse_payment_in_basic_mode()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.method <> 'comp' and exists (
    select 1 from public.restaurants
    where id = new.restaurant_id and basic_mode
  ) then
    raise exception 'PAYMENTS_OFF: this restaurant takes payment at the table, not in the app'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.refuse_payment_in_basic_mode() from public, anon, authenticated;

create trigger trg_order_payments_refuse_in_basic_mode
  before insert on public.order_payments
  for each row
  execute function public.refuse_payment_in_basic_mode();
