-- A guest who pays on their phone after the bill was already settled gets
-- their money back, and the restaurant hears about it.
--
-- The busy-Saturday audit (finding 3): a guest starts paying on their
-- phone, a server takes cash for the same table meanwhile, then the phone
-- payment completes. enforce_one_succeeded_payment_per_order()
-- (20260902090000) rightly refuses to count the second payment, but the
-- error went straight back to the webhook: Stripe and Square kept
-- retrying, the guest stayed charged, and nobody was told.
--
-- Now the settle functions catch that refusal, record it here and return
-- 'double_paid'. The webhook refunds the guest in full (Tableside's fee
-- included) and records how that went; Settle up shows it to the
-- restaurant until someone acknowledges it. The late payment itself is
-- marked cancelled: it never counted.

create table public.payment_conflicts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  payment_id uuid not null references public.order_payments (id) on delete cascade,
  provider text not null,
  -- The PaymentIntent (Stripe) or payment (Square) that charged the guest.
  provider_payment_id text not null,
  amount numeric(10, 2) not null,
  currency text not null,
  refund_status text not null default 'pending',
  provider_refund_id text,
  refund_error text,
  detected_at timestamptz not null default now(),
  refunded_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id) on delete set null,

  constraint payment_conflicts_provider_valid check (provider in ('stripe', 'square')),
  constraint payment_conflicts_refund_status_valid
    check (refund_status in ('pending', 'refunded', 'failed')),
  constraint payment_conflicts_once unique (provider, provider_payment_id)
);

create index payment_conflicts_open_idx
  on public.payment_conflicts (restaurant_id)
  where acknowledged_at is null;

alter table public.payment_conflicts enable row level security;

-- Everyone working the floor sees it: it's the server who took the cash
-- who needs to know the guest also paid.
create policy "payment_conflicts_select_members"
  on public.payment_conflicts
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

revoke all on public.payment_conflicts from anon;
revoke insert, update, delete on public.payment_conflicts from authenticated;

-- ---------------------------------------------------------------------------
-- Recording one. Internal: only the settle functions below call it.
-- ---------------------------------------------------------------------------

create function public.record_payment_conflict(
  p_payment_id uuid,
  p_provider text,
  p_provider_payment_id text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
  v_id uuid;
begin
  select * into v_payment from public.order_payments where id = p_payment_id;

  insert into public.payment_conflicts
    (restaurant_id, payment_id, provider, provider_payment_id, amount, currency)
  values
    (v_payment.restaurant_id, v_payment.id, p_provider, p_provider_payment_id,
     v_payment.total_amount, v_payment.currency)
  on conflict (provider, provider_payment_id) do nothing
  returning id into v_id;

  update public.order_payments
  set status = 'cancelled'
  where id = p_payment_id and status = 'pending';

  if v_id is null then
    select id into v_id from public.payment_conflicts
    where provider = p_provider and provider_payment_id = p_provider_payment_id;
  end if;
  return v_id;
end;
$$;

revoke execute on function public.record_payment_conflict(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_payment_conflict(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Stripe: settle a completed Checkout session. Replaces the webhook's use
-- of mark_order_payment_succeeded() (kept for anything still calling it),
-- answering what happened instead of raising on a double payment.
-- ---------------------------------------------------------------------------

create function public.settle_stripe_checkout(
  p_checkout_session_id text,
  p_payment_intent_id text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
  v_charge text := coalesce(p_payment_intent_id, p_checkout_session_id);
begin
  select * into v_payment
  from public.order_payments
  where stripe_checkout_session_id = p_checkout_session_id;

  if not found then
    return 'unknown';
  end if;
  if v_payment.status = 'succeeded' then
    return 'already';
  end if;
  -- A webhook replay after the conflict was recorded.
  if exists (
    select 1 from public.payment_conflicts
    where provider = 'stripe' and provider_payment_id = v_charge
  ) then
    return 'double_paid';
  end if;

  begin
    update public.order_payments
    set status = 'succeeded',
        paid_at = now(),
        stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id)
    where id = v_payment.id;
  exception when unique_violation then
    if sqlerrm not like 'PAYMENT_ORDER_ALREADY_SETTLED%' then
      raise;
    end if;
    perform public.record_payment_conflict(v_payment.id, 'stripe', v_charge);
    return 'double_paid';
  end;

  return 'settled';
end;
$$;

comment on function public.settle_stripe_checkout(text, text) is
  'Settles a paid Checkout session from a verified Stripe webhook: settled, already, unknown, or double_paid (the bill was settled another way first; recorded in payment_conflicts for a refund). service_role only.';

revoke execute on function public.settle_stripe_checkout(text, text) from public, anon, authenticated;
grant execute on function public.settle_stripe_checkout(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Square: the one settlement path (20261111090000), now answering
-- 'double_paid' instead of raising.
-- ---------------------------------------------------------------------------

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
  -- A webhook replay after the conflict was recorded (the payment is
  -- cancelled by then, which would otherwise read as a mismatch).
  if exists (
    select 1 from public.payment_conflicts
    where provider = 'square' and provider_payment_id = p_square_payment_id
  ) then
    return 'double_paid';
  end if;
  if v_payment.status <> 'pending' or upper(p_currency) <> v_payment.currency then
    return 'mismatch';
  end if;

  -- Cents for most currencies, whole yen for JPY.
  v_scale := case when v_payment.currency = 'JPY' then 1 else 100 end;

  begin
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
  exception when unique_violation then
    if sqlerrm not like 'PAYMENT_ORDER_ALREADY_SETTLED%' then
      raise;
    end if;
    -- What the guest was actually charged, a device-added tip included.
    update public.order_payments
    set square_payment_id = p_square_payment_id,
        tip_amount = case when tip_on_device then v_tip::numeric / v_scale else tip_amount end
    where id = v_payment.id;
    perform public.record_payment_conflict(v_payment.id, 'square', p_square_payment_id);
    return 'double_paid';
  end;

  return 'settled';
end;
$$;

comment on function public.settle_square_payment(text, text, bigint, bigint, text) is
  'Settles any Square payment (online or Terminal) after the server or the signed webhook has read it from Square: settled, already, unknown, mismatch, or double_paid (recorded in payment_conflicts for a refund). service_role only.';

revoke execute on function public.settle_square_payment(text, text, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.settle_square_payment(text, text, bigint, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- How the refund went. service_role: the webhook records it.
-- ---------------------------------------------------------------------------

create function public.record_payment_conflict_refund(
  p_conflict_id uuid,
  p_refund_id text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payment_conflicts
  set refund_status = case when p_refund_id is not null then 'refunded' else 'failed' end,
      provider_refund_id = coalesce(p_refund_id, provider_refund_id),
      refund_error = case when p_refund_id is not null then null else left(p_error, 500) end,
      refunded_at = case when p_refund_id is not null then now() else refunded_at end
  where id = p_conflict_id and refund_status <> 'refunded';
end;
$$;

revoke execute on function public.record_payment_conflict_refund(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_payment_conflict_refund(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- "Got it", from Settle up. An owner or manager closes the notice; staff
-- keep seeing it until then.
-- ---------------------------------------------------------------------------

create function public.acknowledge_payment_conflict(p_conflict_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
begin
  select restaurant_id into v_restaurant_id
  from public.payment_conflicts where id = p_conflict_id;
  if v_restaurant_id is null
     or coalesce(public.current_restaurant_role(v_restaurant_id), '') not in ('owner', 'manager') then
    raise exception 'PAYMENT_FORBIDDEN: only an owner or manager can close this' using errcode = '42501';
  end if;
  update public.payment_conflicts
  set acknowledged_at = now(), acknowledged_by = auth.uid()
  where id = p_conflict_id and acknowledged_at is null;
end;
$$;

revoke execute on function public.acknowledge_payment_conflict(uuid) from public, anon;
grant execute on function public.acknowledge_payment_conflict(uuid) to authenticated, service_role;
