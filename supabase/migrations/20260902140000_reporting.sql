-- Reporting — what a restaurant actually took.
--
-- Payments phases 1–3 made money move correctly and gave an owner no way
-- to see any of it. This adds that view.
--
--
-- THE FIGURES MUST NET OFF REFUNDS, OR THEY LIE
--
-- A page reading "takings £500" when £100 went back is worse than no page:
-- it is confidently wrong, and someone reconciles a bank statement against
-- it. So every money figure here is reported three ways — gross taken,
-- refunded, and net — rather than one number whose definition the reader
-- has to guess.
--
-- Refunds are counted in two buckets, deliberately:
--
--   refunded          refunds Stripe has actually settled
--   refunds_pending   refunds asked for but not yet settled
--
-- `net` deducts only settled refunds, because that is money genuinely
-- gone. Pending refunds are shown beside it rather than folded in, so an
-- owner can see money on its way out without the headline figure moving
-- twice for the same refund.
--
--
-- WHAT COUNTS AS TAKEN
--
-- Only payments with status 'succeeded'. That excludes:
--   * 'pending'   — a Checkout session nobody completed
--   * 'failed'    — a declined card
--   * 'cancelled' — an abandoned checkout
--   * 'reversed'  — cash recorded in error and reversed by a manager
--
-- The last one matters: a reversed cash payment keeps its amount and its
-- paid_at (see 20260902100000), so a report filtering on "has a paid_at"
-- rather than on status would silently count money the restaurant never
-- had. Filtering on status is what makes reversal meaningful.
--
--
-- ACCESS
--
-- Owner and manager only, checked inside each function because
-- SECURITY DEFINER bypasses RLS. Revenue is commercially sensitive and
-- neither the kitchen nor waiting staff need it — the same distinction
-- the staff role matrix already draws elsewhere.
--
--
-- TIME RANGES
--
-- Bounds are timestamptz and half-open: `from <= paid_at < to`. Half-open
-- because a closed range double-counts anything landing exactly on
-- midnight when an owner views two consecutive days. Callers pass absolute
-- instants; converting "today" in the restaurant's own timezone to those
-- instants is the caller's job, using the same Intl-based helper
-- reservations already use (src/lib/reservations/timezone.ts). Doing it
-- here would mean reimplementing DST-aware conversion in SQL.


-- Shared guard. Raises rather than returning empty, so a permission
-- problem cannot be mistaken for a quiet day.
create function public.assert_can_view_reports(target_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  v_role := public.current_restaurant_role(target_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'REPORT_FORBIDDEN: only an owner or manager can view takings'
      using errcode = '42501';
  end if;
end;
$$;

comment on function public.assert_can_view_reports(uuid) is
  'Owner/manager gate for every reporting function. Raises rather than returning nothing, so a permissions problem is never mistaken for a quiet day.';


-- Headline figures for a period.
create function public.get_takings_summary(
  target_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  gross numeric,
  refunded numeric,
  refunds_pending numeric,
  net numeric,
  tips numeric,
  payment_count integer,
  order_count integer,
  average_order_value numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_can_view_reports(target_restaurant_id);

  -- Written as scalar subqueries over a FROM-less SELECT so exactly one
  -- row always comes back. An aggregate with GROUP BY returns NO rows over
  -- an empty set, which would mean a restaurant with no takings got
  -- nothing at all rather than zeros — indistinguishable, to the page,
  -- from a failure.
  return query
  with settled as (
    select p.id, p.amount, p.tip_amount, p.total_amount
    from public.order_payments p
    where p.restaurant_id = target_restaurant_id
      and p.status = 'succeeded'
      and p.paid_at >= p_from
      and p.paid_at < p_to
  ),
  refunds as (
    select
      coalesce(sum(r.amount) filter (where r.status = 'succeeded'), 0) as settled_refunds,
      coalesce(sum(r.amount) filter (where r.status = 'pending'), 0) as pending_refunds
    from public.payment_refunds r
    join settled s on s.id = r.payment_id
  ),
  covered as (
    -- Distinct because one payment may cover several orders (a tab), and
    -- one order must never be counted twice.
    select count(distinct po.order_id) as orders
    from public.payment_orders po
    join settled s on s.id = po.payment_id
  )
  select
    coalesce((select sum(x.total_amount) from settled x), 0)::numeric,
    (select rf.settled_refunds from refunds rf)::numeric,
    (select rf.pending_refunds from refunds rf)::numeric,
    (coalesce((select sum(x.total_amount) from settled x), 0)
      - (select rf.settled_refunds from refunds rf))::numeric,
    coalesce((select sum(x.tip_amount) from settled x), 0)::numeric,
    (select count(*) from settled)::integer,
    (select cv.orders from covered cv)::integer,
    case
      when (select cv.orders from covered cv) > 0
        then round(
          coalesce((select sum(x.amount) from settled x), 0)
            / (select cv.orders from covered cv), 2)
      else 0
    end::numeric;
end;
$$;

comment on function public.get_takings_summary(uuid, timestamptz, timestamptz) is
  'Headline takings for a half-open period: gross, refunded, net, tips, counts. Counts only succeeded payments, so reversed cash and abandoned checkouts are excluded. Average order value uses amount excluding tips. See docs/security.md#reporting.';

revoke execute on function public.get_takings_summary(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_takings_summary(uuid, timestamptz, timestamptz) to authenticated;


-- Card versus cash. The reason cash recording exists is so a till can be
-- reconciled against the bank, and that needs the split.
create function public.get_takings_by_method(
  target_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  method text,
  payment_count integer,
  gross numeric,
  refunded numeric,
  net numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_can_view_reports(target_restaurant_id);

  return query
  select
    p.method,
    count(*)::integer,
    coalesce(sum(p.total_amount), 0)::numeric,
    coalesce(sum(
      (select coalesce(sum(r.amount), 0)
       from public.payment_refunds r
       where r.payment_id = p.id and r.status = 'succeeded')
    ), 0)::numeric,
    (coalesce(sum(p.total_amount), 0) - coalesce(sum(
      (select coalesce(sum(r.amount), 0)
       from public.payment_refunds r
       where r.payment_id = p.id and r.status = 'succeeded')
    ), 0))::numeric
  from public.order_payments p
  where p.restaurant_id = target_restaurant_id
    and p.status = 'succeeded'
    and p.paid_at >= p_from
    and p.paid_at < p_to
  group by p.method
  order by p.method;
end;
$$;

comment on function public.get_takings_by_method(uuid, timestamptz, timestamptz) is
  'Takings split by card and cash, for reconciling a till against the bank. See docs/security.md#reporting.';

revoke execute on function public.get_takings_by_method(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_takings_by_method(uuid, timestamptz, timestamptz) to authenticated;


-- Individual payments. What you open when one customer disputes one
-- charge, so it carries the order numbers and the Stripe reference.
--
-- Includes unsuccessful attempts deliberately: "the customer says they
-- paid" is usually answered by a failed or abandoned attempt, and a list
-- that hid those would make that question unanswerable.
create function public.get_payment_history(
  target_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  payment_id uuid,
  created_at timestamptz,
  paid_at timestamptz,
  status text,
  method text,
  amount numeric,
  tip_amount numeric,
  total_amount numeric,
  refunded numeric,
  currency text,
  order_numbers bigint[],
  stripe_payment_intent_id text,
  reversed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_can_view_reports(target_restaurant_id);

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'REPORT_INVALID_LIMIT: limit must be between 1 and 500'
      using errcode = '22023';
  end if;

  return query
  select
    p.id,
    p.created_at,
    p.paid_at,
    p.status,
    p.method,
    p.amount,
    p.tip_amount,
    p.total_amount,
    (select coalesce(sum(r.amount), 0)
     from public.payment_refunds r
     where r.payment_id = p.id and r.status = 'succeeded')::numeric,
    p.currency,
    array(
      select o.order_number
      from public.payment_orders po
      join public.orders o on o.id = po.order_id
      where po.payment_id = p.id
      order by o.order_number
    ),
    p.stripe_payment_intent_id,
    p.reversed_at
  from public.order_payments p
  where p.restaurant_id = target_restaurant_id
    -- Unsettled attempts have no paid_at, so fall back to created_at or
    -- they would vanish from the list entirely.
    and coalesce(p.paid_at, p.created_at) >= p_from
    and coalesce(p.paid_at, p.created_at) < p_to
  order by coalesce(p.paid_at, p.created_at) desc
  limit p_limit offset p_offset;
end;
$$;

comment on function public.get_payment_history(uuid, timestamptz, timestamptz, integer, integer) is
  'Individual payments for a period, including failed and abandoned attempts — "the customer says they paid" is usually answered by one of those. See docs/security.md#reporting.';

revoke execute on function public.get_payment_history(uuid, timestamptz, timestamptz, integer, integer) from public;
grant execute on function public.get_payment_history(uuid, timestamptz, timestamptz, integer, integer) to authenticated;


-- What actually sells.
--
-- Counted from orders, not payments: an order that was served is a sale
-- whether or not it has been settled yet, and menu decisions should not
-- wait on the till. Cancelled orders are excluded — nothing was sold.
--
-- Uses the frozen line-item snapshots (item_name, line_total), so renaming
-- or repricing a dish does not rewrite history.
create function public.get_best_selling_items(
  target_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 20
)
returns table (
  item_name text,
  quantity_sold bigint,
  revenue numeric,
  order_count integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_can_view_reports(target_restaurant_id);

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'REPORT_INVALID_LIMIT: limit must be between 1 and 200'
      using errcode = '22023';
  end if;

  return query
  select
    oi.item_name,
    sum(oi.quantity)::bigint,
    sum(oi.line_total)::numeric,
    count(distinct oi.order_id)::integer
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.restaurant_id = target_restaurant_id
    and o.status <> 'cancelled'
    and o.created_at >= p_from
    and o.created_at < p_to
  group by oi.item_name
  order by sum(oi.quantity) desc, oi.item_name
  limit p_limit;
end;
$$;

comment on function public.get_best_selling_items(uuid, timestamptz, timestamptz, integer) is
  'Best-selling dishes for a period, from frozen order-item snapshots so renaming or repricing does not rewrite history. Counts served orders regardless of payment. See docs/security.md#reporting.';

revoke execute on function public.get_best_selling_items(uuid, timestamptz, timestamptz, integer) from public;
grant execute on function public.get_best_selling_items(uuid, timestamptz, timestamptz, integer) to authenticated;
