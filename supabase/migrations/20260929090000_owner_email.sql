-- Owner email (phase F, second half)
--
-- Two kinds of email to restaurant owners, sent through Resend from
-- mail.tableside.menu:
--
--   - A DAILY SUMMARY of yesterday, in the restaurant's own timezone: how
--     many orders, their value, the top dishes, and how many times a table
--     asked for staff. Sent only when there WAS an order — a daily "nothing
--     happened" email is the one people learn to delete unread.
--   - PAYMENT ALERTS, for the three payment events an owner can act on:
--     the restaurant's own Tableside subscription going past due, their
--     Stripe account losing the ability to take cards, and a diner's
--     delayed payment failing after they left. Not an ordinary declined
--     card at the table — the diner retries, and an email per decline is
--     noise.
--
-- WHO RECEIVES THEM. Owners only, in v1: managers cannot act on billing,
-- and a daily summary is the owner's view of the business. Each owner
-- controls both from Settings; both default ON, because both are about
-- their own account and an owner who never hears about a failed
-- subscription payment finds out when service stops.
--
-- ONCE ONLY. Vercel's scheduler can skip a run or deliver it twice, and a
-- Stripe webhook can be redelivered. email_dispatches records each email
-- before it is sent, keyed so the second attempt at the same email finds
-- the key taken and sends nothing. (Resend's Idempotency-Key header is set
-- from the same key, as a second line.)

-- Preferences ---------------------------------------------------------------

alter table public.restaurant_users
  add column email_daily_summary boolean not null default true,
  add column email_payment_alerts boolean not null default true;

comment on column public.restaurant_users.email_daily_summary is
  'Whether this member (owners only, in practice) gets the daily summary email for this restaurant. Changed only through set_my_email_preferences().';
comment on column public.restaurant_users.email_payment_alerts is
  'Whether this member (owners only, in practice) gets payment alert emails for this restaurant. Changed only through set_my_email_preferences().';

-- Your own preferences, and nobody else's. restaurant_users_update_owner
-- lets an owner update ANY member row at their restaurant — right for
-- roles, wrong for someone else's inbox. This function touches only the
-- caller's own row.
create function public.set_my_email_preferences(
  target_restaurant_id uuid,
  p_daily_summary boolean,
  p_payment_alerts boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.restaurant_users
  set email_daily_summary = p_daily_summary,
      email_payment_alerts = p_payment_alerts
  where restaurant_id = target_restaurant_id
    and user_id = auth.uid();

  if not found then
    raise exception 'EMAIL_PREFS_NOT_A_MEMBER' using errcode = '42501';
  end if;
end;
$$;

comment on function public.set_my_email_preferences(uuid, boolean, boolean) is
  'Sets the CALLER''s own email preferences for one restaurant. Never another member''s.';

revoke execute on function public.set_my_email_preferences(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_my_email_preferences(uuid, boolean, boolean) to authenticated;

-- What has been sent ----------------------------------------------------------

create table public.email_dispatches (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  kind text not null,
  -- What makes this email THIS email: "2026-09-29" for a daily summary,
  -- a subscription id + status for an alert. Together with kind and the
  -- recipient it is the once-only key.
  dedupe_key text not null,
  recipient_user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Filled in after the send. A row with neither is a claim whose send
  -- crashed mid-way; it stays claimed rather than risk a duplicate, which
  -- for a daily summary is the right trade.
  sent_at timestamptz,
  provider_message_id text,
  error text,

  constraint email_dispatches_kind_valid check (
    kind in (
      'daily_summary',
      'subscription_past_due',
      'card_payments_disabled',
      'diner_payment_failed'
    )
  ),
  constraint email_dispatches_once unique (kind, dedupe_key, recipient_user_id),
  constraint email_dispatches_dedupe_key_length check (length(dedupe_key) between 1 and 200),
  constraint email_dispatches_error_length check (error is null or length(error) <= 500)
);

comment on table public.email_dispatches is
  'One row per owner email, claimed before sending so a duplicated cron run or a redelivered webhook never sends twice. Written only by the service-role sender; no policies.';

alter table public.email_dispatches enable row level security;
-- No policies: only the service role reads or writes this.

-- Who to email ----------------------------------------------------------------

-- The owners of a restaurant who have opted in to a kind of email, with
-- their addresses. Crosses into auth.users, so plpgsql (the PGRST202
-- lesson — see 20260829090000) and an explicit ::text on the email (the
-- varchar(255) lesson — see 20260926100000). Service role only: a list of
-- owners' email addresses is not something any client should be able to
-- ask for.
create function public.get_owner_email_recipients(
  target_restaurant_id uuid,
  p_kind text
)
returns table (user_id uuid, email text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_kind not in ('daily_summary', 'payment_alert') then
    raise exception 'EMAIL_UNKNOWN_KIND' using errcode = '22023';
  end if;

  return query
  select ru.user_id, u.email::text
  from public.restaurant_users ru
  join auth.users u on u.id = ru.user_id
  where ru.restaurant_id = target_restaurant_id
    and ru.role = 'owner'
    and u.email is not null
    and coalesce(u.is_anonymous, false) = false
    and case p_kind
          when 'daily_summary' then ru.email_daily_summary
          else ru.email_payment_alerts
        end;
end;
$$;

comment on function public.get_owner_email_recipients(uuid, text) is
  'Opted-in owners of a restaurant and their email addresses, for one kind of email. Service role only.';

revoke execute on function public.get_owner_email_recipients(uuid, text) from public, anon, authenticated;
grant execute on function public.get_owner_email_recipients(uuid, text) to service_role;

-- Yesterday, in numbers ---------------------------------------------------------

-- The daily summary for one restaurant and one local calendar day. "Day"
-- is the restaurant's own day (restaurants.timezone), so a Mumbai
-- restaurant's summary does not split its dinner service across two
-- emails because the server thinks in UTC.
--
-- Order value is the sum of non-cancelled orders' totals, and is named
-- that in the email — not "revenue" or "takings", because an order can
-- still be unpaid, and the Reports page is where money taken lives.
create function public.get_daily_summary(
  target_restaurant_id uuid,
  p_day date
)
returns table (
  restaurant_name text,
  timezone text,
  currency text,
  order_count integer,
  order_value numeric,
  cancelled_count integer,
  table_request_count integer,
  top_items jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
begin
  select r.timezone into v_tz
  from public.restaurants r
  where r.id = target_restaurant_id;

  if v_tz is null then
    return;
  end if;

  -- Local midnight to local midnight, converted back to instants.
  v_from := (p_day::timestamp) at time zone v_tz;
  v_to := ((p_day + 1)::timestamp) at time zone v_tz;

  return query
  select
    r.name,
    r.timezone,
    r.currency,
    (select count(*)::integer from public.orders o
      where o.restaurant_id = r.id
        and o.created_at >= v_from and o.created_at < v_to
        and o.status <> 'cancelled'),
    (select coalesce(sum(o.total), 0) from public.orders o
      where o.restaurant_id = r.id
        and o.created_at >= v_from and o.created_at < v_to
        and o.status <> 'cancelled'),
    (select count(*)::integer from public.orders o
      where o.restaurant_id = r.id
        and o.created_at >= v_from and o.created_at < v_to
        and o.status = 'cancelled'),
    (select count(*)::integer from public.table_requests tr
      where tr.restaurant_id = r.id
        and tr.created_at >= v_from and tr.created_at < v_to),
    coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'quantity', t.quantity)
                       order by t.quantity desc, t.name)
      from (
        select oi.item_name as name, sum(oi.quantity)::integer as quantity
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        where o.restaurant_id = r.id
          and o.created_at >= v_from and o.created_at < v_to
          and o.status <> 'cancelled'
        group by oi.item_name
        order by sum(oi.quantity) desc, oi.item_name
        limit 3
      ) t
    ), '[]'::jsonb)
  from public.restaurants r
  where r.id = target_restaurant_id;
end;
$$;

comment on function public.get_daily_summary(uuid, date) is
  'One restaurant''s day in numbers, for the daily summary email: order count and value (non-cancelled), cancellations, table requests and the top three dishes, all within the restaurant''s own local day. Service role only.';

revoke execute on function public.get_daily_summary(uuid, date) from public, anon, authenticated;
grant execute on function public.get_daily_summary(uuid, date) to service_role;
