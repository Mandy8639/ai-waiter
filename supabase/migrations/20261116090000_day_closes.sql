-- End of day: closing the day, counting the cash drawer, and a closing
-- report that stays as it was.
--
-- A restaurant closes the day once service is done: someone counts the
-- drawer, Tableside says what should be in it, and the difference (over or
-- short) is recorded with everything else about the day. Each close covers
-- the time since the previous one (the first, since that day's local
-- midnight), so a service that runs past midnight is one day, not two.
--
--   expected cash = starting cash (the float)
--                 + cash taken (bills and tips) in the period
--                 - cash handed back as refunds in the period
--
-- Reversed cash payments were never taken, so they're not in it. Comp
-- payments ($0, 20261113090000) charge nothing and are left out of sales.
--
-- The report is computed by day_close_summary() and frozen into the close
-- (summary jsonb) when the day is closed: a refund issued next week mustn't
-- change last Tuesday's close. preview_day_close() shows the same report,
-- live, before closing.
--
-- Owners and managers only, like Reports, checked with
-- current_restaurant_role() so two-step verification applies. A close can
-- be printed on the receipt printer (print job kind 'day_close').

create table public.day_closes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  opening_float numeric(10, 2) not null,
  counted_cash numeric(10, 2) not null,
  expected_cash numeric(10, 2) not null,
  over_short numeric(10, 2) generated always as (counted_cash - expected_cash) stored,
  summary jsonb not null,
  note text,
  closed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint day_closes_restaurant_id_id_key unique (restaurant_id, id),
  constraint day_closes_period_valid check (period_end > period_start),
  constraint day_closes_one_per_end unique (restaurant_id, period_end),
  constraint day_closes_float_non_negative check (opening_float >= 0),
  constraint day_closes_counted_non_negative check (counted_cash >= 0),
  constraint day_closes_note_length check (note is null or char_length(note) <= 500)
);

comment on table public.day_closes is
  'End of day closes: the drawer count and the closing report, frozen when the day was closed. Written only by close_day().';

create index day_closes_restaurant_end_idx on public.day_closes (restaurant_id, period_end desc);

alter table public.day_closes enable row level security;

create policy "day_closes_select_managers"
  on public.day_closes
  for select
  to authenticated
  using (public.current_restaurant_role(restaurant_id) in ('owner', 'manager'));

-- ---------------------------------------------------------------------------
-- Where the open day starts
-- ---------------------------------------------------------------------------

create function public.day_close_period_start(p_restaurant_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_last timestamptz;
  v_tz text;
begin
  select max(period_end) into v_last from public.day_closes where restaurant_id = p_restaurant_id;
  if v_last is not null then
    return v_last;
  end if;
  select coalesce(timezone, 'UTC') into v_tz from public.restaurants where id = p_restaurant_id;
  return date_trunc('day', now() at time zone v_tz) at time zone v_tz;
end;
$$;

revoke execute on function public.day_close_period_start(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The closing report for a period
-- ---------------------------------------------------------------------------

create function public.day_close_summary(
  p_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  with paid as (
    -- Payments that took money in the period. A card on a Terminal or
    -- Tap to Pay is its own line: staff count it differently from a
    -- diner paying on their phone.
    select p.id, p.amount, p.tip_amount, p.total_amount, p.recorded_by,
           case when p.method = 'card' and p.card_present then 'card_in_person'
                else p.method end as method_key
    from public.order_payments p
    where p.restaurant_id = p_restaurant_id
      and p.status = 'succeeded'
      and p.method <> 'comp'
      and p.paid_at >= p_from and p.paid_at < p_to
  ),
  refunded as (
    select r.amount,
           case when p.method = 'card' and p.card_present then 'card_in_person'
                else p.method end as method_key
    from public.payment_refunds r
    join public.order_payments p on p.id = r.payment_id
    where r.restaurant_id = p_restaurant_id
      and r.status = 'succeeded'
      and r.refunded_at >= p_from and r.refunded_at < p_to
  ),
  methods as (
    select m.method_key from paid m
    union
    select r.method_key from refunded r
  ),
  adjusted as (
    select a.kind, count(*)::integer as n, coalesce(sum(a.amount), 0) as amount
    from public.order_adjustments a
    where a.restaurant_id = p_restaurant_id
      and a.removed_at is null
      and a.created_at >= p_from and a.created_at < p_to
    group by a.kind
  ),
  covered as (
    select count(distinct po.order_id)::integer as n
    from public.payment_orders po
    join paid p on p.id = po.payment_id
  ),
  reversed as (
    select count(*)::integer as n, coalesce(sum(p.total_amount), 0) as amount
    from public.order_payments p
    where p.restaurant_id = p_restaurant_id
      and p.status = 'reversed'
      and p.reversed_at >= p_from and p.reversed_at < p_to
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'currency', (select r.currency from public.restaurants r where r.id = p_restaurant_id),
    'payments', jsonb_build_object(
      'count', (select count(*) from paid),
      'sales', coalesce((select sum(amount) from paid), 0),
      'tips', coalesce((select sum(tip_amount) from paid), 0),
      'gross', coalesce((select sum(total_amount) from paid), 0),
      'refunds', coalesce((select sum(amount) from refunded), 0),
      'net', coalesce((select sum(total_amount) from paid), 0)
             - coalesce((select sum(amount) from refunded), 0)
    ),
    'by_method', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', m.method_key,
        'count', (select count(*) from paid p where p.method_key = m.method_key),
        'sales', coalesce((select sum(p.amount) from paid p where p.method_key = m.method_key), 0),
        'tips', coalesce((select sum(p.tip_amount) from paid p where p.method_key = m.method_key), 0),
        'refunds', coalesce((select sum(r.amount) from refunded r where r.method_key = m.method_key), 0),
        'net', coalesce((select sum(p.total_amount) from paid p where p.method_key = m.method_key), 0)
               - coalesce((select sum(r.amount) from refunded r where r.method_key = m.method_key), 0)
      ) order by m.method_key)
      from methods m
    ), '[]'::jsonb),
    'cash', jsonb_build_object(
      'taken', coalesce((select sum(total_amount) from paid where method_key = 'cash'), 0),
      'refunded', coalesce((select sum(amount) from refunded where method_key = 'cash'), 0)
    ),
    'adjustments', jsonb_build_object(
      'void', coalesce((select jsonb_build_object('count', n, 'amount', amount) from adjusted where kind = 'void'),
                       '{"count": 0, "amount": 0}'::jsonb),
      'comp', coalesce((select jsonb_build_object('count', n, 'amount', amount) from adjusted where kind = 'comp'),
                       '{"count": 0, "amount": 0}'::jsonb),
      'discount', coalesce((select jsonb_build_object('count', n, 'amount', amount) from adjusted where kind = 'discount'),
                           '{"count": 0, "amount": 0}'::jsonb)
    ),
    'reversed', (select jsonb_build_object('count', n, 'amount', amount) from reversed),
    'orders', (select n from covered),
    -- Who took payment at the restaurant: cash, card machine, Terminal.
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'email', coalesce(u.email::text, 'Former staff'),
        'count', s.n,
        'cash', s.cash,
        'total', s.total
      ) order by s.total desc)
      from (
        select p.recorded_by,
               count(*)::integer as n,
               coalesce(sum(p.total_amount) filter (where p.method_key = 'cash'), 0) as cash,
               coalesce(sum(p.total_amount), 0) as total
        from paid p
        where p.recorded_by is not null
        group by p.recorded_by
      ) s
      left join auth.users u on u.id = s.recorded_by
    ), '[]'::jsonb)
  )
  into v_result;
  return v_result;
end;
$$;

revoke execute on function public.day_close_summary(uuid, timestamptz, timestamptz) from public, anon, authenticated;

create function public.assert_can_close_day(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.current_restaurant_role(p_restaurant_id), '') not in ('owner', 'manager') then
    raise exception 'CLOSE_FORBIDDEN: only an owner or manager can close the day' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.assert_can_close_day(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- preview_day_close: the open day's report, live
-- ---------------------------------------------------------------------------

create function public.preview_day_close(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_start timestamptz;
begin
  perform public.assert_can_close_day(p_restaurant_id);
  v_start := public.day_close_period_start(p_restaurant_id);
  return jsonb_build_object(
    'period_start', v_start,
    'period_end', now(),
    -- Most restaurants leave the same float in the drawer every day.
    'last_float', (
      select d.opening_float from public.day_closes d
      where d.restaurant_id = p_restaurant_id
      order by d.period_end desc limit 1),
    'summary', public.day_close_summary(p_restaurant_id, v_start, now())
  );
end;
$$;

revoke execute on function public.preview_day_close(uuid) from public, anon;
grant execute on function public.preview_day_close(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- close_day
-- ---------------------------------------------------------------------------

create function public.close_day(
  p_restaurant_id uuid,
  p_opening_float numeric,
  p_counted_cash numeric,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_start timestamptz;
  v_end timestamptz := now();
  v_summary jsonb;
  v_expected numeric(10, 2);
  v_id uuid;
begin
  perform public.assert_can_close_day(p_restaurant_id);
  if p_opening_float is null or p_opening_float < 0
     or p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'CLOSE_INVALID: enter the starting and counted cash' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'CLOSE_INVALID: keep the note under 500 characters' using errcode = '22023';
  end if;

  -- One close at a time per restaurant, so two managers closing together
  -- can't both cover the same period.
  perform 1 from public.restaurants where id = p_restaurant_id for update;

  v_start := public.day_close_period_start(p_restaurant_id);
  if v_end <= v_start then
    raise exception 'CLOSE_TOO_SOON: the day was just closed' using errcode = '22023';
  end if;

  v_summary := public.day_close_summary(p_restaurant_id, v_start, v_end);
  v_expected := round(p_opening_float, 2)
    + (v_summary #>> '{cash,taken}')::numeric
    - (v_summary #>> '{cash,refunded}')::numeric;

  insert into public.day_closes (
    restaurant_id, period_start, period_end, opening_float, counted_cash,
    expected_cash, summary, note, closed_by
  ) values (
    p_restaurant_id, v_start, v_end, round(p_opening_float, 2), round(p_counted_cash, 2),
    v_expected, v_summary, nullif(btrim(coalesce(p_note, '')), ''), auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.close_day(uuid, numeric, numeric, text) from public, anon;
grant execute on function public.close_day(uuid, numeric, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Printing a close
-- ---------------------------------------------------------------------------

alter table public.print_jobs
  add column day_close_id uuid,
  add constraint print_jobs_day_close_same_restaurant
    foreign key (restaurant_id, day_close_id)
    references public.day_closes (restaurant_id, id)
    on delete cascade,
  drop constraint print_jobs_kind_valid,
  add constraint print_jobs_kind_valid
    check (kind in ('kitchen_ticket', 'receipt', 'bill', 'drawer', 'test', 'day_close')),
  drop constraint print_jobs_target,
  add constraint print_jobs_target check (
    (kind = 'kitchen_ticket' and order_id is not null)
    or (kind = 'receipt' and payment_id is not null)
    or (kind = 'bill' and cardinality(order_ids) between 1 and 50)
    or (kind = 'day_close' and day_close_id is not null)
    or kind in ('drawer', 'test')
  );

drop function public.request_print(uuid, text, uuid[], uuid, uuid);

create function public.request_print(
  p_restaurant_id uuid,
  p_kind text,
  p_order_ids uuid[] default null,
  p_payment_id uuid default null,
  p_printer_id uuid default null,
  p_day_close_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text := public.current_restaurant_role(p_restaurant_id);
  v_count integer;
begin
  if v_role is null
    or (p_kind = 'kitchen_ticket' and v_role not in ('owner', 'manager', 'staff', 'kitchen'))
    or (p_kind in ('bill', 'receipt', 'drawer') and v_role not in ('owner', 'manager', 'staff'))
    or (p_kind in ('test', 'day_close') and v_role not in ('owner', 'manager'))
    or p_kind not in ('kitchen_ticket', 'bill', 'receipt', 'drawer', 'test', 'day_close') then
    raise exception 'PRINT_FORBIDDEN: your account can''t print that'
      using errcode = '42501';
  end if;

  if p_kind in ('kitchen_ticket', 'bill') then
    if p_order_ids is null or cardinality(p_order_ids) not between 1 and 50
      or (p_kind = 'kitchen_ticket' and cardinality(p_order_ids) <> 1)
      or exists (
        select 1 from unnest(p_order_ids) as o(id)
        where not exists (
          select 1 from public.orders x
          where x.id = o.id and x.restaurant_id = p_restaurant_id
        )
      ) then
      raise exception 'PRINT_INVALID: those orders aren''t this restaurant''s';
    end if;
  end if;
  if p_kind = 'day_close' and not exists (
    select 1 from public.day_closes
    where id = p_day_close_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'PRINT_INVALID: that day close can''t be printed';
  end if;
  if p_kind = 'receipt' and not exists (
    select 1 from public.order_payments
    where id = p_payment_id and restaurant_id = p_restaurant_id and status = 'succeeded'
  ) then
    raise exception 'PRINT_INVALID: that payment can''t be printed';
  end if;

  insert into public.print_jobs (
    restaurant_id, printer_id, kind, order_id, order_ids, payment_id, day_close_id,
    reprint, open_drawer, requested_by
  )
  select p_restaurant_id, p.id, p_kind,
         case when p_kind = 'kitchen_ticket' then p_order_ids[1] end,
         case when p_kind = 'bill' then p_order_ids end,
         case when p_kind = 'receipt' then p_payment_id end,
         case when p_kind = 'day_close' then p_day_close_id end,
         p_kind = 'kitchen_ticket',
         p_kind = 'drawer',
         v_user
  from public.printers p
  where p.restaurant_id = p_restaurant_id
    and p.is_active
    and case p_kind
      when 'kitchen_ticket' then p.role = 'kitchen'
      when 'drawer' then p.role = 'receipt' and p.opens_drawer
      when 'test' then p.id = p_printer_id
      else p.role = 'receipt'
    end;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


revoke execute on function public.request_print(uuid, text, uuid[], uuid, uuid, uuid) from public, anon;
grant execute on function public.request_print(uuid, text, uuid[], uuid, uuid, uuid) to authenticated, service_role;
