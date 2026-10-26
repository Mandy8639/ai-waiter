-- Network receipt and kitchen printers, driven by our server (Star
-- CloudPRNT). The printer polls https://<host>/api/cloudprnt/<token>
-- every few seconds; when a job is waiting it fetches it and confirms it
-- printed. Nothing is installed on a restaurant device, and printing
-- carries on with every screen closed.
--
-- printers     one row per physical printer. The token in its URL is the
--              only credential a printer has, so only its SHA-256 is
--              stored; the token is shown once, when the printer is added.
-- print_jobs   what each printer still has to print. A job names what to
--              print (an order, a payment, a bill for several orders), not
--              the bytes: the ticket is rendered when the printer asks for
--              it, in the command set that printer reported.
--
-- Queued automatically:
--   kitchen_ticket  for every kitchen printer with auto_print, when an
--                   order is placed; a pickup order waits until its ticket
--                   release time, like the kitchen board.
--   receipt         for every receipt printer with auto_print, when a
--                   payment succeeds; opens the cash drawer too for cash,
--                   on a printer with opens_drawer.
--   drawer          cash on a drawer printer that doesn't print receipts.
-- Queued by hand through request_print(): reprints, a table's bill, a
-- receipt again, opening the drawer, a test page.
--
-- Queueing never gets in the way of an order or a payment: a failure in
-- the triggers is swallowed with a warning.

create table public.printers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null,
  role text not null,
  station_id uuid,
  token_hash text not null,
  auto_print boolean not null default true,
  opens_drawer boolean not null default false,
  is_active boolean not null default true,
  -- Learned from the printer itself.
  mac text,
  client_type text,
  encodings text,
  encodings_at timestamptz,
  last_seen_at timestamptz,
  last_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint printers_restaurant_id_id_key unique (restaurant_id, id),
  constraint printers_token_hash_key unique (token_hash),
  constraint printers_name_length check (length(trim(name)) between 1 and 60),
  constraint printers_role_valid check (role in ('kitchen', 'receipt')),
  constraint printers_station_same_restaurant
    foreign key (restaurant_id, station_id)
    references public.kitchen_stations (restaurant_id, id)
    on delete set null (station_id),
  constraint printers_station_only_kitchen check (station_id is null or role = 'kitchen'),
  constraint printers_drawer_only_receipt check (not opens_drawer or role = 'receipt')
);

comment on table public.printers is
  'Star CloudPRNT printers. Polls /api/cloudprnt/<token>; only the token''s SHA-256 is stored. Managed through create_printer() / update_printer() / delete_printer() / rotate_printer_token().';

create trigger trg_printers_set_updated_at
  before update on public.printers
  for each row execute function public.set_updated_at();

alter table public.printers enable row level security;

-- Owners and managers see their printers (the token hash never leaves the
-- database: the app selects named columns). No write policies.
create policy "printers_select_managers"
  on public.printers for select to authenticated
  using (public.current_restaurant_role(restaurant_id) in ('owner', 'manager'));

create table public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  printer_id uuid not null,
  kind text not null,
  order_id uuid,
  order_ids uuid[],
  payment_id uuid references public.order_payments (id) on delete cascade,
  reprint boolean not null default false,
  open_drawer boolean not null default false,
  status text not null default 'queued',
  attempts integer not null default 0,
  print_after timestamptz not null default now(),
  sent_at timestamptz,
  printed_at timestamptz,
  last_code text,
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint print_jobs_printer_same_restaurant
    foreign key (restaurant_id, printer_id)
    references public.printers (restaurant_id, id)
    on delete cascade,
  constraint print_jobs_order_same_restaurant
    foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id)
    on delete cascade,
  constraint print_jobs_kind_valid check (kind in ('kitchen_ticket', 'receipt', 'bill', 'drawer', 'test')),
  constraint print_jobs_status_valid check (status in ('queued', 'sent', 'printed', 'failed', 'skipped')),
  constraint print_jobs_target check (
    (kind = 'kitchen_ticket' and order_id is not null)
    or (kind = 'receipt' and payment_id is not null)
    or (kind = 'bill' and cardinality(order_ids) between 1 and 50)
    or kind in ('drawer', 'test')
  )
);

comment on table public.print_jobs is
  'What each printer still has to print. Rendered when the printer fetches it (src/lib/printing/). Written by the triggers below and request_print(); claimed by the CloudPRNT route with the service role.';

create index print_jobs_printer_waiting
  on public.print_jobs (printer_id, print_after)
  where status in ('queued', 'sent');

alter table public.print_jobs enable row level security;

create policy "print_jobs_select_members"
  on public.print_jobs for select to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- Kitchen tickets for a new order.
create function public.queue_kitchen_tickets()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    insert into public.print_jobs (restaurant_id, printer_id, kind, order_id, print_after)
    select new.restaurant_id, p.id, 'kitchen_ticket', new.id,
           coalesce(new.ticket_release_at, new.created_at)
    from public.printers p
    where p.restaurant_id = new.restaurant_id
      and p.role = 'kitchen'
      and p.is_active
      and p.auto_print;
  exception when others then
    raise warning 'queue_kitchen_tickets: %', sqlerrm;
  end;
  return new;
end;
$$;
revoke execute on function public.queue_kitchen_tickets() from public, anon, authenticated;

create trigger trg_orders_queue_kitchen_tickets
  after insert on public.orders
  for each row execute function public.queue_kitchen_tickets();

-- A receipt (and the drawer, for cash) once a payment succeeds.
create function public.queue_payment_prints()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status <> 'succeeded'
    or (tg_op = 'UPDATE' and old.status = 'succeeded') then
    return new;
  end if;
  begin
    insert into public.print_jobs (restaurant_id, printer_id, kind, payment_id, open_drawer)
    select new.restaurant_id, p.id,
           case when p.auto_print then 'receipt' else 'drawer' end,
           case when p.auto_print then new.id end,
           new.method = 'cash' and p.opens_drawer
    from public.printers p
    where p.restaurant_id = new.restaurant_id
      and p.role = 'receipt'
      and p.is_active
      and (p.auto_print or (new.method = 'cash' and p.opens_drawer));
  exception when others then
    raise warning 'queue_payment_prints: %', sqlerrm;
  end;
  return new;
end;
$$;
revoke execute on function public.queue_payment_prints() from public, anon, authenticated;

create trigger trg_order_payments_queue_prints
  after insert or update of status on public.order_payments
  for each row execute function public.queue_payment_prints();

-- A fresh printer URL token: 64 hex characters from two random UUIDs.
create function public.new_printer_token()
returns text
language sql
volatile
as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;
revoke execute on function public.new_printer_token() from public, anon, authenticated;

create function public.printer_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;
revoke execute on function public.printer_token_hash(text) from public, anon, authenticated;

create function public.assert_can_manage_printers(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.current_restaurant_role(p_restaurant_id), '') not in ('owner', 'manager') then
    raise exception 'PRINTER_FORBIDDEN: only owners and managers can set up printers'
      using errcode = '42501';
  end if;
end;
$$;
revoke execute on function public.assert_can_manage_printers(uuid) from public, anon, authenticated;

-- Adds a printer and returns its token, the only time it is ever shown.
create function public.create_printer(
  p_restaurant_id uuid,
  p_name text,
  p_role text,
  p_station_id uuid default null,
  p_opens_drawer boolean default false
)
returns table (printer_id uuid, token text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text := public.new_printer_token();
  v_id uuid;
begin
  perform public.assert_can_manage_printers(p_restaurant_id);
  if p_role not in ('kitchen', 'receipt') then
    raise exception 'PRINTER_INVALID: choose kitchen or receipt';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 60 then
    raise exception 'PRINTER_INVALID: give the printer a name (60 characters max)';
  end if;

  insert into public.printers (restaurant_id, name, role, station_id, opens_drawer, token_hash)
  values (
    p_restaurant_id, trim(p_name), p_role,
    case when p_role = 'kitchen' then p_station_id end,
    p_role = 'receipt' and coalesce(p_opens_drawer, false),
    public.printer_token_hash(v_token)
  )
  returning id into v_id;

  return query select v_id, v_token;
end;
$$;
revoke execute on function public.create_printer(uuid, text, text, uuid, boolean) from public, anon;
grant execute on function public.create_printer(uuid, text, text, uuid, boolean) to authenticated;

create function public.update_printer(
  p_printer_id uuid,
  p_name text,
  p_station_id uuid,
  p_auto_print boolean,
  p_opens_drawer boolean,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_printer public.printers%rowtype;
begin
  select * into v_printer from public.printers where id = p_printer_id;
  if not found then
    raise exception 'PRINTER_NOT_FOUND: printer not found' using errcode = '42501';
  end if;
  perform public.assert_can_manage_printers(v_printer.restaurant_id);
  if p_name is null or length(trim(p_name)) not between 1 and 60 then
    raise exception 'PRINTER_INVALID: give the printer a name (60 characters max)';
  end if;

  update public.printers set
    name = trim(p_name),
    station_id = case when role = 'kitchen' then p_station_id end,
    auto_print = coalesce(p_auto_print, auto_print),
    opens_drawer = role = 'receipt' and coalesce(p_opens_drawer, opens_drawer),
    is_active = coalesce(p_is_active, is_active)
  where id = p_printer_id;
end;
$$;
revoke execute on function public.update_printer(uuid, text, uuid, boolean, boolean, boolean) from public, anon;
grant execute on function public.update_printer(uuid, text, uuid, boolean, boolean, boolean) to authenticated;

create function public.delete_printer(p_printer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant uuid;
begin
  select restaurant_id into v_restaurant from public.printers where id = p_printer_id;
  if not found then
    raise exception 'PRINTER_NOT_FOUND: printer not found' using errcode = '42501';
  end if;
  perform public.assert_can_manage_printers(v_restaurant);
  delete from public.printers where id = p_printer_id;
end;
$$;
revoke execute on function public.delete_printer(uuid) from public, anon;
grant execute on function public.delete_printer(uuid) to authenticated;

-- A new URL for a printer (the old one stops working at once). For a URL
-- that was shared by mistake, or a printer moved to another restaurant.
create function public.rotate_printer_token(p_printer_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant uuid;
  v_token text := public.new_printer_token();
begin
  select restaurant_id into v_restaurant from public.printers where id = p_printer_id;
  if not found then
    raise exception 'PRINTER_NOT_FOUND: printer not found' using errcode = '42501';
  end if;
  perform public.assert_can_manage_printers(v_restaurant);
  update public.printers
  set token_hash = public.printer_token_hash(v_token),
      mac = null, client_type = null, encodings = null, encodings_at = null, last_seen_at = null
  where id = p_printer_id;
  return v_token;
end;
$$;
revoke execute on function public.rotate_printer_token(uuid) from public, anon;
grant execute on function public.rotate_printer_token(uuid) to authenticated;

-- Printing by hand. Returns how many printers it went to (0: none set up).
--   kitchen_ticket  p_order_ids[1], on every active kitchen printer, marked REPRINT
--   bill            p_order_ids (a table's unpaid orders), on receipt printers
--   receipt         p_payment_id, on receipt printers
--   drawer          opens the drawer on drawer printers
--   test            a test page on p_printer_id (owners and managers)
-- Front of house and owners/managers may print; the kitchen account may
-- reprint a ticket.
create function public.request_print(
  p_restaurant_id uuid,
  p_kind text,
  p_order_ids uuid[] default null,
  p_payment_id uuid default null,
  p_printer_id uuid default null
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
    or (p_kind = 'test' and v_role not in ('owner', 'manager'))
    or p_kind not in ('kitchen_ticket', 'bill', 'receipt', 'drawer', 'test') then
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
  if p_kind = 'receipt' and not exists (
    select 1 from public.order_payments
    where id = p_payment_id and restaurant_id = p_restaurant_id and status = 'succeeded'
  ) then
    raise exception 'PRINT_INVALID: that payment can''t be printed';
  end if;

  insert into public.print_jobs (
    restaurant_id, printer_id, kind, order_id, order_ids, payment_id,
    reprint, open_drawer, requested_by
  )
  select p_restaurant_id, p.id, p_kind,
         case when p_kind = 'kitchen_ticket' then p_order_ids[1] end,
         case when p_kind = 'bill' then p_order_ids end,
         case when p_kind = 'receipt' then p_payment_id end,
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
revoke execute on function public.request_print(uuid, text, uuid[], uuid, uuid) from public, anon;
grant execute on function public.request_print(uuid, text, uuid[], uuid, uuid) to authenticated;

-- What the print buttons need to know without reading the printers table
-- (owners and managers only): does this restaurant have an active printer
-- for each kind of job? Any member may ask, so Settle up and the kitchen
-- board show a button only when it will print somewhere.
create function public.restaurant_print_capabilities(p_restaurant_id uuid)
returns table (kitchen boolean, receipt boolean, drawer boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_restaurant_member(p_restaurant_id) then
    return query select false, false, false;
    return;
  end if;
  return query
  select
    coalesce(bool_or(p.role = 'kitchen'), false),
    coalesce(bool_or(p.role = 'receipt'), false),
    coalesce(bool_or(p.role = 'receipt' and p.opens_drawer), false)
  from public.printers p
  where p.restaurant_id = p_restaurant_id
    and p.is_active;
end;
$$;

revoke execute on function public.restaurant_print_capabilities(uuid) from public, anon;
grant execute on function public.restaurant_print_capabilities(uuid) to authenticated, service_role;
