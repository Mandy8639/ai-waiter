-- Split bill (phase J): one tab, paid in parts by several people, each on
-- their own phone (so each can use their own Apple Pay or Google Pay).
--
-- THE WHOLE PHASE IN ONE SENTENCE: the parts add up to exactly the bill,
-- to the cent, and no order is marked paid until every part is.
--
-- THE SHAPE
--
--   The diner holding the tab freezes their unpaid orders into a split
--   (create_tab_split), either as N EQUAL SHARES or as ONE PART PER DISH.
--   Each part is a row in tab_split_units with an exact amount, fixed at
--   creation and never recomputed. Anyone holding the split's link picks
--   parts and pays for them through Stripe Checkout (start_split_payment):
--   one order_payments row per payer, tagged with split_id.
--
--   A split payment covers NO orders while the split is open. Only when
--   the last part is paid does the split record coverage in
--   payment_orders, all at once, for every split payment. Until then, the
--   rest of the payment code — which decides "paid" by a succeeded
--   payment covering the order — sees these orders as unpaid, which is the
--   truth.
--
-- EXACTNESS
--
--   Money is split in integer minor units (cents; whole yen for JPY) by the
--   largest-remainder method (allocate_minor). Equal shares of $100.00 in
--   three are 33.34 + 33.33 + 33.33: the leftover cent goes to the first
--   share and is never created or lost. A dish's part is its line total
--   plus its exact slice of that order's tax and service charge, allocated
--   the same way, so the dish parts of an order add up to the order's
--   total. The coverage written at the end has both margins exact: each
--   payment's rows add up to what it charged, and each order's rows add up
--   to its total. The tests check all of these.
--
-- NOTHING ELSE CAN PAY THESE ORDERS WHILE THE SPLIT IS OPEN
--
--   A BEFORE INSERT trigger on payment_orders refuses to attach an order in
--   an open split to any payment that isn't that split's own. Every other
--   way of paying — one order, the whole tab, cash — goes through
--   payment_orders, so none of them needs changing to respect a split.
--   The one exception is start_tab_payment(), which is re-created below
--   with a single extra predicate so a tab with a split in it can still
--   pay its OTHER orders instead of refusing outright.
--
-- STATE ONLY MOVES ON STRIPE'S SAY-SO
--
--   A part is claimed ('pending') when its payer opens Checkout, becomes
--   'paid' only when the signed webhook settles that payment
--   (mark_order_payment_succeeded, unchanged), and is released back to
--   'open' only when the webhook reports the Checkout failed or expired
--   (mark_order_payment_failed, unchanged). There is deliberately no
--   function a browser can call to release a claim: a released claim whose
--   Checkout is still payable would be a way to pay twice. Abandoning a
--   Checkout is done by asking Stripe to expire it, and letting Stripe's
--   event do the rest.

-- Money helpers ---------------------------------------------------------------

-- Mirrors ZERO_DECIMAL_CURRENCIES in src/lib/payments/money.ts; a unit test
-- checks the two lists match.
create function public.currency_minor_digits(p_currency text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when upper(p_currency) in (
      'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
      'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'
    ) then 0
    else 2
  end
$$;

create function public.to_minor_units(p_amount numeric, p_currency text)
returns bigint
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_scaled numeric := p_amount * power(10::numeric, public.currency_minor_digits(p_currency));
begin
  if v_scaled <> trunc(v_scaled) then
    raise exception 'SPLIT_AMOUNT_PRECISION: % has more precision than % allows', p_amount, p_currency
      using errcode = '22023';
  end if;
  return v_scaled::bigint;
end;
$$;

create function public.from_minor_units(p_minor bigint, p_currency text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select round(p_minor::numeric / power(10::numeric, public.currency_minor_digits(p_currency)), 2)
$$;

-- Largest remainder: p_total split across p_weights in proportion, as
-- integers that add up to exactly p_total. Ties go to the earlier
-- position. All-zero weights are treated as equal weights.
create function public.allocate_minor(p_total bigint, p_weights bigint[])
returns bigint[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_n integer := coalesce(array_length(p_weights, 1), 0);
  v_weights bigint[] := p_weights;
  v_sum numeric;
  v_result bigint[];
  v_rem numeric[];
  v_leftover bigint;
  v_i integer;
  v_idx integer;
begin
  if v_n = 0 then
    if p_total <> 0 then
      raise exception 'allocate_minor: nothing to allocate % across', p_total;
    end if;
    return array[]::bigint[];
  end if;
  if p_total < 0 then
    raise exception 'allocate_minor: negative total %', p_total;
  end if;

  select coalesce(sum(w), 0) into v_sum from unnest(v_weights) as w;
  if v_sum = 0 then
    v_weights := array_fill(1::bigint, array[v_n]);
    v_sum := v_n;
  end if;

  v_result := array_fill(0::bigint, array[v_n]);
  v_rem := array_fill(0::numeric, array[v_n]);
  for v_i in 1 .. v_n loop
    if v_weights[v_i] < 0 then
      raise exception 'allocate_minor: negative weight';
    end if;
    v_result[v_i] := floor(p_total::numeric * v_weights[v_i] / v_sum);
    v_rem[v_i] := (p_total::numeric * v_weights[v_i]) - v_result[v_i] * v_sum;
  end loop;

  select p_total - coalesce(sum(r), 0) into v_leftover from unnest(v_result) as r;

  for v_idx in
    select i from generate_subscripts(v_rem, 1) as i
    order by v_rem[i] desc, i asc
    limit v_leftover
  loop
    v_result[v_idx] := v_result[v_idx] + 1;
  end loop;

  return v_result;
end;
$$;

revoke execute on function public.currency_minor_digits(text) from public, anon;
revoke execute on function public.to_minor_units(numeric, text) from public, anon;
revoke execute on function public.from_minor_units(bigint, text) from public, anon;
revoke execute on function public.allocate_minor(bigint, bigint[]) from public, anon;
grant execute on function public.currency_minor_digits(text) to authenticated;
grant execute on function public.to_minor_units(numeric, text) to authenticated;
grant execute on function public.from_minor_units(bigint, text) to authenticated;
grant execute on function public.allocate_minor(bigint, bigint[]) to authenticated;

-- Tables ----------------------------------------------------------------------

create table public.tab_splits (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  customer_session_id uuid not null,
  mode text not null,
  currency text not null,
  total numeric(10, 2) not null,
  token_hash text not null unique,
  -- The link itself, kept so the diner who made the split can show it to
  -- the table again. Looked up only by hash; read back only by its owner
  -- (get_my_open_split). Holding it lets someone read the bill and PAY part
  -- of it, never take anything, which is why it is not treated like a
  -- staff invitation token.
  share_token text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  cancelled_at timestamptz,

  constraint tab_splits_restaurant_id_id_key unique (restaurant_id, id),
  constraint tab_splits_session_same_restaurant
    foreign key (restaurant_id, customer_session_id)
    references public.customer_sessions (restaurant_id, id)
    on delete cascade,
  constraint tab_splits_mode_valid check (mode in ('equal', 'by_dish')),
  constraint tab_splits_status_valid check (status in ('open', 'paid', 'cancelled')),
  constraint tab_splits_total_positive check (total > 0)
);

comment on table public.tab_splits is
  'Phase J: a tab frozen for paying in parts. Parts are tab_split_units; its orders are tab_split_orders. Written only through the split functions. See docs/security.md#split-bill-phase-j.';

-- One open split per visit.
create unique index tab_splits_one_open_per_session
  on public.tab_splits (customer_session_id) where status = 'open';

create table public.tab_split_orders (
  split_id uuid not null,
  order_id uuid not null,
  restaurant_id uuid not null,
  active boolean not null default true,

  primary key (split_id, order_id),
  constraint tab_split_orders_split_same_restaurant
    foreign key (restaurant_id, split_id)
    references public.tab_splits (restaurant_id, id) on delete cascade,
  constraint tab_split_orders_order_same_restaurant
    foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete cascade
);

-- An order is in at most one live split.
create unique index tab_split_orders_one_active_per_order
  on public.tab_split_orders (order_id) where active;

create table public.tab_split_units (
  id uuid primary key default gen_random_uuid(),
  split_id uuid not null,
  restaurant_id uuid not null,
  position integer not null,
  kind text not null,
  label text not null,
  order_id uuid,
  order_item_id uuid,
  amount numeric(10, 2) not null,
  status text not null default 'open',
  payment_id uuid references public.order_payments (id) on delete set null,

  constraint tab_split_units_split_same_restaurant
    foreign key (restaurant_id, split_id)
    references public.tab_splits (restaurant_id, id) on delete cascade,
  constraint tab_split_units_kind_valid check (kind in ('share', 'dish')),
  constraint tab_split_units_status_valid check (status in ('open', 'pending', 'paid')),
  constraint tab_split_units_amount_non_negative check (amount >= 0),
  constraint tab_split_units_position_unique unique (split_id, position),
  -- A claimed part names its payment; an open part names none.
  constraint tab_split_units_claim_consistent
    check ((status = 'open') = (payment_id is null))
);

create index tab_split_units_payment_id_idx on public.tab_split_units (payment_id)
  where payment_id is not null;

alter table public.order_payments
  add column split_id uuid references public.tab_splits (id) on delete restrict;

comment on column public.order_payments.split_id is
  'Phase J: set when this payment pays parts of a split. Such a payment covers no orders (no payment_orders rows) until the whole split is paid.';

create index order_payments_split_id_idx on public.order_payments (split_id)
  where split_id is not null;

alter table public.tab_splits enable row level security;
alter table public.tab_split_orders enable row level security;
alter table public.tab_split_units enable row level security;
-- No policies: read and written only through the functions below.

-- Guards ------------------------------------------------------------------------

-- Nothing but the split itself may attach an order in an open split to a
-- payment. Covers start_order_payment, start_tab_payment and
-- record_cash_payment without editing them.
create function public.enforce_split_order_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_split uuid;
  v_payment_split uuid;
begin
  select so.split_id into v_split
  from public.tab_split_orders so
  join public.tab_splits s on s.id = so.split_id
  where so.order_id = new.order_id
    and so.active
    and s.status = 'open';

  if v_split is null then
    return new;
  end if;

  select p.split_id into v_payment_split
  from public.order_payments p
  where p.id = new.payment_id;

  if v_payment_split is distinct from v_split then
    raise exception 'PAYMENT_ORDER_IN_SPLIT: this order is part of a bill being split'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_split_order_payment() from public, anon, authenticated;

create trigger payment_orders_respect_split
  before insert on public.payment_orders
  for each row execute function public.enforce_split_order_payment();

-- An order people are part-way through paying for cannot be cancelled out
-- from under them: the split would charge for food that was never made.
create function public.enforce_split_order_not_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' and exists (
    select 1
    from public.tab_split_orders so
    join public.tab_splits s on s.id = so.split_id
    where so.order_id = new.id and so.active and s.status = 'open'
  ) then
    raise exception 'ORDER_IN_SPLIT: this order is part of a bill being split; the table must cancel the split first'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_split_order_not_cancelled() from public, anon, authenticated;

create trigger orders_not_cancelled_in_split
  before update on public.orders
  for each row execute function public.enforce_split_order_not_cancelled();

-- Creating a split ----------------------------------------------------------------

create function public.split_token_hash(p_token text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

revoke execute on function public.split_token_hash(text) from public, anon, authenticated;

-- Freezes the caller's unpaid orders into a split. The caller's visit comes
-- from auth.uid(); nothing about which orders or how much is taken from the
-- browser except the mode and, for equal shares, how many.
create function public.create_tab_split(p_mode text, p_share_count integer default null)
returns table (new_split_id uuid, new_split_token text)
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
  v_total_minor bigint;
  v_split uuid;
  v_token text;
  v_shares bigint[];
  v_i integer;
  v_position integer := 0;
  v_order record;
  v_lines record;
  v_line_ids uuid[];
  v_line_names text[];
  v_line_qty integer[];
  v_line_minor bigint[];
  v_extras bigint[];
begin
  if p_mode not in ('equal', 'by_dish') then
    raise exception 'SPLIT_INVALID_MODE' using errcode = '22023';
  end if;
  if p_mode = 'equal' and (p_share_count is null or p_share_count < 2 or p_share_count > 20) then
    raise exception 'SPLIT_INVALID_SHARES: split into 2 to 20 shares' using errcode = '22023';
  end if;

  select * into v_session
  from public.customer_sessions cs
  where cs.user_id = auth.uid()
    and cs.status = 'active'
    and cs.expires_at > now();
  if not found then
    raise exception 'PAYMENT_NO_SESSION: no active session for this diner' using errcode = 'P0002';
  end if;

  select * into v_settings from public.restaurant_settings s
  where s.restaurant_id = v_session.restaurant_id;
  if not found or not v_settings.accept_card then
    raise exception 'PAYMENT_CARD_NOT_ACCEPTED: restaurant does not accept card' using errcode = '22023';
  end if;

  select * into v_account from public.restaurant_payment_accounts a
  where a.restaurant_id = v_session.restaurant_id;
  if not found or not v_account.charges_enabled then
    raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.tab_splits s
    where s.customer_session_id = v_session.id and s.status = 'open'
  ) then
    raise exception 'SPLIT_ALREADY_OPEN: this bill is already being split' using errcode = '22023';
  end if;

  -- Lock the tab's orders so a concurrent payment can't settle one while
  -- the split is being frozen around it.
  perform 1 from public.orders o
  where o.customer_session_id = v_session.id and o.status <> 'cancelled'
  for update;

  select array_agg(o.id order by o.order_number), coalesce(sum(o.total), 0),
         min(o.currency), count(distinct o.currency)::integer
  into v_order_ids, v_total, v_currency, v_currency_count
  from public.orders o
  where o.customer_session_id = v_session.id
    and o.status <> 'cancelled'
    and not exists (
      select 1 from public.payment_orders po
      join public.order_payments p on p.id = po.payment_id
      where po.order_id = o.id and p.status = 'succeeded'
    );

  if v_order_ids is null or v_total <= 0 then
    raise exception 'PAYMENT_NOTHING_TO_PAY: this tab has no unpaid orders' using errcode = '22023';
  end if;
  if v_currency_count > 1 then
    raise exception 'PAYMENT_MIXED_CURRENCY: this tab mixes currencies' using errcode = '22023';
  end if;

  -- A Checkout already open for any of these orders could still be paid.
  -- The caller must have Stripe expire it first; the webhook then marks it
  -- cancelled and this succeeds.
  if exists (
    select 1 from public.payment_orders po
    join public.order_payments p on p.id = po.payment_id
    where po.order_id = any(v_order_ids) and p.status = 'pending'
  ) then
    raise exception 'PAYMENT_IN_PROGRESS: a payment for this bill is already open' using errcode = '22023';
  end if;

  v_total_minor := public.to_minor_units(v_total, v_currency);
  if p_mode = 'equal' and v_total_minor < p_share_count then
    raise exception 'SPLIT_TOO_SMALL: the bill is too small to split that many ways' using errcode = '22023';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.tab_splits (restaurant_id, customer_session_id, mode, currency, total, token_hash, share_token)
  values (v_session.restaurant_id, v_session.id, p_mode, v_currency, v_total, public.split_token_hash(v_token), v_token)
  returning id into v_split;

  insert into public.tab_split_orders (split_id, order_id, restaurant_id)
  select v_split, unnest(v_order_ids), v_session.restaurant_id;

  if p_mode = 'equal' then
    v_shares := public.allocate_minor(
      v_total_minor, array_fill(1::bigint, array[p_share_count])
    );
    for v_i in 1 .. p_share_count loop
      insert into public.tab_split_units (split_id, restaurant_id, position, kind, label, amount)
      values (
        v_split, v_session.restaurant_id, v_i, 'share',
        format('Share %s of %s', v_i, p_share_count),
        public.from_minor_units(v_shares[v_i], v_currency)
      );
    end loop;
  else
    -- One part per order line: the line total plus its slice of the
    -- order's tax and service charge (total - subtotal), allocated by line
    -- total so the lines of each order add up to exactly the order total.
    for v_order in
      select o.id, o.order_number, o.total
      from public.orders o
      where o.id = any(v_order_ids)
      order by o.order_number
    loop
      select array_agg(oi.id order by oi.created_at, oi.item_name, oi.id),
             array_agg(oi.item_name order by oi.created_at, oi.item_name, oi.id),
             array_agg(oi.quantity order by oi.created_at, oi.item_name, oi.id),
             array_agg(public.to_minor_units(oi.line_total, v_currency) order by oi.created_at, oi.item_name, oi.id)
      into v_line_ids, v_line_names, v_line_qty, v_line_minor
      from public.order_items oi
      where oi.order_id = v_order.id;

      if v_line_ids is null then
        raise exception 'SPLIT_ORDER_HAS_NO_ITEMS: order #% has nothing to split', v_order.order_number
          using errcode = '22023';
      end if;

      v_extras := public.allocate_minor(
        public.to_minor_units(v_order.total, v_currency)
          - (select sum(m) from unnest(v_line_minor) as m)::bigint,
        v_line_minor
      );

      for v_i in 1 .. array_length(v_line_ids, 1) loop
        v_position := v_position + 1;
        insert into public.tab_split_units
          (split_id, restaurant_id, position, kind, label, order_id, order_item_id, amount)
        values (
          v_split, v_session.restaurant_id, v_position, 'dish',
          case when v_line_qty[v_i] > 1
            then format('%s× %s', v_line_qty[v_i], v_line_names[v_i])
            else v_line_names[v_i] end,
          v_order.id, v_line_ids[v_i],
          public.from_minor_units(v_line_minor[v_i] + v_extras[v_i], v_currency)
        );
      end loop;
    end loop;
  end if;

  -- The invariant the phase exists for, checked where it is made.
  if (select sum(u.amount) from public.tab_split_units u where u.split_id = v_split) <> v_total then
    raise exception 'SPLIT_SUM_MISMATCH: parts do not add up to the bill' using errcode = 'XX000';
  end if;

  return query select v_split, v_token;
end;
$$;

comment on function public.create_tab_split(text, integer) is
  'Phase J: freezes the caller''s unpaid orders into a split (equal shares or one part per dish) and returns the share link token once. The parts add up to exactly the bill. Session from auth.uid().';

revoke execute on function public.create_tab_split(text, integer) from public, anon;
grant execute on function public.create_tab_split(text, integer) to authenticated;

-- The owner cancels a split nobody has started paying.
create function public.cancel_tab_split()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_split uuid;
begin
  select s.id into v_split
  from public.tab_splits s
  join public.customer_sessions cs on cs.id = s.customer_session_id
  where cs.user_id = auth.uid() and s.status = 'open'
  for update of s;

  if v_split is null then
    raise exception 'SPLIT_NOT_FOUND: no open split for this bill' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.tab_split_units u
    where u.split_id = v_split and u.status <> 'open'
  ) then
    raise exception 'SPLIT_STARTED: someone has already paid or is paying a part' using errcode = '22023';
  end if;

  update public.tab_splits set status = 'cancelled', cancelled_at = now() where id = v_split;
  update public.tab_split_orders set active = false where split_id = v_split;
end;
$$;

revoke execute on function public.cancel_tab_split() from public, anon;
grant execute on function public.cancel_tab_split() to authenticated;

-- Reading a split -------------------------------------------------------------------

-- Everything the split page shows, for anyone holding the link. No
-- names, no session, no table: what was ordered, the parts and whether
-- each is paid.
create function public.get_tab_split(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_split public.tab_splits%rowtype;
  v_result jsonb;
begin
  select * into v_split from public.tab_splits s
  where s.token_hash = public.split_token_hash(p_token);
  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'split_id', v_split.id,
    'status', v_split.status,
    'mode', v_split.mode,
    'currency', v_split.currency,
    'total', v_split.total,
    'paid_total', coalesce((
      select sum(u.amount) from public.tab_split_units u
      where u.split_id = v_split.id and u.status = 'paid'), 0),
    'restaurant_name', r.name,
    'restaurant_slug', r.slug,
    'tipping_enabled', coalesce((
      select st.tipping_enabled from public.restaurant_settings st
      where st.restaurant_id = v_split.restaurant_id), false),
    'is_owner', exists (
      select 1 from public.customer_sessions cs
      where cs.id = v_split.customer_session_id and cs.user_id = auth.uid()),
    'order_numbers', (
      select coalesce(jsonb_agg(o.order_number order by o.order_number), '[]'::jsonb)
      from public.tab_split_orders so join public.orders o on o.id = so.order_id
      where so.split_id = v_split.id),
    'units', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', u.id, 'position', u.position, 'kind', u.kind, 'label', u.label,
        'amount', u.amount, 'status', u.status) order by u.position), '[]'::jsonb)
      from public.tab_split_units u where u.split_id = v_split.id)
  )
  into v_result
  from public.restaurants r
  where r.id = v_split.restaurant_id;

  return v_result;
end;
$$;

revoke execute on function public.get_tab_split(text) from public;
grant execute on function public.get_tab_split(text) to anon, authenticated;

-- The caller's own open split, so the tab page can link back to it.
create function public.get_my_open_split()
returns table (open_split_id uuid, open_split_token text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.share_token
  from public.tab_splits s
  join public.customer_sessions cs on cs.id = s.customer_session_id
  where cs.user_id = auth.uid() and s.status = 'open'
$$;

revoke execute on function public.get_my_open_split() from public, anon;
grant execute on function public.get_my_open_split() to authenticated;

-- Paying parts ------------------------------------------------------------------------

-- Claims the chosen parts for one payer and creates their payment. The
-- amount is the sum of the parts, read here; the browser names only which
-- parts and the tip. Returns what the server needs to open Checkout,
-- including the platform fee (computed here because a payer from a shared
-- link may not be signed in).
create function public.start_split_payment(
  p_token text,
  p_unit_ids uuid[],
  p_tip_amount numeric default 0
)
returns table (
  split_payment_id uuid,
  split_amount numeric,
  split_tip numeric,
  split_total numeric,
  split_currency text,
  split_stripe_account_id text,
  split_restaurant_slug text,
  split_part_count integer,
  split_fee_minor_units integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_split public.tab_splits%rowtype;
  v_settings public.restaurant_settings%rowtype;
  v_account public.restaurant_payment_accounts%rowtype;
  v_count integer;
  v_open integer;
  v_amount numeric(10, 2);
  v_payment uuid;
begin
  if p_tip_amount is null or p_tip_amount < 0 then
    raise exception 'Tip cannot be negative' using errcode = '22023';
  end if;
  if p_unit_ids is null or cardinality(p_unit_ids) = 0 then
    raise exception 'SPLIT_NOTHING_CHOSEN: choose what you are paying for' using errcode = '22023';
  end if;

  select * into v_split from public.tab_splits s
  where s.token_hash = public.split_token_hash(p_token)
  for update;
  if not found then
    raise exception 'SPLIT_NOT_FOUND: this split link is not valid' using errcode = 'P0002';
  end if;
  if v_split.status <> 'open' then
    raise exception 'SPLIT_CLOSED: this bill is already settled or the split was cancelled' using errcode = '22023';
  end if;

  select * into v_settings from public.restaurant_settings s
  where s.restaurant_id = v_split.restaurant_id;
  if not found or not v_settings.accept_card then
    raise exception 'PAYMENT_CARD_NOT_ACCEPTED: restaurant does not accept card' using errcode = '22023';
  end if;
  if not v_settings.tipping_enabled and p_tip_amount > 0 then
    raise exception 'PAYMENT_TIPPING_DISABLED: restaurant has tipping switched off' using errcode = '22023';
  end if;
  select * into v_account from public.restaurant_payment_accounts a
  where a.restaurant_id = v_split.restaurant_id;
  if not found or not v_account.charges_enabled then
    raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
  end if;

  -- Lock the chosen parts; every one must belong to this split and be free.
  select count(*)::integer,
         count(*) filter (where u.status = 'open')::integer,
         coalesce(sum(u.amount), 0)
  into v_count, v_open, v_amount
  from (
    select u.* from public.tab_split_units u
    where u.id = any(p_unit_ids) and u.split_id = v_split.id
    for update
  ) u;

  if v_count <> cardinality(array(select distinct unnest(p_unit_ids))) then
    raise exception 'SPLIT_UNKNOWN_PART: one of those parts is not on this bill' using errcode = '22023';
  end if;
  if v_open <> v_count then
    raise exception 'SPLIT_PART_TAKEN: someone is already paying for one of those' using errcode = '22023';
  end if;
  if v_amount <= 0 then
    raise exception 'SPLIT_NOTHING_TO_PAY: those parts come to nothing' using errcode = '22023';
  end if;

  insert into public.order_payments (restaurant_id, status, method, amount, tip_amount, currency, split_id)
  values (v_split.restaurant_id, 'pending', 'card', v_amount, p_tip_amount, v_split.currency, v_split.id)
  returning id into v_payment;

  update public.tab_split_units u
  set status = 'pending', payment_id = v_payment
  where u.id = any(p_unit_ids) and u.split_id = v_split.id;

  return query
    select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
           v_account.stripe_account_id,
           (select r.slug from public.restaurants r where r.id = v_split.restaurant_id),
           v_count,
           public.platform_fee_minor_units(
             v_split.restaurant_id,
             public.to_minor_units(p.amount, p.currency)::integer
           )
    from public.order_payments p where p.id = v_payment;
end;
$$;

comment on function public.start_split_payment(text, uuid[], numeric) is
  'Phase J: a payer (anyone with the split link) claims parts and gets one pending card payment for their sum. Callable without signing in, by design: holding the link is the permission, and paying someone''s bill takes nothing from them.';

revoke execute on function public.start_split_payment(text, uuid[], numeric) from public;
grant execute on function public.start_split_payment(text, uuid[], numeric) to anon, authenticated;

-- Records the Checkout session on a split payment (the split's version of
-- attach_payment_checkout_session, which checks order ownership a split
-- payer doesn't have).
create function public.attach_split_checkout_session(
  p_token text,
  p_payment_id uuid,
  p_checkout_session_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  update public.order_payments p
  set stripe_checkout_session_id = p_checkout_session_id
  from public.tab_splits s
  where p.id = p_payment_id
    and p.split_id = s.id
    and s.token_hash = public.split_token_hash(p_token)
    and p.status = 'pending'
    and p.stripe_checkout_session_id is null;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'SPLIT_PAYMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.attach_split_checkout_session(text, uuid, text) from public;
grant execute on function public.attach_split_checkout_session(text, uuid, text) to anon, authenticated;

-- What the server needs to ask Stripe to expire an abandoned split
-- Checkout. Read-only: the claim is released by Stripe's own event.
create function public.get_split_payment_checkout(p_token text, p_payment_id uuid)
returns table (split_checkout_session_id text, split_stripe_account_id text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.stripe_checkout_session_id, a.stripe_account_id
  from public.order_payments p
  join public.tab_splits s on s.id = p.split_id
  join public.restaurant_payment_accounts a on a.restaurant_id = s.restaurant_id
  where p.id = p_payment_id
    and s.token_hash = public.split_token_hash(p_token)
    and p.status = 'pending'
    and p.stripe_checkout_session_id is not null
$$;

revoke execute on function public.get_split_payment_checkout(text, uuid) from public;
grant execute on function public.get_split_payment_checkout(text, uuid) to anon, authenticated;

-- The pending Checkouts on the caller's own tab, so the server can have
-- Stripe expire them before a split is made.
create function public.get_my_tab_pending_checkouts()
returns table (pending_checkout_session_id text, pending_stripe_account_id text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct p.stripe_checkout_session_id, a.stripe_account_id
  from public.customer_sessions cs
  join public.orders o on o.customer_session_id = cs.id
  join public.payment_orders po on po.order_id = o.id
  join public.order_payments p on p.id = po.payment_id
  join public.restaurant_payment_accounts a on a.restaurant_id = p.restaurant_id
  where cs.user_id = auth.uid()
    and p.status = 'pending'
    and p.stripe_checkout_session_id is not null
$$;

revoke execute on function public.get_my_tab_pending_checkouts() from public, anon;
grant execute on function public.get_my_tab_pending_checkouts() to authenticated;

-- Settling --------------------------------------------------------------------------

-- Follows a split payment's status, as set by the webhook functions.
-- Succeeded: its parts are paid, and if that was the last part the split
-- is paid and coverage is written. Failed or cancelled: its parts are
-- released for someone else to pay.
create function public.follow_split_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_split public.tab_splits%rowtype;
  v_orders uuid[];
  v_order_minor bigint[];
  v_payment record;
  v_remaining bigint;
  v_take bigint;
  v_o integer;
begin
  if new.split_id is null or new.status = old.status then
    return new;
  end if;

  -- Serialise every settlement of this split: two parts paid at the same
  -- moment must not both conclude that the other is still outstanding.
  select * into v_split from public.tab_splits s where s.id = new.split_id for update;

  if new.status in ('failed', 'cancelled') then
    update public.tab_split_units u
    set status = 'open', payment_id = null
    where u.payment_id = new.id and u.status = 'pending';
    return new;
  end if;

  if new.status <> 'succeeded' then
    return new;
  end if;

  update public.tab_split_units u
  set status = 'paid'
  where u.payment_id = new.id;

  if v_split.status <> 'open' or exists (
    select 1 from public.tab_split_units u
    where u.split_id = v_split.id and u.status <> 'paid'
  ) then
    return new;
  end if;

  -- The last part. The split is paid; write coverage for every payment in
  -- it, with both margins exact.
  update public.tab_splits set status = 'paid', paid_at = now() where id = v_split.id;

  if v_split.mode = 'by_dish' then
    -- Each payment covers exactly the dishes it paid for.
    insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
    select u.payment_id, u.order_id, v_split.restaurant_id, sum(u.amount)
    from public.tab_split_units u
    where u.split_id = v_split.id
    group by u.payment_id, u.order_id;
  else
    -- Equal shares: fill orders in order, payment by payment (a
    -- north-west-corner fill), so each payment's rows add up to its amount
    -- and each order's rows add up to its total.
    select array_agg(o.id order by o.order_number),
           array_agg(public.to_minor_units(o.total, v_split.currency) order by o.order_number)
    into v_orders, v_order_minor
    from public.tab_split_orders so join public.orders o on o.id = so.order_id
    where so.split_id = v_split.id;

    v_o := 1;
    for v_payment in
      select p.id, public.to_minor_units(p.amount, p.currency) as minor
      from public.order_payments p
      where p.split_id = v_split.id and p.status = 'succeeded'
      order by (select min(u.position) from public.tab_split_units u where u.payment_id = p.id)
    loop
      v_remaining := v_payment.minor;
      while v_remaining > 0 loop
        v_take := least(v_remaining, v_order_minor[v_o]);
        if v_take > 0 then
          insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
          values (v_payment.id, v_orders[v_o], v_split.restaurant_id,
                  public.from_minor_units(v_take, v_split.currency));
        end if;
        v_order_minor[v_o] := v_order_minor[v_o] - v_take;
        v_remaining := v_remaining - v_take;
        if v_order_minor[v_o] = 0 and v_o < array_length(v_orders, 1) then
          v_o := v_o + 1;
        end if;
      end loop;
    end loop;
  end if;

  return new;
end;
$$;

revoke execute on function public.follow_split_payment() from public, anon, authenticated;

create trigger order_payments_follow_split
  after update of status on public.order_payments
  for each row execute function public.follow_split_payment();

-- A split payment must never pick up coverage any other way than the
-- split's own completion, and a paid split's payments are the only ones
-- allowed to share an order. The one-succeeded-payment-per-order trigger
-- only fires when a payment changes status; split coverage is written
-- after every split payment has already succeeded, so it never trips it.

-- start_tab_payment(): unchanged but for one predicate — orders in a split
-- are the split's to settle, so the rest of the tab stays payable.
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

  select p.* into v_existing
  from public.order_payments p
  where p.restaurant_id = v_session.restaurant_id
    and p.status = 'pending'
    and p.split_id is null
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
    )
    -- Phase J: an order in a live split is the split's to settle.
    and not exists (
      select 1
      from public.tab_split_orders so
      join public.tab_splits s on s.id = so.split_id
      where so.order_id = o.id and so.active and s.status = 'open'
    );

  if v_count = 0 then
    raise exception 'PAYMENT_NOTHING_TO_PAY: this tab has no unpaid orders' using errcode = '22023';
  end if;

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

revoke execute on function public.start_tab_payment(numeric) from public, anon;
grant execute on function public.start_tab_payment(numeric) to authenticated;
