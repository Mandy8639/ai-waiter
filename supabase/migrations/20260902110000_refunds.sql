-- Payments phase 3, step 3 — refunds, full and partial.
--
-- This is the first code that moves money OUTWARD, so the failure that
-- matters is the mirror of phase 2's: not charging twice, but refunding
-- more than was ever charged. Everything below is arranged around that.
--
--
-- REFUNDS ARE THEIR OWN RECORDS, NOT A FLAG ON THE PAYMENT
--
-- A payment can be refunded in parts, on different days, by different
-- people, for different reasons. A `refunded` boolean or a single
-- `refunded_amount` column cannot answer "who refunded what, and why",
-- which is the question anyone actually asks. So each refund is a row.
--
-- The payment itself stays `succeeded` after a refund, including a full
-- one. It DID succeed; that is a historical fact and rewriting it would
-- lose the distinction between "never paid" and "paid then refunded".
-- Whether an order is currently settled is therefore a question about
-- payments AND refunds — see payment_refunded_total() below.
--
--
-- WHY REFUNDS ARE CARD-ONLY
--
-- Reversing cash is a bookkeeping correction (step 2, reverse_cash_payment)
-- because no processor was involved. A card refund moves money back
-- through Stripe. Conflating the two would either mark an order unpaid
-- while the customer's money stayed taken, or attempt a Stripe refund
-- against a payment Stripe never saw.

create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  -- ON DELETE RESTRICT, not CASCADE: a payment with refunds against it
  -- must not be removable, or the money-out record vanishes with it.
  payment_id uuid not null references public.order_payments (id) on delete restrict,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,

  amount numeric(10, 2) not null,
  currency text not null,
  reason text not null,

  status text not null default 'pending',
  stripe_refund_id text,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  refunded_at timestamptz,

  constraint payment_refunds_amount_positive check (amount > 0),
  constraint payment_refunds_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint payment_refunds_status_valid check (
    status in ('pending', 'succeeded', 'failed', 'cancelled')
  ),
  constraint payment_refunds_reason_length check (
    length(trim(reason)) between 1 and 500
  ),
  constraint payment_refunds_refunded_at_matches_status check (
    (status = 'succeeded' and refunded_at is not null)
    or (status <> 'succeeded' and refunded_at is null)
  )
);

comment on table public.payment_refunds is
  'Money returned against a payment. One row per refund — a payment may be refunded in parts, by different people, for different reasons. See docs/security.md#payments.';

create unique index payment_refunds_stripe_refund_id_key
  on public.payment_refunds (stripe_refund_id)
  where stripe_refund_id is not null;

create index payment_refunds_payment_id_idx on public.payment_refunds (payment_id);
create index payment_refunds_restaurant_id_idx on public.payment_refunds (restaurant_id);

create trigger trg_payment_refunds_set_updated_at
  before update on public.payment_refunds
  for each row
  execute function public.set_updated_at();

alter table public.payment_refunds enable row level security;

-- Staff-only, and unlike payments this is NOT shown to the diner here:
-- the customer-facing surface shows what they paid, and a refund reaches
-- them through their bank. Exposing internal reasons ("suspected card
-- fraud") to the payer is not something to do by accident.
create policy "payment_refunds_select_staff"
  on public.payment_refunds
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- No INSERT/UPDATE/DELETE policy for any role — same stance as every other
-- money table. Only the SECURITY DEFINER functions and the webhook write.


-- How much of a payment has been given back. Counts pending refunds as
-- committed: a refund in flight has already been asked of Stripe, so
-- ignoring it here is how you refund the same money twice.
create function public.payment_refunded_total(p_payment_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(r.amount), 0)
  from public.payment_refunds r
  where r.payment_id = p_payment_id
    and r.status in ('pending', 'succeeded')
$$;

comment on function public.payment_refunded_total(uuid) is
  'Total refunded against a payment, counting pending refunds as committed — a refund already asked of Stripe must not be refundable again. See docs/security.md#payments.';

grant execute on function public.payment_refunded_total(uuid) to authenticated;


-- THE central invariant of this step: never give back more than was taken.
--
-- A trigger rather than a CHECK constraint, because the limit lives on
-- another table (order_payments.total_amount) and the sum spans rows.
-- Locks the payment row first so two concurrent refunds cannot each see
-- room for themselves and both proceed.
create function public.enforce_refund_within_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_charged numeric(10, 2);
  v_refunded numeric(10, 2);
begin
  if NEW.status = 'failed' or NEW.status = 'cancelled' then
    return NEW;
  end if;

  select total_amount into v_charged
  from public.order_payments
  where id = NEW.payment_id
  for update;

  select coalesce(sum(r.amount), 0) into v_refunded
  from public.payment_refunds r
  where r.payment_id = NEW.payment_id
    and r.status in ('pending', 'succeeded')
    and r.id <> NEW.id;

  if v_refunded + NEW.amount > v_charged then
    raise exception 'REFUND_EXCEEDS_PAYMENT: refunding % would exceed the % charged (% already refunded)',
      NEW.amount, v_charged, v_refunded
      using errcode = '22023';
  end if;

  return NEW;
end;
$$;

comment on function public.enforce_refund_within_payment() is
  'Guarantees refunds never exceed what was charged. A trigger rather than a CHECK because the limit lives on another table and the sum spans rows; locks the payment so concurrent refunds serialise.';

create trigger trg_payment_refunds_within_payment
  before insert or update on public.payment_refunds
  for each row
  execute function public.enforce_refund_within_payment();


-- Opens a refund. Owner/manager only.
--
-- Returns what the server action needs to ask Stripe: the payment intent
-- and the connected account the original charge was made on. A refund must
-- go back through the same account it came from.
create function public.start_refund(
  p_payment_id uuid,
  p_amount numeric,
  p_reason text
)
returns table (
  refund_id uuid,
  amount numeric,
  currency text,
  stripe_payment_intent_id text,
  stripe_account_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
  v_account public.restaurant_payment_accounts%rowtype;
  v_role text;
  v_refund_id uuid;
  v_amount numeric(10, 2);
begin
  select * into v_payment from public.order_payments where id = p_payment_id;
  if not found then
    raise exception 'REFUND_PAYMENT_NOT_FOUND: no such payment' using errcode = 'P0002';
  end if;

  -- SECURITY DEFINER bypasses RLS, so this check IS the access control.
  v_role := public.current_restaurant_role(v_payment.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'REFUND_FORBIDDEN: only an owner or manager can refund a payment'
      using errcode = '42501';
  end if;

  if v_payment.method <> 'card' then
    raise exception 'REFUND_NOT_CARD: only a card payment can be refunded — reverse a cash payment instead'
      using errcode = '22023';
  end if;

  if v_payment.status <> 'succeeded' then
    raise exception 'REFUND_PAYMENT_NOT_SETTLED: only a settled payment can be refunded'
      using errcode = '22023';
  end if;

  if v_payment.stripe_payment_intent_id is null then
    raise exception 'REFUND_NO_PAYMENT_INTENT: this payment has no Stripe charge to refund'
      using errcode = '22023';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REFUND_REASON_REQUIRED: give a reason for the refund' using errcode = '22023';
  end if;

  -- A null amount means "refund what is left", which is what a full
  -- refund actually means once partial ones exist.
  v_amount := coalesce(
    p_amount,
    v_payment.total_amount - public.payment_refunded_total(p_payment_id)
  );

  if v_amount <= 0 then
    raise exception 'REFUND_NOTHING_LEFT: this payment is already fully refunded'
      using errcode = '22023';
  end if;

  -- The trigger is the real guarantee; this is for a clear message.
  if public.payment_refunded_total(p_payment_id) + v_amount > v_payment.total_amount then
    raise exception 'REFUND_EXCEEDS_PAYMENT: refunding % would exceed the % charged',
      v_amount, v_payment.total_amount
      using errcode = '22023';
  end if;

  select * into v_account
  from public.restaurant_payment_accounts a
  where a.restaurant_id = v_payment.restaurant_id;

  if not found then
    raise exception 'REFUND_NO_ACCOUNT: restaurant has no connected account' using errcode = '22023';
  end if;

  insert into public.payment_refunds (
    payment_id, restaurant_id, amount, currency, reason, status, created_by
  ) values (
    p_payment_id, v_payment.restaurant_id, v_amount, v_payment.currency,
    trim(p_reason), 'pending', auth.uid()
  )
  returning id into v_refund_id;

  return query
    select r.id, r.amount, r.currency,
           v_payment.stripe_payment_intent_id, v_account.stripe_account_id
    from public.payment_refunds r
    where r.id = v_refund_id;
end;
$$;

comment on function public.start_refund(uuid, numeric, text) is
  'Opens a pending refund against a card payment, owner/manager only. A null amount refunds whatever is left. Returns the payment intent and connected account so the refund goes back through the account it came from. See docs/security.md#payments.';

revoke execute on function public.start_refund(uuid, numeric, text) from public;
grant execute on function public.start_refund(uuid, numeric, text) to authenticated;


-- Links a Stripe refund to its row, then settles it.
--
-- Split from start_refund for the same reason checkout is: the Stripe
-- object cannot exist until the row does, and the row must not be left
-- unlinkable if the Stripe call fails. Idempotent for the same refund id.
create function public.attach_refund_stripe_id(
  p_refund_id uuid,
  p_stripe_refund_id text,
  p_succeeded boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund public.payment_refunds%rowtype;
  v_role text;
begin
  select * into v_refund from public.payment_refunds where id = p_refund_id;
  if not found then
    raise exception 'REFUND_NOT_FOUND: no such refund' using errcode = 'P0002';
  end if;

  v_role := public.current_restaurant_role(v_refund.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'REFUND_FORBIDDEN: only an owner or manager can refund a payment'
      using errcode = '42501';
  end if;

  if v_refund.stripe_refund_id is not null
     and v_refund.stripe_refund_id <> p_stripe_refund_id then
    raise exception 'REFUND_ALREADY_LINKED: this refund already points at a different Stripe refund'
      using errcode = '22023';
  end if;

  update public.payment_refunds
  set stripe_refund_id = p_stripe_refund_id,
      status = case when p_succeeded then 'succeeded' else status end,
      refunded_at = case when p_succeeded then coalesce(refunded_at, now()) else refunded_at end
  where id = p_refund_id;
end;
$$;

comment on function public.attach_refund_stripe_id(uuid, text, boolean) is
  'Links a Stripe refund to its row and settles it when Stripe reports success. Idempotent for the same refund id; refuses to repoint at a different one. See docs/security.md#payments.';

revoke execute on function public.attach_refund_stripe_id(uuid, text, boolean) from public;
grant execute on function public.attach_refund_stripe_id(uuid, text, boolean) to authenticated;


-- Webhook path, for refunds Stripe settles asynchronously. service_role
-- only, exactly like payment settlement.
create function public.mark_refund_settled(
  p_stripe_refund_id text,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current text;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'Invalid terminal refund status: %', p_status using errcode = '22023';
  end if;

  select status into v_current
  from public.payment_refunds
  where stripe_refund_id = p_stripe_refund_id;

  if not found then
    return false;
  end if;

  -- Replay, or a late event for something already settled.
  if v_current = p_status then
    return true;
  end if;
  if v_current = 'succeeded' then
    return true;
  end if;

  update public.payment_refunds
  set status = p_status,
      refunded_at = case when p_status = 'succeeded' then now() else refunded_at end
  where stripe_refund_id = p_stripe_refund_id;

  return true;
end;
$$;

comment on function public.mark_refund_settled(text, text) is
  'Settles a refund from a verified Stripe webhook event. Idempotent, never downgrades a succeeded refund, and returns false rather than raising for an unknown refund so Stripe does not retry a 500 forever. See docs/security.md#payments.';

revoke execute on function public.mark_refund_settled(text, text) from public;
revoke execute on function public.mark_refund_settled(text, text) from authenticated;
grant execute on function public.mark_refund_settled(text, text) to service_role;
