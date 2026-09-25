-- Staff invitation links (phase C)
--
-- THE BLOCKER THIS REMOVES. add_restaurant_staff_by_email() looks the
-- invitee up in auth.users and raises `user_not_found` when there is no
-- row — an explicit v1 decision recorded in
-- 20260829090000_staff_management.sql ("the invited email must already
-- have an AI Waiter account — no invite-email flow yet"). The consequence
-- only shows up in practice: a restaurant that hires a waiter cannot add
-- them. The owner has to talk the new hire through signing up first, then
-- go back and add the email they hope was typed the same way. That is the
-- single worst moment in onboarding, and it happens on day one.
--
-- WHY A LINK AND NOT AN EMAIL. Sending mail needs a provider, a verified
-- sending domain, deliverability monitoring and a bounce story — none of
-- which is code, and none of which the rest of this system's tests can
-- reach. A link the owner copies and sends over whatever they already use
-- to talk to their staff (WhatsApp, SMS, in person) needs none of it and
-- closes the same gap. Emailed invitations can come later; see
-- docs/COMPETITIVE_ROADMAP.md phase F.
--
-- WHAT THE TOKEN IS, AND THEREFORE WHAT IT MUST NOT BE. A holder of a
-- valid token becomes staff at a restaurant. The token is the entire
-- authorization — there is no second factor and no email binding — so
-- four properties are load-bearing, and each is enforced here rather than
-- in the application:
--
--   1. SINGLE USE. Accepting sets status = 'accepted'. A link forwarded
--      to a group chat admits one person, not everyone who read it.
--   2. SHORT LIVED. Seven days, set at creation and never extended.
--   3. REVOCABLE. An owner who mis-sends a link can kill it immediately,
--      without waiting out the expiry.
--   4. THE ROLE IS FIXED AT CREATION. accept_staff_invitation() takes the
--      token and nothing else. There is no role argument anywhere on the
--      accepting side, so no URL, form field or payload can influence
--      what the accepter becomes. This is the same reasoning as
--      create_restaurant()'s hardcoded 'owner'.
--
-- STORED AS A HASH. The table keeps sha256(token), never the token. The
-- plaintext exists once, in create_staff_invitation()'s return value, and
-- is never recoverable afterwards — so a leaked backup or a stray read of
-- this table yields no usable invitations. The cost is real and accepted:
-- the dashboard can show a link only on the screen that created it, which
-- is why src/app/dashboard/staff/invite says so plainly and why creating
-- a replacement is one click.
--
-- sha256() is core Postgres (11+), not pgcrypto. That matters: the PGlite
-- harness that runs these migrations in tests has no pgcrypto and cannot
-- install it, so a gen_random_bytes()/digest() version of this file would
-- be untestable in the only place the migration SQL is actually executed
-- by CI. gen_random_uuid() is pg_strong_random underneath, and two of them
-- give a 64-character hex token with ~244 bits behind it.

create table public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,

  -- sha256 of the token, hex. Unique so two invitations can never share a
  -- link, which the accept path relies on to identify exactly one row.
  token_hash text not null unique,

  -- What the accepter becomes. Never read from the accepter's request.
  role text not null,

  -- The owner's own reminder of who a link was meant for ("new waiter,
  -- started Monday"). Two 'staff' invitations created a minute apart are
  -- otherwise indistinguishable in the pending list, which makes revoking
  -- the right one guesswork. Never shown to the invitee — it may well say
  -- something the invitee should not read.
  label text,

  status text not null default 'pending',

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,

  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,

  constraint staff_invitations_role_valid
    check (role in ('owner', 'manager', 'kitchen', 'staff')),

  -- No 'expired' status. Expiry is a comparison against expires_at, so it
  -- is true the moment it becomes true — a stored 'expired' state would
  -- need something to run and set it, and an invitation that is expired in
  -- fact but 'pending' in the column is exactly the kind of gap a
  -- scheduled job's first missed run opens.
  constraint staff_invitations_status_valid
    check (status in ('pending', 'accepted', 'revoked')),

  -- The timestamps move with the status and never independently of it.
  constraint staff_invitations_accepted_consistent
    check ((status = 'accepted') = (accepted_at is not null)),
  constraint staff_invitations_revoked_consistent
    check ((status = 'revoked') = (revoked_at is not null)),
  -- An accepted invitation always records who accepted it: this row is the
  -- only evidence of how someone became staff without an owner adding them.
  constraint staff_invitations_accepted_by_present
    check (status <> 'accepted' or accepted_by is not null),

  constraint staff_invitations_label_length
    check (label is null or length(label) <= 60),
  -- Nothing but a hex sha256 digest belongs in this column. Catches a
  -- future caller that stores the plaintext token by mistake — the one
  -- error in this design that would be both silent and serious.
  constraint staff_invitations_token_hash_shape
    check (token_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.staff_invitations is
  'A single-use, expiring link that makes its holder a member of one restaurant at one role. Stores sha256(token), never the token. Created and consumed only through the SECURITY DEFINER functions in this migration.';

comment on column public.staff_invitations.token_hash is
  'sha256 of the invitation token, hex. The token itself is returned once by create_staff_invitation() and is not recoverable from this row.';

comment on column public.staff_invitations.label is
  'The inviting owner''s private reminder of who the link was for. Never returned to the invitee — see get_staff_invitation_preview(), which omits it.';

-- The pending list the dashboard reads, newest first.
create index staff_invitations_pending_idx
  on public.staff_invitations (restaurant_id, created_at desc)
  where status = 'pending';

alter table public.staff_invitations enable row level security;

-- Deliberately no policies at all, so RLS denies every direct read and
-- write. Each function below is SECURITY DEFINER and shapes its own
-- output: the preview returns three fields to a signed-out visitor, the
-- pending list returns no hash to an owner, and nothing returns a token.
-- A policy would have to be written to match that shaping and then kept
-- matching it; no client query needs one, so there is none to drift.
--
-- (The hash's own secrecy is not what this is protecting. sha256 is
-- preimage-resistant, so reading token_hash gets an attacker no closer to
-- a usable link. The reason is narrower and duller: unused surface.)

-- Creating a link -----------------------------------------------------------

create function public.create_staff_invitation(
  target_restaurant_id uuid,
  p_role text,
  p_label text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role text;
  v_pending integer;
  v_token text;
begin
  -- Identical authorization to add_restaurant_staff_by_email(), and
  -- re-implemented for the identical reason: SECURITY DEFINER bypasses
  -- restaurant_users_insert_owner_manager entirely, so that policy cannot
  -- be relied on as a backstop. An invitation is the same grant of access
  -- by a different route, and must not be an easier one.
  v_caller_role := public.current_restaurant_role(target_restaurant_id);

  if v_caller_role is null or v_caller_role not in ('owner', 'manager') then
    raise exception 'STAFF_INVITE_INSUFFICIENT_ROLE' using errcode = '42501';
  end if;
  if v_caller_role = 'manager' and p_role = 'owner' then
    raise exception 'STAFF_INVITE_MANAGERS_CANNOT_GRANT_OWNER' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'manager', 'kitchen', 'staff') then
    raise exception 'STAFF_INVITE_INVALID_ROLE' using errcode = '22023';
  end if;

  -- A cap on outstanding links, for the same reason phase A caps open
  -- table requests: the value of the pending list is that somebody can
  -- glance at it and see what access is outstanding. Two hundred rows is
  -- not a list, it is a place things hide. Twenty is far more than any
  -- single restaurant hires at once, and an owner who hits it can revoke
  -- or let the oldest expire.
  select count(*) into v_pending
  from public.staff_invitations
  where restaurant_id = target_restaurant_id
    and status = 'pending'
    and expires_at > now();

  if v_pending >= 20 then
    raise exception 'STAFF_INVITE_TOO_MANY_PENDING' using errcode = '53400';
  end if;

  -- Two UUIDs, hyphens stripped: 64 hex characters, ~244 bits of
  -- pg_strong_random. Not gen_random_bytes() — see the header note on
  -- pgcrypto and the test harness.
  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  insert into public.staff_invitations (
    restaurant_id, token_hash, role, label, created_by, expires_at
  )
  values (
    target_restaurant_id,
    encode(sha256(convert_to(v_token, 'utf8')), 'hex'),
    p_role,
    nullif(left(trim(coalesce(p_label, '')), 60), ''),
    auth.uid(),
    now() + interval '7 days'
  );

  -- The only time the plaintext token exists anywhere. The caller must
  -- show it to the owner now or lose it.
  return v_token;
end;
$$;

comment on function public.create_staff_invitation(uuid, text, text) is
  'Creates a single-use, 7-day invitation link and returns its token ONCE — only the sha256 is stored. Same authorization as add_restaurant_staff_by_email() (owner: any role; manager: any role except owner), re-implemented because SECURITY DEFINER bypasses the RLS policy that would otherwise encode it.';

revoke execute on function public.create_staff_invitation(uuid, text, text) from public, anon;
grant execute on function public.create_staff_invitation(uuid, text, text) to authenticated;

-- What the person holding the link is told, before signing in ---------------

create function public.get_staff_invitation_preview(p_token text)
returns table (
  restaurant_name text,
  invited_role text,
  state text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.staff_invitations;
  v_name text;
begin
  select * into v_invite
  from public.staff_invitations
  where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex');

  -- One row always, so the caller never has to distinguish "no rows" from
  -- "a row saying unknown". Nothing is named for a token nobody issued.
  if v_invite.id is null then
    return query select null::text, null::text, 'unknown'::text;
    return;
  end if;

  select r.name into v_name
  from public.restaurants r
  where r.id = v_invite.restaurant_id;

  -- The restaurant IS named for a revoked, used or expired invitation, on
  -- purpose. Whoever holds this link held a real one; "your invitation to
  -- Nashta has expired, ask them for a new one" is something they can act
  -- on, where "invalid link" leaves them stuck and suspicious. There is
  -- nothing to enumerate towards — a 244-bit token is not guessed.
  return query
  select v_name,
         v_invite.role,
         case
           when v_invite.status = 'revoked' then 'revoked'
           when v_invite.status = 'accepted' then 'used'
           when v_invite.expires_at <= now() then 'expired'
           else 'valid'
         end;
end;
$$;

comment on function public.get_staff_invitation_preview(text) is
  'What to show the holder of an invitation link before they sign in: the restaurant name, the role offered, and one of valid/expired/used/revoked/unknown. Returns the label to nobody and the token to nobody.';

-- The one anon-callable function added by this migration, and the only one
-- it needs. The person following an invitation link has no account yet by
-- definition, so the page that tells them what they have been invited to
-- runs as a signed-out visitor. The trust model is get_table_by_token()'s:
-- possession of an unguessable token is the authorization, and the
-- function returns the minimum that makes the page honest — no restaurant
-- id, no label, no inviter, no token. It writes nothing.
--
-- The alternative was a page that asks a stranger to create an account
-- for an unnamed organisation, which is indistinguishable from phishing
-- and is the one place where being vague costs more than it protects.
revoke execute on function public.get_staff_invitation_preview(text) from public;
grant execute on function public.get_staff_invitation_preview(text) to anon, authenticated;

-- Accepting -----------------------------------------------------------------

-- The output columns are deliberately NOT named after the columns this
-- body writes to. plpgsql resolves a bare identifier in an INSERT's column
-- list against the function's own parameters first, so a `returns table
-- (restaurant_id uuid, ...)` makes `insert into restaurant_users
-- (restaurant_id, ...)` fail with "column reference restaurant_id is
-- ambiguous" — at run time, not at create time, which is why it is worth a
-- note rather than a silent rename.
create function public.accept_staff_invitation(p_token text)
returns table (
  joined_restaurant_id uuid,
  joined_restaurant_name text,
  granted_role text,
  already_member boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_anonymous boolean;
  v_invite public.staff_invitations;
  v_inserted integer;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'STAFF_INVITE_NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  -- A diner who scanned a table's QR code is a real authenticated user
  -- (Supabase Anonymous Auth), and `grant execute ... to authenticated`
  -- covers them. Without this check, forwarding an invitation link to a
  -- phone that happens to be mid-meal would attach staff access to an
  -- identity that vanishes with the browser storage and can never be
  -- signed back into — the same trap create_restaurant() closed on
  -- 2026-09-12, for the same reason, read the same way: from
  -- auth.users.is_anonymous, which is the server's own record of how the
  -- identity was made and cannot be shaped by the caller's token.
  select u.is_anonymous into v_is_anonymous
  from auth.users u
  where u.id = v_user_id;

  if coalesce(v_is_anonymous, false) then
    raise exception 'STAFF_INVITE_ANONYMOUS_CALLER' using errcode = '42501';
  end if;

  -- Locked for the duration: two taps on "Accept", or a link opened twice,
  -- must not both pass the status check and produce two acceptances.
  select * into v_invite
  from public.staff_invitations
  where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex')
  for update;

  if v_invite.id is null then
    raise exception 'STAFF_INVITE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_invite.status = 'revoked' then
    raise exception 'STAFF_INVITE_REVOKED' using errcode = '42501';
  end if;
  if v_invite.status = 'accepted' then
    raise exception 'STAFF_INVITE_ALREADY_USED' using errcode = '42501';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'STAFF_INVITE_EXPIRED' using errcode = '42501';
  end if;

  -- The role comes from the invitation row, which came from an owner or a
  -- manager. p_token is the only thing this function accepted from its
  -- caller.
  --
  -- ON CONFLICT rather than a preceding EXISTS check: the unique
  -- membership constraint is the arbiter either way, and this way the
  -- answer to "were they already in?" comes from the insert itself
  -- instead of from a read that another transaction could invalidate.
  insert into public.restaurant_users (restaurant_id, user_id, role)
  values (v_invite.restaurant_id, v_user_id, v_invite.role)
  on conflict (user_id, restaurant_id) do nothing;

  get diagnostics v_inserted = ROW_COUNT;

  -- An existing member keeps the role they already have. An invitation
  -- link must not be able to promote anyone: a 'manager' link forwarded to
  -- a waiter who is already 'staff' would otherwise be a promotion that no
  -- owner performed and nobody sees. Role changes stay where they are
  -- visible and reversible — the staff page, by an owner.
  --
  -- The invitation is still consumed. It reached a real person at the
  -- right restaurant; leaving it pending would only invite a second,
  -- equally pointless acceptance.
  update public.staff_invitations
  set status = 'accepted',
      accepted_at = now(),
      accepted_by = v_user_id
  where id = v_invite.id;

  select r.name into v_name
  from public.restaurants r
  where r.id = v_invite.restaurant_id;

  return query
  select v_invite.restaurant_id,
         v_name,
         v_invite.role,
         v_inserted = 0;
end;
$$;

comment on function public.accept_staff_invitation(text) is
  'Consumes an invitation token and makes the calling account a member of that restaurant at the invitation''s role. Takes the token and nothing else, so no caller can influence the role. Refuses anonymous (diner) identities, and never changes an existing member''s role.';

revoke execute on function public.accept_staff_invitation(text) from public, anon;
grant execute on function public.accept_staff_invitation(text) to authenticated;

-- Revoking ------------------------------------------------------------------

create function public.revoke_staff_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.staff_invitations;
  v_caller_role text;
begin
  select * into v_invite
  from public.staff_invitations
  where id = p_invitation_id
  for update;

  if v_invite.id is null then
    raise exception 'STAFF_INVITE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Any owner or manager of the restaurant, not only whoever created the
  -- link. Revoking only ever removes access, and the owner who needs to
  -- kill a mis-sent link at 9pm is not always the one who sent it.
  v_caller_role := public.current_restaurant_role(v_invite.restaurant_id);
  if v_caller_role is null or v_caller_role not in ('owner', 'manager') then
    raise exception 'STAFF_INVITE_INSUFFICIENT_ROLE' using errcode = '42501';
  end if;

  -- An already-accepted invitation cannot be un-accepted: the person is a
  -- member now, and removing them is the staff page's job. Revoking one
  -- that has merely expired is allowed, and is how the pending list gets
  -- tidied.
  if v_invite.status <> 'pending' then
    raise exception 'STAFF_INVITE_NOT_PENDING' using errcode = '42501';
  end if;

  update public.staff_invitations
  set status = 'revoked', revoked_at = now()
  where id = v_invite.id;
end;
$$;

comment on function public.revoke_staff_invitation(uuid) is
  'Kills a pending invitation link. Any owner or manager of the restaurant, since revoking only removes access. Refuses an already-accepted invitation — that is a member now, not a link.';

revoke execute on function public.revoke_staff_invitation(uuid) from public, anon;
grant execute on function public.revoke_staff_invitation(uuid) to authenticated;

-- What the dashboard shows --------------------------------------------------

create function public.get_staff_invitations(target_restaurant_id uuid)
returns table (
  id uuid,
  invited_role text,
  label text,
  created_at timestamptz,
  expires_at timestamptz,
  is_expired boolean,
  created_by_email text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role text;
begin
  -- Narrower than get_restaurant_staff(), which any member may read.
  -- Outstanding access grants are a management concern, and only these two
  -- roles can create or revoke one, so a list nobody else can act on is a
  -- list nobody else needs.
  v_caller_role := public.current_restaurant_role(target_restaurant_id);
  if v_caller_role is null or v_caller_role not in ('owner', 'manager') then
    raise exception 'STAFF_INVITE_INSUFFICIENT_ROLE' using errcode = '42501';
  end if;

  -- Pending only. Accepted invitations are visible as the members they
  -- produced, on the staff list above this one; revoked ones are noise.
  -- Expired-but-pending rows are included deliberately — an owner needs to
  -- see that the link they sent on Monday has gone stale.
  return query
  select i.id,
         i.role,
         i.label,
         i.created_at,
         i.expires_at,
         i.expires_at <= now(),
         -- ::text is load-bearing. auth.users.email is varchar(255), and a
         -- `returns table (... text)` whose body hands back a varchar
         -- raises 42804 on a real project while passing every local test.
         -- See the note on auth.users in src/lib/backup/supabase-stub.ts.
         u.email::text
  from public.staff_invitations i
  left join auth.users u on u.id = i.created_by
  where i.restaurant_id = target_restaurant_id
    and i.status = 'pending'
  order by i.created_at desc;
end;
$$;

comment on function public.get_staff_invitations(uuid) is
  'Pending invitation links for a restaurant, newest first, for owners and managers only. Returns no token and no hash — a created link is unrecoverable by design.';

-- plpgsql, like get_restaurant_staff(): this body crosses into auth.users
-- for the inviter's email, and a `language sql` function that does so
-- returns PGRST202 from PostgREST indefinitely. See the long note in
-- 20260829090000_staff_management.sql.

revoke execute on function public.get_staff_invitations(uuid) from public, anon;
grant execute on function public.get_staff_invitations(uuid) to authenticated;
