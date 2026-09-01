-- Payments phase 2 — charging a card for an order.
--
-- Phase 1 connected each restaurant's Stripe account and added the payment
-- settings; it moved no money. This is the phase that does.
--
-- Scope, decided with the user:
--
--   * Direct charges on the restaurant's own connected account. The
--     restaurant is the merchant of record and funds never rest in a
--     platform balance — the whole point of the phase 1 account shape.
--   * No platform application fee. The restaurant keeps everything except
--     Stripe's own fees. Adding a fee later touches the charge call and a
--     reconciliation view, not this schema.
--   * Stripe Checkout, hosted. No card data reaches this application, and
--     3DS/SCA, wallets and every card edge case stay Stripe's problem.
--   * Pay at the end of the meal only. `payment_timing = 'at_order'`
--     remains inert, exactly as it is today: nothing here changes
--     submit_order() or the path an order takes to the kitchen.
--   * Card only. Cash recording and refunds stay in phase 3, which is why
--     `method` is constrained to 'card' rather than left open — a value
--     with no write path is a lie about what the system does.
--
--
-- WHY A SEPARATE TABLE, NOT COLUMNS ON `orders`
--
-- Every monetary field on `orders` is immutable for the order's lifetime,
-- enforced by trg_orders_enforce_immutable_fields
-- (20260824090100_order_status_transitions.sql) and relied on by
-- docs/security.md#order-immutability. A tip is decided long after the
-- order is placed, so a tip column on `orders` would either break that
-- guarantee or need an exception carved into it. Neither is acceptable:
-- the immutability of a placed order is load-bearing for the audit trail.
--
-- So payment is its own record with its own lifecycle, pointing at the
-- order. `amount` is copied from orders.total when the payment is started
-- rather than joined at read time, for the same reason the order copied
-- its prices from the menu: what was charged must never be re-derived from
-- something that could have changed.
create table public.order_payments (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  order_id uuid not null,

  status text not null default 'pending',
  method text not null default 'card',

  -- Frozen at payment-start from orders.total. See the note above.
  amount numeric(10, 2) not null,
  tip_amount numeric(10, 2) not null default 0,
  -- Generated, so the amount actually charged can never drift from its
  -- two components through a partial update.
  total_amount numeric(10, 2) generated always as (amount + tip_amount) stored,

  -- Copied from orders.currency, which was itself frozen from the
  -- restaurant at submission time.
  currency text not null,

  stripe_checkout_session_id text,
  stripe_payment_intent_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,

  -- Tenant-scoped FK: an order_payments row can only ever point at an
  -- order belonging to the same restaurant. The same composite-key
  -- mechanism used throughout this schema since batch 5.
  constraint order_payments_order_same_restaurant
    foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id)
    on delete cascade,

  constraint order_payments_status_valid check (
    status in ('pending', 'succeeded', 'failed', 'cancelled')
  ),
  -- Widened in phase 3 when cash recording gets a write path.
  constraint order_payments_method_valid check (method in ('card')),
  constraint order_payments_amount_non_negative check (amount >= 0),
  constraint order_payments_tip_non_negative check (tip_amount >= 0),
  constraint order_payments_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- A succeeded payment must have recorded what settled it; a pending one
  -- must not claim to have been paid.
  constraint order_payments_paid_at_matches_status check (
    (status = 'succeeded' and paid_at is not null)
    or (status <> 'succeeded' and paid_at is null)
  )
);

comment on table public.order_payments is
  'One card payment attempt against an order. Tips live here, never on orders, whose monetary fields are immutable. See docs/security.md#payments.';

-- THE central invariant of this phase: an order can never be paid twice.
-- A partial unique index rather than a plain one, because failed and
-- cancelled attempts are expected and must be allowed to accumulate — a
-- diner whose card is declined has to be able to try again.
create unique index order_payments_one_succeeded_per_order
  on public.order_payments (order_id)
  where status = 'succeeded';

comment on index public.order_payments_one_succeeded_per_order is
  'An order can have many payment attempts but at most one that succeeded. This is what makes double-charging a database error rather than a code review question.';

-- Stripe's own identifiers are unique per object; enforcing that here is
-- what makes webhook replay a no-op at the storage layer rather than
-- something the handler has to reason about.
create unique index order_payments_checkout_session_key
  on public.order_payments (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create unique index order_payments_payment_intent_key
  on public.order_payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create index order_payments_order_id_idx on public.order_payments (order_id);
create index order_payments_restaurant_id_idx on public.order_payments (restaurant_id);

create trigger trg_order_payments_set_updated_at
  before update on public.order_payments
  for each row
  execute function public.set_updated_at();

alter table public.order_payments enable row level security;

-- A diner sees payments for their own order; any staff member sees every
-- payment at their own restaurant. Read-only for both: the only writers
-- are the SECURITY DEFINER functions below and the Stripe webhook.
create policy "order_payments_select_own_or_staff"
  on public.order_payments
  for select
  to authenticated
  using (
    public.order_belongs_to_caller(order_id)
    or public.is_restaurant_member(restaurant_id)
  );

-- No INSERT/UPDATE/DELETE policy for any role, deliberately — the same
-- append-only-via-function-only stance as order_status_history and
-- order_ticket_groups. Money must not be writable by a client under any
-- role, including an owner.


-- Starts a payment for an order and returns everything the server action
-- needs to open a Stripe Checkout session.
--
-- The amount is derived HERE, from the order, and never accepted from the
-- caller. A client that could name its own price is the single most
-- obvious way to get this wrong, so the only thing the caller supplies is
-- the tip.
--
-- Returns the connected account id as well: the server action needs it to
-- place a direct charge, and it never reaches the browser. Customers
-- cannot read restaurant_payment_accounts directly — that table is
-- owner/manager-gated — which is exactly why this has to hand it back.
create function public.start_order_payment(
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
begin
  if p_tip_amount is null or p_tip_amount < 0 then
    raise exception 'Tip cannot be negative' using errcode = '22023';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'PAYMENT_ORDER_NOT_FOUND: no such order' using errcode = 'P0002';
  end if;

  -- Authorization: only the diner whose session placed this order may pay
  -- for it. SECURITY DEFINER bypasses RLS, so this check is not a
  -- convenience — it IS the access control for this function.
  if not public.order_belongs_to_caller(p_order_id) then
    raise exception 'PAYMENT_NOT_YOUR_ORDER: order belongs to another session' using errcode = '42501';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'PAYMENT_ORDER_CANCELLED: order was cancelled' using errcode = '22023';
  end if;

  -- Cheap pre-check for a clear error message. The partial unique index is
  -- what actually guarantees this under concurrency; this is not relied on
  -- to prevent a double charge.
  if exists (
    select 1 from public.order_payments p
    where p.order_id = p_order_id and p.status = 'succeeded'
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

  select * into v_account
  from public.restaurant_payment_accounts a
  where a.restaurant_id = v_order.restaurant_id;

  if not found or not v_account.charges_enabled then
    raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
  end if;

  insert into public.order_payments (
    restaurant_id, order_id, status, method, amount, tip_amount, currency
  ) values (
    v_order.restaurant_id, p_order_id, 'pending', 'card',
    v_order.total, p_tip_amount, v_order.currency
  )
  returning id into v_payment_id;

  return query
    select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
           v_account.stripe_account_id
    from public.order_payments p
    where p.id = v_payment_id;
end;
$$;

comment on function public.start_order_payment(uuid, numeric) is
  'Creates a pending card payment for the caller''s own order and returns what is needed to open a Stripe Checkout session. Derives the amount from the order — never from the caller. See docs/security.md#payments.';

revoke execute on function public.start_order_payment(uuid, numeric) from public;
grant execute on function public.start_order_payment(uuid, numeric) to authenticated;


-- Attaches the Stripe Checkout session id to a pending payment, straight
-- after the session is created. Split from start_order_payment because the
-- session cannot exist until the row does, and the row must not be left
-- unlinkable if the Stripe call fails.
create function public.attach_payment_checkout_session(
  p_payment_id uuid,
  p_checkout_session_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.order_belongs_to_caller(
    (select order_id from public.order_payments where id = p_payment_id)
  ) then
    raise exception 'PAYMENT_NOT_YOUR_ORDER' using errcode = '42501';
  end if;

  update public.order_payments
  set stripe_checkout_session_id = p_checkout_session_id
  where id = p_payment_id
    and status = 'pending'
    and stripe_checkout_session_id is null;

  if not found then
    raise exception 'PAYMENT_NOT_PENDING: payment is not pending or already has a session' using errcode = '22023';
  end if;
end;
$$;

comment on function public.attach_payment_checkout_session(uuid, text) is
  'Links a freshly created Stripe Checkout session to its pending payment row. See docs/security.md#payments.';

revoke execute on function public.attach_payment_checkout_session(uuid, text) from public;
grant execute on function public.attach_payment_checkout_session(uuid, text) to authenticated;


-- Settles a payment. Called ONLY from the Stripe webhook, which is why it
-- is granted to service_role and to nobody else.
--
-- The browser's return from Checkout is not evidence of payment — it is a
-- URL the diner can visit, edit, or replay. Stripe's signed webhook is the
-- only thing that may move a payment to 'succeeded', and this function is
-- the only path that does it.
--
-- Idempotent by design: Stripe retries webhooks, and the same event may
-- arrive more than once. A second call for an already-succeeded payment is
-- a no-op, not an error, so a retry never produces a 500 that makes Stripe
-- retry again.
create function public.mark_order_payment_succeeded(
  p_checkout_session_id text,
  p_payment_intent_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status
  from public.order_payments
  where stripe_checkout_session_id = p_checkout_session_id;

  if not found then
    return false;
  end if;

  if v_status = 'succeeded' then
    return true; -- replay; already settled
  end if;

  update public.order_payments
  set status = 'succeeded',
      paid_at = now(),
      stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id)
  where stripe_checkout_session_id = p_checkout_session_id;

  return true;
end;
$$;

comment on function public.mark_order_payment_succeeded(text, text) is
  'Settles a payment from a verified Stripe webhook event. The only path that may set status = succeeded. Idempotent under webhook replay. See docs/security.md#payments.';

revoke execute on function public.mark_order_payment_succeeded(text, text) from public;
revoke execute on function public.mark_order_payment_succeeded(text, text) from authenticated;
grant execute on function public.mark_order_payment_succeeded(text, text) to service_role;


-- Marks an abandoned or failed Checkout session. Also webhook-only.
-- Leaving these 'pending' forever would make "has this order been paid?"
-- unanswerable, and would block the diner from retrying with a clear UI.
create function public.mark_order_payment_failed(
  p_checkout_session_id text,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('failed', 'cancelled') then
    raise exception 'Invalid terminal payment status: %', p_status
      using errcode = '22023';
  end if;

  update public.order_payments
  set status = p_status
  where stripe_checkout_session_id = p_checkout_session_id
    and status = 'pending';

  return found;
end;
$$;

comment on function public.mark_order_payment_failed(text, text) is
  'Marks a pending payment failed or cancelled from a verified Stripe webhook event. Never touches an already-succeeded payment. See docs/security.md#payments.';

revoke execute on function public.mark_order_payment_failed(text, text) from public;
revoke execute on function public.mark_order_payment_failed(text, text) from authenticated;
grant execute on function public.mark_order_payment_failed(text, text) to service_role;


-- The customer-facing read path for payment settings.
--
-- Follows get_public_order_settings()'s rule exactly (see
-- 20260823100150_public_order_settings.sql): a diner never reads
-- restaurant_settings directly, only the specific fields a public page
-- needs, through a function that returns nothing else.
--
-- `can_take_card` is the field that matters. `accept_card` is what the
-- restaurant switched on; whether Stripe will actually accept a charge is
-- a different question, and restaurant_payment_accounts is owner/manager
-- gated so a diner cannot check it. Collapsing both into one answer here
-- is what stops the app offering a Pay button that could only fail at
-- Stripe — and it deliberately reveals nothing about the account itself,
-- not even that one exists.
create function public.get_public_payment_settings(
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
      and coalesce(a.charges_enabled, false) as can_take_card,
    coalesce(s.tipping_enabled, false) as tipping_enabled
  from public.restaurant_settings s
  left join public.restaurant_payment_accounts a
    on a.restaurant_id = s.restaurant_id
  where s.restaurant_id = target_restaurant_id
$$;

comment on function public.get_public_payment_settings(uuid) is
  'The only public read path onto payment settings — whether a card can actually be charged, and whether to offer a tip. Never exposes the connected account. See docs/security.md#payments.';

grant execute on function public.get_public_payment_settings(uuid) to anon, authenticated;
