-- Admin Phase 8: plan prices and the free month, changed from /admin
-- (docs/admin.md).
--
-- Plans (platform_plans) already live in the database: monthly price, the
-- fee on card payments (fee_bps) and the Stripe price each subscribes to.
-- What was in code is the free month's length (30 days, the column default
-- on restaurants.trial_ends_at from 20261018120000). This moves it into a
-- server-only settings table, and adds the two functions /admin uses to
-- change plans and the free month, each recorded in a history.
--
-- How a price change behaves: a Stripe price can't be edited, so /admin
-- creates a NEW Stripe price and points the plan at it. New subscribers get
-- the new price; existing subscriptions stay on the price they signed up to
-- (Stripe never moves them by itself). A fee change applies to every
-- restaurant on the plan from its next card payment. A free-month change
-- applies to restaurants created after it; existing free months are left
-- alone.

create table public.platform_billing_settings (
  -- One row, always: id is fixed to true.
  id boolean primary key default true,
  free_month_days integer not null default 30,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),

  constraint platform_billing_settings_single_row check (id),
  constraint platform_billing_settings_free_month_range
    check (free_month_days between 0 and 90)
);

insert into public.platform_billing_settings (id, free_month_days)
values (true, 30);

comment on table public.platform_billing_settings is
  'Platform-wide billing settings changed on /admin (one row). free_month_days: how long a new restaurant pays no platform fee and needs no subscription. Server-only.';

create table public.platform_plan_history (
  id uuid primary key default gen_random_uuid(),
  -- Null for a free-month change, which isn't about one plan.
  plan_id uuid references public.platform_plans (id) on delete cascade,
  change text not null,
  old_value text,
  new_value text,
  -- For a price change: the Stripe price it replaced, and the new one.
  old_stripe_price_id text,
  new_stripe_price_id text,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),

  constraint platform_plan_history_change_valid
    check (change in ('monthly_price', 'fee', 'free_month'))
);

create index platform_plan_history_changed_at_idx
  on public.platform_plan_history (changed_at desc);

comment on table public.platform_plan_history is
  'Every plan price, card fee and free-month change made on /admin. Server-only.';

alter table public.platform_billing_settings enable row level security;
alter table public.platform_plan_history enable row level security;
revoke all on table public.platform_billing_settings from anon, authenticated;
revoke all on table public.platform_plan_history from anon, authenticated;

-- The free month's length, for the column default below. SECURITY DEFINER
-- because the settings table has no grants; it returns one number that is
-- also shown publicly on the landing page.
create function public.platform_free_month_days()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select free_month_days from public.platform_billing_settings where id),
    30
  )
$$;

revoke execute on function public.platform_free_month_days() from public, anon;
grant execute on function public.platform_free_month_days() to authenticated;

-- New restaurants get the free month as set on /admin.
alter table public.restaurants
  alter column trial_ends_at
  set default (now() + make_interval(days => public.platform_free_month_days()));

-- A plan's monthly price (with the Stripe price created for it) or fee.
-- service_role only: /admin calls it after its own checks.
create function public.admin_update_plan(
  p_plan_id uuid,
  p_monthly_price_cents integer,
  p_stripe_price_id text,
  p_fee_bps integer,
  p_user uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.platform_plans%rowtype;
begin
  select * into v_plan from public.platform_plans where id = p_plan_id for update;
  if not found then
    raise exception 'PLAN_NOT_FOUND';
  end if;

  if p_monthly_price_cents is not null
     and p_monthly_price_cents is distinct from v_plan.monthly_price_cents then
    -- A paid plan needs the Stripe price created for it; a free one must
    -- not name one (platform_plans_free_has_no_price).
    if p_monthly_price_cents > 0 and coalesce(p_stripe_price_id, '') = '' then
      raise exception 'PLAN_PRICE_NEEDS_STRIPE_PRICE';
    end if;
    update public.platform_plans
    set monthly_price_cents = p_monthly_price_cents,
        stripe_price_id = case when p_monthly_price_cents = 0 then null else p_stripe_price_id end
    where id = p_plan_id;
    insert into public.platform_plan_history
      (plan_id, change, old_value, new_value, old_stripe_price_id, new_stripe_price_id, changed_by)
    values (
      p_plan_id, 'monthly_price',
      v_plan.monthly_price_cents::text, p_monthly_price_cents::text,
      v_plan.stripe_price_id,
      case when p_monthly_price_cents = 0 then null else p_stripe_price_id end,
      p_user
    );
  end if;

  if p_fee_bps is not null and p_fee_bps is distinct from v_plan.fee_bps then
    update public.platform_plans set fee_bps = p_fee_bps where id = p_plan_id;
    insert into public.platform_plan_history
      (plan_id, change, old_value, new_value, changed_by)
    values (p_plan_id, 'fee', v_plan.fee_bps::text, p_fee_bps::text, p_user);
  end if;
end;
$$;

comment on function public.admin_update_plan(uuid, integer, text, integer, uuid) is
  'Changes a plan''s monthly price (with the new Stripe price created for it) and/or its card fee from /admin, recorded in platform_plan_history. service_role only.';

revoke execute on function public.admin_update_plan(uuid, integer, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.admin_update_plan(uuid, integer, text, integer, uuid) to service_role;

create function public.admin_set_free_month(p_days integer, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old integer;
begin
  select free_month_days into v_old
  from public.platform_billing_settings where id for update;

  if p_days is distinct from v_old then
    update public.platform_billing_settings
    set free_month_days = p_days, updated_by = p_user, updated_at = now()
    where id;
    insert into public.platform_plan_history
      (plan_id, change, old_value, new_value, changed_by)
    values (null, 'free_month', v_old::text, p_days::text, p_user);
  end if;
end;
$$;

comment on function public.admin_set_free_month(integer, uuid) is
  'Sets how many days a NEW restaurant''s free month lasts (0-90), from /admin, recorded in platform_plan_history. Existing free months are unchanged. service_role only.';

revoke execute on function public.admin_set_free_month(integer, uuid) from public, anon, authenticated;
grant execute on function public.admin_set_free_month(integer, uuid) to service_role;
