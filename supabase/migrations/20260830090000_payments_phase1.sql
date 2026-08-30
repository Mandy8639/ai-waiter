-- Payments, phase 1 of 3: Stripe Connect onboarding and per-restaurant
-- payment settings. Deliberately moves no money — nothing here creates a
-- charge. See the plan for the full three-phase shape; phase 2 adds
-- payments/payment_orders and card charging, phase 3 adds session tabs,
-- cash and refunds.
--
-- Money routing is Stripe Connect with DIRECT charges onto each
-- restaurant's own connected account, so the restaurant is the merchant of
-- record and funds never rest in a platform account. That is a deliberate
-- decision to avoid the platform acting as a money transmitter.
--
-- IMPORTANT — a security invariant changes here, and it is contained on
-- purpose. Until now no request-path code has ever used the RLS-bypassing
-- service-role client (see docs/security.md#server-only-secrets); it
-- appeared only in a local seed script. A Stripe webhook carries no user
-- session, so its only authentication is the request signature, and it
-- must therefore write as service_role. The tables below are shaped so
-- that this is the ONLY thing the webhook can do: it may update capability
-- flags and record event ids, and nothing else. Row creation and any
-- change to stripe_account_id still go through a SECURITY DEFINER function
-- gated on a real owner/manager, exactly like every other write in this
-- schema.

-- ---------------------------------------------------------------------
-- Per-restaurant payment configuration
-- ---------------------------------------------------------------------
--
-- Defaults are chosen so that applying this migration changes NOTHING for
-- any restaurant already taking orders. 'at_end' is the permissive mode —
-- it never blocks an order from reaching the kitchen — and card acceptance
-- is off until a restaurant has actually connected an account. If the
-- defaults were reversed, phase 2 would silently start requiring payment
-- before the kitchen could see an order, breaking every existing
-- restaurant the moment it shipped.
alter table public.restaurant_settings
  add column payment_timing text not null default 'at_end',
  add column accept_card boolean not null default false,
  add column accept_cash boolean not null default false,
  add column tipping_enabled boolean not null default false;

alter table public.restaurant_settings
  add constraint restaurant_settings_payment_timing_valid
  check (payment_timing in ('at_order', 'at_end'));

comment on column public.restaurant_settings.payment_timing is
  'at_order: an order may not leave ''pending'' until a succeeded payment covers it (enforced in phase 2). at_end: orders flow to the kitchen immediately and the session tab is settled afterwards. Defaults to at_end so existing restaurants are unaffected.';
comment on column public.restaurant_settings.accept_card is
  'Card payment via the restaurant''s connected Stripe account. Off by default — meaningless until restaurant_payment_accounts.charges_enabled is true.';
comment on column public.restaurant_settings.accept_cash is
  'Lets staff record an order as settled in cash, so a day''s takings reconcile in one place (phase 3).';
comment on column public.restaurant_settings.tipping_enabled is
  'Offer a tip at checkout. A tip lives on the payment, never on the order — orders.total is immutable by trigger.';

-- ---------------------------------------------------------------------
-- Stripe Connect account linkage
-- ---------------------------------------------------------------------
create table public.restaurant_payment_accounts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants (id) on delete cascade,
  stripe_account_id text not null unique,

  -- Mirrored from Stripe via the account.updated webhook. Never trusted as
  -- a source of truth for whether a charge will succeed — it is a cache of
  -- Stripe's own answer, refreshed asynchronously, and phase 2 re-checks
  -- charges_enabled before attempting anything.
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint restaurant_payment_accounts_stripe_id_format
    check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$')
);

comment on table public.restaurant_payment_accounts is
  'One Stripe Connect account per restaurant. Capability flags are a cache of Stripe''s state, refreshed by the account.updated webhook. See docs/security.md#payments.';

create index restaurant_payment_accounts_stripe_account_id_idx
  on public.restaurant_payment_accounts (stripe_account_id);

create trigger trg_restaurant_payment_accounts_set_updated_at
  before update on public.restaurant_payment_accounts
  for each row
  execute function public.set_updated_at();

alter table public.restaurant_payment_accounts enable row level security;

-- Readable by owner/manager only: this is commercial configuration, not
-- something kitchen or floor staff need, and it names an external
-- financial account.
create policy "restaurant_payment_accounts_select_owner_manager"
  on public.restaurant_payment_accounts
  for select
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

-- No INSERT/UPDATE/DELETE policy for any role. Writes come from
-- link_restaurant_payment_account() below, or from the webhook as
-- service_role (which bypasses RLS by design) for capability flags only.

-- The one path that attaches a Stripe account to a restaurant.
-- SECURITY DEFINER so it can write a table with no write policy, but it
-- re-derives the caller's role itself rather than trusting anything passed
-- in — the same shape as add_restaurant_staff_by_email().
create function public.link_restaurant_payment_account(
  p_restaurant_id uuid,
  p_stripe_account_id text
)
returns public.restaurant_payment_accounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_row public.restaurant_payment_accounts%rowtype;
begin
  if v_user_id is null then
    raise exception 'PAYMENT_ACCOUNT_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  v_role := public.current_restaurant_role(p_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'PAYMENT_ACCOUNT_FORBIDDEN: insufficient role' using errcode = '42501';
  end if;

  if p_stripe_account_id !~ '^acct_[A-Za-z0-9]+$' then
    raise exception 'PAYMENT_ACCOUNT_INVALID_ID: not a Stripe account id' using errcode = '22023';
  end if;

  -- Re-running onboarding for a restaurant that already has an account is
  -- a no-op rather than an error: Stripe's hosted flow can be abandoned
  -- and resumed, and the caller should not have to care which it is.
  insert into public.restaurant_payment_accounts (restaurant_id, stripe_account_id)
  values (p_restaurant_id, p_stripe_account_id)
  on conflict (restaurant_id) do update
    set stripe_account_id = excluded.stripe_account_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.link_restaurant_payment_account(uuid, text) is
  'Attaches a Stripe Connect account to a restaurant. owner/manager only; re-runnable. Capability flags are not set here — they arrive from Stripe via the account.updated webhook.';

revoke execute on function public.link_restaurant_payment_account(uuid, text) from public;
grant execute on function public.link_restaurant_payment_account(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Webhook replay protection
-- ---------------------------------------------------------------------
--
-- Stripe retries deliveries and can deliver the same event more than once;
-- phase 2 makes that dangerous (a replayed payment_intent.succeeded must
-- not settle an order twice). Recording ids here, with a unique constraint
-- doing the actual work, makes handling idempotent from the first phase
-- rather than bolted on once money is involved.
--
-- Platform infrastructure, not tenant data: RLS is enabled with NO
-- policies at all, so no authenticated user can read or write it. Only
-- service_role — the webhook — touches this table.
create table public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,

  constraint stripe_webhook_events_id_not_blank check (length(trim(stripe_event_id)) > 0)
);

comment on table public.stripe_webhook_events is
  'Every Stripe event id this app has accepted, so a retried or replayed delivery is processed at most once. No RLS policies by design: service_role only.';

create index stripe_webhook_events_received_at_idx
  on public.stripe_webhook_events (received_at desc);

alter table public.stripe_webhook_events enable row level security;

-- Refreshes the cached capability flags from a caller who has just asked
-- Stripe directly. Two callers need this: the account.updated webhook
-- (which writes as service_role and bypasses RLS), and the dashboard's
-- "refresh status" action — without which a developer running locally,
-- with no webhook endpoint reachable from Stripe, would never see their
-- account become chargeable.
--
-- The flags are a CACHE of Stripe's answer, never the authority. An
-- owner could call this RPC directly and claim charges_enabled — the only
-- consequence is that their own later charge attempt is rejected by
-- Stripe, since phase 2 re-checks capability with Stripe before charging.
-- No cross-tenant reach and no money at risk, so a role gate is the
-- appropriate level of protection here.
create function public.sync_restaurant_payment_account_status(
  p_restaurant_id uuid,
  p_charges_enabled boolean,
  p_payouts_enabled boolean,
  p_details_submitted boolean
)
returns public.restaurant_payment_accounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_row public.restaurant_payment_accounts%rowtype;
begin
  if v_user_id is null then
    raise exception 'PAYMENT_ACCOUNT_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  v_role := public.current_restaurant_role(p_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'PAYMENT_ACCOUNT_FORBIDDEN: insufficient role' using errcode = '42501';
  end if;

  update public.restaurant_payment_accounts
  set charges_enabled = p_charges_enabled,
      payouts_enabled = p_payouts_enabled,
      details_submitted = p_details_submitted
  where restaurant_id = p_restaurant_id
  returning * into v_row;

  if not found then
    raise exception 'PAYMENT_ACCOUNT_NOT_FOUND: no Stripe account is linked to this restaurant'
      using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

comment on function public.sync_restaurant_payment_account_status(uuid, boolean, boolean, boolean) is
  'Updates the cached Stripe capability flags. Called by the dashboard after querying Stripe, and mirrored by the account.updated webhook. Advisory cache only — phase 2 re-checks with Stripe before charging.';

revoke execute on function public.sync_restaurant_payment_account_status(uuid, boolean, boolean, boolean) from public;
grant execute on function public.sync_restaurant_payment_account_status(uuid, boolean, boolean, boolean) to authenticated;
