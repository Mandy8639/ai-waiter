-- Kitchen alerts for the iOS app (Apple Push Notification service).
--
-- The web's kitchen push (20260928090000_push_subscriptions.sql) uses the
-- browser Push API, which doesn't exist inside an iOS app's web view. The
-- Tableside iOS app (ios/, Capacitor) registers with APNs natively and
-- hands the server a device token instead; the sender
-- (src/lib/push/dispatch.ts) sends the same order and table-request alerts
-- to these tokens through APNs, alongside the web subscriptions.
--
-- Same shape and same rules as push_subscriptions, for the same reasons:
--   * a token can put a notification on a staff member's phone, so RLS
--     shows a member only their own rows, and diners nothing;
--   * writes go only through the two functions below, members only;
--   * a token belongs to one member at one restaurant, and cascades away
--     when that membership does (removed from the team, account deleted);
--   * the same phone registering again takes its row over.
--
-- `environment` is which APNs gateway the token belongs to: a development
-- build's token only works on the sandbox gateway, a TestFlight or App
-- Store build's only on production. The app can't tell, so the sender
-- learns it: production first, sandbox on BadDeviceToken, and remembers.

create table public.native_push_tokens (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  user_id uuid not null,

  platform text not null default 'ios',
  token text not null,
  environment text,

  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count integer not null default 0,

  constraint native_push_tokens_member
    foreign key (user_id, restaurant_id)
    references public.restaurant_users (user_id, restaurant_id)
    on delete cascade,
  constraint native_push_tokens_unique_device unique (token, restaurant_id),
  constraint native_push_tokens_platform_valid check (platform in ('ios')),
  -- APNs device tokens are hex; 64 characters today, longer allowed.
  constraint native_push_tokens_token_shape
    check (token ~ '^[0-9a-f]{64,200}$'),
  constraint native_push_tokens_environment_valid
    check (environment is null or environment in ('production', 'sandbox'))
);

comment on table public.native_push_tokens is
  'A staff member''s iPhone or iPad that has opted in to kitchen alerts in the Tableside iOS app, for one restaurant. Each token can put a notification on that device, so RLS shows a member only their own rows. Cascades away with the membership. See 20261011090000_native_push_tokens.sql.';

create index native_push_tokens_restaurant_idx
  on public.native_push_tokens (restaurant_id);

alter table public.native_push_tokens enable row level security;

create policy "native_push_tokens_select_own"
  on public.native_push_tokens
  for select
  to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete policies: writes go through the functions below,
-- and the service-role sender keeps the delivery bookkeeping.

create function public.save_native_push_token(
  target_restaurant_id uuid,
  p_token text,
  p_platform text default 'ios'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_restaurant_member(target_restaurant_id) then
    raise exception 'PUSH_NOT_A_MEMBER' using errcode = '42501';
  end if;

  insert into public.native_push_tokens (restaurant_id, user_id, platform, token)
  values (target_restaurant_id, auth.uid(), p_platform, lower(p_token))
  on conflict (token, restaurant_id) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        failure_count = 0;
end;
$$;

comment on function public.save_native_push_token(uuid, text, text) is
  'Turns kitchen alerts on for this phone in the iOS app, at this restaurant. Members only; the same phone registering again takes over its row.';

create function public.delete_native_push_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.native_push_tokens
  where token = lower(p_token)
    and user_id = auth.uid();
end;
$$;

comment on function public.delete_native_push_token(text) is
  'Turns kitchen alerts off for this phone in the iOS app; the caller''s own rows only.';

revoke execute on function public.save_native_push_token(uuid, text, text) from public, anon;
grant execute on function public.save_native_push_token(uuid, text, text) to authenticated;
revoke execute on function public.delete_native_push_token(text) from public, anon;
grant execute on function public.delete_native_push_token(text) to authenticated;
