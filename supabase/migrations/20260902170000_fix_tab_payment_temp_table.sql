-- Payments phase 3 — start_tab_payment() could never run in production.
--
-- The original gathered a tab's unpaid orders into a temporary table and
-- cleared it first with a bare `delete from tab_orders_tmp;`. Supabase
-- loads pg_safeupdate on the roles PostgREST connects as, which rejects
-- any DELETE or UPDATE with no WHERE clause:
--
--   21000: DELETE requires a WHERE clause
--
-- So every attempt to pay a tab failed before touching Stripe. It was not
-- caught earlier for two compounding reasons, both worth naming:
--
--   1. The integration tests run on PGlite, which does not load
--      pg_safeupdate. The statement is perfectly legal there, so 13 tests
--      covering this function all passed against a database that does not
--      enforce the rule the real one does.
--
--   2. Nothing called the function until the tab UI was built, so no
--      failure surfaced. Schema shipped ahead of a caller hides exactly
--      this kind of fault.
--
-- The fix is not to add `where true`. That would satisfy the extension
-- while keeping a temporary table whose lifetime depends on transaction
-- and connection reuse under a pooler — needless risk for something that
-- was only ever a scratch list. The set of order ids is collected into a
-- local uuid[] instead: gathered once, aggregated and inserted from, with
-- no DDL, no cross-statement state, and no dependence on pooling
-- behaviour.
--
-- Everything else about the function is unchanged, including the session
-- being derived from auth.uid() rather than accepted as a parameter.

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

  -- The caller's own session is derived from auth.uid(), never passed in:
  -- a session id parameter would be a way to pay — or read the total of —
  -- someone else's table.
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

  select * into v_account
  from public.restaurant_payment_accounts a
  where a.restaurant_id = v_session.restaurant_id;

  if not found or not v_account.charges_enabled then
    raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
  end if;

  -- Reuse a tab payment already in flight, for the same reason a
  -- single-order one is reused: a second Checkout session is a second
  -- charge.
  select p.* into v_existing
  from public.order_payments p
  where p.restaurant_id = v_session.restaurant_id
    and p.status = 'pending'
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

  -- Everything still owed on this tab, gathered once. Same predicate as
  -- before; only the container changed.
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
    );

  if v_count = 0 then
    raise exception 'PAYMENT_NOTHING_TO_PAY: this tab has no unpaid orders' using errcode = '22023';
  end if;

  -- Orders freeze their currency individually, so a session could in
  -- principle hold two currencies if the restaurant changed its own
  -- between orders. One Stripe charge cannot span currencies; refusing is
  -- honest, and paying order by order still works.
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

comment on function public.start_tab_payment(numeric) is
  'Starts one card payment covering every unpaid order in the caller''s own session. The session comes from auth.uid() and the amount is summed in the database, never supplied by the caller. See docs/security.md#payments.';

revoke execute on function public.start_tab_payment(numeric) from public;
grant execute on function public.start_tab_payment(numeric) to authenticated;
