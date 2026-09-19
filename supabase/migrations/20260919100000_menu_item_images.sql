-- Menu photos, phase 1: the data model. See docs/MENU_PHOTO_STRATEGY.md.
--
-- A dish can show a real restaurant photo, an AI-generated illustration,
-- or nothing — mixed freely across a menu. The product rule this schema
-- exists to protect: a diner must always be able to tell an AI
-- illustration from a real photo, and that label must be impossible to get
-- wrong by accident or on purpose. So:
--
--   * Where an image came from is STORED (menu_item_images.source), never
--     inferred from a URL or filename.
--   * Every upload or generation is a NEW row. Rows are never overwritten
--     with a different image, so the current image is never destroyed
--     before its replacement is ready.
--   * A dish points at exactly one active row. Switching is one
--     transaction inside publish_menu_item_image().
--   * Nothing a signed-in user can reach writes these columns directly.
--     The image table has no write policies at all, and the three image
--     columns on menu_items are guarded by a trigger; the only writers are
--     the SECURITY DEFINER functions below, each of which checks that the
--     caller is an owner or manager of the dish's restaurant.
--
-- No storage buckets, no provider, no UI in this migration — those are
-- later phases. Everything here is testable in PGlite on its own.

-- Limits -----------------------------------------------------------------
-- One row of configuration, readable by the app (to show "n left today")
-- and changed only by migration or service role. Kept in the database so
-- the limits are enforced where the attempts are counted, not in app code
-- a second request could race past.

create table public.menu_image_generation_limits (
  -- A single-row table: the primary key can only ever be true.
  id boolean primary key default true,
  attempts_per_restaurant_per_day integer not null default 10,
  attempts_per_item_per_day integer not null default 2,
  max_pending_per_item integer not null default 1,
  -- A generation still marked "generating" after this long is treated as
  -- failed, so a crashed request cannot hold a dish's pending slot forever.
  generation_timeout_seconds integer not null default 180,
  updated_at timestamptz not null default now(),

  constraint menu_image_generation_limits_single_row check (id),
  constraint menu_image_generation_limits_positive check (
    attempts_per_restaurant_per_day >= 0
    and attempts_per_item_per_day >= 0
    and max_pending_per_item >= 1
    and generation_timeout_seconds >= 30
  )
);

comment on table public.menu_image_generation_limits is
  'The AI image generation caps, as one row. Attempts are counted over a rolling 24 hours from menu_item_images, including failed attempts. Change the row (service role / migration) to change the limits; there is no per-plan limit yet.';

insert into public.menu_image_generation_limits (id) values (true)
on conflict (id) do nothing;

create trigger trg_menu_image_generation_limits_set_updated_at
  before update on public.menu_image_generation_limits
  for each row
  execute function public.set_updated_at();

alter table public.menu_image_generation_limits enable row level security;

-- Readable by any signed-in user: the numbers are not secret, and the owner
-- UI needs them to explain a refusal before it happens.
create policy "menu_image_generation_limits_select_authenticated"
  on public.menu_image_generation_limits
  for select
  to authenticated
  using (true);

-- Images -----------------------------------------------------------------

create table public.menu_item_images (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  menu_item_id uuid not null,

  -- real:          the restaurant supplied it, and said so.
  -- ai_generated:  generated for this dish and, once active, accepted by
  --                an owner or manager. Always labelled to diners.
  -- unverified:    an image URL that existed before this table did. It
  --                might be a real photo; nobody has said so yet. Becomes
  --                real only through confirm_menu_item_image_authentic().
  source text not null,

  status text not null,
  status_changed_at timestamptz not null default now(),

  -- Storage object paths (buckets arrive in phase 2). Always under
  -- {restaurant_id}/{menu_item_id}/{id}/ — complete_menu_item_image()
  -- refuses anything else.
  original_path text,
  variant_paths jsonb,
  -- A pre-migration image URL the restaurant had typed in: source
  -- 'unverified', or 'real' once an owner has confirmed it. Never for AI.
  external_url text,

  width integer,
  height integer,
  byte_size integer,
  mime_type text,
  content_sha256 text,

  -- For AI images only: which provider and model made it, the prompt
  -- template version and the prompt itself, and a hash of the dish data it
  -- was built from. Provider-neutral on purpose — a future provider fills
  -- the same keys.
  generation jsonb,

  -- A customer-safe reason, only when status = 'failed'.
  error text,

  created_by uuid references auth.users (id) on delete set null,
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint menu_item_images_source_valid
    check (source in ('real', 'ai_generated', 'unverified')),
  constraint menu_item_images_status_valid check (
    status in (
      'uploading', 'generating', 'pending_review', 'active',
      'superseded', 'rejected', 'removed', 'failed'
    )
  ),
  -- Only AI images carry generation metadata; one that has been reviewed or
  -- published must carry it, so every AI image on a menu is traceable.
  constraint menu_item_images_generation_only_for_ai
    check (source = 'ai_generated' or generation is null),
  constraint menu_item_images_generation_required_once_ready check (
    source <> 'ai_generated'
    or status in ('generating', 'rejected', 'failed')
    or generation is not null
  ),
  -- A legacy URL is either still unverified, or an unverified image an
  -- owner has since confirmed as real (it keeps its URL). An AI image never
  -- has one, and an image with its own stored files never has one.
  constraint menu_item_images_external_url_valid check (
    (source <> 'unverified' or external_url is not null)
    and (source <> 'ai_generated' or external_url is null)
    and (external_url is null or original_path is null)
  ),
  -- A stored image that has reached review or beyond has its files.
  constraint menu_item_images_files_once_ready check (
    external_url is not null
    or status not in ('pending_review', 'active', 'superseded')
    or (original_path is not null and variant_paths is not null)
  ),
  constraint menu_item_images_error_only_when_failed
    check (error is null or status = 'failed'),
  -- A confirmer implies a confirmation time. (The reverse need not hold:
  -- confirmed_by is set null if that user account is later deleted.)
  constraint menu_item_images_confirmation_pair
    check (confirmed_by is null or confirmed_at is not null),
  constraint menu_item_images_dimensions_positive check (
    (width is null or width > 0) and (height is null or height > 0)
    and (byte_size is null or byte_size > 0)
  ),

  -- Tenant-scoped FK: an image can only belong to a dish of the SAME
  -- restaurant (the composite pattern from docs/database.md).
  constraint menu_item_images_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id)
    on delete cascade,
  -- Target for menu_items' composite pointer below.
  constraint menu_item_images_id_item_key unique (id, menu_item_id)
);

comment on table public.menu_item_images is
  'Every image a dish has had or might have. Rows are append-only in spirit: a replacement is a new row, and the dish points at the active one. Written only by the SECURITY DEFINER functions in 20260919100000_menu_item_images.sql.';
comment on column public.menu_item_images.source is
  'real | ai_generated | unverified. Stored, never inferred. unverified becomes real only by explicit owner/manager confirmation; ai_generated can never become real.';
comment on column public.menu_item_images.status_changed_at is
  'When the row last changed status. Superseded, rejected, removed and failed rows become eligible for file cleanup 30 days after this.';

-- One live image per dish, and at most one in-flight generation per dish
-- (the database, not the UI, stops a double-click from paying twice).
create unique index menu_item_images_one_active_per_item
  on public.menu_item_images (menu_item_id)
  where status = 'active';
create unique index menu_item_images_one_generating_per_item
  on public.menu_item_images (menu_item_id)
  where status = 'generating';

-- Counting today's attempts, per restaurant and per dish.
create index menu_item_images_ai_attempts_idx
  on public.menu_item_images (restaurant_id, created_at desc)
  where source = 'ai_generated';
create index menu_item_images_menu_item_id_idx
  on public.menu_item_images (menu_item_id, created_at desc);
-- The future cleanup script's scan.
create index menu_item_images_cleanup_idx
  on public.menu_item_images (status_changed_at)
  where status in ('superseded', 'rejected', 'removed', 'failed');

create trigger trg_menu_item_images_set_updated_at
  before update on public.menu_item_images
  for each row
  execute function public.set_updated_at();

create or replace function public.menu_item_images_track_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger trg_menu_item_images_track_status_change
  before update on public.menu_item_images
  for each row
  execute function public.menu_item_images_track_status_change();

alter table public.menu_item_images enable row level security;

-- Members can see their own restaurant's images (kitchen staff included —
-- reading is harmless). There are deliberately NO insert, update or delete
-- policies: every write goes through the functions below. Diners never
-- read this table; they read the denormalised columns on menu_items.
create policy "menu_item_images_select_members"
  on public.menu_item_images
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- Generation attempts (quota and audit history) -----------------------------
--
-- Why a separate table: menu_item_images rows are deleted with their dish
-- (on delete cascade). Counting attempts from them let an owner reset the
-- restaurant's daily limit by deleting and re-creating dishes — verified in
-- the Phase 1 audit (14 attempts inside the 10/day limit). Attempts are
-- evidence that a (potentially billed) generation request happened, so they
-- live here, append-only, and survive the dish and the image:
--
--   menu_items ── menu_item_images            (current image lifecycle)
--   menu_image_generation_attempts           (permanent quota/audit history)
--
-- Deleting a dish nulls menu_item_id here but keeps the row, so the
-- restaurant-wide count never goes down. A re-created dish is a new
-- identity with a fresh per-dish count; the restaurant count is unchanged.

create table public.menu_image_generation_attempts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  -- NULL once the dish is deleted. The attempt still counts.
  menu_item_id uuid,
  -- NULL once the image row is deleted (with its dish, or by cleanup).
  image_id uuid references public.menu_item_images (id) on delete set null,
  status text not null default 'started',
  -- Filled in when known — the provider abstraction reports them with the
  -- result. Provider-neutral: a future paid model fills the same columns.
  provider text,
  model text,
  failure_reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),

  constraint menu_image_generation_attempts_status_valid
    check (status in ('started', 'succeeded', 'failed', 'timed_out', 'cancelled')),
  constraint menu_image_generation_attempts_finished_when_terminal
    check ((status = 'started') = (finished_at is null)),
  constraint menu_image_generation_attempts_reason_only_when_unsuccessful
    check (failure_reason is null or status in ('failed', 'timed_out')),
  -- Tenant-scoped, like every other dish reference in this schema. SET NULL
  -- only the dish column, so the attempt (and its restaurant) survives.
  constraint menu_image_generation_attempts_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id)
    on delete set null (menu_item_id)
);

comment on table public.menu_image_generation_attempts is
  'Append-only history of AI image generation attempts. The source of truth for generation quotas. Survives deletion of the dish and the image; removed only with the restaurant.';

create index menu_image_generation_attempts_restaurant_idx
  on public.menu_image_generation_attempts (restaurant_id, started_at desc);
create index menu_image_generation_attempts_item_idx
  on public.menu_image_generation_attempts (menu_item_id, started_at desc)
  where menu_item_id is not null;
create unique index menu_image_generation_attempts_image_key
  on public.menu_image_generation_attempts (image_id)
  where image_id is not null;

-- Append-only, enforced for every role (the admin included), not just by
-- the absence of RLS write policies:
--   * rows cannot be deleted directly — only by the cascade from deleting
--     the restaurant itself (a referential action runs one trigger level
--     deeper, pg_trigger_depth() >= 2);
--   * identity and timing never change;
--   * the dish / image references may only become NULL (their FK actions);
--   * status moves once, from 'started' to a final state.
create or replace function public.menu_image_generation_attempts_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() < 2 then
      raise exception 'MENU_IMAGE_ATTEMPTS_APPEND_ONLY';
    end if;
    return old;
  end if;

  if new.id is distinct from old.id
    or new.restaurant_id is distinct from old.restaurant_id
    or new.started_at is distinct from old.started_at
    or new.created_at is distinct from old.created_at
    or (new.menu_item_id is distinct from old.menu_item_id and new.menu_item_id is not null)
    or (new.image_id is distinct from old.image_id and new.image_id is not null) then
    raise exception 'MENU_IMAGE_ATTEMPTS_APPEND_ONLY';
  end if;

  if new.status is distinct from old.status and old.status <> 'started' then
    raise exception 'MENU_IMAGE_ATTEMPTS_APPEND_ONLY';
  end if;

  if old.status <> 'started' and (
    new.provider is distinct from old.provider
    or new.model is distinct from old.model
    or new.failure_reason is distinct from old.failure_reason
    or new.finished_at is distinct from old.finished_at
  ) then
    raise exception 'MENU_IMAGE_ATTEMPTS_APPEND_ONLY';
  end if;

  return new;
end;
$$;

create trigger trg_menu_image_generation_attempts_append_only
  before update or delete on public.menu_image_generation_attempts
  for each row
  execute function public.menu_image_generation_attempts_append_only();

alter table public.menu_image_generation_attempts enable row level security;

-- Members can read their restaurant's history; nobody writes it except the
-- functions below.
create policy "menu_image_generation_attempts_select_members"
  on public.menu_image_generation_attempts
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- The dish's current image -------------------------------------------------

alter table public.menu_items
  add column active_image_id uuid,
  add column image_source text,
  add column image_variants jsonb,
  add constraint menu_items_image_source_valid
    check (image_source is null or image_source in ('real', 'ai_generated', 'unverified')),
  add constraint menu_items_image_pointer_consistent
    check ((active_image_id is null) = (image_source is null)),
  -- The active image must be one of THIS dish's images. SET NULL on the
  -- pointer column only, so an image delete can never take the dish with
  -- it. For an ACTIVE image that SET NULL would leave image_source without
  -- an image, which menu_items_image_pointer_consistent refuses: an active
  -- image cannot be deleted at all, only taken down through
  -- remove_menu_item_image(). Retention cleanup deletes only superseded,
  -- rejected, removed and failed rows.
  add constraint menu_items_active_image_belongs_to_item
    foreign key (active_image_id, id)
    references public.menu_item_images (id, menu_item_id)
    on delete set null (active_image_id);

comment on column public.menu_items.image_source is
  'Denormalised from the active menu_item_images row so the diner menu needs no join. Drives the "AI-generated" label. Writable only by the image functions (see menu_items_guard_image_columns).';
comment on column public.menu_items.image_variants is
  'Public variant paths of the active image; NULL for an unverified legacy image, which still renders from image_url.';

-- The ordinary menu edit path (RLS lets owners and managers update any
-- column of their dishes) must not be able to relabel an AI illustration as
-- a restaurant photo. Column privileges cannot do this on Supabase —
-- authenticated holds a table-wide UPDATE grant, which a column REVOKE does
-- not override — so a trigger does it: a direct write from a request role
-- is refused, while the SECURITY DEFINER functions (running as their owner)
-- pass.
create or replace function public.menu_items_guard_image_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.active_image_id is not null
        or new.image_source is not null
        or new.image_variants is not null then
        raise exception 'MENU_ITEM_IMAGE_COLUMNS_READ_ONLY';
      end if;
    elsif new.active_image_id is distinct from old.active_image_id
      or new.image_source is distinct from old.image_source
      or new.image_variants is distinct from old.image_variants then
      raise exception 'MENU_ITEM_IMAGE_COLUMNS_READ_ONLY';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.menu_items_guard_image_columns() is
  'Refuses direct writes to menu_items.active_image_id / image_source / image_variants from request roles. Only the menu image functions may change which image a dish shows and how it is labelled.';

create trigger trg_menu_items_guard_image_columns
  before insert or update on public.menu_items
  for each row
  execute function public.menu_items_guard_image_columns();

-- Path validation ---------------------------------------------------------
--
-- A stored file path must be exactly "<prefix><file name>", where the
-- prefix is the image's own folder ({restaurant}/{dish}/{image}/) and the
-- file name is one plain segment: letters, digits, "_" or "-", with at most
-- one short extension. That single allow-list rules out "..", "./", "//",
-- backslashes, sub-folders, empty names, whitespace and control characters
-- at once, for the original and every variant alike.
create or replace function public.menu_image_path_is_valid(p_path text, p_prefix text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_path is not null
    and p_prefix is not null
    and length(p_path) <= 512
    and left(p_path, length(p_prefix)) = p_prefix
    and substr(p_path, length(p_prefix) + 1) ~ '^[A-Za-z0-9_-]+(\.[A-Za-z0-9]{1,8})?$'
$$;

comment on function public.menu_image_path_is_valid(text, text) is
  'True when p_path is a single plain file name directly inside the p_prefix folder. Internal: used by complete_menu_item_image().';

-- Shared helpers ----------------------------------------------------------

-- Loads a dish and checks the caller may manage its photos. Locks the dish
-- row so two concurrent changes to one dish's image serialise.
create or replace function public.menu_image_authorize_item(p_menu_item_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
begin
  select restaurant_id into v_restaurant_id
  from public.menu_items
  where id = p_menu_item_id
  for update;

  if not found then
    raise exception 'MENU_IMAGE_ITEM_NOT_FOUND';
  end if;

  -- Relies on the coalesce fix in 20260904120000_menu_imports.sql: this
  -- returns false, never NULL, for an outsider.
  if not public.is_restaurant_manager_or_owner(v_restaurant_id) then
    raise exception 'MENU_IMAGE_FORBIDDEN';
  end if;

  return v_restaurant_id;
end;
$$;

-- Loads an image with its dish locked, and checks the caller.
create or replace function public.menu_image_authorize_image(p_image_id uuid)
returns public.menu_item_images
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image public.menu_item_images;
begin
  select * into v_image from public.menu_item_images where id = p_image_id;
  if not found then
    raise exception 'MENU_IMAGE_NOT_FOUND';
  end if;

  perform public.menu_image_authorize_item(v_image.menu_item_id);

  -- Re-read under the dish lock taken above.
  select * into v_image from public.menu_item_images where id = p_image_id for update;
  return v_image;
end;
$$;

-- Marks this restaurant's generations that outlived the timeout as failed,
-- so they stop occupying a dish's pending slot. They still count as
-- attempts: an attempt that timed out still cost a request.
create or replace function public.menu_image_expire_stale_generations(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_timeout integer;
begin
  select generation_timeout_seconds into v_timeout
  from public.menu_image_generation_limits where id;

  with expired as (
    update public.menu_item_images
    set status = 'failed',
        error = 'Image generation took too long and was stopped.'
    where restaurant_id = p_restaurant_id
      and status = 'generating'
      and created_at < now() - make_interval(secs => coalesce(v_timeout, 180))
    returning id
  )
  update public.menu_image_generation_attempts a
  set status = 'timed_out',
      finished_at = now(),
      failure_reason = 'Timed out.'
  from expired
  where a.image_id = expired.id
    and a.status = 'started';
end;
$$;

-- Grants for these internal helpers are set at the end of this file.

-- Starting an upload or a generation --------------------------------------

create or replace function public.begin_menu_item_image_upload(p_menu_item_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_image_id uuid;
begin
  v_restaurant_id := public.menu_image_authorize_item(p_menu_item_id);

  insert into public.menu_item_images (restaurant_id, menu_item_id, source, status, created_by)
  values (v_restaurant_id, p_menu_item_id, 'real', 'uploading', auth.uid())
  returning id into v_image_id;

  return v_image_id;
end;
$$;

comment on function public.begin_menu_item_image_upload(uuid) is
  'Creates an "uploading" real-photo row for a dish and returns its id, which fixes the storage path the upload may use. Owner/manager only.';

create or replace function public.begin_menu_item_image_generation(p_menu_item_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_limits public.menu_image_generation_limits;
  v_restaurant_attempts integer;
  v_item_attempts integer;
  v_item_pending integer;
  v_image_id uuid;
begin
  v_restaurant_id := public.menu_image_authorize_item(p_menu_item_id);

  -- Serialise attempts per restaurant, so two requests cannot both read
  -- "9 used" and both start the tenth.
  perform 1 from public.restaurants where id = v_restaurant_id for update;

  perform public.menu_image_expire_stale_generations(v_restaurant_id);

  select * into v_limits from public.menu_image_generation_limits where id;

  -- ATTEMPTS, not successes, and from the append-only ledger: every
  -- attempt ever started counts, whatever became of it — and whether or not
  -- its dish or image still exists. A failed call can still be a billed
  -- call, and deleting a dish must not hand the restaurant its quota back.
  select count(*) into v_restaurant_attempts
  from public.menu_image_generation_attempts
  where restaurant_id = v_restaurant_id
    and started_at > now() - interval '24 hours';

  if v_restaurant_attempts >= v_limits.attempts_per_restaurant_per_day then
    raise exception 'MENU_IMAGE_GENERATION_RESTAURANT_LIMIT';
  end if;

  -- Per dish: this dish identity's attempts. A deleted-and-recreated dish
  -- is a new identity and starts fresh; the restaurant count above does not.
  select count(*) into v_item_attempts
  from public.menu_image_generation_attempts
  where menu_item_id = p_menu_item_id
    and started_at > now() - interval '24 hours';

  if v_item_attempts >= v_limits.attempts_per_item_per_day then
    raise exception 'MENU_IMAGE_GENERATION_ITEM_LIMIT';
  end if;

  -- An image waiting for the owner, or still being made, blocks another:
  -- review the one you have before paying for the next.
  select count(*) into v_item_pending
  from public.menu_item_images
  where menu_item_id = p_menu_item_id
    and source = 'ai_generated'
    and status in ('generating', 'pending_review');

  if v_item_pending >= v_limits.max_pending_per_item then
    raise exception 'MENU_IMAGE_GENERATION_PENDING_EXISTS';
  end if;

  insert into public.menu_item_images (restaurant_id, menu_item_id, source, status, created_by)
  values (v_restaurant_id, p_menu_item_id, 'ai_generated', 'generating', auth.uid())
  returning id into v_image_id;

  -- Recorded in the same transaction as the reservation, so an attempt can
  -- never exist without being counted.
  insert into public.menu_image_generation_attempts (restaurant_id, menu_item_id, image_id)
  values (v_restaurant_id, p_menu_item_id, v_image_id);

  return v_image_id;
end;
$$;

comment on function public.begin_menu_item_image_generation(uuid) is
  'Reserves one AI generation attempt for a dish, enforcing menu_image_generation_limits (rolling 24h, attempts not successes, one pending per dish). Returns the image id to generate into. Owner/manager only.';

-- Finishing an upload or a generation -------------------------------------

create or replace function public.complete_menu_item_image(
  p_image_id uuid,
  p_original_path text,
  p_variant_paths jsonb,
  p_width integer,
  p_height integer,
  p_byte_size integer,
  p_mime_type text,
  p_content_sha256 text,
  p_generation jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image public.menu_item_images;
  v_prefix text;
  v_path text;
begin
  v_image := public.menu_image_authorize_image(p_image_id);

  if v_image.status not in ('uploading', 'generating') then
    raise exception 'MENU_IMAGE_INVALID_STATE';
  end if;

  -- Every file must live under this image's own folder, so a caller
  -- cannot point an image at another dish's — or another restaurant's —
  -- objects.
  v_prefix := v_image.restaurant_id || '/' || v_image.menu_item_id || '/' || v_image.id || '/';

  if not public.menu_image_path_is_valid(p_original_path, v_prefix) then
    raise exception 'MENU_IMAGE_INVALID_PATH';
  end if;

  if p_variant_paths is null
    or jsonb_typeof(p_variant_paths) <> 'object'
    or p_variant_paths = '{}'::jsonb then
    raise exception 'MENU_IMAGE_INVALID_PATH';
  end if;

  -- Every value must be a string path; a nested object or number is not a
  -- file and is refused rather than silently stringified.
  if exists (
    select 1 from jsonb_each(p_variant_paths) where jsonb_typeof(value) <> 'string'
  ) then
    raise exception 'MENU_IMAGE_INVALID_PATH';
  end if;

  for v_path in select value from jsonb_each_text(p_variant_paths) loop
    if not public.menu_image_path_is_valid(v_path, v_prefix) then
      raise exception 'MENU_IMAGE_INVALID_PATH';
    end if;
  end loop;

  if v_image.source = 'ai_generated' then
    if p_generation is null
      or jsonb_typeof(p_generation) <> 'object'
      or coalesce(p_generation ->> 'provider', '') = ''
      or coalesce(p_generation ->> 'model', '') = '' then
      raise exception 'MENU_IMAGE_GENERATION_METADATA_REQUIRED';
    end if;
  elsif p_generation is not null then
    raise exception 'MENU_IMAGE_GENERATION_METADATA_NOT_ALLOWED';
  end if;

  update public.menu_item_images
  set status = 'pending_review',
      original_path = p_original_path,
      variant_paths = p_variant_paths,
      width = p_width,
      height = p_height,
      byte_size = p_byte_size,
      mime_type = p_mime_type,
      content_sha256 = p_content_sha256,
      generation = p_generation
  where id = p_image_id;

  if v_image.source = 'ai_generated' then
    update public.menu_image_generation_attempts
    set status = 'succeeded',
        finished_at = now(),
        provider = p_generation ->> 'provider',
        model = p_generation ->> 'model'
    where image_id = p_image_id
      and status = 'started';
  end if;
end;
$$;

comment on function public.complete_menu_item_image(uuid, text, jsonb, integer, integer, integer, text, text, jsonb) is
  'Records a processed upload or generation and moves it to pending_review. Refuses paths outside the image''s own folder, and an AI image without provider/model metadata. Never publishes.';

create or replace function public.fail_menu_item_image(p_image_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image public.menu_item_images;
begin
  v_image := public.menu_image_authorize_image(p_image_id);

  if v_image.status not in ('uploading', 'generating') then
    raise exception 'MENU_IMAGE_INVALID_STATE';
  end if;

  update public.menu_item_images
  set status = 'failed',
      error = left(coalesce(nullif(trim(p_error), ''), 'Something went wrong.'), 300)
  where id = p_image_id;

  update public.menu_image_generation_attempts
  set status = 'failed',
      finished_at = now(),
      failure_reason = left(coalesce(nullif(trim(p_error), ''), 'Something went wrong.'), 300)
  where image_id = p_image_id
    and status = 'started';
end;
$$;

-- Review ------------------------------------------------------------------

-- The only way an image reaches diners. One transaction: the old active
-- image steps down only as the new one steps up.
create or replace function public.publish_menu_item_image(p_image_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image public.menu_item_images;
begin
  v_image := public.menu_image_authorize_image(p_image_id);

  if v_image.status <> 'pending_review' then
    raise exception 'MENU_IMAGE_INVALID_STATE';
  end if;

  update public.menu_item_images
  set status = 'superseded'
  where menu_item_id = v_image.menu_item_id
    and status = 'active';

  update public.menu_item_images
  set status = 'active',
      published_at = now()
  where id = p_image_id;

  update public.menu_items
  set active_image_id = p_image_id,
      image_source = v_image.source,
      image_variants = v_image.variant_paths
  where id = v_image.menu_item_id;
end;
$$;

comment on function public.publish_menu_item_image(uuid) is
  'Makes a reviewed image the dish''s image: supersedes the previous active image and moves the pointer in one transaction. The only path by which an image, AI or real, becomes visible to diners. Owner/manager only.';

create or replace function public.reject_menu_item_image(p_image_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image public.menu_item_images;
begin
  v_image := public.menu_image_authorize_image(p_image_id);

  if v_image.status not in ('uploading', 'generating', 'pending_review') then
    raise exception 'MENU_IMAGE_INVALID_STATE';
  end if;

  update public.menu_item_images set status = 'rejected' where id = p_image_id;

  -- Rejecting a generation still in flight cancels the attempt — which
  -- still counts against the quota. Rejecting an image already made
  -- leaves its attempt as it was (succeeded).
  update public.menu_image_generation_attempts
  set status = 'cancelled',
      finished_at = now()
  where image_id = p_image_id
    and status = 'started';
end;
$$;

comment on function public.reject_menu_item_image(uuid) is
  'Discards a draft (an upload in progress, a generation, or an image awaiting review). The dish''s active image is never touched. Owner/manager only.';

create or replace function public.remove_menu_item_image(p_menu_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.menu_image_authorize_item(p_menu_item_id);

  update public.menu_item_images
  set status = 'removed'
  where menu_item_id = p_menu_item_id and status = 'active';

  update public.menu_items
  set active_image_id = null,
      image_source = null,
      image_variants = null
  where id = p_menu_item_id;
end;
$$;

comment on function public.remove_menu_item_image(uuid) is
  'Takes the dish back to no image. The row is kept (status removed) for the 30-day retention window. The legacy image_url column is left as it is. Owner/manager only.';

create or replace function public.confirm_menu_item_image_authentic(p_menu_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image public.menu_item_images;
begin
  perform public.menu_image_authorize_item(p_menu_item_id);

  select * into v_image
  from public.menu_item_images
  where menu_item_id = p_menu_item_id and status = 'active'
  for update;

  -- Only an unverified legacy image can be vouched for. An AI illustration
  -- can never become a "restaurant photo" — the way to get one is to
  -- upload a real photo and publish it.
  if not found or v_image.source <> 'unverified' then
    raise exception 'MENU_IMAGE_NOT_UNVERIFIED';
  end if;

  update public.menu_item_images
  set source = 'real',
      confirmed_by = auth.uid(),
      confirmed_at = now()
  where id = v_image.id;

  update public.menu_items
  set image_source = 'real'
  where id = p_menu_item_id;
end;
$$;

comment on function public.confirm_menu_item_image_authentic(uuid) is
  'The owner or manager vouches that a dish''s existing (unverified, pre-migration) image is a real restaurant photo. Refuses AI-generated images outright. Owner/manager only.';

-- Quota, for the owner UI ---------------------------------------------------

create or replace function public.get_menu_image_generation_quota(
  p_restaurant_id uuid,
  p_menu_item_id uuid default null
)
returns table (
  restaurant_attempts integer,
  restaurant_limit integer,
  item_attempts integer,
  item_limit integer,
  item_pending integer,
  max_pending_per_item integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limits public.menu_image_generation_limits;
begin
  if not public.is_restaurant_manager_or_owner(p_restaurant_id) then
    raise exception 'MENU_IMAGE_FORBIDDEN';
  end if;

  select * into v_limits from public.menu_image_generation_limits where id;

  restaurant_limit := v_limits.attempts_per_restaurant_per_day;
  item_limit := v_limits.attempts_per_item_per_day;
  max_pending_per_item := v_limits.max_pending_per_item;

  select count(*) into restaurant_attempts
  from public.menu_image_generation_attempts
  where restaurant_id = p_restaurant_id
    and started_at > now() - interval '24 hours';

  if p_menu_item_id is not null then
    select count(*) into item_attempts
    from public.menu_image_generation_attempts
    where menu_item_id = p_menu_item_id
      and restaurant_id = p_restaurant_id
      and started_at > now() - interval '24 hours';

    -- A generation past its timeout is not really pending; it will be
    -- expired on the next attempt. Not counting it here keeps this
    -- read-only function honest without writing.
    select count(*) into item_pending
    from public.menu_item_images
    where menu_item_id = p_menu_item_id
      and restaurant_id = p_restaurant_id
      and source = 'ai_generated'
      and (
        status = 'pending_review'
        or (
          status = 'generating'
          and created_at >= now() - make_interval(secs => v_limits.generation_timeout_seconds)
        )
      );
  end if;

  return next;
end;
$$;

comment on function public.get_menu_image_generation_quota(uuid, uuid) is
  'How many AI generation attempts a restaurant (and optionally one dish) has used in the last 24 hours, against the configured limits. Read-only; the limits themselves are enforced in begin_menu_item_image_generation().';

-- Legacy image URLs ---------------------------------------------------------

-- Existing menu_items.image_url values are URLs somebody typed in. They are
-- NOT assumed to be real photography: each becomes an 'unverified' active
-- image until an owner confirms it. image_url itself is left untouched.
-- Idempotent — a dish that already has an active image is skipped.
create or replace function public.backfill_legacy_menu_item_images()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_item record;
  v_image_id uuid;
begin
  for v_item in
    select id, restaurant_id, image_url
    from public.menu_items
    where image_url is not null
      and length(trim(image_url)) > 0
      and active_image_id is null
  loop
    insert into public.menu_item_images (
      restaurant_id, menu_item_id, source, status, external_url, published_at
    )
    values (v_item.restaurant_id, v_item.id, 'unverified', 'active', v_item.image_url, now())
    returning id into v_image_id;

    update public.menu_items
    set active_image_id = v_image_id,
        image_source = 'unverified'
    where id = v_item.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.backfill_legacy_menu_item_images() is
  'Turns each pre-existing menu_items.image_url into an unverified active image. Leaves image_url as it is. Safe to run again. Not callable by request roles.';

select public.backfill_legacy_menu_item_images();

-- Grants ----------------------------------------------------------------------
--
-- Supabase grants EXECUTE on every new function in `public` to anon,
-- authenticated and service_role through default privileges — not only to
-- PUBLIC. So each function here is revoked from all three client-facing
-- grantees explicitly, then granted back only where intended. (The
-- integration harness now mirrors those default privileges, so a missing
-- revoke fails a test instead of shipping.)
--
-- PUBLIC API — callable by signed-in users; every one checks, inside, that
-- the caller is an owner or manager of the dish's restaurant:
--   begin_menu_item_image_upload, begin_menu_item_image_generation,
--   complete_menu_item_image, fail_menu_item_image, publish_menu_item_image,
--   reject_menu_item_image, remove_menu_item_image,
--   confirm_menu_item_image_authentic, get_menu_image_generation_quota.
--
-- INTERNAL — never callable by a client; used only from inside the
-- functions above (which run as their owner) or by the migration itself:
--   menu_image_authorize_item, menu_image_authorize_image,
--   menu_image_expire_stale_generations, menu_image_path_is_valid,
--   backfill_legacy_menu_item_images.
--
-- TRIGGER functions (menu_items_guard_image_columns,
-- menu_item_images_track_status_change,
-- menu_image_generation_attempts_append_only) return `trigger` and cannot be
-- invoked through the API; their EXECUTE grants are left alone so that
-- ordinary writes by those roles keep firing them.

-- Internal: revoked from everyone a request can run as.
revoke execute on function public.menu_image_authorize_item(uuid) from public, anon, authenticated;
revoke execute on function public.menu_image_authorize_image(uuid) from public, anon, authenticated;
revoke execute on function public.menu_image_expire_stale_generations(uuid) from public, anon, authenticated;
revoke execute on function public.menu_image_path_is_valid(text, text) from public, anon, authenticated;
revoke execute on function public.backfill_legacy_menu_item_images() from public, anon, authenticated;

-- Public API: never for anon (a signed-out caller has no restaurant), and
-- granted to authenticated — the in-function owner/manager check is what
-- turns away diners, staff and other restaurants.
revoke execute on function public.begin_menu_item_image_upload(uuid) from public, anon;
revoke execute on function public.begin_menu_item_image_generation(uuid) from public, anon;
revoke execute on function public.complete_menu_item_image(uuid, text, jsonb, integer, integer, integer, text, text, jsonb) from public, anon;
revoke execute on function public.fail_menu_item_image(uuid, text) from public, anon;
revoke execute on function public.publish_menu_item_image(uuid) from public, anon;
revoke execute on function public.reject_menu_item_image(uuid) from public, anon;
revoke execute on function public.remove_menu_item_image(uuid) from public, anon;
revoke execute on function public.confirm_menu_item_image_authentic(uuid) from public, anon;
revoke execute on function public.get_menu_image_generation_quota(uuid, uuid) from public, anon;

grant execute on function public.begin_menu_item_image_upload(uuid) to authenticated;
grant execute on function public.begin_menu_item_image_generation(uuid) to authenticated;
grant execute on function public.complete_menu_item_image(uuid, text, jsonb, integer, integer, integer, text, text, jsonb) to authenticated;
grant execute on function public.fail_menu_item_image(uuid, text) to authenticated;
grant execute on function public.publish_menu_item_image(uuid) to authenticated;
grant execute on function public.reject_menu_item_image(uuid) to authenticated;
grant execute on function public.remove_menu_item_image(uuid) to authenticated;
grant execute on function public.confirm_menu_item_image_authentic(uuid) to authenticated;
grant execute on function public.get_menu_image_generation_quota(uuid, uuid) to authenticated;
