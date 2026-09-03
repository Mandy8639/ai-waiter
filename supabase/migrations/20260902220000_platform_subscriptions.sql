-- Platform billing, part 2 — the monthly half.
--
-- Part 1 took a share of each card payment, which earns nothing from a
-- restaurant that trades mostly in cash. This is the subscription that
-- closes that gap.
--
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- Nothing here enforces payment. A restaurant whose subscription lapses
-- keeps working exactly as before, and the dashboard simply says so.
-- Enforcement was considered and declined for now: a false positive —
-- a webhook that arrives late, a card that fails once — would take a real
-- restaurant offline mid-service, which is a far worse failure than a
-- missed month of revenue. When enforcement does arrive it should be a
-- deliberate decision with its own migration, not a side effect of this
-- one.
--
--
-- WHY THE SUBSCRIPTION LIVES ON THE PLATFORM ACCOUNT
--
-- Order payments are DIRECT charges on the restaurant's connected
-- account: the diner pays the restaurant. A subscription is the opposite
-- direction — the restaurant pays the platform — so its customer and
-- subscription objects belong to the platform account, and its events
-- arrive from a different source than every webhook this app handles
-- today. That is why the route reading them is separate.

alter table public.platform_plans
  add column stripe_price_id text;

comment on column public.platform_plans.stripe_price_id is
  'The Stripe Price this plan subscribes to. Null for a free plan, which needs no subscription at all — see scripts/setup-stripe-prices.ts for how these are created.';

-- A FREE plan must not name a price: there is nothing to charge for, and
-- a price id on it would make "Subscribe" offer a charge nobody agreed to.
--
-- The reverse is deliberately NOT enforced. A paid plan legitimately has
-- no price id until scripts/setup-stripe-prices.ts creates it, and a
-- constraint requiring one would make this migration unappliable against
-- the existing rows. The application checks it instead, at the only place
-- it matters: startSubscriptionCheckout() refuses a plan with no price
-- rather than opening a checkout Stripe cannot build.
alter table public.platform_plans
  add constraint platform_plans_free_has_no_price check (
    monthly_price_cents > 0 or stripe_price_id is null
  );


create table public.restaurant_subscriptions (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  plan_id uuid not null references public.platform_plans (id) on delete restrict,

  -- Stripe's own identifiers, on the PLATFORM account rather than the
  -- restaurant's connected one.
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique,

  -- Mirrors Stripe's subscription status verbatim rather than
  -- reinterpreting it. A local vocabulary would drift from the source of
  -- truth the moment Stripe adds a state.
  status text not null,

  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint restaurant_subscriptions_status_valid check (
    status in (
      'trialing', 'active', 'past_due', 'canceled',
      'incomplete', 'incomplete_expired', 'unpaid', 'paused'
    )
  )
);

comment on table public.restaurant_subscriptions is
  'A restaurant''s subscription to the platform, on the platform Stripe account. Status mirrors Stripe verbatim. Nothing here gates access — a lapsed subscription is recorded and shown, never enforced. See docs/security.md#platform-billing.';

create index restaurant_subscriptions_status_idx
  on public.restaurant_subscriptions (status);

create trigger restaurant_subscriptions_set_updated_at
  before update on public.restaurant_subscriptions
  for each row execute function public.set_updated_at();

alter table public.restaurant_subscriptions enable row level security;

-- A restaurant's own members may see what it is subscribed to. Writes come
-- only from the webhook, through the service-role function below — there
-- is no client-facing write policy at all, because a subscription's state
-- is Stripe's to assert, not a browser's.
create policy "restaurant_subscriptions_select_members"
  on public.restaurant_subscriptions
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));


-- Records what Stripe says about a subscription.
--
-- Upsert rather than insert-or-update-by-hand: Stripe delivers
-- subscription events out of order and more than once, and every one of
-- them carries the complete current state. Writing the whole row each time
-- makes a duplicate or late delivery harmless.
create function public.record_restaurant_subscription(
  p_restaurant_id uuid,
  p_plan_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.restaurant_subscriptions (
    restaurant_id, plan_id, stripe_customer_id, stripe_subscription_id,
    status, current_period_end, cancel_at_period_end
  ) values (
    p_restaurant_id, p_plan_id, p_stripe_customer_id, p_stripe_subscription_id,
    p_status, p_current_period_end, coalesce(p_cancel_at_period_end, false)
  )
  on conflict (restaurant_id) do update
  set plan_id = excluded.plan_id,
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end;

  -- A subscription IS the plan assignment. Keeping restaurant_plans in
  -- step here means the per-transaction fee from part 1 follows the plan
  -- someone actually pays for, rather than the two disagreeing about which
  -- plan a restaurant is on.
  insert into public.restaurant_plans (restaurant_id, plan_id)
  values (p_restaurant_id, p_plan_id)
  on conflict (restaurant_id) do update set plan_id = excluded.plan_id;
end;
$$;

comment on function public.record_restaurant_subscription is
  'Records Stripe''s view of a subscription and keeps restaurant_plans in step, so the per-payment fee follows the plan being paid for. Service role only — subscription state is Stripe''s to assert.';

revoke execute on function public.record_restaurant_subscription(
  uuid, uuid, text, text, text, timestamptz, boolean
) from public;
grant execute on function public.record_restaurant_subscription(
  uuid, uuid, text, text, text, timestamptz, boolean
) to service_role;
