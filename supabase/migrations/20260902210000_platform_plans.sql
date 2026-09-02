-- Platform billing, part 1 — what the platform charges, and the
-- per-transaction half of collecting it.
--
-- Until now this platform earned nothing. Connected accounts are created
-- with `fees_collector: 'stripe'`, so each restaurant already bears
-- Stripe's own fees, and no charge carried an application_fee_amount:
-- every penny of every payment went to the restaurant.
--
--
-- WHY PLANS ARE A TABLE AND NOT A CONSTANT
--
-- A price list changes, and when it does the old price must keep applying
-- to whoever is on it. A constant in the code changes everyone's price
-- retroactively at the next deploy, which is the sort of thing a customer
-- notices before you do.
--
-- The monthly price is stored here even though nothing charges it yet.
-- That is not schema-ahead-of-caller in the sense that has bitten this
-- project three times: a plan legitimately HAS a price, and naming it is
-- part of defining the plan. What does not exist yet is the subscription
-- that bills it — and no table pretends otherwise, because none is
-- created here. Subscriptions arrive with the code that charges them.
--
--
-- BASIS POINTS, NOT PERCENT
--
-- fee_bps is an integer in basis points (100 bps = 1%). A numeric percent
-- invites 0.015 vs 1.5 confusion at exactly the place where the mistake is
-- a silent overcharge of a real restaurant.

create table public.platform_plans (
  id uuid primary key default gen_random_uuid(),
  -- Stable, human-readable key used in code and support conversations.
  -- The display name can change; this cannot.
  slug text not null unique,
  name text not null,

  -- The monthly subscription price. Recorded now, charged in part 2.
  monthly_price_cents integer not null,
  currency text not null default 'USD',

  -- The platform's cut of each card payment, in basis points.
  fee_bps integer not null,

  -- Exactly one plan is given to restaurants that have never chosen one.
  is_default boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint platform_plans_slug_not_blank check (length(trim(slug)) > 0),
  constraint platform_plans_monthly_price_non_negative check (monthly_price_cents >= 0),
  -- A ceiling as well as a floor. 1000 bps is 10%; anything above that is
  -- far more likely to be a typo than a pricing decision, and the failure
  -- mode is overcharging every diner at that restaurant.
  constraint platform_plans_fee_bps_sane check (fee_bps >= 0 and fee_bps <= 1000)
);

comment on table public.platform_plans is
  'What the platform charges restaurants. monthly_price_cents is recorded but not yet billed — see docs/security.md#platform-billing.';
comment on column public.platform_plans.fee_bps is
  'The platform''s cut of each card payment, in basis points (100 = 1%). Integer rather than a numeric percent so 1.5% cannot be misread as 150%.';

-- Only one default, enforced rather than trusted: two defaults would make
-- which plan a new restaurant lands on depend on row order.
create unique index platform_plans_single_default
  on public.platform_plans (is_default)
  where is_default;

create trigger platform_plans_set_updated_at
  before update on public.platform_plans
  for each row execute function public.set_updated_at();


-- Which plan a restaurant is on. Separate from restaurants so that a
-- restaurant with no row is unambiguously "on the default" rather than
-- carrying a null that every reader has to interpret.
create table public.restaurant_plans (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  plan_id uuid not null references public.platform_plans (id) on delete restrict,
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.restaurant_plans is
  'A restaurant''s chosen plan. No row means the default plan applies. ON DELETE RESTRICT on plan_id so a plan someone is on cannot be deleted out from under them.';

create trigger restaurant_plans_set_updated_at
  before update on public.restaurant_plans
  for each row execute function public.set_updated_at();

alter table public.platform_plans enable row level security;
alter table public.restaurant_plans enable row level security;

-- Plans are the price list: any signed-in user may read them, because a
-- restaurant deciding whether to sign up needs to see what it would pay.
-- Nobody may write them from the client; pricing changes are a migration
-- or a console action, deliberately.
create policy "platform_plans_select_all"
  on public.platform_plans
  for select
  to authenticated
  using (true);

-- A restaurant's own assignment is visible to its members and no one else.
create policy "restaurant_plans_select_members"
  on public.restaurant_plans
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));


-- The launch price list. Deliberately conservative on the fee: this is
-- taken from every card payment, and a rate that turns out to be too low
-- is a conversation, while one that is too high is a refund.
insert into public.platform_plans (slug, name, monthly_price_cents, fee_bps, is_default)
values
  ('starter', 'Starter', 0, 100, true),
  ('standard', 'Standard', 4900, 50, false),
  ('pro', 'Pro', 14900, 25, false);


-- What the platform takes from one payment.
--
-- Returns minor units, because that is what Stripe's application_fee_amount
-- wants and converting in two places is how the two drift apart.
--
-- Rounds DOWN. A fee is a share of someone else's money; rounding a
-- fraction of a cent in the platform's favour on every transaction is both
-- wrong and the kind of wrong that compounds quietly.
create function public.platform_fee_minor_units(
  p_restaurant_id uuid,
  p_total_minor_units integer
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select floor(
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
$$;

comment on function public.platform_fee_minor_units(uuid, integer) is
  'The platform''s cut of one payment, in minor units, from the restaurant''s plan (or the default). Rounds down: a fraction of a cent is never taken in the platform''s favour. Returns 0 when no plan and no default exist, so a misconfigured price list charges nothing rather than guessing.';

revoke execute on function public.platform_fee_minor_units(uuid, integer) from public;
grant execute on function public.platform_fee_minor_units(uuid, integer) to authenticated;


-- The fee for one specific payment.
--
-- Takes the payment id rather than a restaurant id so the caller cannot
-- name a restaurant it does not own — the payment already knows which
-- restaurant it belongs to, and resolving it here means the fee is
-- computed from stored facts rather than from anything a browser sent.
--
-- The minor-unit amount is still passed in: converting numeric(10,2) to
-- minor units depends on the currency's decimal digits, and that
-- conversion already lives in one tested place (src/lib/payments/money.ts,
-- which handles zero-decimal currencies like JPY). Reimplementing it in
-- SQL would create a second version to drift.
create function public.platform_fee_for_payment(
  p_payment_id uuid,
  p_amount_minor_units integer
)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
begin
  select restaurant_id into v_restaurant_id
  from public.order_payments where id = p_payment_id;

  if not found then
    -- No payment, no fee. Raising would turn a monitoring-worthy oddity
    -- into a failed checkout for a diner who did nothing wrong.
    return 0;
  end if;

  return public.platform_fee_minor_units(v_restaurant_id, p_amount_minor_units);
end;
$$;

comment on function public.platform_fee_for_payment(uuid, integer) is
  'The platform''s cut of one payment, resolved from the payment''s own restaurant so a caller cannot name someone else''s. Returns 0 for an unknown payment rather than raising: a diner''s checkout must not fail over a billing lookup.';

revoke execute on function public.platform_fee_for_payment(uuid, integer) from public;
grant execute on function public.platform_fee_for_payment(uuid, integer) to authenticated;
